// グラフ分析：何を（指標）× どう分けるか（切り口）× 内訳（系列）× 期間。
// 入力文の読み取り（parseQuestion）と、集計結果をグラフ用に整える処理（shapeResult）。どちらも純粋な関数（テストあり）。

export type MetricKey =
  | "people_total" | "people_new" | "attendances" | "participants" | "events"
  | "interactions" | "submissions" | "tasks_done" | "emails_sent";
export type DimKey =
  | "total" | "month" | "week" | "day" | "weekday"
  | "region" | "tag" | "field" | "interest" | "attendance_band" | "industry" | "kind" | "event";
export type RangePreset = "last30d" | "last90d" | "last6m" | "last12m" | "this_year" | "last_year" | "all";
export type ChartKind = "auto" | "line" | "column" | "bar" | "pie";

export type Spec = {
  metric: MetricKey;
  dim: DimKey;
  series?: DimKey | null;
  fieldKey?: string | null;
  seriesFieldKey?: string | null;
  range: RangePreset;
  chart?: ChartKind;
};

export type FieldDef = { key: string; label: string; field_type: string };

export const METRICS: Record<MetricKey, { label: string; unit: string; person: boolean; note?: string }> = {
  people_total: { label: "人数（登録者の総数）", unit: "人", person: true, note: "期間の終わり時点で登録されている人数" },
  people_new: { label: "新規登録数", unit: "人", person: true },
  attendances: { label: "参加数（延べ）", unit: "回", person: true, note: "参加を確認した記録の数。同じ人の複数回参加も数える" },
  participants: { label: "参加者数（実人数）", unit: "人", person: true, note: "期間内に1回以上参加した人の数" },
  events: { label: "イベント数", unit: "件", person: false },
  interactions: { label: "やりとりの件数", unit: "件", person: true },
  submissions: { label: "フォーム回答数", unit: "件", person: true },
  tasks_done: { label: "完了したタスク", unit: "件", person: true },
  emails_sent: { label: "メール送信数", unit: "通", person: true },
};

export const DIMS: Record<DimKey, { label: string; type: "none" | "time" | "ordered" | "category"; person?: boolean; only?: MetricKey[]; multi?: boolean }> = {
  total: { label: "合計のみ", type: "none" },
  month: { label: "月ごと", type: "time" },
  week: { label: "週ごと", type: "time" },
  day: { label: "日ごと", type: "time" },
  weekday: { label: "曜日別", type: "ordered" },
  region: { label: "地域別", type: "category", person: true },
  tag: { label: "タグ別", type: "category", person: true, multi: true },
  field: { label: "追加項目別", type: "category", person: true },
  interest: { label: "関心分野別", type: "category", person: true, multi: true },
  attendance_band: { label: "参加回数別", type: "ordered", person: true },
  industry: { label: "所属企業の業種別", type: "category", person: true },
  kind: { label: "種類別", type: "category", only: ["interactions", "submissions", "tasks_done"] },
  event: { label: "イベント別", type: "category", only: ["attendances", "participants", "events"] },
};

export const RANGES: Record<RangePreset, string> = {
  last30d: "直近30日",
  last90d: "直近90日",
  last6m: "直近6か月",
  last12m: "直近12か月",
  this_year: "今年",
  last_year: "昨年",
  all: "全期間（5年）",
};

export const KIND_LABEL: Record<string, string> = {
  call: "電話", meeting: "面談", email: "メール", visit: "訪問", online: "オンライン", other: "その他",
  csv: "CSV", webhook: "連携", google_forms: "Googleフォーム", google_sheets: "スプレッドシート", typeform: "Typeform", tally: "Tally",
  low: "優先度 低", normal: "優先度 中", high: "優先度 高",
};
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const BANDS = ["0回", "1回", "2〜3回", "4〜9回", "10回以上"];

export function dimAllowed(metric: MetricKey, dim: DimKey) {
  const d = DIMS[dim];
  if (d.person && !METRICS[metric].person) return false;
  if (d.only && !d.only.includes(metric)) return false;
  return true;
}

// ------------------------------------------------------------
// 期間（日本時間の暦で区切る）
// ------------------------------------------------------------
const JST = 9 * 3600e3;
const jstParts = (ms: number) => { const d = new Date(ms + JST); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };
const jstMidnight = (y: number, m: number, d: number) => Date.UTC(y, m, d) - JST;

