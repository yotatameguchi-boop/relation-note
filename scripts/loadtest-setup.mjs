// 負荷試験の準備：専用のスタッフと組織を作り、大量データを入れる（手元のDB専用）
//   node scripts/loadtest-setup.mjs [人数=100000]
// ログイン情報は .env.local に LOADTEST_EMAIL / LOADTEST_PASSWORD / LOADTEST_ORG として追記する。
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("手元のDB専用です");
const n = Number(process.argv[2] ?? 100000);
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let email = process.env.LOADTEST_EMAIL, password = process.env.LOADTEST_PASSWORD, org = process.env.LOADTEST_ORG;
if (!email) {
  email = "loadtest@npo-crm.test";
  password = randomBytes(18).toString("base64url");
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: "負荷試験", terms_version: "2026-10-25" } });
  if (error) throw error;
  const c = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email, password });
  const { data, error: e2 } = await c.rpc("create_organization", { org_name: "負荷試験組織" });
  if (e2) throw e2;
  org = data;
  appendFileSync(".env.local", `\n# 負荷試験（scripts/loadtest-setup.mjs が作成）\nLOADTEST_EMAIL=${email}\nLOADTEST_PASSWORD=${password}\nLOADTEST_ORG=${org}\n`);
}
const { data: u } = await admin.from("users").select("id").eq("email", email).single();
const t = Date.now();
execFileSync("psql", ["postgresql://postgres:postgres@127.0.0.1:55622/postgres", "-q", "-v", `org=${org}`, "-v", `owner=${u.id}`, "-v", `n=${n}`,
  "-f", "scripts/loadtest-seed.sql"], { stdio: "inherit" });
console.log(`投入 ${((Date.now() - t) / 1000).toFixed(0)}秒 org=${org}`);
