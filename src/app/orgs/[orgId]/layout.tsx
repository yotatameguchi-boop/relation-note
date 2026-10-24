import Link from "next/link";
import { requireUser, requireMembership, can, canManageSharing, getFeatures, hasPerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Nav } from "@/components/Nav";
import { SidebarMenu } from "@/components/SidebarMenu";
import { Logo } from "@/components/Logo";
import { ROLE_LABEL } from "@/lib/roles";
import { usageWarnings, type Usage } from "@/lib/usage";
import { TermsNotice } from "@/components/TermsNotice";
import { LegalFooter } from "@/components/LegalFooter";
import { billingNotice, type OrgBilling } from "@/lib/billing";

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const user = await requireUser();
  const [{ data: usage }, { data: taskCounts }, { data: billing }] = await Promise.all([
    supabase.rpc("org_usage", { org: orgId }),
    supabase.rpc("my_task_counts", { org: orgId }),
    supabase.from("organizations").select("status, billing_suspended, subscription_status, trial_ends_at, current_period_end, cancel_at_period_end").eq("id", orgId).single(),
  ]);
  const bill = billing ? billingNotice(billing as OrgBilling, m.role === "owner") : null;
  const due = (taskCounts as { overdue: number; today: number } | null);
  const dueCount = (due?.overdue ?? 0) + (due?.today ?? 0);
  const warnings = usage ? usageWarnings(usage as Usage) : [];
  const base = `/orgs/${orgId}`;
  const editor = can(m, "editor");
  const admin = can(m, "admin");
  const features = await getFeatures(orgId);
  const sharingNav = features.partner_sharing
    ? [
        ...(canManageSharing(m) || hasPerm(m, "view_shared") ? [{ href: `${base}/sharing`, label: "組織連携", exact: true }] : []),
        ...(canManageSharing(m) ? [{ href: `${base}/sharing/outgoing`, label: "自組織から共有中" }] : []),
        ...(hasPerm(m, "view_shared") ? [{ href: `${base}/sharing/received`, label: "他組織から共有された活動者" }] : []),
      ]
    : [];

  return (
    <div className="shell">
      <aside className="sidebar">
        <SidebarMenu brand={<div className="brand"><Link href="/orgs" className="logo" aria-label="RelationNote 組織の選択へ"><Logo size={30} wordSize={16} /></Link></div>}>
        <div className="small" style={{ margin: "0 10px 8px" }}>
          <strong>{m.organizationName}</strong>
          <div className="muted org-switch">{ROLE_LABEL[m.role]}・<Link href="/orgs">組織を切り替え</Link></div>
        </div>
        <Nav
          sections={[
            { items: [{ href: base, label: "ダッシュボード", exact: true }, { href: `${base}/insights`, label: "グラフ分析" }] },
            {
              items: [{ href: `${base}/tasks`, label: "タスク", badge: dueCount > 0 ? `${dueCount}` : undefined, badgeLabel: `期限が今日までの自分のタスク ${dueCount}件` }],
            },
            {
              title: "顧客",
              items: [
                { href: `${base}/people`, label: "人物一覧", exact: true },
                { href: `${base}/companies`, label: "企業" },
                ...(editor ? [{ href: `${base}/people/duplicates`, label: "重複候補" }] : []),
                { href: `${base}/tags`, label: "タグ" },
              ],
            },
            {
              title: "メール",
              items: [{ href: `${base}/emails`, label: "メール配信" }],
            },
            {
              title: "応募フォーム",
              items: editor
                ? [
                    { href: `${base}/forms`, label: "取り込み・連携" },
                    { href: `${base}/review`, label: "確認待ちの回答" },
                  ]
                : [],
            },
            {
              title: "イベント",
              items: [
                { href: `${base}/events`, label: "イベント・参加履歴" },
                { href: `${base}/photos`, label: "写真と人数推定" },
              ],
            },
            ...(sharingNav.length ? [{ title: "組織間共有", items: sharingNav }] : []),
            {
              title: "運用",
              items: [
                { href: `${base}/jobs`, label: "処理状況" },
                ...(admin ? [{ href: `${base}/members`, label: "スタッフと権限" }, { href: `${base}/audit`, label: "操作履歴" }] : []),
                { href: `${base}/settings`, label: "組織設定・利用量" },
                ...(m.role === "owner" ? [{ href: `${base}/billing`, label: "料金・契約" }] : []),
              ],
            },
          ]}
        />
        <form action="/auth/signout" method="post" style={{ margin: "16px 10px" }}>
          <button className="btn-secondary btn-small">ログアウト</button>
        </form>
        </SidebarMenu>
      </aside>
      <main className="main">
        <TermsNotice userId={user.id} />
        {bill && (
          <div className={`notice ${bill.tone}`}>
            {bill.text}
            {bill.link && <> <Link href={`${base}/billing`}>料金・契約へ</Link></>}
          </div>
        )}
        {m.status === "suspended" && !bill?.suspended && (
          <div className="notice notice-warn">この組織は利用停止中です。データの閲覧と出力のみ行えます。</div>
        )}
        {warnings.map((w) => (
          <div key={w.key} className={`notice ${w.ratio >= 1 ? "notice-danger" : "notice-warn"}`}>
            {w.label}が{w.ratio >= 1 ? "上限に達しました。新しい処理は停止しています（既存データの閲覧・出力は可能）。" : `上限の${Math.floor(w.ratio * 100)}%に達しています。`}
            追加利用はプラン変更のお申し込みで対応します（無断で追加請求することはありません）。
          </div>
        ))}
        {children}
        <LegalFooter />
      </main>
    </div>
  );
}