export function rangeBounds(r: RangePreset, now: number): { from: number; to: number } {
  const { y, m, d } = jstParts(now);
  const tomorrow = jstMidnight(y, m, d + 1);
  switch (r) {
    case "last30d": return { from: jstMidnight(y, m, d - 29), to: tomorrow };
    case "last90d": return { from: jstMidnight(y, m, d - 89), to: tomorrow };
    case "last6m": return { from: jstMidnight(y, m - 5, 1), to: tomorrow };
    case "last12m": return { from: jstMidnight(y, m - 11, 1), to: tomorrow };
    case "this_year": return { from: jstMidnight(y, 0, 1), to: tomorrow };
    case "last_year": return { from: jstMidnight(y - 1, 0, 1), to: jstMidnight(y, 0, 1) };
    case "all": return { from: jstMidnight(y - 4, 0, 1), to: tomorrow };
  }
}

/** 期間に対して細かすぎる時間の切り口を直す（日ごとは最大約3か月、週ごとは最大約1年） */
export function normalizeSpec(s: Spec, now: number): Spec {
  const out: Spec = { ...s, series: s.series ?? null };
  if (!dimAllowed(out.metric, out.dim)) out.dim = METRICS[out.metric].person ? "region" : "month";
  if (out.series && (!dimAllowed(out.metric, out.series) || out.series === out.dim || DIMS[out.series].type === "time" || DIMS[out.dim].type === "none")) out.series = null;
  const { from, to } = rangeBounds(out.range, now);
  const days = (to - from) / 86400e3;
  if (out.dim === "day" && days > 100) out.dim = days > 400 ? "month" : "week";
  if (out.dim === "week" && days > 400) out.dim = "month";
  return out;
}

// ------------------------------------------------------------
// 入力文の読み取り（決まった言い回しから指標・切り口・期間を拾う。拾えたものを返し、画面で確認・修正してもらう）
// ------------------------------------------------------------
const METRIC_WORDS: [RegExp, MetricKey][] = [
  [/(新規|新しく|増えた|入会|登録数|登録した人|新しい人)/, "people_new"],
  [/(実人数|参加者数|参加した人|参加者)/, "participants"],
  [/(延べ|参加数|参加回数の合計|出席|参加)/, "attendances"],
  [/(イベント数|開催数|開催回数|イベントの数|開催)/, "events"],
  [/(やりとり|やり取り|接触|面談|電話|訪問|商談)/, "interactions"],
  [/(応募|回答|フォーム|申込|申し込み)/, "submissions"],
  [/(タスク|完了|対応済)/, "tasks_done"],
  [/(メール|配信|送信)/, "emails_sent"],
  [/(人数|何人|人物|会員数|登録者|顧客数|関係者|名簿|全体|総数)/, "people_total"],
];
const DIM_WORDS: [RegExp, DimKey][] = [
  [/(参加回数別|回数別|回数ごと|リピート|何回)/, "attendance_band"],
  [/(曜日)/, "weekday"],
  [/((?<!曜)日ごと|(?<!曜)日別|毎日|日次)/, "day"],
  [/(週ごと|週別|毎週|週次)/, "week"],
  [/(月ごと|月別|毎月|月次|推移|増減|伸び|変化|トレンド)/, "month"],
  [/(地域|エリア|住所|市町村|居住|どこ)/, "region"],
  [/(タグ|属性|分類)/, "tag"],
  [/(関心|興味|分野)/, "interest"],
  [/(業種|業界|企業別|会社別)/, "industry"],
  [/(イベント別|イベントごと|どのイベント)/, "event"],
  [/(種類|種別|方法|手段|経路|優先度)/, "kind"],
];
const RANGE_WORDS: [RegExp, RangePreset | ((n: number, unit: string) => RangePreset)][] = [
  [/(今年|本年|年初から)/, "this_year"],
  [/(去年|昨年|前年)/, "last_year"],
  [/(全期間|これまで|今まで|累計|ずっと|全部)/, "all"],
  [/(?:過去|直近|この|ここ)?\s*(\d+|[一二三六十]+)\s*(日|週間|週|か月|ヶ月|カ月|ケ月|月|年)/, (n, unit) => {
    const days = unit === "日" ? n : unit.startsWith("週") ? n * 7 : unit === "年" ? n * 365 : n * 30;
    return days <= 31 ? "last30d" : days <= 95 ? "last90d" : days <= 190 ? "last6m" : days <= 400 ? "last12m" : "all";
  }],
  [/(先月|今月|最近)/, "last90d"],
  [/(半年)/, "last6m"],
  [/(1年|一年|この1年)/, "last12m"],
];
const KANJI: Record<string, number> = { 一: 1, 二: 2, 三: 3, 六: 6, 十: 10 };
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : s.split("").reduce((a, c) => (c === "十" ? (a || 1) * 10 : a + (KANJI[c] ?? 0)), 0));

