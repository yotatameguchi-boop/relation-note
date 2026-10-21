// 写真の人数カウントの評価
//
//   合成データ（アルゴリズムの比較。実写真の精度ではない）
//     node scripts/eval-counting.mts synthetic [--out eval/reports/synthetic.md]
//
//   実写真（ローカル環境で、実際の人物検出APIを設定したワーカーを使う）
//     node scripts/eval-counting.mts real eval/dataset.json [--out eval/reports/real.md]
//       - 写真をローカルの評価用組織へアップロードし、本番と同じ前処理・ワーカーで解析する
//       - DETECTOR=mock のワーカーでは実行しない（--allow-mock で動作確認だけはできるが、精度の数値として扱わない）
//
//   しきい値の調整（保存済みの検出枠を使うので外部APIを呼ばない）
//     node scripts/eval-counting.mts sweep <評価用組織ID> eval/dataset.json
//       - split が "tune" の写真だけでしきい値を選び、"test" の写真で評価する
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { suppressDuplicates, DEFAULT_SETTINGS, type CountSettings, type RawDetection } from "../supabase/functions/_shared/counting.ts";

type Row = { id: string; split: string; tags: string[]; truth: number; estimate: number; raw?: number; ms?: number; calls?: number; review_seconds?: number | null };

function summarize(rows: Row[]) {
  const n = rows.length;
  if (!n) return null;
  const err = rows.map((r) => r.estimate - r.truth);
  const mae = err.reduce((s, e) => s + Math.abs(e), 0) / n;
  const bias = err.reduce((s, e) => s + e, 0) / n;
  const over = err.filter((e) => e > 0).length;
  const under = err.filter((e) => e < 0).length;
  const exact = err.filter((e) => e === 0).length;
  const avg = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === "number");
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  return { n, mae, bias, over, under, exact, ms: avg(rows.map((r) => r.ms)), calls: avg(rows.map((r) => r.calls)), review: avg(rows.map((r) => r.review_seconds)) };
}

function table(groups: [string, Row[]][]) {
  const lines = ["| 区分 | 枚数 | 平均絶対誤差 | 平均誤差（＋は過大） | 過大 | 過小 | 一致 | 平均処理時間 | 平均API呼び出し | 平均修正時間 |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const [name, rows] of groups) {
    const s = summarize(rows);
    if (!s) continue;
    const f = (x: number | null, d = 2) => (x == null ? "—" : x.toFixed(d));
    lines.push(`| ${name} | ${s.n} | ${f(s.mae)} | ${f(s.bias)} | ${s.over} | ${s.under} | ${s.exact} | ${s.ms == null ? "—" : `${f(s.ms / 1000, 1)}秒`} | ${f(s.calls, 1)} | ${s.review == null ? "—" : `${f(s.review, 0)}秒`} |`);
  }
  return lines.join("\n");
}

function byTag(rows: Row[]): [string, Row[]][] {
  const tags = [...new Set(rows.flatMap((r) => r.tags))].sort();
  return [["全体", rows], ...tags.map((t) => [t, rows.filter((r) => r.tags.includes(t))] as [string, Row[]])];
}

function write(out: string | undefined, text: string) {
  console.log(text);
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, text);
    console.error(`\n→ ${out}`);
  }
}

