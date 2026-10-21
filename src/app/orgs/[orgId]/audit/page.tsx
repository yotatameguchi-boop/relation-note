import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime } from "@/lib/format";
import { Pager } from "@/components/ui";

const ACTION: Record<string, string> = {
  "organization.create": "組織を作成", "organization.transfer_ownership": "所有権を移譲",
  "invitation.create": "スタッフを招待", "invitation.revoke": "招待を取り消し",
  "membership.join": "組織に参加", "membership.update": "権限を変更", "membership.remove": "スタッフを削除", "membership.leave": "組織から脱退",
  "person.merge": "人物を統合", "person.delete": "人物を削除", "person.bulk_delete": "人物を一括削除",
  "people.export": "人物を一括出力", "import.start": "CSV取り込みを開始", "submission.resolve": "回答を判断",
  "form_connection.rotate_secret": "連携の秘密を再発行", "photo.reanalyze": "写真を再解析", "photo.delete": "写真を削除",
  "event.confirm_headcount": "参加人数を確定", "job.retry": "処理を再実行",
};
const PAGE = 100;

export default async function Audit({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ page?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  await requireMembership(orgId, "admin");
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();
  const { data: logs, count } = await supabase.from("audit_logs").select("id, action, target_type, target_id, detail, created_at, users(display_name, email)", { count: "exact" })
    .eq("organization_id", orgId).order("created_at", { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1);
  return (
    <>
      <h1>操作履歴</h1>
      <p className="muted small">権限変更・統合・削除・出力などの重要な操作を記録しています（保存期間3年）。回答の内容などの個人情報は記録しません。</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>日時</th><th>スタッフ</th><th>操作</th><th>詳細</th></tr></thead>
          <tbody>
            {(logs ?? []).map((l) => {
              const u = l.users as unknown as { display_name: string; email: string } | null;
              return (
                <tr key={l.id}>
                  <td className="small">{fmtDateTime(l.created_at)}</td>
                  <td className="small">{u?.display_name ?? "システム"}</td>
                  <td>{ACTION[l.action] ?? l.action}</td>
                  <td className="small muted"><code>{JSON.stringify(l.detail)}</code></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={count ?? 0} pageSize={PAGE} hrefFor={(p) => `/orgs/${orgId}/audit?page=${p}`} />
    </>
  );
}
