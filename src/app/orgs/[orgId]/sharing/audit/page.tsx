import { createClient } from "@/lib/supabase/server";
import { fmtDateTime } from "@/lib/format";
import { partnerNames } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { SharingTabs } from "@/components/SharingTabs";

const ACTION: Record<string, string> = {
  "partnership.request": "連携を申請", "partnership.approve": "連携を承認", "partnership.reject": "連携を拒否",
  "partnership.cancel": "申請を取り下げ", "partnership.dissolve": "連携を解除",
  "authorization.record": "共有根拠を記録", "authorization.withdraw": "共有根拠の撤回を記録",
  "grant.create": "共有を開始", "grant.update": "共有内容を変更", "grant.publish": "更新版を公開", "grant.stop": "共有を停止",
  "shared.list": "共有一覧を閲覧", "shared.view": "共有された活動者を閲覧",
};

export default async function SharingAudit({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { manage, view } = await sharingContext(orgId, "manage");
  const supabase = await createClient();
  const [{ data: logs }, names] = await Promise.all([
    supabase.from("sharing_audit_logs").select("id, action, actor_organization_id, source_organization_id, target_organization_id, grant_id, detail, created_at, users:actor_id(display_name)")
      .or(`source_organization_id.eq.${orgId},target_organization_id.eq.${orgId}`).order("created_at", { ascending: false }).limit(300),
    partnerNames(orgId),
  ]);
  const orgName = (id: string | null) => (id === orgId ? "自組織" : id ? names.get(id) ?? "他組織" : "—");
  return (
    <>
      <h1>共有履歴</h1>
      <SharingTabs orgId={orgId} current="audit" manage={manage} view={view} />
      <p className="small muted">連携・根拠・共有の設定変更と、共有された情報の閲覧を記録しています。共有データの本文は記録しません。</p>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>日時</th><th>操作した組織・スタッフ</th><th>操作</th><th>共有元→共有先</th><th>詳細</th></tr></thead>
          <tbody>
            {(logs ?? []).map((l) => (
              <tr key={l.id}>
                <td>{fmtDateTime(l.created_at)}</td>
                <td>{orgName(l.actor_organization_id)}{l.actor_organization_id === orgId && `・${(l.users as unknown as { display_name: string } | null)?.display_name ?? ""}`}</td>
                <td>{ACTION[l.action] ?? l.action}</td>
                <td>{orgName(l.source_organization_id)} → {orgName(l.target_organization_id)}</td>
                <td><code>{JSON.stringify(l.detail)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
