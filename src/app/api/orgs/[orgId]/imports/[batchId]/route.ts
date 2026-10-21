import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";

// { rows: [...] } で行を追加、{ start: true } で処理開始（ジョブ登録）
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string; batchId: string }> }) {
  const { orgId, batchId } = await params;
  const body = (await req.json().catch(() => null)) as { rows?: unknown[]; start?: boolean } | null;
  const supabase = await createClient();
  const { data: batch } = await supabase.from("import_batches").select("id").eq("organization_id", orgId).eq("id", batchId).maybeSingle();
  if (!batch) return NextResponse.json({ error: "対象が見つかりません。" }, { status: 404 });
  if (body?.start) {
    const { data, error } = await supabase.rpc("start_import_batch", { batch: batchId });
    if (error) return NextResponse.json({ error: toMessage(error) }, { status: 400 });
    return NextResponse.json({ jobId: data });
  }
  if (!Array.isArray(body?.rows)) return NextResponse.json({ error: "rows is required" }, { status: 400 });
  const { data, error } = await supabase.rpc("append_import_rows", { batch: batchId, rows: body.rows });
  if (error) return NextResponse.json({ error: toMessage(error) }, { status: 400 });
  return NextResponse.json(data);
}
