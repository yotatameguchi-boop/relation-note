import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDate, fmtDateTime, nowMs, todayJst } from "@/lib/format";
import { BASIS_LABEL, CONTACT_FIELDS, FIELD_LABEL, listPartnerships, parseFields, SHARE_FIELDS } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { Flash } from "@/components/ui";
import { SharingDisabled, SharingTabs } from "@/components/SharingTabs";
import { PeoplePicker } from "@/components/PeoplePicker";

const url = (orgId: string) => `/orgs/${orgId}/sharing/authorizations`;
const jst = (d: string, end = false) => (d ? new Date(`${d}T${end ? "23:59:59" : "00:00:00"}+09:00`).toISOString() : null);

async function record(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const people = fd.getAll("people").map(String);
  const fields = parseFields(fd.getAll("fields"));
  const contacts = parseFields(fd.getAll("contact_fields"));
  if (contacts.length && fd.get("contacts_confirmed") !== "on") {
    redirect(`${url(orgId)}?error=${encodeURIComponent("連絡先を含める場合は、本人が連絡先の共有にも同意していることの確認にチェックしてください。")}&people=${people.join(",")}`);
  }
  if (!people.length) redirect(`${url(orgId)}?error=${encodeURIComponent("活動者を選んでください。")}`);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_sharing_authorizations", {
    org: orgId, person_ids: people, target: String(fd.get("target") ?? ""), p_basis_type: String(fd.get("basis_type")),
    p_basis_detail: String(fd.get("basis_detail") ?? ""), p_purpose: String(fd.get("purpose") ?? ""),
    p_allowed_fields: [...fields, ...contacts], p_evidence_ref: String(fd.get("evidence_ref") ?? ""),
    p_confirmed_at: jst(String(fd.get("confirmed_at") ?? "")), p_valid_until: jst(String(fd.get("valid_until") ?? ""), true),
  });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}&people=${people.join(",")}`);
  revalidatePath(url(orgId));
  redirect(`${url(orgId)}?ok=${encodeURIComponent(`${data}人分の共有根拠を記録しました。`)}`);
}

async function withdraw(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("withdraw_sharing_authorization", { auth_id: String(fd.get("id")), reason: String(fd.get("reason") ?? "") });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId)}?ok=${encodeURIComponent(`撤回を記録しました。関連する共有 ${data}件を停止しました。`)}`);
}

