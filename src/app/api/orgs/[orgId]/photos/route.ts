import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toMessage } from "@/lib/errors";

// 1) 所属・権限・残り利用枠を確認し、保存容量と解析枠を予約 → 2) 期限付きのアップロードURLを発行
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const body = (await req.json().catch(() => null)) as { filename?: string; mime?: string; size?: number; eventId?: string | null } | null;
  if (!body?.mime || !body.size) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reserve_photo_upload", {
    org: orgId, event: body.eventId || null, file_name: body.filename ?? "", mime: body.mime, size_bytes: body.size,
  });
  if (error) return NextResponse.json({ error: toMessage(error) }, { status: error.message?.startsWith("quota") ? 409 : 400 });
  const { photo_id, path } = data as { photo_id: string; path: string };
  // 予約はユーザー権限で成功している（組織・権限確認済み）ので、URL発行だけサービスロールで行う
  const { data: signed, error: sErr } = await createAdminClient().storage.from("photos").createSignedUploadUrl(path);
  if (sErr) return NextResponse.json({ error: "アップロードURLを発行できませんでした。" }, { status: 500 });
  return NextResponse.json({ photoId: photo_id, path, token: signed.token, signedUrl: signed.signedUrl });
}
