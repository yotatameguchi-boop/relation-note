"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { TERMS_VERSION } from "@/lib/legal";
import { passwordProblem } from "@/lib/password";

function safeNext(v: FormDataEntryValue | null) {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/orgs";
}

// 確認メールのリンクの戻り先（本番・プレビュー・ローカルでそれぞれ自分のURL）
const callbackUrl = () => `${env.appUrl}/auth/callback`;

export async function signIn(fd: FormData) {
  const email = String(fd.get("email") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: String(fd.get("password") ?? "") });
  if (error?.code === "email_not_confirmed") {
    redirect(`/login?unconfirmed=1&email=${encodeURIComponent(email)}&error=${encodeURIComponent("メールアドレスの確認が済んでいません。届いたメールのリンクを開いてください。")}`);
  }
  if (error) redirect(`/login?error=${encodeURIComponent(error.code === "over_request_rate_limit" ? "ログインの試行が多すぎます。しばらく待ってからお試しください。" : "メールアドレスかパスワードが違います。")}`);
  // 二段階認証を設定している人は、続けて認証アプリのコードを入力する
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") redirect(`/login/mfa?next=${encodeURIComponent(safeNext(fd.get("next")))}`);
  redirect(safeNext(fd.get("next")));
}

export async function signUp(fd: FormData) {
  const email = String(fd.get("email") ?? "");
  if (fd.get("agree") !== "on") {
    redirect(`/login?mode=signup&error=${encodeURIComponent("利用規約とプライバシーポリシーへの同意が必要です。")}`);
  }
  const weak = passwordProblem(String(fd.get("password") ?? ""), email);
  if (weak) redirect(`/login?mode=signup&error=${encodeURIComponent(weak)}`);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password: String(fd.get("password") ?? ""),
    options: {
      data: { display_name: String(fd.get("display_name") ?? ""), terms_version: TERMS_VERSION },
      emailRedirectTo: callbackUrl(),
    },
  });
  if (error) {
    const msg = error.code === "over_email_send_rate_limit"
      ? "確認メールの送信が混み合っています。しばらくしてからもう一度お試しください。"
      : error.code === "weak_password"
      ? "パスワードが条件を満たしていません。10文字以上で、英字と数字を両方含めてください。"
      : "作成できませんでした。入力内容を確認してください。";
    redirect(`/login?mode=signup&error=${encodeURIComponent(msg)}`);
  }
  if (!data.session) {
    redirect(`/login?sent=1&email=${encodeURIComponent(email)}`);
  }
  redirect(safeNext(fd.get("next")));
}

export async function resendConfirmation(fd: FormData) {
  const email = String(fd.get("email") ?? "");
  const supabase = await createClient();
  await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: callbackUrl() } });
  // 登録の有無を推測されないよう、結果に関わらず同じ表示にする
  redirect(`/login?sent=1&email=${encodeURIComponent(email)}`);
}