export type Parsed = { spec: Spec; understood: string[]; unknown: boolean };

export function parseQuestion(text: string, fields: FieldDef[], now: number): Parsed {
  const t = text.normalize("NFKC").trim();
  const understood: string[] = [];
  let metric: MetricKey | null = null;
  for (const [re, k] of METRIC_WORDS) if (re.test(t)) { metric = k; break; }

  // 切り口：出てきた順に、時間の切り口と分類の切り口を1つずつ拾う
  const found: { dim: DimKey; at: number; fieldKey?: string }[] = [];
  for (const f of fields.filter((f) => ["select", "multi_select", "checkbox"].includes(f.field_type))) {
    const at = t.indexOf(f.label);
    if (at >= 0) found.push({ dim: "field", at, fieldKey: f.key });
  }
  for (const [re, k] of DIM_WORDS) {
    const m = re.exec(t);
    if (m && !found.some((f) => f.dim === k)) found.push({ dim: k, at: m.index });
  }
  found.sort((a, b) => a.at - b.at);
  // 「参加回数別」は指標の「参加」より優先して切り口として読む
  if (found.some((f) => f.dim === "attendance_band") && (metric === "attendances" || metric === "participants") && !/(参加者|参加数|延べ)/.test(t)) metric = null;

  let time = found.find((f) => DIMS[f.dim].type === "time");
  // 「〜の内訳で」は時間の推移を分類ごとに分けて見たい、と読む
  if (!time && /内訳/.test(t) && found.length) time = { dim: "month", at: -1 };
  const cats = found.filter((f) => DIMS[f.dim].type !== "time");
  let range: RangePreset = "last12m";
  for (const [re, r] of RANGE_WORDS) {
    const m = re.exec(t);
    if (m) {
      range = typeof r === "function" ? r(toNum(m[1]), m[2]) : r;
      understood.push(`期間：${RANGES[range]}`);
      break;
    }
  }
  if (!metric) metric = /(イベント)/.test(t) && !cats.some((c) => c.dim === "event") ? "events" : "people_total";
  understood.unshift(`指標：${METRICS[metric].label}`);

  let dim: DimKey = "total";
  let series: DimKey | null = null;
  let fieldKey: string | null = null;
  let seriesFieldKey: string | null = null;
  if (time) {
    dim = time.dim;
    if (cats[0]) { series = cats[0].dim; seriesFieldKey = cats[0].fieldKey ?? null; }
  } else if (cats[0]) {
    dim = cats[0].dim; fieldKey = cats[0].fieldKey ?? null;
  } else {
    dim = METRICS[metric].person && metric === "people_total" ? "region" : "month";
  }
  if (dim !== "total") {
    const label = dim === "field" ? `${fields.find((f) => f.key === fieldKey)?.label ?? "追加項目"}別` : DIMS[dim].label;
    understood.push(`切り口：${label}`);
  }
  if (series) understood.push(`内訳：${series === "field" ? `${fields.find((f) => f.key === seriesFieldKey)?.label ?? "追加項目"}別` : DIMS[series].label}`);

  const spec = normalizeSpec({ metric, dim, series, fieldKey, seriesFieldKey, range, chart: "auto" }, now);
  return { spec, understood, unknown: found.length === 0 && !METRIC_WORDS.some(([re]) => re.test(t)) };
}

// ------------------------------------------------------------
// 集計結果をグラフ用に整える
// ------------------------------------------------------------
export type Row = { x: string; s: string | null; value: number };
export type Shaped = {
  kind: "time" | "ordered" | "category" | "none";
  labels: string[];           // 横軸（または縦の分類）の表示名
  keys: string[];             // 元の値（月なら YYYY-MM）
  series: { key: string; label: string; values: number[]; total: number }[];
  total: number | null;       // 合計（重複の数え方が違う指標・複数選択の切り口では null）
  folded: number;             // 「その他」にまとめた数
};

const MAX_CATEGORIES = 12;
const MAX_SERIES = 5;
const LAST = ["未設定", "タグなし", "企業なし", "業種未設定"];

