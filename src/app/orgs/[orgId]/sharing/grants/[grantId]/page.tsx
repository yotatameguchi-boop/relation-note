import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { ALL_SHARE_FIELDS, FIELD_LABEL, GRANT_STATE_LABEL, parseFields, partnerNames, SNAPSHOT_KEY_LABEL, snapshotRows } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { Flash } from "@/components/ui";
import { SharingTabs } from "@/components/SharingTabs";

const url = (orgId: string, id: string) => `/orgs/${orgId}/sharing/grants/${id}`;

async function publish(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId")); const id = String(fd.get("id"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("publish_share_update", { grant_id: id });
  if (error) redirect(`${url(orgId, id)}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url(orgId, id));
  redirect(`${url(orgId, id)}?ok=${encodeURIComponent(`第${data}版を公開しました。`)}`);
}

async function update(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId")); const id = String(fd.get("id"));
  const fields = parseFields(fd.getAll("fields"));
  if (fields.some((f) => f === "email" || f === "phone") && fd.get("contacts_confirmed") !== "on") {
    redirect(`${url(orgId, id)}?error=${encodeURIComponent("連絡先を含める場合は確認にチェックしてください。")}`);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_share_grant", {
    grant_id: id, p_fields: fields, p_tag_ids: fd.getAll("tags").map(String), p_participation_ids: fd.getAll("parts").map(String),
    p_expires_at: new Date(`${fd.get("expires")}T23:59:59+09:00`).toISOString(),
  });
  if (error) redirect(`${url(orgId, id)}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url(orgId, id));
  redirect(`${url(orgId, id)}?ok=${encodeURIComponent(`共有内容を変更し、第${data}版として公開しました。`)}`);
}

async function stop(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId")); const id = String(fd.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("stop_share_grants", { org: orgId, grant_ids: [id], reason: "stopped_by_source" });
  if (error) redirect(`${url(orgId, id)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId, id)}?ok=${encodeURIComponent("共有を停止しました。")}`);
}

