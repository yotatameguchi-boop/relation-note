// 運営者用：認証アプリの端末をすべて失ったスタッフの二段階認証を解除する。
// 必ず本人確認（組織の管理者からの依頼＋本人への連絡）を済ませてから実行し、実行したことを記録しておく。
//   ENV_FILE=.env.remote node scripts/reset-mfa.mjs <メールアドレス>
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(process.env.ENV_FILE ?? ".env.local");
const email = (process.argv[2] ?? "").toLowerCase();
if (!email.includes("@")) throw new Error("usage: reset-mfa.mjs <email>");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: u } = await admin.from("users").select("id").eq("email", email).maybeSingle();
if (!u) throw new Error("そのメールアドレスのスタッフはいません");
const { data } = await admin.auth.admin.mfa.listFactors({ userId: u.id });
for (const f of data?.factors ?? []) {
  const { error } = await admin.auth.admin.mfa.deleteFactor({ userId: u.id, id: f.id });
  if (error) throw error;
}
console.log(`${email}：${data?.factors?.length ?? 0}件の認証アプリを解除しました。次のログインで設定し直してもらってください。`);
