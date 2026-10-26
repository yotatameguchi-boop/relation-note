import { Logo } from "@/components/Logo";
import { LegalFooter } from "@/components/LegalFooter";
import { PASSWORD_HINT, PASSWORD_MIN } from "@/lib/password";
import { resendConfirmation, signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string; mode?: string; sent?: string; unconfirmed?: string; email?: string }> }) {
  const sp = await searchParams;
  const signup = sp.mode === "signup";
  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <h1 style={{ margin: 0 }}><Logo size={44} wordSize={26} /></h1>
        <p className="muted" style={{ marginTop: 8 }}>顧客・関係者のつながりをまとめて管理</p>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{signup ? "アカウント作成" : "ログイン"}</h2>
        {sp.sent && (
          <div className="notice notice-ok">
            {sp.email ? `${sp.email} に` : ""}確認メールを送信しました。メール内のリンクを開くと登録が完了します。
            届かない場合は迷惑メールフォルダもご確認ください。
          </div>
        )}
        {sp.error && <div className="notice notice-danger">{sp.error}</div>}
        {(sp.unconfirmed || sp.sent) && sp.email && (
          <form action={resendConfirmation} style={{ marginBottom: 12 }}>
            <input type="hidden" name="email" value={sp.email} />
            <button className="btn-secondary btn-small">確認メールを再送する</button>
          </form>
        )}
        <form action={signup ? signUp : signIn}>
          <input type="hidden" name="next" value={sp.next ?? ""} />
          {signup && (
            <div className="field">
              <label htmlFor="display_name">表示名</label>
              <input id="display_name" name="display_name" required maxLength={60} />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">メールアドレス</label>
            <input id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="password">パスワード</label>
            <input id="password" name="password" type="password" required minLength={signup ? PASSWORD_MIN : 1} maxLength={72}
              autoComplete={signup ? "new-password" : "current-password"} aria-describedby={signup ? "pw-hint" : undefined} />
            {signup && <div id="pw-hint" className="small muted" style={{ marginTop: 4 }}>{PASSWORD_HINT}</div>}
          </div>
          {signup && (
            <label className="row small" style={{ gap: 8, margin: "4px 0 14px", alignItems: "flex-start" }}>
              <input type="checkbox" name="agree" required style={{ width: "auto", marginTop: 4 }} />
              <span><a href="/terms" target="_blank">利用規約</a>と<a href="/privacy" target="_blank">プライバシーポリシー</a>に同意します</span>
            </label>
          )}
          <button type="submit">{signup ? "作成してログイン" : "ログイン"}</button>
        </form>
        <p className="small" style={{ marginTop: 14 }}>
          {signup ? (
            <a href={`/login${sp.next ? `?next=${encodeURIComponent(sp.next)}` : ""}`}>ログインに戻る</a>
          ) : (
            <a href={`/login?mode=signup${sp.next ? `&next=${encodeURIComponent(sp.next)}` : ""}`}>スタッフアカウントを作成</a>
          )}
        </p>
      </div>
      <LegalFooter />
    </div>
  );
}
