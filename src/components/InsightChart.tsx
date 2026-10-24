"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Shaped } from "@/lib/insights";

/**
 * グラフ本体（SVG）。配色は globals.css の .viz-root の変数（ライト・ダークそれぞれ色覚の検証済み）。
 *   line   … 折れ線。系列が1つなら面を薄く塗る。十字線で全系列の値を表示
 *   column … 縦棒（系列が複数なら積み上げ）。棒は太さ24pxまで、先端4px丸め、隣との間に2pxのすき間
 *   bar    … 横棒（分類の比較）。値は棒の先に表示
 *   pie    … ドーナツ型の円グラフ（全体に占める割合）。区分は多い順に5つ＋その他まで。中央に合計
 * 値はツールチップと表でも読めるようにする（色だけに頼らない）。
 */
type Kind = "line" | "column" | "bar" | "pie";

const fmt = (n: number) => n.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
const compact = (n: number) => (Math.abs(n) >= 10000 ? `${fmt(n / 10000)}万` : Math.abs(n) >= 1000 ? `${fmt(n / 1000)}千` : fmt(n));
const color = (i: number, key: string) => (key === "__other__" ? "var(--series-other)" : `var(--series-${(i % 5) + 1})`);

function niceTicks(max: number, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** 上端だけ角を丸めた棒（基線側は四角） */
function roundedBar(x: number, y: number, w: number, h: number, r: number, horizontal: boolean) {
  if (h <= 0 || w <= 0) return "";
  if (horizontal) {
    const rr = Math.min(r, w, h / 2);
    return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
  }
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

type Tip = { x: number; y: number; title: string; rows: { label: string; value: number; color: string; line: boolean }[] };

export function InsightChart({ data: raw, kind, unit }: { data: Shaped; kind: Kind; unit: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  // 折れ線では「その他」（まとめた系列）を描かない。合算値が大きく、名前のある系列が底に潰れるため（表と棒では表示）
  const other = kind === "line" && raw.series.length > 1 ? raw.series.find((s) => s.key === "__other__") : undefined;
  const data = other ? { ...raw, series: raw.series.filter((s) => s !== other) } : raw;
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const multi = data.series.length > 1;
  const stacked = multi && kind !== "line";

  if (kind === "pie") return (
    <div ref={wrapRef} className="viz-root viz-wrap">
      <Donut data={data} width={width} unit={unit} setTip={setTip} />
      {tip && <Tooltip tip={tip} unit={unit} />}
    </div>
  );

  if (kind === "bar") return (
    <div ref={wrapRef} className="viz-root viz-wrap">
      <HBar data={data} width={width} unit={unit} stacked={stacked} setTip={setTip} />
      {multi && <Legend data={data} line={false} />}
      {tip && <Tooltip tip={tip} unit={unit} />}
    </div>
  );

  return (
    <div ref={wrapRef} className="viz-root viz-wrap">
      <XYChart data={data} kind={kind} width={width} unit={unit} stacked={stacked} hover={hover} setHover={setHover} setTip={setTip} />
      {multi && <Legend data={data} line={kind === "line"} />}
      {other && <p className="small muted" style={{ margin: "4px 0 0" }}>{other.label}は折れ線では省略しています（縦棒・表で確認できます）。</p>}
      {tip && <Tooltip tip={tip} unit={unit} />}
    </div>
  );
}

function Legend({ data, line }: { data: Shaped; line: boolean }) {
  return (
    <ul className="viz-legend" aria-label="凡例">
      {data.series.map((s, i) => (
        <li key={s.key}>
          <svg width="14" height="10" aria-hidden="true">
            {line ? <line x1="0" y1="5" x2="14" y2="5" stroke={color(i, s.key)} strokeWidth="2" strokeLinecap="round" />
              : <rect x="1" y="0" width="12" height="10" rx="2" fill={color(i, s.key)} />}
          </svg>
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Tooltip({ tip, unit }: { tip: Tip; unit: string }) {
  return (
    <div className="viz-tip" role="status" style={{ left: tip.x, top: tip.y }}>
      <div className="viz-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="viz-tip-row">
          <svg width="12" height="8" aria-hidden="true">
            {r.line ? <line x1="0" y1="4" x2="12" y2="4" stroke={r.color} strokeWidth="2" strokeLinecap="round" />
              : <rect x="0" y="0" width="12" height="8" rx="2" fill={r.color} />}
          </svg>
          <strong>{fmt(r.value)}<small>{unit}</small></strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

function XYChart({ data, kind, width, unit, stacked, hover, setHover, setTip }: {
  data: Shaped; kind: "line" | "column"; width: number; unit: string; stacked: boolean;
  hover: number | null; setHover: (i: number | null) => void; setTip: (t: Tip | null) => void;
}) {
  const n = data.labels.length;
  const H = 280;
  const longest = Math.max(...data.series.map((s) => s.values.at(-1) ?? 0)).toString().length;
  const m = { top: 16, right: kind === "line" ? 16 + Math.min(10, longest) * 8 : 12, bottom: 34, left: 44 };
  const pw = width - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const totals = data.labels.map((_, i) => data.series.reduce((a, s) => a + s.values[i], 0));
  const max = stacked ? Math.max(...totals, 0) : Math.max(...data.series.flatMap((s) => s.values), 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => m.top + ph - (v / top) * ph;
  const band = pw / Math.max(n, 1);
  const cx = (i: number) => (kind === "line" ? m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw) : m.left + band * i + band / 2);
  const barW = Math.max(2, Math.min(24, band * 0.62));
  // 横軸の目盛りは重ならないように間引く（端は必ず表示）
  const labelEvery = Math.max(1, Math.ceil((n * 64) / Math.max(pw, 1)));
  const shortLabel = (l: string) => l.replace(/^\d{4}年/, (yy) => (n > 12 ? yy.slice(2, 4) + "/" : "")).replace(/^(\d\d)\/(\d+)月/, "$1/$2").replace("（途中）", "＊");
  const maxIdx = totals.indexOf(Math.max(...totals));
  // 折れ線の右端の値ラベルは、重なるときは出さない（凡例とツールチップで読める）
  const ends = data.series.map((s) => y(s.values.at(-1) ?? 0)).sort((a, b) => a - b);
  const endLabels = kind === "line" && data.series.length <= 4 && ends.every((v, i) => i === 0 || v - ends[i - 1] >= 14);

  const showTip = (i: number) => {
    setHover(i);
    const x = cx(i);
    setTip({
      x: Math.min(Math.max(x + 12, 8), width - 200),
      y: m.top,
      title: data.labels[i],
      rows: data.series.map((s, si) => ({ label: s.label, value: s.values[i], color: color(si, s.key), line: kind === "line" })),
    });
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = kind === "line" ? Math.round(((px - m.left) / Math.max(pw, 1)) * (n - 1)) : Math.floor((px - m.left) / band);
    if (i >= 0 && i < n) showTip(i);
  };
  const clear = () => { setHover(null); setTip(null); };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      showTip(Math.min(n - 1, Math.max(0, (hover ?? (e.key === "ArrowRight" ? -1 : n)) + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Escape") clear();
  };

  return (
    <svg width={width} height={H} role="img" tabIndex={0} onKeyDown={onKey} onBlur={clear}
      aria-label={`${data.series.map((s) => s.label).join("、")}のグラフ。左右の矢印キーで値を読めます`} className="viz-svg">
      {/* 目盛り線（実線の細線・控えめ） */}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={m.left} x2={m.left + pw} y1={y(t)} y2={y(t)} className={t === 0 ? "viz-base" : "viz-grid"} />
          <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">{compact(t)}</text>
        </g>
      ))}
      {data.labels.map((l, i) => (i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery) ? (
        <text key={i} x={cx(i)} y={H - m.bottom + 18} textAnchor={kind === "line" && i === 0 ? "start" : kind === "line" && i === n - 1 ? "end" : "middle"} className="viz-tick">
          {shortLabel(l)}
        </text>
      ) : null)}

      {kind === "column" && data.labels.map((_, i) => {
        let acc = 0;
        return (
          <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
            {data.series.map((s, si) => {
              const v = s.values[i];
              if (!v) return null;
              const y0 = y(acc);
              acc += stacked ? v : 0;
              const y1 = stacked ? y(acc) : y(v);
              const isTop = !stacked || si === data.series.length - 1 || data.series.slice(si + 1).every((t) => !t.values[i]);
              // 積み上げの区切りは2pxのすき間（線は引かない）
              const gap = stacked && si > 0 && acc - v > 0 ? 2 : 0;
              const h = Math.max(0, y0 - y1 - gap);
              return isTop
                ? <path key={s.key} d={roundedBar(cx(i) - barW / 2, y1, barW, h, 4, false)} fill={color(si, s.key)} />
                : <rect key={s.key} x={cx(i) - barW / 2} y={y1} width={barW} height={h} fill={color(si, s.key)} />;
            })}
          </g>
        );
      })}
      {kind === "column" && !stacked && n <= 40 && totals[maxIdx] > 0 && (
        // 値の表示は最大の棒だけ（他はツールチップと表で読める）
        <text x={cx(maxIdx)} y={y(totals[maxIdx]) - 6} textAnchor="middle" className="viz-value">{fmt(totals[maxIdx])}</text>
      )}

      {kind === "line" && data.series.map((s, si) => {
        const pts = s.values.map((v, i) => [cx(i), y(v)] as const);
        const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
        const last = pts[pts.length - 1];
        return (
          <g key={s.key}>
            {data.series.length === 1 && pts.length > 1 && (
              <path d={`${d} L${last[0]},${y(0)} L${pts[0][0]},${y(0)} Z`} fill={color(si, s.key)} opacity={0.1} />
            )}
            <path d={d} fill="none" stroke={color(si, s.key)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {last && <circle cx={last[0]} cy={last[1]} r={4} fill={color(si, s.key)} stroke="var(--viz-surface)" strokeWidth={2} />}
            {last && endLabels && (
              <text x={last[0] + 8} y={last[1]} dy="0.32em" className="viz-value">{compact(s.values.at(-1) ?? 0)}</text>
            )}
          </g>
        );
      })}
      {kind === "line" && hover !== null && (
        <g>
          <line x1={cx(hover)} x2={cx(hover)} y1={m.top} y2={m.top + ph} className="viz-cross" />
          {data.series.map((s, si) => (
            <circle key={s.key} cx={cx(hover)} cy={y(s.values[hover])} r={4} fill={color(si, s.key)} stroke="var(--viz-surface)" strokeWidth={2} />
          ))}
        </g>
      )}
      {/* 当たり判定は描画範囲全体（線や棒そのものを狙わなくてよい） */}
      <rect x={m.left} y={m.top} width={pw} height={ph} fill="transparent" onPointerMove={onMove} onPointerLeave={clear} />
      <desc>{unit}</desc>
    </svg>
  );
}

function HBar({ data, width, unit, stacked, setTip }: { data: Shaped; width: number; unit: string; stacked: boolean; setTip: (t: Tip | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = data.labels.length;
  const totals = data.labels.map((_, i) => data.series.reduce((a, s) => a + s.values[i], 0));
  const max = Math.max(...totals, 0) || 1;
  const labelW = Math.min(180, Math.max(72, ...data.labels.map((l) => Math.min(14, l.length) * 13 + 8)));
  const valueW = 64;
  const row = 34;
  const barH = 20;
  const pw = width - labelW - valueW - 8;
  const H = n * row + 8;
  const x = (v: number) => (v / max) * pw;
  const ellipsis = useMemo(() => (l: string) => (l.length > 13 ? l.slice(0, 12) + "…" : l), []);

  return (
    <svg width={width} height={H} role="img" className="viz-svg" aria-label="横棒グラフ。値は表でも確認できます">
      <line x1={labelW} x2={labelW} y1={0} y2={H} className="viz-base" />
      {data.labels.map((l, i) => {
        const cy = i * row + 4;
        let acc = 0;
        const tip = () => {
          setHover(i);
          setTip({
            x: Math.min(labelW + x(totals[i]) + 12, width - 200), y: cy,
            title: l,
            rows: data.series.map((s, si) => ({ label: s.label, value: s.values[i], color: color(si, s.key), line: false })),
          });
        };
        return (
          <g key={l} tabIndex={0} onPointerMove={tip} onFocus={tip} onPointerLeave={() => { setHover(null); setTip(null); }}
            onBlur={() => { setHover(null); setTip(null); }} opacity={hover === null || hover === i ? 1 : 0.55} className="viz-row">
            <rect x={0} y={cy} width={width} height={row - 4} fill="transparent" />
            <text x={labelW - 10} y={cy + barH / 2 + 3} dy="0.32em" textAnchor="end" className="viz-cat"><title>{l}</title>{ellipsis(l)}</text>
            {data.series.map((s, si) => {
              const v = s.values[i];
              if (!v) return null;
              const gap = stacked && acc > 0 ? 2 : 0;
              const x0 = labelW + x(acc) + gap;
              acc += v;
              const w = Math.max(0, labelW + x(acc) - x0);
              const isEnd = !stacked || data.series.slice(si + 1).every((t) => !t.values[i]);
              return isEnd
                ? <path key={s.key} d={roundedBar(x0, cy + 3, w, barH, 4, true)} fill={color(si, s.key)} />
                : <rect key={s.key} x={x0} y={cy + 3} width={w} height={barH} fill={color(si, s.key)} />;
            })}
            <text x={labelW + x(totals[i]) + 8} y={cy + barH / 2 + 3} dy="0.32em" className="viz-value">{fmt(totals[i])}</text>
          </g>
        );
      })}
      <desc>{unit}</desc>
    </svg>
  );
}

/** ドーナツ型の円グラフ。区分の間は面の色で2pxのすき間を空ける（線で縁取らない） */
function Donut({ data, width, unit, setTip }: { data: Shaped; width: number; unit: string; setTip: (t: Tip | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  // 6区分を超えたら、多い順に5つ＋その他にまとめる（細い区分は読めないため）
  const items = data.labels.map((l, i) => ({ label: l, key: data.keys[i], value: data.series[0]?.values[i] ?? 0 })).filter((d) => d.value > 0);
  // 並びは集計側の順（多い順・未設定は最後・順序のある区分はその順）をそのまま使う
  let segs = items;
  if (segs.length > 6) {
    const rest = segs.slice(5);
    segs = [...segs.slice(0, 5), { label: `その他（${rest.length}区分）`, key: "__other__", value: rest.reduce((a, b) => a + b.value, 0) }];
  }
  const total = segs.reduce((a, b) => a + b.value, 0);
  const size = Math.min(260, Math.max(180, width * 0.42));
  const r = size / 2;
  const inner = r * 0.62;
  const stacked = width < 520;
  const cx = r;
  const cy = r;
  const starts = segs.map((_, i) => segs.slice(0, i).reduce((a, b) => a + b.value, 0));
  const pct = (v: number) => (total ? (v / total) * 100 : 0);
  const arcs = segs.map((d, i) => {
    const a0 = -Math.PI / 2 + (total ? (starts[i] / total) * Math.PI * 2 : 0);
    const a1 = a0 + (total ? (d.value / total) * Math.PI * 2 : 0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    const full = a1 - a0 >= Math.PI * 2 - 1e-6;
    const path = full
      ? `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx - 0.01},${cy - r} L${cx - 0.01},${cy - inner} A${inner},${inner} 0 1 0 ${cx},${cy - inner} Z`
      : `M${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} A${inner},${inner} 0 ${large} 0 ${p(a0, inner)} Z`;
    return { ...d, i, path, mid: (a0 + a1) / 2 };
  });
  const show = (i: number) => {
    setHover(i);
    const a = arcs[i];
    setTip({ x: Math.min(cx + (r + 12) * Math.cos(a.mid) + 12, width - 200), y: Math.max(0, cy + r * Math.sin(a.mid) - 20), title: a.label,
      rows: [{ label: `全体の${pct(a.value).toFixed(1)}%`, value: a.value, color: color(i, a.key), line: false }] });
  };
  const clear = () => { setHover(null); setTip(null); };

  return (
    <div style={{ display: "flex", flexDirection: stacked ? "column" : "row", alignItems: stacked ? "flex-start" : "center", gap: 24 }}>
      <svg width={size} height={size} role="img" className="viz-svg" aria-label={`円グラフ。合計 ${fmt(total)}${unit}`}>
        {arcs.map((a) => (
          <path key={a.key} d={a.path} fill={color(a.i, a.key)} stroke="var(--viz-surface)" strokeWidth={2} strokeLinejoin="round"
            opacity={hover === null || hover === a.i ? 1 : 0.5} tabIndex={0} onPointerMove={() => show(a.i)} onFocus={() => show(a.i)}
            onPointerLeave={clear} onBlur={clear} style={{ outline: "none", transformOrigin: `${cx}px ${cy}px`, transform: hover === a.i ? "scale(1.03)" : undefined, transition: "transform .12s" }}>
            <title>{`${a.label} ${fmt(a.value)}${unit}（${pct(a.value).toFixed(1)}%）`}</title>
          </path>
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" className="viz-donut-total">{fmt(total)}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" className="viz-tick">合計（{unit}）</text>
      </svg>
      <ul className="viz-share" aria-label="区分ごとの値と割合">
        {arcs.map((a) => (
          <li key={a.key} onPointerEnter={() => show(a.i)} onPointerLeave={clear} data-active={hover === a.i || undefined}>
            <svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" fill={color(a.i, a.key)} /></svg>
            <span className="viz-share-label">{a.label}</span>
            <strong>{pct(a.value).toFixed(1)}%</strong>
            <span className="viz-share-num">{fmt(a.value)}{unit}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
