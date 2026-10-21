import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// 確認メールのリンクの受け口。
//   ?token_hash=...&type=email … メールのテンプレートから（別の端末・ブラウザで開いても確認できる）
//   ?code=...                  … PKCE（同じブラウザで開いた場合）
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const supabase = await createClient();
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");
  let ok = false;
  if (tokenHash && type) {
    ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  } else if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }
  const dest = url.clone();
  dest.search = "";
  if (ok) {
    dest.pathname = "/orgs";
    dest.searchParams.set("ok", "メールアドレスを確認しました。");
  } else {
    dest.pathname = "/login";
    dest.searchParams.set("error", "確認リンクが無効か、期限切れです。ログイン画面から確認メールを再送してください。");
  }
  return NextResponse.redirect(dest);
}