export default async function GrantPage({ params, searchParams }: { params: Promise<{ orgId: string; grantId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId, grantId } = await params;
  const sp = await searchParams;
  const { manage, view, enabled } = await sharingContext(orgId, "manage");
  const supabase = await createClient();
  const { data: g } = await supabase.from("person_share_grants").select("*, people(full_name)").eq("organization_id", orgId).eq("id", grantId).maybeSingle();
  if (!g) notFound();
  const [{ data: list }, { data: versions }, names, { data: tags }, { data: parts }, { data: auth }] = await Promise.all([
    supabase.rpc("list_outgoing_shares", { org: orgId }),
    supabase.from("person_share_versions").select("version, fields, published_at, users:published_by(display_name)").eq("grant_id", grantId).order("version", { ascending: false }),
    partnerNames(orgId),
    supabase.from("tags").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("event_participations").select("id, status, events(title, starts_at)").eq("organization_id", orgId).eq("person_id", g.person_id).eq("status", "attended"),
    supabase.from("sharing_authorizations").select("purpose, allowed_fields, valid_until, status").eq("id", g.authorization_id).maybeSingle(),
  ]);
  const row = ((list ?? []) as { grant_id: string; state: string; has_changes: boolean }[]).find((r) => r.grant_id === grantId);
  const diff = enabled && g.status === "active" ? (await supabase.rpc("share_grant_diff", { grant_id: grantId })).data as
    { current: Record<string, unknown>; published: Record<string, unknown>; changed_keys: string[] } | null : null;
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="id" value={grantId} /></>);
  const active = g.status === "active" && row?.state !== "expired";

  return (
    <>
      <div className="spread"><h1>{(g.people as { full_name: string }).full_name} さんの共有</h1><Link href={`/orgs/${orgId}/sharing/outgoing`}>← 共有中の一覧</Link></div>
      <SharingTabs orgId={orgId} current="outgoing" manage={manage} view={view} />
      <Flash sp={sp} />
      <div className="grid grid-4">
        <div className="stat"><div className="label">共有先</div><div className="value" style={{ fontSize: 16 }}>{names.get(g.target_organization_id) ?? "（連携終了）"}</div></div>
        <div className="stat"><div className="label">状態</div><div className="value" style={{ fontSize: 16 }}>{GRANT_STATE_LABEL[row?.state ?? g.status] ?? g.status}</div>
          {g.stop_reason && <div className="note">{g.stop_reason}</div>}</div>
        <div className="stat"><div className="label">公開中の版</div><div className="value">第{g.current_version}版</div></div>
        <div className="stat"><div className="label">期限</div><div className="value" style={{ fontSize: 16 }}>{fmtDate(g.expires_at)}</div></div>
      </div>
      {auth && <p className="small muted" style={{ marginTop: 8 }}>共有根拠：{auth.purpose}（範囲：{(auth.allowed_fields as string[]).map((f) => FIELD_LABEL[f]).join("、")}{auth.valid_until && `・${fmtDate(auth.valid_until)}まで`}）</p>}

      {diff && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>元の情報との差分</h2>
          {diff.changed_keys.length === 0 ? <p className="muted small">公開中の内容と、現在の元の情報に差はありません。</p> : (
            <>
              <p className="small">元の情報が変わっています（共有先にはまだ公開していません）。変わった項目：{diff.changed_keys.map((k) => SNAPSHOT_KEY_LABEL[k] ?? k).join("、")}</p>
              <div className="grid grid-2">
                <div><h3>公開中</h3><table className="small"><tbody>{snapshotRows(diff.published).map((r) => <tr key={r.label}><th>{r.label}</th><td>{r.value}</td></tr>)}</tbody></table></div>
                <div><h3>公開すると</h3><table className="small"><tbody>{snapshotRows(diff.current).map((r) => <tr key={r.label}><th>{r.label}</th><td>{r.value}</td></tr>)}</tbody></table></div>
              </div>
              <form action={publish} style={{ marginTop: 10 }}>{hidden}<button>確認したので更新版を公開</button></form>
            </>
          )}
        </div>
      )}

      {active && enabled && (
        <form action={update} className="card">
          {hidden}
          <h2 style={{ marginTop: 0 }}>共有内容を変更</h2>
          <p className="small muted">項目を追加する場合は、共有根拠の範囲に含まれている必要があります。変更すると新しい版として公開されます。</p>
          <div className="row">{ALL_SHARE_FIELDS.map((f) => (
            <label key={f.key} className="row small" style={{ margin: 0, color: "var(--text)" }}>
              <input type="checkbox" name="fields" value={f.key} defaultChecked={(g.fields as string[]).includes(f.key)} />{f.label}</label>
          ))}</div>
          <label className="row small" style={{ marginTop: 6, color: "var(--text)" }}><input type="checkbox" name="contacts_confirmed" />連絡先を含める場合：共有先に見せることを確認した</label>
          <div className="grid grid-2" style={{ marginTop: 8 }}>
            <div className="field"><label>共有するタグ</label><div className="row">{(tags ?? []).map((t) => (
              <label key={t.id} className="tag" style={{ margin: 0 }}><input type="checkbox" name="tags" value={t.id} defaultChecked={(g.tag_ids as string[]).includes(t.id)} />{t.name}</label>
            ))}</div></div>
            <div className="field"><label>共有する活動履歴（参加確認済み）</label><div className="stack">{(parts ?? []).map((p) => {
              const e = p.events as unknown as { title: string; starts_at: string };
              return <label key={p.id} className="row small" style={{ margin: 0, color: "var(--text)" }}>
                <input type="checkbox" name="parts" value={p.id} defaultChecked={(g.participation_ids as string[]).includes(p.id)} />{e.starts_at.slice(0, 10)} {e.title}</label>;
            })}</div></div>
          </div>
          <div className="row"><label className="inline-field">期限<input type="date" name="expires" defaultValue={new Date(new Date(g.expires_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10)} /></label>
            <button>変更して公開</button></div>
        </form>
      )}
      {g.status === "active" && <form action={stop} className="card">{hidden}<button className="btn-danger btn-small">この共有を停止</button>
        <span className="small muted" style={{ marginLeft: 8 }}>停止すると共有先では直ちに閲覧できなくなります。</span></form>}

      <h2>公開履歴</h2>
      <table className="small"><tbody>
        {(versions ?? []).map((v) => (
          <tr key={v.version}><td>第{v.version}版</td><td>{fmtDateTime(v.published_at)}</td><td>{(v.users as unknown as { display_name: string } | null)?.display_name}</td>
            <td>{(v.fields as string[]).map((f) => FIELD_LABEL[f]).join("、")}</td></tr>
        ))}
      </tbody></table>
    </>
  );
}
