import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toMessage } from "@/lib/errors";
import { analysisMeta, preprocessPhoto, PhotoValidationError } from "@/lib/photo/preprocess";

export const runtime = "nodejs";

// アップロード完了後、サーバーで実ファイルの形式・容量・縦横サイズ・保存先の団体を確認してから解析ジョブを登録する。
// photo_pipeline_v2 が有効な団体では、正立・メタデータ除去・縮小した解析用画像（と、必要なら分割画像）を作る。
export async function POST(_req: Request, { params }: { params: Promise<{ orgId: string; photoId: string }> }) {
  const { orgId, photoId } = await params;
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const { data: mem } = await supabase.from("memberships").select("role").eq("organization_id", orgId).eq("user_id", u.user?.id ?? "").maybeSingle();
  if (!mem || !["owner", "admin", "editor"].includes(mem.role)) return NextResponse.json({ error: "この操作を行う権限がありません。" }, { status: 403 });
  const { data: photo } = await supabase.from("photos").select("id, storage_path, status").eq("organization_id", orgId).eq("id", photoId).maybeSingle();
  if (!photo) return NextResponse.json({ error: "対象が見つかりません。" }, { status: 404 });
  if (!photo.storage_path.startsWith(`${orgId}/`)) return NextResponse.json({ error: "対象が見つかりません。" }, { status: 404 });

  const admin = createAdminClient();
  const { data: blob, error: dlErr } = await admin.storage.from("photos").download(photo.storage_path);
  if (dlErr || !blob) return NextResponse.json({ error: "アップロードが完了していません。" }, { status: 409 });
  const input = Buffer.from(await blob.arrayBuffer());

  const { data: flags } = await supabase.from("organization_features").select("photo_pipeline_v2, photo_tiling").eq("organization_id", orgId).maybeSingle();
  let pre;
  try {
    pre = await preprocessPhoto(input, { tiling: Boolean(flags?.photo_pipeline_v2 && flags?.photo_tiling) });
  } catch (e) {
    await admin.storage.from("photos").remove([photo.storage_path]);
    const msg = e instanceof PhotoValidationError ? e.message : "画像を読み込めませんでした。";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  let analysisPath: string | null = null;
  let meta: ReturnType<typeof analysisMeta> | null = null;
  if (flags?.photo_pipeline_v2) {
    analysisPath = `${orgId}/analysis/${photoId}.jpg`;
    const tilePaths = pre.tiles.map((t) => `${orgId}/analysis/${photoId}-t${t.index}.jpg`);
    const uploads = [
      admin.storage.from("photos").upload(analysisPath, pre.analysis.buffer, { contentType: "image/jpeg", upsert: true }),
      ...pre.tiles.map((t, i) => admin.storage.from("photos").upload(tilePaths[i], t.buffer, { contentType: "image/jpeg", upsert: true })),
    ];
    const results = await Promise.all(uploads);
    if (results.some((r) => r.error)) return NextResponse.json({ error: "解析用画像を保存できませんでした。" }, { status: 500 });
    meta = analysisMeta(pre, { analysis: analysisPath, tiles: tilePaths });
  }

  const { data, error } = await admin.rpc("complete_photo_upload_v2", {
    photo: photoId, org: orgId, actual_size: pre.bytes, actual_mime: pre.mime, sha256: pre.sha256,
    p_width: pre.upright.width, p_height: pre.upright.height, p_orientation: pre.orientation,
    p_analysis_path: analysisPath, p_analysis_meta: meta,
  });
  if (error) return NextResponse.json({ error: toMessage(error) }, { status: 400 });
  const r = data as { job_id: string; duplicate_of: string | null };
  return NextResponse.json({ jobId: r.job_id, duplicateOf: r.duplicate_of }, { headers: { "Cache-Control": "private, no-store" } });
}
