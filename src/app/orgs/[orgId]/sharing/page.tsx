import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { listPartnerships } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { Flash } from "@/components/ui";
import { SharingDisabled, SharingTabs } from "@/components/SharingTabs";

const back = (orgId: string, q: string) => `/orgs/${orgId}/sharing?${q}`;

async function request(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_partnership", { org: orgId, code: String(fd.get("code") ?? ""), msg: String(fd.get("message") ?? "") });
  if (error) redirect(back(orgId, `error=${encodeURIComponent(toMessage(error))}`));
  revalidatePath(`/orgs/${orgId}/sharing`);
  redirect(back(orgId, `ok=${encodeURIComponent("連携を申請しました。相手の団体の承認を待っています。")}`));
}

async function respond(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const accept = fd.get("accept") === "1";
  const supabase = await createClient();
  const { error } = await supabase.rpc("respond_partnership", { partnership: String(fd.get("id")), accept });
  if (error) redirect(back(orgId, `error=${encodeURIComponent(toMessage(error))}`));
  redirect(back(orgId, `ok=${encodeURIComponent(accept ? "連携を承認しました。活動者の情報は、個別に共有を設定するまで共有されません。" : "申請を拒否しました。")}`));
}

async function end(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("end_partnership", { partnership: String(fd.get("id")), org: orgId });
  if (error) redirect(back(orgId, `error=${encodeURIComponent(toMessage(error))}`));
  redirect(back(orgId, `ok=${encodeURIComponent("連携を終了しました。両方向の共有は直ちに閲覧できなくなりました。")}`));
}

const STATUS: Record<string, [string, string]> = {
  pending: ["申請中", "badge-warn"], active: ["連携中", "badge-ok"], rejected: ["拒否", ""], cancelled: ["取り下げ", ""], dissolved: ["解除", ""],
};

export default async function Partners({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { enabled, manage, view } = await sharingContext(orgId, "either");
  if (!enabled) return <SharingDisabled />;
  const supabase = await createClient();
  const [{ data: org }, partners] = await Promise.all([
    supabase.from("organizations").select("partner_code").eq("id", orgId).single(),
    listPartnerships(orgId),
  ]);
  const hidden = <input type="hidden" name="orgId" value={orgId} />;

  return (
    <>
      <h1>団体連携</h1>
      <SharingTabs orgId={orgId} current="partners" manage={manage} view={view} />
      <Flash sp={sp} />
      <div className="notice notice-info small">
        連携を承認しても、活動者の情報は共有されません。共有は活動者ごとに、共有根拠を記録したうえで項目と期限を選んで設定します。
        共有は一方向で、相手から自団体への共有は相手が別に設定します。受け取った情報を第三者の団体へ再共有することはできません。
      </div>
      {manage && (
        <div className="grid grid-2">
          <div className="card">
            <h2 style={{ marginTop: 0 }}>自団体の連携コード</h2>
            <p><code style={{ fontSize: 16 }}>{org?.partner_code}</code></p>
            <p className="small muted">連携したい相手の団体にこのコードを伝え、相手から申請してもらうこともできます。</p>
          </div>
          <form action={request} className="card">
            {hidden}
            <h2 style={{ marginTop: 0 }}>連携を申請</h2>
            <label className="field">相手の団体の連携コード<input name="code" required maxLength={20} autoComplete="off" /></label>
            <label className="field">メッセージ（任意）<input name="message" maxLength={500} placeholder="例：合同清掃活動のボランティア調整のため" /></label>
            <button>申請する</button>
          </form>
        </div>
      )}
      <h2>連携の一覧</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>相手の団体</th><th>状態</th><th>経緯</th><th className="num">自団体→相手</th><th className="num">相手→自団体</th><th /></tr></thead>
          <tbody>
            {partners.length === 0 && <tr><td colSpan={6} className="muted">連携はまだありません。</td></tr>}
            {partners.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.partner_name}</strong>{p.message && <div className="small muted">{p.message}</div>}</td>
                <td><span className={`badge ${STATUS[p.status]?.[1] ?? ""}`}>{STATUS[p.status]?.[0] ?? p.status}</span></td>
                <td className="small">{p.direction === "outgoing" ? "自団体から申請" : "相手から申請"}・{fmtDateTime(p.requested_at)}
                  {p.responded_at && <div>応答 {fmtDateTime(p.responded_at)}</div>}{p.dissolved_at && <div>終了 {fmtDateTime(p.dissolved_at)}</div>}</td>
                <td className="num">{p.outgoing_live}人</td>
                <td className="num">{p.incoming_live}人</td>
                <td className="right">
                  {manage && p.status === "pending" && p.direction === "incoming" && (
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <form action={respond}>{hidden}<input type="hidden" name="id" value={p.id} /><input type="hidden" name="accept" value="1" /><button className="btn-small">承認</button></form>
                      <form action={respond}>{hidden}<input type="hidden" name="id" value={p.id} /><input type="hidden" name="accept" value="0" /><button className="btn-secondary btn-small">拒否</button></form>
                    </div>
                  )}
                  {manage && (p.status === "active" || (p.status === "pending" && p.direction === "outgoing")) && (
                    <form action={end}>{hidden}<input type="hidden" name="id" value={p.id} />
                      <button className="btn-secondary btn-small">{p.status === "active" ? "連携を解除" : "申請を取り下げ"}</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">連携を解除すると、両方向の共有は直ちにアプリ内で閲覧できなくなります。すでに相手が閲覧・記録した情報まで回収できるわけではありません。</p>
    </>
  );
}
