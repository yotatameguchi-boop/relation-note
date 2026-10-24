"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { InsightChart } from "@/components/InsightChart";
import { DIMS, METRICS, RANGES, dimAllowed, pieAllowed, specToParams, type DimKey, type FieldDef, type MetricKey, type RangePreset, type Shaped, type Spec } from "@/lib/insights";

const fmt = (n: number) => n.toLocaleString("ja-JP", { maximumFractionDigits: 1 });

/** グラフ・表の切り替えと CSV 出力 */
export function InsightCard({ title, sub, data, kind, unit, spec, base, actions, compact = false }: {
  title: string; sub: string; data: Shaped; kind: "line" | "column" | "bar" | "pie"; unit: string; spec: Spec; base?: string;
  actions?: React.ReactNode; compact?: boolean;
}) {
  const router = useRouter();
  const [table, setTable] = useState(false);
  const empty = data.series.every((s) => s.values.every((v) => !v));
  const setChart = (c: "line" | "column" | "bar" | "pie") => base && router.push(`${base}?${specToParams({ ...spec, chart: c })}`, { scroll: false });
  const csv = () => {
    const head = [DIMS[spec.dim].label.replace(/(別|ごと)$/, "") || "区分", ...data.series.map((s) => s.label)];
    const lines = [head, ...data.labels.map((l, i) => [l, ...data.series.map((s) => String(s.values[i]))])]
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${title}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const canTime = data.kind === "time" || data.kind === "ordered";

  return (
    <div className="card">
      <div className="insight-head">
        <div>
          <h2>{title}</h2>
          <div className="small muted">{sub}</div>
        </div>
        {data.total !== null && !compact && kind !== "pie" && (
          <div className="hero-num" aria-label={`合計 ${fmt(data.total)}${unit}`}>{fmt(data.total)}<small>{unit}{spec.metric === "people_total" && data.kind === "time" ? "（期間末）" : "（合計）"}</small></div>
        )}
      </div>
      {empty ? (
        <p className="muted small" style={{ padding: "32px 0", textAlign: "center" }}>この条件に当てはまるデータはまだありません。期間を広げてみてください。</p>
      ) : table ? (
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>{DIMS[spec.dim].label}</th>{data.series.map((s) => <th key={s.key} style={{ textAlign: "right" }}>{s.label}</th>)}</tr></thead>
            <tbody>{data.labels.map((l, i) => (
              <tr key={l}><td>{l}</td>{data.series.map((s) => <td key={s.key} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(s.values[i])}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <InsightChart data={data} kind={kind} unit={unit} />
      )}
      <div className="row small" style={{ marginTop: 12, justifyContent: "space-between" }}>
        <span className="row">
          {base && !table && (
            <span className="seg" role="group" aria-label="グラフの形">
              {([...(data.kind === "time" ? ["line", "column"] : canTime ? ["column", "bar"] : ["bar", "column"]), ...(pieAllowed(spec, data) ? ["pie"] : [])] as ("line" | "column" | "bar" | "pie")[]).map((c) => (
                <button key={c} type="button" aria-pressed={kind === c} onClick={() => setChart(c)}>{c === "line" ? "折れ線" : c === "column" ? "縦棒" : c === "bar" ? "横棒" : "円"}</button>
              ))}
            </span>
          )}
          <button type="button" className="btn-secondary btn-small" onClick={() => setTable((v) => !v)}>{table ? "グラフで見る" : "表で見る"}</button>
          {!empty && <button type="button" className="btn-secondary btn-small" onClick={csv}>CSV</button>}
        </span>
        {actions}
      </div>
      {!table && !empty && data.labels.at(-1)?.endsWith("（途中）") && (
        <p className="small muted" style={{ margin: "6px 0 0" }}>＊ 最後の{spec.dim === "week" ? "週" : "月"}はまだ途中のため、少なく見えることがあります。</p>
      )}
      {DIMS[spec.dim].multi || (spec.series && DIMS[spec.series].multi) ? (
        <p className="small muted" style={{ marginBottom: 0 }}>※ タグ・関心分野は1人が複数に当てはまるため、合計は人数と一致しません。</p>
      ) : spec.metric === "participants" && (spec.series || data.folded > 0) ? (
        <p className="small muted" style={{ marginBottom: 0 }}>※ 参加者数（実人数）は区分ごとに数えるため、区分を足した数は全体の人数と一致しないことがあります。</p>
      ) : null}
    </div>
  );
}

/** 条件の手直し（入力文の読み取り結果をここで直せる） */
export function SpecControls({ spec, fields, base }: { spec: Spec; fields: FieldDef[]; base: string }) {
  const router = useRouter();
  const go = (patch: Partial<Spec>) => router.push(`${base}?${specToParams({ ...spec, ...patch, chart: "auto" })}`, { scroll: false });
  const groupable = fields.filter((f) => ["select", "multi_select", "checkbox"].includes(f.field_type));
  const dimOptions = (metric: MetricKey, includeTime: boolean) => (Object.keys(DIMS) as DimKey[])
    .filter((d) => d !== "field" && dimAllowed(metric, d) && (includeTime || DIMS[d].type !== "time") && (includeTime || d !== "total"))
    .map((d) => ({ v: d, l: DIMS[d].label }))
    .concat(METRICS[metric].person ? groupable.map((f) => ({ v: `field:${f.key}` as DimKey, l: `${f.label}別` })) : []);
  const dimValue = (d: DimKey, key?: string | null) => (d === "field" ? `field:${key}` : d);
  const parseDim = (v: string) => (v.startsWith("field:") ? { d: "field" as DimKey, k: v.slice(6) } : { d: v as DimKey, k: null });
  const timeDim = DIMS[spec.dim].type === "time";

  return (
    <div className="spec-row">
      <label>何を
        <select value={spec.metric} onChange={(e) => go({ metric: e.target.value as MetricKey })}>
          {(Object.keys(METRICS) as MetricKey[]).map((m) => <option key={m} value={m}>{METRICS[m].label}</option>)}
        </select>
      </label>
      <label>どう分けるか
        <select value={dimValue(spec.dim, spec.fieldKey)} onChange={(e) => { const p = parseDim(e.target.value); go({ dim: p.d, fieldKey: p.k }); }}>
          {dimOptions(spec.metric, true).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      </label>
      <label>内訳（色分け）
        <select value={spec.series ? dimValue(spec.series, spec.seriesFieldKey) : ""} disabled={!timeDim && DIMS[spec.dim].type !== "ordered"}
          onChange={(e) => { const p = e.target.value ? parseDim(e.target.value) : null; go({ series: p?.d ?? null, seriesFieldKey: p?.k ?? null }); }}>
          <option value="">なし</option>
          {dimOptions(spec.metric, false).filter((o) => o.v !== spec.dim).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      </label>
      <label>期間
        <select value={spec.range} onChange={(e) => go({ range: e.target.value as RangePreset })}>
          {(Object.keys(RANGES) as RangePreset[]).map((r) => <option key={r} value={r}>{RANGES[r]}</option>)}
        </select>
      </label>
    </div>
  );
}
