import Link from "next/link";
import { Logo } from "@/components/Logo";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { TermsNotice } from "@/components/TermsNotice";
import { LegalFooter } from "@/components/LegalFooter";
import { PRICING, yen } from "@/lib/legal";

async function createOrg(fd: FormData) {
  "use server";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_organization", { org_name: String(fd.get("name") ?? "") });
  if (error) redirect(`/orgs?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${data}`);
}

export default async function OrgsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("role, organizations!inner(id, name, status)")
    .eq("user_id", user.id);
  const { data: blocked } = await supabase.rpc("mfa_blocked_orgs") as { data: { id: string; name: string }[] | null };
  const orgs = (data ?? []).map((m) => ({ role: m.role as Role, ...(m.organizations as unknown as { id: string; name: string; status: string }) }));

  return (
    <div className="auth-wrap" style={{ maxWidth: 640 }}>
      <div className="auth-hero" style={{ textAlign: "left" }}><Logo size={36} wordSize={20} /></div>
      <div className="spread">
        <h1>組織を選ぶ</h1>
        <form action="/auth/signout" method="post"><button className="btn-secondary btn-small">ログアウト</button></form>
      </div>
      <p className="muted small">{user.email} でログイン中・<Link href="/account">アカウント設定（パスワード・二段階認証）</Link></p>
      {!!blocked?.length && (
        <div className="notice notice-warn">
          {blocked.map((b) => b.name).join("、")} では二段階認証が必須です。<Link href={`/account?mfa=required&next=${encodeURIComponent(`/orgs/${blocked[0].id}`)}#mfa`}>二段階認証を設定する</Link>と表示されます。
        </div>
      )}
      <TermsNotice userId={user.id} />
      {sp.error && <div className="notice notice-danger">{sp.error}</div>}
      <div className="card">
        {orgs.length === 0 && <p className="muted">所属している組織はまだありません。招待リンクを受け取るか、新しく組織を作成してください。</p>}
        {orgs.map((o) => (
          <div key={o.id} className="spread" style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <Link href={`/orgs/${o.id}`}><strong>{o.name}</strong></Link>
            <span className="row">
              {o.status !== "active" && <span className="badge badge-warn">{o.status === "suspended" ? "停止中（閲覧のみ）" : o.status}</span>}
              <span className="badge">{ROLE_LABEL[o.role]}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>新しい組織を作成</h2>
        <p className="small muted">作成したあなたがオーナーになります。{`最初の${PRICING.trialDays}日間は無料です。続けて使う場合は「料金・契約」から標準プラン（月払い ${yen(PRICING.monthly)}・税別）をお申し込みください。`}</p>
        <form action={createOrg} className="row">
          <input name="name" required maxLength={120} placeholder="組織名" style={{ flex: 1 }} />
          <button type="submit">作成</button>
        </form>
      </div>
      <LegalFooter />
    </div>
  );
}
