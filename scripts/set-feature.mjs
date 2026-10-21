// ローカル・検証環境用：団体の機能フラグを切り替える（本番の実データ団体では実行しない）
//   node scripts/set-feature.mjs <団体ID または 団体名> <partner_sharing|photo_pipeline_v2|photo_tiling> <on|off>
import { createClient } from "@supabase/supabase-js";

// ENV_FILE で読み込む設定を切り替えられる（クラウドのデモ環境に入れる場合は .env.remote ＋ ALLOW_NON_LOCAL=1）
process.loadEnvFile(process.env.ENV_FILE ?? ".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url) && process.env.ALLOW_NON_LOCAL !== "1") {
  throw new Error("ローカル以外では実行しません（検証環境で使う場合は ALLOW_NON_LOCAL=1）");
}
const [orgArg, flag, value] = process.argv.slice(2);
if (!orgArg || !["partner_sharing", "photo_pipeline_v2", "photo_tiling"].includes(flag) || !["on", "off"].includes(value)) {
  console.error("usage: node scripts/set-feature.mjs <org id|name> <partner_sharing|photo_pipeline_v2|photo_tiling> <on|off>");
  process.exit(1);
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const isId = /^[0-9a-f-]{36}$/.test(orgArg);
const { data: org, error } = await db.from("organizations").select("id, name").eq(isId ? "id" : "name", orgArg).single();
if (error) throw error;
const { error: e2 } = await db.from("organization_features").upsert({ organization_id: org.id, [flag]: value === "on", updated_at: new Date().toISOString() });
if (e2) throw e2;
console.log(`${org.name}: ${flag} = ${value}`);
