import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * RLS を迂回するサービスロールのクライアント。ブラウザへは絶対に渡さない。
 * 使う前に、呼び出し側で「ログイン中スタッフがその団体のどの権限を持つか」を必ず確認すること。
 */
export function createAdminClient() {
  if (!env.supabaseServiceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
