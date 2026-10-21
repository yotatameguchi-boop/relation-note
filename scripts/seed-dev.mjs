// ローカル開発用のデモデータ（本番では実行しない）。
// .env.local の DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD でオーナーアカウントを作り、サンプル団体を用意する。
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("ローカル以外では実行しません");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = process.env.DEV_LOGIN_EMAIL;
const password = process.env.DEV_LOGIN_PASSWORD;

const { data: list } = await admin.auth.admin.listUsers();
if (!list.users.some((u) => u.email === email)) {
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: "デモ オーナー" } });
  if (error) throw error;
}
const user = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: le } = await user.auth.signInWithPassword({ email, password });
if (le) throw le;

const must = (r) => { if (r.error) throw r.error; return r.data; };
// やり直せるよう、前回のデモ団体は消してから作る
await admin.from("organizations").delete().eq("name", "みどり川クリーン会（デモ）");
const org = must(await user.rpc("create_organization", { org_name: "みどり川クリーン会（デモ）" }));
const tags = must(await user.from("tags").insert(
  [["ボランティア", "#1f6f5c"], ["寄付者", "#b45309"], ["イベント参加者", "#2563eb"], ["協力企業担当者", "#7c3aed"]]
    .map(([name, color]) => ({ organization_id: org, name, color }))).select("id, name"));
const tag = Object.fromEntries(tags.map((t) => [t.name, t.id]));

const names = ["山田 太郎", "佐藤 花子", "鈴木 一郎", "高橋 美咲", "田中 健", "伊藤 さくら", "渡辺 翔", "中村 葵", "小林 大輔", "加藤 結衣", "吉田 蓮", "山本 陽菜"];
const regions = ["みどり市", "あおば町", "みどり市", "かわべ村"];
const people = [];
for (const [i, n] of names.entries()) {
  people.push(must(await user.rpc("create_person", { org, data: {
    full_name: n, region: regions[i % 4], emails: [`demo${i + 1}@example.org`], phones: i % 3 === 0 ? [`090-0000-00${String(i).padStart(2, "0")}`] : [],
    tag_ids: [i % 2 === 0 ? tag["ボランティア"] : tag["イベント参加者"], ...(i % 5 === 0 ? [tag["寄付者"]] : [])],
  } })));
}
const day = (d) => new Date(Date.now() - d * 86400000).toISOString();
const events = must(await user.from("events").insert([
  { organization_id: org, title: "河川敷クリーン作戦 春", starts_at: day(150), location: "みどり川河川敷", anonymous_count: 4 },
  { organization_id: org, title: "河川敷クリーン作戦 夏", starts_at: day(60), location: "みどり川河川敷", anonymous_count: 2 },
  { organization_id: org, title: "環境学習ワークショップ", starts_at: day(10), location: "あおば公民館", anonymous_count: 0 },
].map((e) => e)).select("id, title"));
const att = (e, idx, status = "attended") => idx.map((i) => ({ organization_id: org, event_id: events[e].id, person_id: people[i], status }));
must(await user.from("event_participations").insert([
  ...att(0, [0, 1, 2, 3, 4, 5]), ...att(0, [6], "absent"),
  ...att(1, [0, 1, 2, 7, 8]), ...att(1, [9], "cancelled"),
  ...att(2, [0, 3, 10]), ...att(2, [11], "applied"),
]));
const conn = must(await user.from("form_connections").insert({
  organization_id: org, name: "ボランティア募集フォーム", kind: "csv",
  field_mapping: { タイムスタンプ: "submitted_at", お名前: "full_name", メールアドレス: "email", 電話番号: "phone", お住まいの地域: "region", 参加の動機: "attr:参加の動機" },
  default_tag_ids: [tag["ボランティア"]],
}).select("id").single());
console.log(JSON.stringify({ org, connection: conn.id }));
