import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime, MATCH_REASON_LABEL, STATUS_LABEL } from "@/lib/format";
import { StatusBadge } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function ImportPage({ params }: { params: Promise<{ orgId: string; batchId: string }> }) {
  const { orgId, batchId } = await params;
  await requireMembership(orgId, "editor");
  const supabase = await createClient();
  const { data } = await supabase.rpc("import_batch_summary", { batch: batchId });
  const summary = data as { batch: { id: string; organization_id: string; filename: string; status: string; total_rows: number; duplicate_rows: number; created_at: string; finished_at: string | null }; counts: Record<string, number>; held: number } | null;
  if (!summary || summary.batch.organization_id !== orgId) notFound();
  const { data: problems } = await supabase.from("form_submissions")
    .select("id, raw, status, error, match_reason").eq("organization_id", orgId).eq("batch_id", batchId)
    .in("status", ["error", "needs_review"]).order("received_at").limit(200);
  const b = summary.batch;
  const running = b.status === "queued" || b.status === "processing";

  return (
    <>
      {running && <AutoRefresh seconds={3} />}
      <div className="spread"><h1>取り込み結果</h1><Link href={`/orgs/${orgId}/forms`}>← 取り込み・連携</Link></div>
      <p className="muted small">{b.filename}・{fmtDateTime(b.created_at)}・<StatusBadge status={b.status} /></p>
      <div className="grid grid-4">
        <div className="stat"><div className="label">CSVの行数</div><div className="value">{b.total_rows}</div></div>
        <div className="stat"><div className="label">取り込み済みのためスキップ</div><div className="value">{b.duplicate_rows}</div></div>
        {["created", "linked", "needs_review", "error", "pending", "ignored"].map((s) => (
          <div key={s} className="stat"><div className="label">{STATUS_LABEL[s]}</div><div className="value">{summary.counts[s] ?? 0}</div></div>
        ))}
      </div>
      {summary.held > 0 && (
        <div className="notice notice-warn" style={{ marginTop: 12 }}>
          登録人物数の上限に達したため {summary.held} 件を保留しています。プラン変更後、「確認待ちの回答」画面から再処理できます。
        </div>
      )}
      {running && <p className="muted small" style={{ marginTop: 12 }}>処理中です。この画面は自動で更新されます。</p>}
      {(problems ?? []).length > 0 && (
        <>
          <h2>確認が必要な行</h2>
          <p className="small"><Link href={`/orgs/${orgId}/review`}>確認待ちの回答をまとめて処理する →</Link></p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>状態</th><th>内容</th><th>理由</th></tr></thead>
              <tbody>
                {(problems ?? []).map((p) => (
                  <tr key={p.id}>
                    <td><StatusBadge status={p.status} /></td>
                    <td className="small">{Object.values(p.raw as Record<string, string>).filter(Boolean).slice(0, 4).join(" / ")}</td>
                    <td className="small">{p.error ?? MATCH_REASON_LABEL[p.match_reason ?? ""] ?? p.match_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