export default async function Authorizations({ params, searchParams }: {
  params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string; people?: string; q?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { enabled, manage, view } = await sharingContext(orgId, "manage");
  if (!enabled) return <SharingDisabled />;
  const supabase = await createClient();
  const partners = (await listPartnerships(orgId)).filter((p) => p.status === "active");
  const names = new Map(partners.map((p) => [p.partner_id, p.partner_name]));
  const { data: auths } = await supabase.from("sharing_authorizations")
    .select("id, person_id, target_organization_id, basis_type, purpose, allowed_fields, evidence_ref, confirmed_at, valid_until, status, withdrawn_at, withdraw_reason, people(full_name), users:confirmed_by(display_name)")
    .eq("organization_id", orgId).order("created_at", { ascending: false }).limit(200);
  const selected = (sp.people ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/.test(x));
  const hidden = <input type="hidden" name="orgId" value={orgId} />;
  const today = todayJst();

  return (
    <>
      <h1>共有根拠（本人同意など）</h1>
      <SharingTabs orgId={orgId} current="authorizations" manage={manage} view={view} />
      <Flash sp={sp} />
      <div className="notice notice-info small">
        スタッフが確認した共有の根拠（本人の同意など）を記録します。アプリは根拠の法的な妥当性を判断しません。
        根拠が未記録・撤回済み・期限切れ、または共有する項目や期限が根拠の範囲外の場合は、共有を有効にできません。
      </div>
      {partners.length === 0 ? (
        <div className="card muted">連携中の団体がありません。先に「団体連携」で連携してください。</div>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>根拠を記録</h2>
          <form className="row" style={{ marginBottom: 8 }}>
            <input type="hidden" name="people" value={selected.join(",")} />
            <input name="q" defaultValue={sp.q} placeholder="活動者を検索（氏名・メール・電話）" style={{ flex: 1 }} />
            <button className="btn-secondary btn-small">検索</button>
          </form>
          <form action={record}>
            {hidden}
            <PeoplePicker orgId={orgId} selected={selected} q={sp.q} />
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="inline-field" style={{ flex: 1 }}>共有先の団体<select name="target" required>{partners.map((p) => <option key={p.partner_id} value={p.partner_id}>{p.partner_name}</option>)}</select></label>
              <label className="inline-field">根拠の種類<select name="basis_type">{Object.entries(BASIS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label className="inline-field">確認日<input type="date" name="confirmed_at" required max={today} defaultValue={today} /></label>
              <label className="inline-field">有効期限（任意）<input type="date" name="valid_until" min={today} /></label>
            </div>
            <label className="field" style={{ marginTop: 10 }}>利用目的 *<input name="purpose" required maxLength={500} placeholder="例：合同イベントでのボランティア配置の調整" /></label>
            <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, marginBottom: 10 }}>
              <legend className="small">対象項目（初期状態では選択していません）</legend>
              <div className="row">{SHARE_FIELDS.map((f) => (
                <label key={f.key} className="row small" style={{ margin: 0, color: "var(--text)" }}><input type="checkbox" name="fields" value={f.key} />{f.label}</label>
              ))}</div>
            </fieldset>
            <fieldset style={{ border: "1px solid var(--warn)", borderRadius: 6, marginBottom: 10 }}>
              <legend className="small">連絡先（他の項目とは別に、明示的に選んでください）</legend>
              <div className="row">{CONTACT_FIELDS.map((f) => (
                <label key={f.key} className="row small" style={{ margin: 0, color: "var(--text)" }}><input type="checkbox" name="contact_fields" value={f.key} />{f.label}</label>
              ))}</div>
              <label className="row small" style={{ marginTop: 6, color: "var(--text)" }}>
                <input type="checkbox" name="contacts_confirmed" />連絡先を含める場合：本人が連絡先の共有についても同意していることを確認した
              </label>
            </fieldset>
            <label className="field">根拠となる記録への参照（例：同意書の保管場所、応募フォームの同意欄・回答ID）<input name="evidence_ref" maxLength={500} /></label>
            <label className="field">補足（任意）<input name="basis_detail" maxLength={1000} /></label>
            <button>記録する</button>
          </form>
        </div>
      )}

      <h2>記録済みの根拠</h2>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>活動者</th><th>共有先</th><th>根拠・目的</th><th>対象項目</th><th>確認</th><th>状態</th><th /></tr></thead>
          <tbody>
            {(auths ?? []).length === 0 && <tr><td colSpan={7} className="muted">まだありません。</td></tr>}
            {(auths ?? []).map((a) => {
              const expired = a.valid_until && new Date(a.valid_until).getTime() <= nowMs();
              return (
                <tr key={a.id}>
                  <td><Link href={`/orgs/${orgId}/people/${a.person_id}`}>{(a.people as unknown as { full_name: string }).full_name}</Link></td>
                  <td>{names.get(a.target_organization_id) ?? "（連携終了）"}</td>
                  <td>{BASIS_LABEL[a.basis_type]}：{a.purpose}{a.evidence_ref && <div className="muted">参照：{a.evidence_ref}</div>}</td>
                  <td>{(a.allowed_fields as string[]).map((f) => FIELD_LABEL[f] ?? f).join("、")}</td>
                  <td>{(a.users as unknown as { display_name: string } | null)?.display_name}<div className="muted">{fmtDate(a.confirmed_at)}{a.valid_until && `〜${fmtDate(a.valid_until)}`}</div></td>
                  <td>{a.status === "withdrawn" ? <span className="badge badge-danger">撤回 {fmtDateTime(a.withdrawn_at)}</span>
                    : expired ? <span className="badge">失効</span> : <span className="badge badge-ok">有効</span>}
                    {a.withdraw_reason && <div className="muted">{a.withdraw_reason}</div>}</td>
                  <td>
                    {a.status === "active" && !expired && (
                      <form action={withdraw} className="row">{hidden}<input type="hidden" name="id" value={a.id} />
                        <input name="reason" placeholder="撤回の理由" style={{ width: 120 }} /><button className="btn-secondary btn-small">撤回を記録</button></form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
