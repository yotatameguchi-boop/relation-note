"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type ReviewDetection = {
  id: string; idx: number; x: number; y: number; w: number; h: number; score: number | null;
  source: "full" | "tile"; status: "kept" | "suppressed"; suppressed_reason: string | null;
};
type Box = { x: number; y: number; w: number; h: number };
type Mode = "select" | "add" | "move";

const SUPPRESSED_LABEL: Record<string, string> = {
  below_threshold: "スコア不足",
  duplicate: "重複",
  tile_boundary_duplicate: "領域境界の重複",
};

export type SubmitReview = (input: {
  orgId: string; photoId: string; resultId: string; removed: string[]; added: Box[]; moved: (Box & { id: string })[];
  confirmed: number; note: string; seconds: number;
}) => Promise<{ error?: string }>;

export function PhotoReviewer({ orgId, photoId, resultId, imageUrl, detections, canEdit, submit, alreadyConfirmed }: {
  orgId: string; photoId: string; resultId: string; imageUrl: string; detections: ReviewDetection[]; canEdit: boolean;
  submit: SubmitReview; alreadyConfirmed: number | null;
}) {
  const router = useRouter();
  const started = useRef(0);
  useEffect(() => { started.current = Date.now(); }, []);
  const stage = useRef<HTMLDivElement>(null);
  const kept = useMemo(() => detections.filter((d) => d.status === "kept"), [detections]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Box[]>([]);
  const [moved, setMoved] = useState<Record<string, Box>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("select");
  const [showSuppressed, setShowSuppressed] = useState(false);
  const edited = kept.length - removed.size + added.length;
  const [confirmed, setConfirmed] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmedValue = confirmed === "" ? edited : Number(confirmed);

  const avg = useMemo(() => {
    if (!kept.length) return { w: 0.06, h: 0.18 };
    return { w: kept.reduce((s, d) => s + d.w, 0) / kept.length, h: kept.reduce((s, d) => s + d.h, 0) / kept.length };
  }, [kept]);

  function pointFromEvent(e: React.MouseEvent) {
    const r = stage.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  const centered = (p: { x: number; y: number }, size: { w: number; h: number }): Box => {
    const w = Math.min(size.w, 1);
    const h = Math.min(size.h, 1);
    return { x: Math.min(1 - w, Math.max(0, p.x - w / 2)), y: Math.min(1 - h, Math.max(0, p.y - h / 2)), w, h };
  };

  function onStageClick(e: React.MouseEvent) {
    if (!canEdit) return;
    if (mode === "add") {
      setAdded([...added, centered(pointFromEvent(e), avg)]);
    } else if (mode === "move" && selected) {
      const d = kept.find((k) => k.id === selected)!;
      setMoved({ ...moved, [selected]: centered(pointFromEvent(e), { w: d.w, h: d.h }) });
      setMode("select");
    }
  }

  function toggleRemove(id: string) {
    const next = new Set(removed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setRemoved(next);
  }

  async function save() {
    if (confirmed !== "" && Number(confirmed) !== edited && !note.trim()) {
      setError("修正後の枠の数と違う人数で確定する場合は、理由をメモに書いてください。");
      return;
    }
    setBusy(true);
    setError("");
    const r = await submit({
      orgId, photoId, resultId, removed: [...removed], added,
      moved: Object.entries(moved).filter(([id]) => !removed.has(id)).map(([id, b]) => ({ id, ...b })),
      confirmed: confirmedValue, note, seconds: Math.round((Date.now() - started.current) / 1000),
    });
    setBusy(false);
    if (r.error) setError(r.error);
    else router.refresh();
  }

  const pct = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div>
        {canEdit && (
          <div className="row small" style={{ marginBottom: 8 }} role="toolbar" aria-label="修正の操作">
            <button type="button" className={mode === "select" ? "btn-small" : "btn-secondary btn-small"} onClick={() => setMode("select")}>枠を選ぶ</button>
            <button type="button" className={mode === "add" ? "btn-small" : "btn-secondary btn-small"} onClick={() => setMode("add")}>見逃した人物を追加</button>
            <label className="row" style={{ margin: 0, color: "var(--text)" }}>
              <input type="checkbox" checked={showSuppressed} onChange={(e) => setShowSuppressed(e.target.checked)} />除外した枠も表示
            </label>
          </div>
        )}
        <div className="photo-stage" ref={stage} onClick={onStageClick} style={{ cursor: mode === "select" ? "default" : "crosshair" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="イベント写真（解析用に向きを補正した画像）" draggable={false} />
          {showSuppressed && detections.filter((d) => d.status === "suppressed").map((d) => (
            <div key={d.id} className="box box-suppressed" style={pct(d)}><span>{SUPPRESSED_LABEL[d.suppressed_reason ?? ""] ?? "除外"}</span></div>
          ))}
          {kept.map((d) => {
            const b = moved[d.id] ?? d;
            const cls = removed.has(d.id) ? "box box-removed" : selected === d.id ? "box box-selected" : moved[d.id] ? "box box-moved" : "box";
            return (
              <button key={d.id} type="button" className={cls} style={pct(b)}
                aria-label={`検出 ${d.idx + 1}（モデルのスコア ${d.score != null ? Math.round(d.score) : "—"}）${removed.has(d.id) ? "・削除予定" : ""}`}
                onClick={(e) => { if (mode === "select") { e.stopPropagation(); setSelected(d.id === selected ? null : d.id); } }}>
                <span>{removed.has(d.id) ? "×" : d.score != null ? Math.round(d.score) : ""}</span>
              </button>
            );
          })}
          {added.map((b, i) => (
            <button key={`a${i}`} type="button" className="box box-added" style={pct(b)} aria-label={`追加した人物 ${i + 1}（クリックで取り消し）`}
              onClick={(e) => { e.stopPropagation(); if (mode === "select") setAdded(added.filter((_, j) => j !== i)); }}>
              <span>＋</span>
            </button>
          ))}
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          枠の数字はモデルのスコアで、人数が正しい確率ではありません。黄＝検出、橙＝位置を修正、緑＝追加、赤×＝削除予定。
        </p>
        {canEdit && selected && (
          <div className="row small" style={{ marginTop: 6 }}>
            <span>選んだ枠：</span>
            <button type="button" className="btn-secondary btn-small" onClick={() => toggleRemove(selected)}>
              {removed.has(selected) ? "削除を取り消す" : "誤検出として削除"}
            </button>
            <button type="button" className="btn-secondary btn-small" onClick={() => setMode("move")} disabled={removed.has(selected)}>
              位置を修正（次に写真をクリックした場所へ移動）
            </button>
            {moved[selected] && (
              <button type="button" className="btn-secondary btn-small" onClick={() => { const m = { ...moved }; delete m[selected]; setMoved(m); }}>位置を戻す</button>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <table className="small"><tbody>
          <tr><th>検出人数（この解析）</th><td className="num">{kept.length}</td></tr>
          <tr><th>削除</th><td className="num">{removed.size}</td></tr>
          <tr><th>追加</th><td className="num">{added.length}</td></tr>
          <tr><th>位置の修正</th><td className="num">{Object.keys(moved).filter((id) => !removed.has(id)).length}</td></tr>
          <tr><th>修正後の人数</th><td className="num"><strong>{edited}</strong></td></tr>
          <tr><th>確定済みの人数</th><td className="num">{alreadyConfirmed ?? "未確認"}</td></tr>
        </tbody></table>
        {canEdit ? (
          <div style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor="confirmed">写真内の確定人数</label>
              <input id="confirmed" type="number" min={0} value={confirmed} placeholder={String(edited)} onChange={(e) => setConfirmed(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="note">メモ（枠の数と違う人数にする場合は必須）</label>
              <input id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>
            {error && <div className="notice notice-danger small">{error}</div>}
            <button type="button" onClick={save} disabled={busy || Number.isNaN(confirmedValue) || confirmedValue < 0}>
              {confirmedValue}人で確定
            </button>
            <p className="small muted" style={{ marginTop: 8 }}>
              写真内の人数です。イベント全体の参加人数には自動で反映されません。0人で確定しても「無人だった」ことの証明にはなりません。
            </p>
          </div>
        ) : (
          <p className="small muted">確定は編集者以上が行えます。</p>
        )}
      </div>
    </div>
  );
}