function timeBuckets(dim: "month" | "week" | "day", from: number, to: number) {
  const keys: string[] = [];
  const labels: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  if (dim === "month") {
    let { y, m } = jstParts(from);
    for (;;) {
      if (jstMidnight(y, m, 1) >= to) break;
      keys.push(`${y}-${pad(m + 1)}`);
      labels.push(`${y}年${m + 1}月`);
      m++; if (m > 11) { m = 0; y++; }
    }
  } else {
    const { y, m } = jstParts(from);
    let { d } = jstParts(from);
    if (dim === "week") { const wd = (new Date(jstMidnight(y, m, d) + JST).getUTCDay() + 6) % 7; d -= wd; }
    for (let t = jstMidnight(y, m, d); t < to; t += (dim === "week" ? 7 : 1) * 86400e3) {
      const p = jstParts(t);
      keys.push(`${p.y}-${pad(p.m + 1)}-${pad(p.d)}`);
      labels.push(dim === "week" ? `${p.m + 1}/${p.d}週` : `${p.m + 1}/${p.d}`);
    }
  }
  return { keys, labels };
}

export function shapeResult(spec: Spec, rows: Row[], now: number, fieldOptions: string[] = []): Shaped {
  const dimType = DIMS[spec.dim].type;
  const { from, to } = rangeBounds(spec.range, now);
  const base = rows.filter((r) => r.x === "__base__");
  const data = rows.filter((r) => r.x !== "__base__");

  // 系列：合計の多い順に上位5つ、残りは「その他」
  const seriesTotals = new Map<string, number>();
  for (const r of data) seriesTotals.set(r.s ?? "", (seriesTotals.get(r.s ?? "") ?? 0) + Number(r.value));
  for (const r of base) if (!seriesTotals.has(r.s ?? "")) seriesTotals.set(r.s ?? "", 0);
  let seriesKeys = [...seriesTotals.entries()].sort((a, b) => sortCat(a, b)).map(([k]) => k);
  let foldedSeries: string[] = [];
  if (seriesKeys.length > MAX_SERIES) { foldedSeries = seriesKeys.slice(MAX_SERIES - 1); seriesKeys = [...seriesKeys.slice(0, MAX_SERIES - 1), "__other__"]; }
  const sKey = (s: string | null) => (foldedSeries.includes(s ?? "") ? "__other__" : (s ?? ""));

  // 横軸
  let keys: string[];
  let labels: string[];
  let folded = 0;
  if (dimType === "time") {
    ({ keys, labels } = timeBuckets(spec.dim as "month" | "week" | "day", from, to));
    // 今の月・週はまだ途中なので、減ったように見えても誤解されないよう示す
    if (spec.dim !== "day" && to > now && labels.length) labels[labels.length - 1] += "（途中）";
  } else if (spec.dim === "weekday") {
    keys = ["1", "2", "3", "4", "5", "6", "7"]; labels = WEEKDAYS.map((w) => `${w}曜`);
  } else if (spec.dim === "attendance_band") {
    keys = BANDS; labels = BANDS;
  } else {
    const xTotals = new Map<string, number>();
    for (const r of data) xTotals.set(r.x, (xTotals.get(r.x) ?? 0) + Number(r.value));
    if (spec.dim === "field" && fieldOptions.length) for (const o of fieldOptions) if (!xTotals.has(o)) xTotals.set(o, 0);
    keys = [...xTotals.entries()].sort(sortCat).map(([k]) => k);
    if (keys.length > MAX_CATEGORIES) { folded = keys.length - (MAX_CATEGORIES - 1); keys = [...keys.slice(0, MAX_CATEGORIES - 1), "__other__"]; }
    labels = keys.map((k) => (k === "__other__" ? `その他（${folded}件）` : spec.dim === "kind" ? KIND_LABEL[k] ?? k : k));
  }
  const xIndex = new Map(keys.map((k, i) => [k, i]));
  const xOf = (x: string) => xIndex.get(x) ?? (keys.includes("__other__") ? xIndex.get("__other__") : undefined);

  const series = seriesKeys.map((k) => ({
    key: k,
    label: spec.series ? (k === "__other__" ? `その他（${foldedSeries.length}）` : spec.series === "kind" ? KIND_LABEL[k] ?? k : k) : METRICS[spec.metric].label,
    values: keys.map(() => 0),
    total: 0,
  }));
  if (!series.length) series.push({ key: "", label: METRICS[spec.metric].label, values: keys.map(() => 0), total: 0 });
  const sIndex = new Map(series.map((s, i) => [s.key, i]));
  for (const r of data) {
    const xi = xOf(r.x);
    const si = sIndex.get(sKey(r.s));
    if (xi === undefined || si === undefined) continue;
    series[si].values[xi] += Number(r.value);
  }
  // 人数の推移は累計にする
  if (spec.metric === "people_total" && dimType === "time") {
    for (const s of series) {
      let acc = base.filter((b) => sKey(b.s) === s.key).reduce((a, b) => a + Number(b.value), 0);
      s.values = s.values.map((v) => (acc += v));
    }
  }
  for (const s of series) s.total = dimType === "time" && spec.metric === "people_total" ? s.values.at(-1) ?? 0 : s.values.reduce((a, b) => a + b, 0);
  const exact = spec.metric !== "participants" && !DIMS[spec.dim].multi && !(spec.series && DIMS[spec.series].multi);
  const total = spec.metric === "people_total" && dimType === "time"
    ? series.reduce((a, s) => a + (s.values.at(-1) ?? 0), 0)
    : exact ? series.reduce((a, s) => a + s.total, 0) : null;
  return { kind: dimType, labels, keys, series, total: spec.series && !exact ? null : total, folded };
}

