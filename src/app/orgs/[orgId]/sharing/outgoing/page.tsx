import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDate, fmtDateTime, nowMs } from "@/lib/format";
import { FIELD_LABEL, GRANT_STATE_LABEL } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { Flash } from "@/components/ui";
import { SharingTabs } from "@/components/SharingTabs";

async function stop(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const ids = fd.getAll("ids").map(String);
  if (!ids.length) redirect(`/orgs/${orgId}/sharing/outgoing?error=${encodeURIComponent("停止する共有を選んでください。")}`);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stop_share_grants", { org: orgId, grant_ids: ids, reason: "stopped_by_source" });
  if (error) redirect(`/orgs/${orgId}/sharing/outgoing?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/sharing/outgoing?ok=${encodeURIComponent(`${data}件の共有を停止しました。共有先では直ちに閲覧できなくなります。`)}`);
}

type Row = {
  grant_id: string; person_id: string; person_name: string; target_name: string; fields: string[]; expires_at: string;
  status: string; state: string; current_version: number; published_at: string | null; has_changes: boolean; stop_reason: string | null;
};

export default async function Outgoing({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  // 停止は機能フラグを無効にした後でも行えるよう、一覧はフラグに関係なく表示する
  const { manage, view } = await sharingContext(orgId, "manage");
  const supabase = await createClient();
  const { data } = await supabase.rpc("list_outgoing_shares", { org: orgId });
  const rows = (data ?? []) as Row[];
  const soon = nowMs() + 14 * 86400e3;
  return (
    <>
      <h1>自団体から共有中の活動者</h1>
      <SharingTabs orgId={orgId} current="outgoing" manage={manage} view={view} />
      <Flash sp={sp} />
      <form action={stop}>
        <input type="hidden" name="orgId" value={orgId} />
        <div className="row small" style={{ marginBottom: 8 }}>
          <span className="muted">選んだ共有を：</span><button className="btn-danger btn-small">停止する</button>
        </div>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th /><th>活動者</th><th>共有先</th><th>共有項目</th><th>公開中の版</th><th>期限</th><th>状態</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted">共有している活動者はいません。</td></tr>}
              {rows.map((r) => (
                <tr key={r.grant_id}>
                  <td>{r.status === "active" && <input type="checkbox" name="ids" value={r.grant_id} aria-label={`${r.person_name}の共有を選択`} />}</td>
                  <td><Link href={`/orgs/${orgId}/sharing/grants/${r.grant_id}`}>{r.person_name}</Link></td>
                  <td>{r.target_name}</td>
                  <td>{r.fields.map((f) => FIELD_LABEL[f] ?? f).join("、")}</td>
                  <td>第{r.current_version}版・{fmtDateTime(r.published_at)}
                    {r.has_changes && <div><span className="badge badge-warn">元の情報に未公開の変更あり</span></div>}</td>
                  <td>{fmtDate(r.expires_at)}{r.state === "live" && new Date(r.expires_at).getTime() < soon && <div><span className="badge badge-warn">まもなく期限</span></div>}</td>
                  <td><span className={`badge ${r.state === "live" ? "badge-ok" : ""}`}>{GRANT_STATE_LABEL[r.state] ?? r.state}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </form>
      <p className="small muted">停止・期限切れ・連携解除・根拠の撤回のいずれかで、共有先ではアプリ内で閲覧できなくなります。すでに相手が閲覧・記録した内容まで回収できるわけではありません。</p>
    </>
  );
}
