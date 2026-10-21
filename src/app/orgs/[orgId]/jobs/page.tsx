import { redirect } from "next/navigation";
import { requireMembership, can, hasPerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { Flash, StatusBadge } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";

const KIND: Record<string, string> = { process_submissions: "回答の取り込み", photo_analysis: "写真解析", export_people: "人物の一括出力" };

async function retry(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("retry_job", { job: String(fd.get("jobId")) });
  if (error) redirect(`/orgs/${orgId}/jobs?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/jobs?ok=${encodeURIComponent("再実行を受け付けました。")}`);
}

export default async function Jobs({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string; highlight?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const { data: jobs } = await supabase.from("jobs").select("id, kind, status, attempts, max_attempts, last_error, result, created_at, finished_at")
    .eq("organization_id", orgId).order("created_at", { ascending: false }).limit(100);
  const active = (jobs ?? []).some((j) => j.status === "queued" || j.status === "running");
  return (
    <>
      {active && <AutoRefresh seconds={5} />}
      <h1>処理状況</h1>
      <p className="muted small">写真解析・CSV取り込み・一括出力は順番に処理されます。失敗した処理は自動で再試行し、続けて失敗したものは「隔離」として止め、確認後に再実行できます。</p>
      <Flash sp={sp} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>受付</th><th>種類</th><th>状態</th><th className="num">試行</th><th>結果・エラー</th><th /></tr></thead>
          <tbody>
            {(jobs ?? []).length === 0 && <tr><td colSpan={6} className="muted">処理はありません。</td></tr>}
            {(jobs ?? []).map((j) => (
              <tr key={j.id} style={sp.highlight === j.id ? { background: "var(--accent-weak)" } : undefined}>
                <td className="small">{fmtDateTime(j.created_at)}</td>
                <td>{KIND[j.kind] ?? j.kind}</td>
                <td><StatusBadge status={j.status} /></td>
                <td className="num">{j.attempts}/{j.max_attempts}</td>
                <td className="small">
                  {j.last_error && <span style={{ color: "var(--danger)" }}>{j.last_error}</span>}
                  {j.kind === "export_people" && j.status === "succeeded" && hasPerm(m, "bulk_export") && (
                    <a href={`/api/orgs/${orgId}/exports/${j.id}`}>CSVをダウンロード（{(j.result as { rows: number }).rows}件）</a>
                  )}
                  {j.kind === "photo_analysis" && j.result && `推定 ${(j.result as { estimated_count: number }).estimated_count}人`}
                  {j.kind === "process_submissions" && j.result && `処理 ${(j.result as { processed: number }).processed}件`}
                </td>
                <td>
                  {j.status === "dead" && can(m, "admin") && (
                    <form action={retry}><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="jobId" value={j.id} /><button className="btn-small">再実行</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
