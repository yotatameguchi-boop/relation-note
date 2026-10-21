import { Logo } from "@/components/Logo";
import { signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string; mode?: string }> }) {
  const sp = await searchParams;
  const signup = sp.mode === "signup";
  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <h1 style={{ margin: 0 }}><Logo size={44} wordSize={26} /></h1>
        <p className="muted" style={{ marginTop: 8 }}>NPO向け 顧客・関係人口管理</p>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{signup ? "アカウント作成" : "ログイン"}</h2>
        {sp.error && <div className="notice notice-danger">{sp.error}</div>}
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
            <input id="password" name="password" type="password" required minLength={8}
              autoComplete={signup ? "new-password" : "current-password"} />
          </div>
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
    </div>
  );
}
