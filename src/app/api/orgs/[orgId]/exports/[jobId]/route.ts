import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// 一括出力のダウンロード。「一括出力」権限を確認してから期限付きURLへリダイレクトする。
export async function GET(_req: Request, { params }: { params: Promise<{ orgId: string; jobId: string }> }) {
  const { orgId, jobId } = await params;
  const supabase = await createClient();
  const { data: allowed } = await supabase.rpc("has_perm", { org: orgId, perm: "bulk_export" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { data: job } = await supabase.from("jobs").select("id, kind, status, result").eq("organization_id", orgId).eq("id", jobId).maybeSingle();
  const path = (job?.result as { path?: string } | null)?.path;
  if (!job || job.kind !== "export_people" || job.status !== "succeeded" || !path?.startsWith(`${orgId}/`)) {
    return NextResponse.json({ error: "not_ready" }, { status: 404 });
  }
  const { data, error } = await createAdminClient().storage.from("exports").createSignedUrl(path, 300, { download: `people-${jobId.slice(0, 8)}.csv` });
  if (error) return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.redirect(data.signedUrl);
}
