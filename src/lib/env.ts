// アプリの公開URL（招待リンク・外部フォームの受信URLに使う。サーバー側でのみ参照）
//   本番：NEXT_PUBLIC_APP_URL
//   Vercel のプレビュー：ブランチごとのURL（VERCEL_BRANCH_URL）
function appUrl() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  const host = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3080";
}

export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  appUrl: appUrl(),
};
