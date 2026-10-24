import { describe, expect, it } from "vitest";
import { chartKind, normalizeSpec, parseQuestion, rangeBounds, shapeResult, type Spec } from "@/lib/insights";

const now = Date.parse("2026-10-24T03:00:00Z"); // 日本時間 10/24 12:00
const fields = [{ key: "member_type", label: "会員種別", field_type: "select" }, { key: "joined", label: "入会日", field_type: "date" }];
const p = (t: string) => parseQuestion(t, fields, now).spec;

describe("入力文の読み取り", () => {
  it.each([
    ["地域別の人数", { metric: "people_total", dim: "region" }],
    ["月ごとの参加者数の推移", { metric: "participants", dim: "month" }],
    ["今年の新規登録数を月別に", { metric: "people_new", dim: "month", range: "this_year" }],
    ["タグ別の人数", { metric: "people_total", dim: "tag" }],
    ["参加回数別の人数", { metric: "people_total", dim: "attendance_band" }],
    ["直近6か月の参加数をタグ別の内訳で", { metric: "attendances", dim: "month", series: "tag", range: "last6m" }],
    ["曜日別の参加数", { metric: "attendances", dim: "weekday" }],
    ["やりとりの種類別の件数", { metric: "interactions", dim: "kind" }],
    ["会員種別ごとの人数", { metric: "people_total", dim: "field", fieldKey: "member_type" }],
    ["過去30日の応募を日ごとに", { metric: "submissions", dim: "day", range: "last30d" }],
    ["去年のイベント数", { metric: "events", dim: "month", range: "last_year" }],
    ["業種別のやりとり", { metric: "interactions", dim: "industry" }],
  ])("%s", (q, want) => {
    expect(p(q)).toMatchObject(want);
  });
  it("何も読み取れないときは知らせる（人数の地域別を仮に出す）", () => {
    const r = parseQuestion("こんにちは", fields, now);
    expect(r.unknown).toBe(true);
    expect(r.spec).toMatchObject({ metric: "people_total", dim: "region" });
  });
  it("指標に合わない切り口は使わない（イベント数に地域はない）", () => {
    expect(normalizeSpec({ metric: "events", dim: "region", range: "last12m" }, now).dim).toBe("month");
    expect(normalizeSpec({ metric: "people_total", dim: "kind", range: "last12m" }, now).dim).toBe("region");
  });
  it("期間に対して細かすぎる時間の切り口は粗くする", () => {
    expect(normalizeSpec({ metric: "people_new", dim: "day", range: "last12m" }, now).dim).toBe("week");
    expect(normalizeSpec({ metric: "people_new", dim: "day", range: "all" }, now).dim).toBe("month");
    expect(normalizeSpec({ metric: "people_new", dim: "day", range: "last30d" }, now).dim).toBe("day");
  });
});

describe("期間（日本時間の暦）", () => {
  it("直近12か月は11か月前の1日から明日の0時まで", () => {
    const { from, to } = rangeBounds("last12m", now);
    expect(new Date(from).toISOString()).toBe("2025-10-31T15:00:00.000Z");
    expect(new Date(to).toISOString()).toBe("2026-10-24T15:00:00.000Z");
  });
  it("昨年は1/1〜12/31", () => {
    const { from, to } = rangeBounds("last_year", now);
    expect(new Date(from).toISOString()).toBe("2024-12-31T15:00:00.000Z");
    expect(new Date(to).toISOString()).toBe("2025-12-31T15:00:00.000Z");
  });
});

describe("グラフ用に整える", () => {
  const spec = (s: Partial<Spec>): Spec => ({ metric: "people_new", dim: "month", range: "last6m", ...s });
  it("月ごとは期間のすべての月を並べ、無い月は0にする", () => {
    const r = shapeResult(spec({}), [{ x: "2026-07", s: null, value: 3 }, { x: "2026-10", s: null, value: 2 }], now);
    expect(r.keys).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(r.series[0].values).toEqual([0, 0, 3, 0, 0, 2]);
    expect(r.total).toBe(5);
  });
  it("人数の推移は期間前の人数からの累計", () => {
    const r = shapeResult(spec({ metric: "people_total" }), [{ x: "__base__", s: null, value: 10 }, { x: "2026-06", s: null, value: 2 }, { x: "2026-09", s: null, value: 1 }], now);
    expect(r.series[0].values).toEqual([10, 12, 12, 12, 13, 13]);
    expect(r.total).toBe(13);
  });
  it("分類は多い順、未設定は最後、13件以上は「その他」にまとめる", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ x: `地域${i}`, s: null, value: 20 - i }));
    rows.push({ x: "未設定", s: null, value: 100 });
    const r = shapeResult(spec({ metric: "people_total", dim: "region" }), rows, now);
    expect(r.labels.length).toBe(12);
    expect(r.labels[0]).toBe("地域0");
    expect(r.labels.at(-1)).toMatch(/^その他（5件）$/);
    expect(r.series[0].values.at(-1)).toBe(100 + 9 + 8 + 7 + 6);
  });
  it("系列は上位4つ＋その他、曜日は月〜日の順", () => {
    const rows = ["A", "B", "C", "D", "E", "F"].flatMap((s, i) => [{ x: "1", s, value: 10 - i }, { x: "7", s, value: 1 }]);
    const r = shapeResult(spec({ metric: "attendances", dim: "weekday", series: "tag" }), rows, now);
    expect(r.labels).toEqual(["月曜", "火曜", "水曜", "木曜", "金曜", "土曜", "日曜"]);
    expect(r.series.map((s) => s.key)).toEqual(["A", "B", "C", "D", "__other__"]);
    expect(r.series[4].values[0]).toBe(6 + 5);
    expect(r.total).toBeNull(); // タグは1人が複数に数えられるので合計を出さない
  });
  it("自動のグラフの形", () => {
    const s = spec({});
    expect(chartKind(s, shapeResult(s, [], now))).toBe("column");
    const t = spec({ metric: "people_total" });
    expect(chartKind(t, shapeResult(t, [], now))).toBe("line");
    const c = spec({ dim: "region" });
    expect(chartKind(c, shapeResult(c, [{ x: "北区", s: null, value: 1 }], now))).toBe("bar");
  });
});
