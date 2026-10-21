import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";

// CSV取り込みのバッチを作成する。行は /imports/[batchId] に分割して送る。
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const body = (await req.json().catch(() => null)) as { connectionId?: string; filename?: string } | null;
  if (!body?.connectionId) return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
  const supabase = await createClient();
  // 接続がこの団体のものか（RLS越しに）確認
  const { data: conn } = await supabase.from("form_connections").select("id").eq("organization_id", orgId).eq("id", body.connectionId).maybeSingle();
  if (!conn) return NextResponse.json({ error: "対象が見つかりません。" }, { status: 404 });
  const { data, error } = await supabase.rpc("create_import_batch", { conn: conn.id, file_name: (body.filename ?? "").slice(0, 255) });
  if (error) return NextResponse.json({ error: toMessage(error) }, { status: 400 });
  return NextResponse.json({ batchId: data });
}
