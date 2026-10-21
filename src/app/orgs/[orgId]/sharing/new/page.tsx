import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { todayJst } from "@/lib/format";
import { CONTACT_FIELDS, FIELD_LABEL, listPartnerships, parseFields, SHARE_FIELDS, snapshotRows } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { Flash } from "@/components/ui";
import { SharingDisabled, SharingTabs } from "@/components/SharingTabs";
import { PeoplePicker } from "@/components/PeoplePicker";

type SP = Record<string, string | string[] | undefined>;
const all = (v: string | string[] | undefined) => ([] as string[]).concat(v ?? []).flatMap((x) => x.split(",")).filter(Boolean);
const uuids = (v: string | string[] | undefined) => all(v).filter((x) => /^[0-9a-f-]{36}$/.test(x));
const endOfDayJst = (d: string) => new Date(`${d}T23:59:59+09:00`).toISOString();

const READINESS: Record<string, [string, string]> = {
  ok: ["共有できます", "badge-ok"],
  already_shared: ["すでに共有中（変更は共有中一覧から）", "badge-warn"],
  no_authorization: ["共有根拠が未記録", "badge-danger"],
  withdrawn_or_expired: ["共有根拠が撤回・失効", "badge-danger"],
  insufficient_fields: ["選んだ項目が根拠の範囲外", "badge-danger"],
  shorter_than_share: ["根拠の有効期限が共有期限より短い", "badge-danger"],
};

async function create(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const people = fd.getAll("people").map(String);
  const fields = parseFields([...fd.getAll("fields"), ...fd.getAll("contact_fields")]);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_share_grants", {
    org: orgId, target: String(fd.get("target")), person_ids: people, p_fields: fields,
    p_tag_ids: fd.getAll("tags").map(String), p_event_ids: fd.getAll("events").map(String),
    p_expires_at: endOfDayJst(String(fd.get("expires"))),
  });
  if (error) redirect(`/orgs/${orgId}/sharing/new?error=${encodeURIComponent(toMessage(error))}`);
  const r = data as { created: unknown[]; skipped: unknown[] };
  redirect(`/orgs/${orgId}/sharing/outgoing?ok=${encodeURIComponent(`${r.created.length}人の共有を開始しました。${r.skipped.length ? `${r.skipped.length}人は根拠などの条件を満たさないため共有していません。` : ""}`)}`);
}

