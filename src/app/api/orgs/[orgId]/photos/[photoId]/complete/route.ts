import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toMessage } from "@/lib/errors";

function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

// アップロード完了後、サーバーで実ファイルの形式・サイズ・保存先の団体を確認してから解析ジョブを登録する
export async function POST(_req: Request, { params }: { params: Promise<{ orgId: string; photoId: string }> }) {
  const { orgId, photoId } = await params;
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  // 編集者以上であることを RLS 越しに確認
  const { data: mem } = await supabase.from("memberships").select("role").eq("organization_id", orgId).eq("user_id", u.user?.id ?? "").maybeSingle();
  if (!mem || !["owner", "admin", "editor"].includes(mem.role)) return NextResponse.json({ error: "この操作を行う権限がありません。" }, { status: 403 });
  const { data: photo } = await supabase.from("photos").select("id, storage_path, status").eq("organization_id", orgId).eq("id", photoId).maybeSingle();
  if (!photo) return NextResponse.json({ error: "対象が見つかりません。" }, { status: 404 });
  if (!photo.storage_path.startsWith(`${orgId}/`)) return NextResponse.json({ error: "tenant_mismatch" }, { status: 400 });

  const admin = createAdminClient();
  const { data: blob, error: dlErr } = await admin.storage.from("photos").download(photo.storage_path);
  if (dlErr || !blob) return NextResponse.json({ error: "アップロードが完了していません。" }, { status: 409 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = sniff(bytes.subarray(0, 16));
  if (!mime) {
    await admin.storage.from("photos").remove([photo.storage_path]);
    return NextResponse.json({ error: "画像ファイルではありません。" }, { status: 400 });
  }
  const { data: jobId, error } = await admin.rpc("complete_photo_upload", { photo: photoId, org: orgId, actual_size: bytes.byteLength, actual_mime: mime });
  if (error) return NextResponse.json({ error: toMessage(error) }, { status: 400 });
  return NextResponse.json({ jobId });
}
