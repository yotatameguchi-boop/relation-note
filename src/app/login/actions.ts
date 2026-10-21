"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function safeNext(v: FormDataEntryValue | null) {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/orgs";
}

export async function signIn(fd: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(fd.get("email") ?? ""),
    password: String(fd.get("password") ?? ""),
  });
  if (error) redirect(`/login?error=${encodeURIComponent("メールアドレスかパスワードが違います。")}`);
  redirect(safeNext(fd.get("next")));
}

export async function signUp(fd: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: String(fd.get("email") ?? ""),
    password: String(fd.get("password") ?? ""),
    options: { data: { display_name: String(fd.get("display_name") ?? "") } },
  });
  if (error) redirect(`/login?mode=signup&error=${encodeURIComponent("作成できませんでした: " + error.message)}`);
  if (!data.session) redirect(`/login?error=${encodeURIComponent("確認メールを送信しました。メール内のリンクから登録を完了してください。")}`);
  redirect(safeNext(fd.get("next")));
}
