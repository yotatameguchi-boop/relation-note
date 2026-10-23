// 負荷試験：本番ビルド（next start）に、ログイン済みのスタッフとして主要画面を同時に要求し、応答時間を測る。
//   BASE=http://localhost:3090 node scripts/loadtest.mjs [同時数の並び=1,10,30] [各段階の秒数=30]
//   本番のデモ組織に軽くかける場合：ENV_FILE=.env.remote BASE=https://relationnote.vercel.app LOADTEST_ORG=<組織ID>
//     LOADTEST_EMAIL/LOADTEST_PASSWORD 未設定なら DEV_LOGIN_* を使う
// 目標：同時10人で 95% の要求が2秒以内（設計書の非機能要件）。結果は JSON で標準出力へ。
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(process.env.ENV_FILE ?? ".env.local");
const BASE = process.env.BASE ?? "http://localhost:3090";
const levels = (process.argv[2] ?? "1,10,30").split(",").map(Number);
const seconds = Number(process.argv[3] ?? 30);
const org = process.env.LOADTEST_ORG;
if (!org) throw new Error("先に node scripts/loadtest-setup.mjs を実行してください");

// ログインして、ブラウザと同じ形式のセッション Cookie を作る
const jar = new Map();
const ssr = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value)) },
});
const { error } = await ssr.auth.signInWithPassword({
  email: process.env.LOADTEST_EMAIL ?? process.env.DEV_LOGIN_EMAIL, password: process.env.LOADTEST_PASSWORD ?? process.env.DEV_LOGIN_PASSWORD });
if (error) throw error;
const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

// 試験で開く人物・タグ（実在のIDを使う）
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let { data: people } = await db.from("people").select("id").eq("organization_id", org).gt("attendance_count", 1).limit(200);
if (!people?.length) ({ data: people } = await db.from("people").select("id").eq("organization_id", org).limit(200));
const { data: tags } = await db.from("tags").select("id").eq("organization_id", org).limit(3);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const NAMES = ["佐藤", "鈴木 花子", "高橋", "田中 健", "中村", "lt-1", "090-0000"];

// 実際の利用に近い比率（一覧・検索・詳細が中心）
const SCENARIOS = [
  { name: "ダッシュボード", expect: "<h1>ダッシュボード", w: 3, path: () => `/orgs/${org}` },
  { name: "人物一覧", expect: "<h1>人物一覧", w: 4, path: () => `/orgs/${org}/people` },
  { name: "人物検索", expect: "<h1>人物一覧", w: 5, path: () => `/orgs/${org}/people?q=${encodeURIComponent(pick(NAMES))}` },
  { name: "人物一覧（参加回数順・深いページ）", expect: "<h1>人物一覧", w: 2, path: () => `/orgs/${org}/people?sort=attendance_count&page=${1 + Math.floor(Math.random() * 200)}` },
  { name: "人物一覧（タグ絞り込み）", expect: "<h1>人物一覧", w: 2, path: () => `/orgs/${org}/people?tag=${pick(tags).id}` },
  { name: "人物の詳細", expect: ">タイムライン</h2>", w: 5, path: () => `/orgs/${org}/people/${pick(people).id}` },
  { name: "企業検索", expect: "<h1>企業", w: 2, path: () => `/orgs/${org}/companies?q=${encodeURIComponent("負荷0" + Math.floor(Math.random() * 10))}` },
  { name: "タスク", expect: "<h1>タスク", w: 2, path: () => `/orgs/${org}/tasks` },
  { name: "重複候補", expect: "<h1>重複候補", w: 1, path: () => `/orgs/${org}/people/duplicates` },
  { name: "操作履歴", expect: "<h1>操作履歴", w: 1, path: () => `/orgs/${org}/audit` },
];
const bag = SCENARIOS.flatMap((s) => Array(s.w).fill(s));

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};

async function hit(s) {
  const t = performance.now();
  try {
    const r = await fetch(BASE + s.path(), { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    // 200 以外・転送・見出しが出ていない（エラー画面）ものは失敗
    const ok = r.status === 200 && body.includes(s.expect);
    return { s: s.name, ms: performance.now() - t, ok, status: r.status };
  } catch (e) {
    return { s: s.name, ms: performance.now() - t, ok: false, status: e.name };
  }
}

// 温める（初回のコンパイル・接続確立を計測から外す）
for (const s of SCENARIOS) await hit(s);

const results = [];
for (const vus of levels) {
  const samples = [];
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: vus }, async () => {
    while (Date.now() < end) samples.push(await hit(pick(bag)));
  }));
  const all = samples.map((x) => x.ms);
  const by = {};
  for (const s of SCENARIOS) {
    const xs = samples.filter((x) => x.s === s.name);
    by[s.name] = { n: xs.length, p50: pct(xs.map((x) => x.ms), 50), p95: pct(xs.map((x) => x.ms), 95), errors: xs.filter((x) => !x.ok).length };
  }
  const row = {
    vus, seconds, requests: samples.length, rps: +(samples.length / seconds).toFixed(1),
    p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: Math.round(Math.max(...all)),
    within2s: +(all.filter((x) => x <= 2000).length / all.length * 100).toFixed(1),
    errors: samples.filter((x) => !x.ok).length,
    errorKinds: [...new Set(samples.filter((x) => !x.ok).map((x) => `${x.s}:${x.status}`))].slice(0, 5),
    by,
  };
  results.push(row);
  console.error(`同時${vus}：${row.requests}件 ${row.rps}件/秒 p50 ${row.p50}ms p95 ${row.p95}ms p99 ${row.p99}ms 2秒以内 ${row.within2s}% 失敗 ${row.errors}`);
}
console.log(JSON.stringify({ base: BASE, org, at: new Date().toISOString(), results }, null, 1));