// ------------------------------------------------------------
// 合成データ：既知の正解枠に、検出APIで起きがちな誤り（見逃し・重複・誤検出・スコアのばらつき）を乗せる
// ------------------------------------------------------------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function synthetic(out?: string) {
  const r = rng(20261022);
  const scenes: { tags: string[]; truth: { x: number; y: number; w: number; h: number }[] }[] = [];
  const make = (tag: string, count: () => number, size: () => number, spread: number) => {
    for (let i = 0; i < 60; i++) {
      const n = count();
      const truth = Array.from({ length: n }, (_, k) => {
        const w = size();
        const h = w * 2.4;
        const x = Math.min(1 - w, (k / Math.max(1, n)) * spread + r() * (1 - spread) * 0.9);
        return { x, y: Math.min(1 - h, 0.2 + r() * 0.4), w, h };
      });
      scenes.push({ tags: [tag, i < 30 ? "tune" : "test"], truth });
    }
  };
  make("少人数", () => 1 + Math.floor(r() * 5), () => 0.08 + r() * 0.06, 0.9);
  make("密集・重なり", () => 15 + Math.floor(r() * 25), () => 0.05 + r() * 0.03, 0.95);
  make("小さく写った人物", () => 5 + Math.floor(r() * 15), () => 0.015 + r() * 0.02, 0.9);

  const simulate = (truth: { x: number; y: number; w: number; h: number }[], tag: string): RawDetection[] => {
    const miss = tag === "小さく写った人物" ? 0.25 : tag === "密集・重なり" ? 0.12 : 0.03;
    const dets: RawDetection[] = [];
    for (const t of truth) {
      if (r() < miss) continue;
      const score = 55 + r() * 44;
      dets.push({ ...t, score, source: "full" });
      if (r() < 0.15) {
        // 同じ人物への重複検出（少しずれた枠）
        const j = () => (r() - 0.5) * t.w * 0.15;
        dets.push({ x: t.x + j(), y: t.y + j(), w: t.w * (0.92 + r() * 0.1), h: t.h * (0.92 + r() * 0.1), score: score - r() * 15, source: "full" });
      }
    }
    if (r() < 0.2) dets.push({ x: r() * 0.8, y: r() * 0.6, w: 0.05, h: 0.1, score: 50 + r() * 25, source: "full" });
    return dets;
  };

  const simulated = scenes.map((s) => ({ ...s, dets: simulate(s.truth, s.tags[0]) }));
  const rowsWith = (f: (dets: RawDetection[]) => number): Row[] => simulated.map((s, i) => ({
    id: `s${i}`, split: s.tags[1], tags: [s.tags[0]], truth: s.truth.length, estimate: f(s.dets) }));
  const rawRows = rowsWith((d) => d.filter((x) => x.score >= DEFAULT_SETTINGS.min_score).length);
  const withSame = (t: number) => rowsWith((d) => suppressDuplicates(d, { ...DEFAULT_SETTINGS, same_source_iou_threshold: t }).filter((x) => x.status === "kept").length);
  const candidates = [0.5, 0.55, 0.6, 0.7, 0.8, 0.9];
  const tuneMae = candidates.map((t) => [t, summarize(withSame(t).filter((r) => r.split === "tune"))!.mae] as const);
  const test = (rows: Row[]) => rows.filter((r) => r.split === "test");
  const text = [
    "# 人数カウント 合成データでの比較",
    "",
    "> **これは合成データによるアルゴリズムの動作比較です。実写真での精度ではありません。**",
    "> 正解の枠に、検出APIで起きがちな誤り（見逃し・同じ人物への重複検出・誤検出）を乱数で加えたものを使っています。",
    "> 誤りの発生率は仮定であり、実際の Rekognition などの挙動を反映したものではありません。",
    "",
    `設定：${JSON.stringify(DEFAULT_SETTINGS)}`,
    "",
    "## 整理なし（スコアのしきい値のみ）・test 区分",
    table(byTag(test(rawRows))),
    "",
    "## 同一解析内の重複判定しきい値（same_source_iou_threshold）の比較・tune 区分の平均絶対誤差",
    "| しきい値 | tune 平均絶対誤差 |", "|---|---|",
    ...tuneMae.map(([t, m]) => `| ${t} | ${m.toFixed(2)} |`),
    "",
    "## 重複抑制あり：一律 0.55（初期案）・test 区分",
    table(byTag(test(withSame(0.55)))),
    "",
    `## 重複抑制あり：既定（同一解析内 ${DEFAULT_SETTINGS.same_source_iou_threshold}）・test 区分`,
    table(byTag(test(withSame(DEFAULT_SETTINGS.same_source_iou_threshold)))),
    "",
    "読み方：",
    "- 同一解析内で IoU 0.55 から重複とみなす初期案は、密集・重なりのある写真で別人をまとめてしまい、過小カウントを悪化させた（合成データ上）。",
    "- tune 区分では同一解析内のしきい値は高いほど誤差が小さく、0.9（ほぼ同一の枠だけを重複とみなす）が最良だったため既定値とした。",
    "  それでも test 区分の密集写真では、整理なしより誤差が大きい。合成データの密集シーンは別人の枠どうしの重なりが実際より大きい可能性があり、",
    "  この比較だけでは実写真での優劣は判断できない。全体解析と領域解析の間の重複判定（0.55・境界の包含判定）は領域分割を使う場合に必要。",
    "- 重複抑制は過大カウントを減らすが、見逃し（過小カウント）は減らさない。密集・小さな人物の見逃しは検出枠方式の限界で、",
    "  領域分割や別方式（密度推定モデルなど）の要否は実写真の評価で判断する必要がある。",
  ].join("\n");
  write(out, text);
}

// ------------------------------------------------------------
// 実写真
// ------------------------------------------------------------
type Dataset = { images: { file: string; truth_count: number; split: "tune" | "test"; tags?: string[] }[] };

async function env() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("評価はローカル環境でのみ実行します");
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

