import { STATUS_LABEL } from "@/lib/format";

export function Flash({ sp }: { sp: { error?: string; ok?: string } }) {
  return (
    <>
      {sp.error && <div className="notice notice-danger" role="alert">{sp.error}</div>}
      {sp.ok && <div className="notice notice-ok">{sp.ok}</div>}
    </>
  );
}

const TONE: Record<string, string> = {
  attended: "badge-ok", linked: "badge-ok", created: "badge-ok", succeeded: "badge-ok", completed: "badge-ok", analyzed: "badge-ok",
  needs_review: "badge-warn", pending: "badge-warn", queued: "badge-warn", running: "badge-warn", processing: "badge-warn",
  analyzing: "badge-warn", uploading: "badge-warn",
  error: "badge-danger", failed: "badge-danger", dead: "badge-danger", cancelled: "", absent: "",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${TONE[status] ?? ""}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function TagChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="tag"><span className="dot" style={{ background: color }} />{name}</span>
  );
}

export function Meter({ used, limit, label, format }: { used: number; limit: number; label: string; format?: (n: number) => string }) {
  const ratio = limit > 0 ? used / limit : 0;
  const cls = ratio >= 1 ? "meter full" : ratio >= 0.8 ? "meter warn" : "meter";
  const f = format ?? ((n: number) => n.toLocaleString("ja-JP"));
  return (
    <div>
      <div className="spread small"><span>{label}</span><span className="muted">{f(used)} / {f(limit)}</span></div>
      <div className={cls}><span style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
    </div>
  );
}

export function Pager({ page, total, pageSize, hrefFor }: { page: number; total: number; pageSize: number; hrefFor: (p: number) => string }) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager small">
      {page > 1 ? <a href={hrefFor(page - 1)}>← 前へ</a> : <span className="muted">← 前へ</span>}
      <span>{page} / {last}（{total.toLocaleString("ja-JP")}件）</span>
      {page < last ? <a href={hrefFor(page + 1)}>次へ →</a> : <span className="muted">次へ →</span>}
    </div>
  );
}
