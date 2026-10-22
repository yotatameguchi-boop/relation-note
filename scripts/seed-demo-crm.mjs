// デモ用：顧客管理の機能（追加項目・企業・やりとり・タスク・メール配信の下書き・Tally の連携）のサンプル
// scripts/seed-dev.mjs と seed-demo-features.mjs の後に実行する。本番の実データでは実行しない。
//   ENV_FILE=.env.remote ALLOW_NON_LOCAL=1 node scripts/seed-demo-crm.mjs
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(process.env.ENV_FILE ?? ".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url) && process.env.ALLOW_NON_LOCAL !== "1") {
  throw new Error("ローカル以外では実行しません（デモ環境に入れる場合は ALLOW_NON_LOCAL=1）");
}
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const user = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: login, error: le } = await user.auth.signInWithPassword({ email: process.env.DEV_LOGIN_EMAIL, password: process.env.DEV_LOGIN_PASSWORD });
if (le) throw le;
const me = login.user.id;
const must = (r) => { if (r.error) throw r.error; return r.data; };

const org = must(await admin.from("organizations").select("id").eq("name", "みどり川クリーン会（デモ）").single()).id;
must(await user.from("organizations").update({ email_sender_info: "〒000-0000 みどり市中央1-1（デモの住所です）／ info@example.org" }).eq("id", org));

// 追加項目
await admin.from("custom_field_definitions").delete().eq("organization_id", org);
must(await user.from("custom_field_definitions").insert([
  { organization_id: org, entity: "person", key: "member_type", label: "会員種別", field_type: "select", options: ["正会員", "賛助会員", "学生会員"], position: 1 },
  { organization_id: org, entity: "person", key: "joined_on", label: "入会日", field_type: "date", options: [], position: 2 },
  { organization_id: org, entity: "person", key: "newsletter", label: "会報の送付", field_type: "checkbox", options: [], position: 3 },
  { organization_id: org, entity: "company", key: "employees", label: "従業員数", field_type: "number", options: [], position: 1 },
  { organization_id: org, entity: "company", key: "support", label: "支援の種類", field_type: "multi_select", options: ["協賛金", "物品", "社員ボランティア"], position: 2 },
]));
const pid = async (name) => must(await user.from("people").select("id").eq("organization_id", org).eq("full_name", name).single()).id;
const taro = await pid("山田 太郎");
const hanako = await pid("佐藤 花子");
must(await user.rpc("set_custom_fields", { p_entity: "person", record_id: taro, vals: { member_type: "正会員", joined_on: "2024-04-01", newsletter: true } }));
must(await user.rpc("set_custom_fields", { p_entity: "person", record_id: hanako, vals: { member_type: "賛助会員", joined_on: "2025-09-15" } }));

// 企業と担当者
await admin.from("companies").delete().eq("organization_id", org);
const c1 = must(await user.rpc("create_company", { org, data: { name: "株式会社みどり建設", industry: "建設業", phone: "03-0000-0001",
  website: "https://example.com", custom_fields: { employees: "120", support: ["協賛金", "社員ボランティア"] } } }));
const c2 = must(await user.rpc("create_company", { org, data: { name: "あおば信用金庫", industry: "金融", custom_fields: { employees: "300", support: ["協賛金"] } } }));
must(await user.from("person_company_links").insert([
  { organization_id: org, person_id: taro, company_id: c1, department: "総務部", title: "課長", is_primary: true },
  { organization_id: org, person_id: hanako, company_id: c2, department: "地域貢献室", is_primary: true },
]));

// やりとり（手で記録したものだけ入れ直す。一斉配信の送信記録は残す）
await admin.from("interactions").delete().eq("organization_id", org).is("email_recipient_id", null);
const day = (d) => new Date(Date.now() - d * 86400e3).toISOString();
must(await user.from("interactions").insert([
  { organization_id: org, kind: "meeting", direction: "outbound", occurred_at: day(12), person_id: taro, company_id: c1,
    subject: "秋の清掃活動への協賛のご相談", body: "協賛金と社員ボランティア10名の参加を前向きに検討いただけることになった。", created_by: me },
  { organization_id: org, kind: "call", direction: "inbound", occurred_at: day(5), person_id: taro,
    subject: "社員ボランティアの人数の連絡", body: "12名で参加とのこと。集合場所を案内する。", created_by: me },
  { organization_id: org, kind: "email", direction: "outbound", occurred_at: day(3), company_id: c2,
    subject: "協賛のお礼", body: "ご協賛へのお礼と、活動報告書の送付予定をお伝えした。", created_by: me },
]));

// タスク
const dateStr = (d) => new Date(Date.now() + 9 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);
await admin.from("tasks").delete().eq("organization_id", org);
must(await user.from("tasks").insert([
  { organization_id: org, title: "協賛の申込書を送る", due_date: dateStr(-1), priority: "high", assignee_id: me, person_id: taro, company_id: c1, created_by: me },
  { organization_id: org, title: "集合場所の地図を送る", due_date: dateStr(0), priority: "normal", assignee_id: me, person_id: taro, created_by: me },
  { organization_id: org, title: "活動報告書を送る", due_date: dateStr(7), priority: "normal", assignee_id: me, company_id: c2, created_by: me },
]));

// メール配信の下書き（送信はしない）
await admin.from("email_campaigns").delete().eq("organization_id", org).eq("status", "draft");
const vol = must(await user.from("tags").select("id").eq("organization_id", org).eq("name", "ボランティア").single()).id;
must(await user.from("email_campaigns").insert({ organization_id: org, name: "11月の清掃活動のご案内", created_by: me,
  subject: "【{{組織名}}】11月の河川敷清掃のご案内",
  body_text: "{{氏名}} 様\n\nいつもご協力ありがとうございます。{{組織名}}です。\n11月15日（土）9時から、みどり川河川敷で清掃活動を行います。\n\nご参加をお待ちしています。",
  audience: { tag_ids: [vol], match: "any", exclude_tag_ids: [] } }));

// Tally の連携（受け口のみ。秘密は画面から発行する）
await admin.from("form_connections").delete().eq("organization_id", org).in("kind", ["tally", "google_forms"]);
must(await user.from("form_connections").insert([
  { organization_id: org, name: "Tally：イベント申込フォーム", kind: "tally" },
  { organization_id: org, name: "Google フォーム：ボランティア募集", kind: "google_forms" },
]));
console.log(JSON.stringify({ org, companies: [c1, c2] }));