async function real(manifest: string, out?: string, allowMock = false) {
  const db = await env();
  const { preprocessPhoto, analysisMeta } = await import("../src/lib/photo/preprocess.ts");
  const ds = JSON.parse(readFileSync(manifest, "utf8")) as Dataset;
  const base = dirname(resolve(manifest));
  // 評価専用の組織（本番データとは別）
  const name = `評価用（人数カウント ${new Date().toISOString().slice(0, 16)}）`;
  const { data: org, error } = await db.from("organizations").insert({ name, plan_id: "large" }).select("id").single();
  if (error) throw error;
  await db.from("organization_features").upsert({ organization_id: org.id, photo_pipeline_v2: true, photo_tiling: process.argv.includes("--tiling") });
  console.error(`評価用組織 ${org.id} に ${ds.images.length}枚をアップロードします`);
  const items: { id: string; job: string; img: Dataset["images"][number] }[] = [];
  for (const img of ds.images) {
    const buf = readFileSync(resolve(base, img.file));
    const pre = await preprocessPhoto(buf, { tiling: process.argv.includes("--tiling") });
    const id = crypto.randomUUID();
    const path = `${org.id}/${id}.${pre.format === "jpeg" ? "jpg" : pre.format}`;
    const apath = `${org.id}/analysis/${id}.jpg`;
    const tiles = pre.tiles.map((t) => `${org.id}/analysis/${id}-t${t.index}.jpg`);
    await db.storage.from("photos").upload(path, buf, { contentType: pre.mime });
    await db.storage.from("photos").upload(apath, pre.analysis.buffer, { contentType: "image/jpeg" });
    for (const [i, t] of pre.tiles.entries()) await db.storage.from("photos").upload(tiles[i], t.buffer, { contentType: "image/jpeg" });
    await db.from("photos").insert({ id, organization_id: org.id, storage_path: path, original_filename: img.file, mime_type: pre.mime,
      size_bytes: pre.bytes, expires_at: new Date(Date.now() + 30 * 86400e3).toISOString() });
    const { data: r, error: e } = await db.rpc("complete_photo_upload_v2", { photo: id, org: org.id, actual_size: pre.bytes, actual_mime: pre.mime,
      sha256: pre.sha256, p_width: pre.upright.width, p_height: pre.upright.height, p_orientation: pre.orientation,
      p_analysis_path: apath, p_analysis_meta: analysisMeta(pre, { analysis: apath, tiles }) });
    if (e) throw e;
    items.push({ id, job: (r as { job_id: string }).job_id, img });
  }
  console.error("ワーカーの処理を待っています（supabase functions serve と Cron が動いている必要があります）…");
  const deadline = Date.now() + 15 * 60e3;
  for (;;) {
    const { data } = await db.from("jobs").select("status").in("id", items.map((i) => i.job));
    if ((data ?? []).every((j) => ["succeeded", "dead"].includes(j.status))) break;
    if (Date.now() > deadline) throw new Error("時間内に解析が終わりませんでした");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const rows: Row[] = [];
  let provider = "";
  for (const it of items) {
    const { data: run } = await db.from("photo_analysis_results").select("estimated_count, raw_detection_count, duration_ms, provider_calls, model_provider, model_name, model_version")
      .eq("photo_id", it.id).order("version_no", { ascending: false }).limit(1).maybeSingle();
    if (!run) { console.error(`解析失敗：${it.img.file}`); continue; }
    provider = `${run.model_provider}/${run.model_name} ${run.model_version ?? ""}`;
    if (run.model_provider === "mock" && !allowMock) throw new Error("ワーカーが DETECTOR=mock です。実際の人物検出APIを設定してから実行してください。");
    rows.push({ id: it.id, split: it.img.split, tags: it.img.tags ?? [], truth: it.img.truth_count, estimate: run.estimated_count,
      raw: run.raw_detection_count ?? undefined, ms: run.duration_ms ?? undefined, calls: run.provider_calls });
  }
  writeFileSync(resolve(base, `.eval-org-${org.id}.json`), JSON.stringify({ org: org.id, items: items.map((i) => ({ id: i.id, file: i.img.file })) }, null, 2));
  report(rows, provider, org.id, out, allowMock);
}

function report(rows: Row[], provider: string, orgId: string, out?: string, mock = false) {
  const text = [
    `# 人数カウント 実写真での評価`,
    "",
    mock ? "> **DETECTOR=mock で実行したため、以下は動作確認であり精度の数値ではありません。**\n" : "",
    `- 検出：${provider}`,
    `- 評価用組織：${orgId}（スタッフの修正時間は、この組織の写真を画面で確定した後に \`report\` で再集計すると入ります）`,
    `- 評価用（test）とします。しきい値の調整は tune 区分だけで行ってください。`,
    "",
    "## test 区分",
    table(byTag(rows.filter((r) => r.split === "test"))),
    "",
    "## tune 区分（しきい値調整用。性能の報告には使わない）",
    table(byTag(rows.filter((r) => r.split === "tune"))),
  ].join("\n");
  write(out, text);
}

/** 画面での確定（修正時間を含む）後に再集計する */
async function reportFromDb(orgId: string, manifest: string, out?: string) {
  const db = await env();
  const ds = JSON.parse(readFileSync(manifest, "utf8")) as Dataset;
  const map = JSON.parse(readFileSync(resolve(dirname(resolve(manifest)), `.eval-org-${orgId}.json`), "utf8")) as { items: { id: string; file: string }[] };
  const rows: Row[] = [];
  let provider = "";
  for (const it of map.items) {
    const img = ds.images.find((i) => i.file === it.file)!;
    const { data: run } = await db.from("photo_analysis_results").select("id, estimated_count, duration_ms, provider_calls, model_provider, model_name").eq("photo_id", it.id).order("version_no", { ascending: false }).limit(1).maybeSingle();
    const { data: rev } = await db.from("photo_reviews").select("review_seconds").eq("photo_id", it.id).order("reviewed_at", { ascending: false }).limit(1).maybeSingle();
    if (!run) continue;
    provider = `${run.model_provider}/${run.model_name}`;
    rows.push({ id: it.id, split: img.split, tags: img.tags ?? [], truth: img.truth_count, estimate: run.estimated_count, ms: run.duration_ms ?? undefined, calls: run.provider_calls, review_seconds: rev?.review_seconds });
  }
  report(rows, provider, orgId, out, provider.startsWith("mock"));
}

/** 保存済みの検出枠でしきい値を再計算する（外部APIは呼ばない）。tune で選び、test で評価する */
async function sweep(orgId: string, manifest: string, out?: string) {
  const db = await env();
  const ds = JSON.parse(readFileSync(manifest, "utf8")) as Dataset;
  const map = JSON.parse(readFileSync(resolve(dirname(resolve(manifest)), `.eval-org-${orgId}.json`), "utf8")) as { items: { id: string; file: string }[] };
  const data: { split: string; tags: string[]; truth: number; dets: RawDetection[] }[] = [];
  for (const it of map.items) {
    const img = ds.images.find((i) => i.file === it.file)!;
    const { data: run } = await db.from("photo_analysis_results").select("id").eq("photo_id", it.id).order("version_no", { ascending: false }).limit(1).maybeSingle();
    if (!run) continue;
    const { data: ds2 } = await db.from("photo_detections").select("x, y, w, h, score, source, tile_index").eq("analysis_result_id", run.id);
    data.push({ split: img.split, tags: img.tags ?? [], truth: img.truth_count,
      dets: (ds2 ?? []).map((d) => ({ x: +d.x, y: +d.y, w: +d.w, h: +d.h, score: +d.score, source: d.source, tile: d.tile_index ?? undefined })) });
  }
  const evalWith = (s: CountSettings, split: string): Row[] => data.filter((d) => d.split === split).map((d, i) => ({
    id: String(i), split, tags: d.tags, truth: d.truth, estimate: suppressDuplicates(d.dets, s).filter((x) => x.status === "kept").length }));
  let best = { s: DEFAULT_SETTINGS, mae: Infinity };
  for (const min_score of [50, 55, 60, 65, 70, 75, 80]) for (const iou_threshold of [0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
    const s = { ...DEFAULT_SETTINGS, min_score, iou_threshold };
    const mae = summarize(evalWith(s, "tune"))?.mae ?? Infinity;
    if (mae < best.mae) best = { s, mae };
  }
  write(out, [
    "# しきい値の調整（tune で選び、test で評価）",
    `- 既定：${JSON.stringify(DEFAULT_SETTINGS)}`,
    `- tune で最良：${JSON.stringify(best.s)}（tune の平均絶対誤差 ${best.mae.toFixed(2)}）`,
    "",
    "## test 区分：既定の設定", table(byTag(evalWith(DEFAULT_SETTINGS, "test"))),
    "", "## test 区分：tune で選んだ設定", table(byTag(evalWith(best.s, "test"))),
  ].join("\n"));
}

const [mode, a1, a2] = process.argv.slice(2);
const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
if (mode === "synthetic") synthetic(out);
else if (mode === "real" && a1) await real(a1, out, process.argv.includes("--allow-mock"));
else if (mode === "report" && a1 && a2) await reportFromDb(a1, a2, out);
else if (mode === "sweep" && a1 && a2) await sweep(a1, a2, out);
else {
  console.error("usage: node scripts/eval-counting.mts synthetic | real <dataset.json> [--tiling] | report <org> <dataset.json> | sweep <org> <dataset.json> [--out file]");
  process.exit(1);
}