function sortCat(a: [string, number], b: [string, number]) {
  const la = LAST.includes(a[0]) ? 1 : 0;
  const lb = LAST.includes(b[0]) ? 1 : 0;
  return la - lb || b[1] - a[1] || a[0].localeCompare(b[0], "ja");
}

/** 円グラフにできるか：分類の切り口で、1人が1つの区分にだけ入る（合計が全体になる）とき */
export function pieAllowed(spec: Spec, shaped: Shaped) {
  return (shaped.kind === "category" || shaped.kind === "ordered") && !spec.series && !DIMS[spec.dim].multi && shaped.series.length === 1;
}

/** 自動のときのグラフの形：時間は折れ線（系列あり・累計）か縦棒、順序のある分類は縦棒、それ以外は横棒 */
export function chartKind(spec: Spec, shaped: Shaped): Exclude<ChartKind, "auto"> {
  if (spec.chart === "pie" && !pieAllowed(spec, shaped)) return shaped.kind === "time" ? "line" : "bar";
  if (spec.chart && spec.chart !== "auto") return spec.chart;
  if (shaped.kind === "time") return shaped.series.length > 1 || spec.metric === "people_total" || shaped.labels.length > 24 ? "line" : "column";
  if (shaped.kind === "ordered") return "column";
  return "bar";
}

export function specTitle(spec: Spec, fields: FieldDef[]) {
  const dimLabel = (d: DimKey, key?: string | null) => (d === "field" ? `${fields.find((f) => f.key === key)?.label ?? "追加項目"}別` : DIMS[d].label);
  const parts = [METRICS[spec.metric].label.replace(/（.*）/, "")];
  if (spec.dim !== "total") parts.push(dimLabel(spec.dim, spec.fieldKey));
  if (spec.series) parts.push(`（${dimLabel(spec.series, spec.seriesFieldKey)}の内訳）`);
  return parts.join(" ・ ").replace(" ・ （", "（");
}

export const EXAMPLES = [
  "地域別の人数",
  "月ごとの参加者数の推移",
  "今年の新規登録数を月別に",
  "タグ別の人数",
  "参加回数別の人数",
  "直近6か月の参加数をタグ別の内訳で",
  "曜日別の参加数",
  "やりとりの種類別の件数",
];

export function isSpec(v: unknown): v is Spec {
  const s = v as Spec;
  return !!s && typeof s === "object" && s.metric in METRICS && s.dim in DIMS && s.range in RANGES
    && (s.series == null || s.series in DIMS);
}

/** URL の検索条件 ⇄ Spec（画面の状態を URL に持たせ、共有・戻るができるようにする） */
export function specFromParams(p: Record<string, string | undefined>): Spec | null {
  if (!p.m || !p.d) return null;
  const s = {
    metric: p.m, dim: p.d, series: p.s || null, fieldKey: p.f || null, seriesFieldKey: p.sf || null,
    range: p.r || "last12m", chart: (["line", "column", "bar", "pie"].includes(p.c ?? "") ? p.c : "auto") as ChartKind,
  };
  return isSpec(s) ? s : null;
}

export function specToParams(s: Spec): string {
  const u = new URLSearchParams({ m: s.metric, d: s.dim, r: s.range });
  if (s.series) u.set("s", s.series);
  if (s.fieldKey) u.set("f", s.fieldKey);
  if (s.seriesFieldKey) u.set("sf", s.seriesFieldKey);
  if (s.chart && s.chart !== "auto") u.set("c", s.chart);
  return u.toString();
}
