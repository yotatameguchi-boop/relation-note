import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { Logo } from "@/components/Logo";
import { LegalFooter } from "@/components/LegalFooter";
import { MfaSetup } from "@/components/MfaSetup";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { PASSWORD_HINT, PASSWORD_MIN, passwordProblem } from "@/lib/password";

async function changePassword(fd: FormData) {
  "use server";
  const user = await requireUser();
  const current = String(fd.get("current") ?? "");
  const next = String(fd.get("next") ?? "");
  const back = (k: "ok" | "error", m: string) => redirect(`/account?${k}=${encodeURIComponent(m)}#password`);
  if (next !== String(fd.get("confirm") ?? "")) back("error", "新しいパスワードが確認用と一致しません。");
  const weak = passwordProblem(next, user.email ?? undefined);
  if (weak) back("error", weak);
  if (next === current) back("error", "今と同じパスワードは使えません。");
  // 今のパスワードを確かめる（今のログインを置き換えないよう、別の使い捨ての接続で確認する）
  const probe = createPlainClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: wrong } = await probe.auth.signInWithPassword({ email: user.email!, password: current });
  if (wrong) back("error", "今のパスワードが違います。");
  await probe.auth.signOut({ scope: "local" });
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) back("error", error.code === "weak_password" ? PASSWORD_HINT : error.code === "insufficient_aal" ? "二段階認証のコードを入力してログインし直してから変更してください。" : "変更できませんでした。");
  back("ok", "パスワードを変更しました。");
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; mfa?: string; next?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const supabase = await createClient();
  const [{ data: factors }, { data: blocked }, { data: aal }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.rpc("mfa_blocked_orgs"),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  const verified = (factors?.totp ?? []).filter((f) => f.status === "verified");
  // 必須の組織に入るため設定しに来た人は、設定後に元の画面へ戻す
  if (sp.next && verified.length && aal?.currentLevel === "aal2" && sp.mfa === "required") {
    const n = sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/orgs";
    redirect(n);
  }
  const { count: requiredCount } = await supabase.from("organizations").select("id", { count: "exact", head: true }).eq("require_mfa", true);
  const required = (requiredCount ?? 0) > 0 || !!(blocked as unknown[] | null)?.length;

  return (
    <div className="auth-wrap" style={{ maxWidth: 720 }}>
      <div className="auth-hero" style={{ textAlign: "left" }}><Link href="/orgs" aria-label="組織の選択へ"><Logo size={36} wordSize={20} /></Link></div>
      <div className="spread">
        <h1>アカウント設定</h1>
        <Link href="/orgs" className="small">組織の選択へ戻る</Link>
      </div>
      <p className="muted small">{user.email} でログイン中</p>
      <Flash sp={sp} />
      {sp.mfa === "required" && !verified.length && (
        <div className="notice notice-warn">この組織では二段階認証が必須です。下で設定すると、組織の画面に入れるようになります。</div>
      )}

      <section className="card" id="mfa">
        <h2 style={{ marginTop: 0 }}>二段階認証</h2>
        <p className="small muted">ログインのとき、パスワードに加えてスマートフォンの認証アプリに表示される6桁のコードを入力します。</p>
        <MfaSetup factors={verified.map((f) => ({ id: f.id, friendly_name: f.friendly_name, created_at: f.created_at }))} required={required} />
        <p className="small muted" style={{ marginBottom: 0 }}>
          機種変更や紛失に備えて、予備の端末も登録しておくと安心です。すべての端末を失った場合は、組織の管理者を通じて運営者にご連絡ください。
        </p>
      </section>

      <section className="card" id="password">
        <h2 style={{ marginTop: 0 }}>パスワードの変更</h2>
        <form action={changePassword}>
          <div className="field">
            <label htmlFor="current">今のパスワード</label>
            <input id="current" name="current" type="password" required autoComplete="current-password" />
          </div>
          <div className="field">
            <label htmlFor="next">新しいパスワード</label>
            <input id="next" name="next" type="password" required minLength={PASSWORD_MIN} maxLength={72} autoComplete="new-password" aria-describedby="pw-hint" />
            <div id="pw-hint" className="small muted" style={{ marginTop: 4 }}>{PASSWORD_HINT}他のサービスと同じパスワードは避けてください。</div>
          </div>
          <div className="field">
            <label htmlFor="confirm">新しいパスワード（確認）</label>
            <input id="confirm" name="confirm" type="password" required minLength={PASSWORD_MIN} maxLength={72} autoComplete="new-password" />
          </div>
          <button>変更する</button>
        </form>
      </section>
      <LegalFooter />
    </div>
  );
}