export default async function NewShare({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<SP> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { enabled, manage, view } = await sharingContext(orgId, "manage");
  if (!enabled) return <SharingDisabled />;
  const supabase = await createClient();
  const partners = (await listPartnerships(orgId)).filter((p) => p.status === "active");
  const people = uuids(sp.people);
  const target = typeof sp.target === "string" ? sp.target : partners[0]?.partner_id ?? "";
  const fields = parseFields(all(sp.fields));
  const contacts = parseFields(all(sp.contact_fields)).filter((f) => f === "email" || f === "phone");
  const contactsConfirmed = sp.contacts_confirmed === "on";
  const tags = uuids(sp.tags);
  const events = uuids(sp.events);
  const defaultExpiry = todayJst(90);
  const expires = typeof sp.expires === "string" && sp.expires ? sp.expires : defaultExpiry;
  const allFields = [...fields, ...(contactsConfirmed ? contacts : [])];
  const wantPreview = sp.preview === "1";

  const [{ data: tagList }, { data: eventList }] = await Promise.all([
    supabase.from("tags").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("events").select("id, title, starts_at").eq("organization_id", orgId).order("starts_at", { ascending: false }).limit(100),
  ]);

  let readiness: { person_id: string; full_name: string; status: string }[] = [];
  const previews: { name: string; rows: ReturnType<typeof snapshotRows> }[] = [];
  let previewError = "";
  if (wantPreview && people.length && target && allFields.length) {
    const { data, error } = await supabase.rpc("share_readiness", {
      org: orgId, target, person_ids: people, p_fields: allFields, p_expires_at: endOfDayJst(expires),
    });
    if (error) previewError = toMessage(error);
    readiness = (data ?? []) as typeof readiness;
    // 相手に見える内容（最大3人分）。活動履歴は選んだイベントの参加確認済み記録だけ
    for (const r of readiness.filter((x) => x.status === "ok").slice(0, 3)) {
      const { data: parts } = await supabase.from("event_participations").select("id").eq("organization_id", orgId)
        .eq("person_id", r.person_id).in("event_id", events.length ? events : ["00000000-0000-0000-0000-000000000000"]).eq("status", "attended");
      const { data: snap } = await supabase.rpc("preview_share", {
        org: orgId, pid: r.person_id, p_fields: allFields, p_tag_ids: tags, p_participation_ids: (parts ?? []).map((p) => p.id),
      });
      previews.push({ name: r.full_name, rows: snapshotRows((snap ?? {}) as Record<string, unknown>) });
    }
  } else if (wantPreview) {
    previewError = "活動者・共有先・項目を選んでください。";
  }
  const ready = readiness.filter((r) => r.status === "ok");
  const sel = (arr: string[], v: string) => arr.includes(v);

  return (
    <>
      <h1>活動者の共有を設定</h1>
      <SharingTabs orgId={orgId} current="new" manage={manage} view={view} />
      <Flash sp={{ error: typeof sp.error === "string" ? sp.error : undefined }} />
      {partners.length === 0 ? <div className="card muted">連携中の組織がありません。</div> : (
        <>
          <form className="row card" style={{ padding: 10 }}>
            {people.map((p) => <input key={p} type="hidden" name="people" value={p} />)}
            <input name="q" defaultValue={typeof sp.q === "string" ? sp.q : ""} placeholder="活動者を検索して追加" style={{ flex: 1 }} />
            <button className="btn-secondary btn-small">検索</button>
          </form>
          <form className="card">
            <input type="hidden" name="preview" value="1" />
            <PeoplePicker orgId={orgId} selected={people} q={typeof sp.q === "string" ? sp.q : undefined} />
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="inline-field" style={{ flex: 1 }}>共有先<select name="target" defaultValue={target}>{partners.map((p) => <option key={p.partner_id} value={p.partner_id}>{p.partner_name}</option>)}</select></label>
              <label className="inline-field">共有期限（この日の終わりまで）<input type="date" name="expires" defaultValue={expires} required /></label>
            </div>
            <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, margin: "10px 0" }}>
              <legend className="small">共有する項目（初期状態では選択していません）</legend>
              <div className="row">{SHARE_FIELDS.map((f) => (
                <label key={f.key} className="row small" style={{ margin: 0, color: "var(--text)" }}>
                  <input type="checkbox" name="fields" value={f.key} defaultChecked={sel(fields, f.key)} />{f.label}</label>
              ))}</div>
            </fieldset>
            <fieldset style={{ border: "1px solid var(--warn)", borderRadius: 6, marginBottom: 10 }}>
              <legend className="small">連絡先（明示的に選んでください）</legend>
              <div className="row">{CONTACT_FIELDS.map((f) => (
                <label key={f.key} className="row small" style={{ margin: 0, color: "var(--text)" }}>
                  <input type="checkbox" name="contact_fields" value={f.key} defaultChecked={sel(contacts, f.key)} />{f.label}</label>
              ))}</div>
              <label className="row small" style={{ marginTop: 6, color: "var(--text)" }}>
                <input type="checkbox" name="contacts_confirmed" defaultChecked={contactsConfirmed} />連絡先を共有先に見せることを確認した（チェックしないと連絡先は共有しません）
              </label>
            </fieldset>
            <div className="grid grid-2">
              <div className="field"><label>共有するタグ（「選んだタグ」を共有する場合）</label>
                <div className="row">{(tagList ?? []).map((t) => (
                  <label key={t.id} className="tag" style={{ margin: 0 }}><input type="checkbox" name="tags" value={t.id} defaultChecked={sel(tags, t.id)} />{t.name}</label>
                ))}</div></div>
              <div className="field"><label>共有する活動履歴（選んだイベントの参加確認済み記録だけ）</label>
                <div className="stack" style={{ maxHeight: 160, overflowY: "auto" }}>{(eventList ?? []).map((e) => (
                  <label key={e.id} className="row small" style={{ margin: 0, color: "var(--text)" }}>
                    <input type="checkbox" name="events" value={e.id} defaultChecked={sel(events, e.id)} />{e.starts_at.slice(0, 10)} {e.title}</label>
                ))}</div></div>
            </div>
            <button className="btn-secondary">相手に見える内容をプレビュー</button>
          </form>

          {previewError && <div className="notice notice-warn">{previewError}</div>}
          {wantPreview && readiness.length > 0 && (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>プレビュー</h2>
              <p className="small">共有する項目：{allFields.map((f) => FIELD_LABEL[f]).join("、")}
                {contacts.length > 0 && !contactsConfirmed && <span className="badge badge-warn" style={{ marginLeft: 6 }}>確認がないため連絡先は含めていません</span>}</p>
              <table className="small"><tbody>
                {readiness.map((r) => (
                  <tr key={r.person_id}><td>{r.full_name}</td><td><span className={`badge ${READINESS[r.status]?.[1] ?? ""}`}>{READINESS[r.status]?.[0] ?? r.status}</span></td></tr>
                ))}
              </tbody></table>
              {previews.map((pv) => (
                <div key={pv.name} className="card shared-card" style={{ marginTop: 10 }}>
                  <div className="small muted">{pv.name} さんについて、共有先にはこのように表示されます</div>
                  <table className="small"><tbody>
                    {pv.rows.map((r) => <tr key={r.label}><th style={{ width: "30%" }}>{r.label}{r.contact && <span className="badge badge-warn" style={{ marginLeft: 4 }}>連絡先</span>}</th><td>{r.value}</td></tr>)}
                  </tbody></table>
                </div>
              ))}
              <p className="small muted">内部メモ、未選択の応募回答、写真、添付ファイルは共有されません。共有後に元の情報を編集しても、更新版を公開するまで共有先の表示は変わりません。</p>
              {ready.length > 0 ? (
                <form action={create}>
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="target" value={target} />
                  <input type="hidden" name="expires" value={expires} />
                  {ready.map((r) => <input key={r.person_id} type="hidden" name="people" value={r.person_id} />)}
                  {fields.map((f) => <input key={f} type="hidden" name="fields" value={f} />)}
                  {contactsConfirmed && contacts.map((f) => <input key={f} type="hidden" name="contact_fields" value={f} />)}
                  {tags.map((t) => <input key={t} type="hidden" name="tags" value={t} />)}
                  {events.map((e) => <input key={e} type="hidden" name="events" value={e} />)}
                  <button>この内容で {ready.length}人を共有する</button>
                </form>
              ) : <p className="notice notice-warn small">共有できる活動者がいません。「共有根拠」で根拠を記録してください。</p>}
            </div>
          )}
        </>
      )}
    </>
  );
}
