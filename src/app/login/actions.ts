"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { TERMS_VERSION } from "@/lib/legal";

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
  if (error) redirect(`/login?error=${encodeURIComponent("メールアドレスかパスワードが違います。")}`);
  redirect(safeNext(fd.get("next")));
}

export async function signUp(fd: FormData) {
  const email = String(fd.get("email") ?? "");
  if (fd.get("agree") !== "on") {
    redirect(`/login?mode=signup&error=${encodeURIComponent("利用規約とプライバシーポリシーへの同意が必要です。")}`);
  }
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
