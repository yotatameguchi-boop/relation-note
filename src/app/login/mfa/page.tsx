import { redirect } from "next/navigation";
import { Logo } from "@/components/Logo";
import { LegalFooter } from "@/components/LegalFooter";
import { createClient } from "@/lib/supabase/server";

function safeNext(v: unknown) {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/orgs";
}

async function verify(fd: FormData) {
  "use server";
  const next = safeNext(fd.get("next"));
  const code = String(fd.get("code") ?? "").replace(/\s/g, "");
  const supabase = await createClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp.find((f) => f.status === "verified" && f.id === String(fd.get("factor") ?? "")) ?? factors?.totp.find((f) => f.status === "verified");
  if (!factor) redirect(next);
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor!.id, code });
  if (error) {
    const msg = error.code === "over_request_rate_limit" || error.status === 429
      ? "試行が多すぎます。しばらく待ってからお試しください。"
      : "コードが違うか、有効期限が切れています。認証アプリに表示されている最新のコードを入力してください。";
    redirect(`/login/mfa?next=${encodeURIComponent(next)}&error=${encodeURIComponent(msg)}`);
  }
  redirect(next);
}

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) redirect("/login");
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = factors?.totp.filter((f) => f.status === "verified") ?? [];
  if (!verified.length) redirect(safeNext(sp.next));
  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <h1 style={{ margin: 0 }}><Logo size={44} wordSize={26} /></h1>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>二段階認証</h2>
        <p className="small">認証アプリ（Google Authenticator・Microsoft Authenticator など）に表示されている6桁のコードを入力してください。</p>
        {sp.error && <div className="notice notice-danger" role="alert">{sp.error}</div>}
        <form action={verify}>
          <input type="hidden" name="next" value={safeNext(sp.next)} />
          {verified.length > 1 && (
            <div className="field">
              <label htmlFor="factor">使う認証アプリ</label>
              <select id="factor" name="factor">{verified.map((f) => <option key={f.id} value={f.id}>{f.friendly_name ?? "認証アプリ"}</option>)}</select>
            </div>
          )}
          <div className="field">
            <label htmlFor="code">確認コード</label>
            <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus
              style={{ fontSize: 22, letterSpacing: ".3em", textAlign: "center" }} />
          </div>
          <button type="submit">確認してログイン</button>
        </form>
        <p className="small muted" style={{ marginTop: 14 }}>
          スマートフォンを紛失した場合は、組織の管理者を通じて運営者にご連絡ください。ご本人の確認後に二段階認証を解除します。
        </p>
        <form action="/auth/signout" method="post"><button className="link-btn small">別のアカウントでログインする</button></form>
      </div>
      <LegalFooter />
    </div>
  );
}
