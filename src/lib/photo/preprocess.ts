import { createHash } from "node:crypto";
import sharp from "sharp";
import { computeTiles, DEFAULT_TILING, type TileRect, type TilingOptions } from "../../../supabase/functions/_shared/counting.ts";

// 写真の検証と解析用画像の生成（サーバー側。利用者のブラウザでの処理には依存しない）
//   1. 実際の形式・容量・縦横サイズを検証
//   2. EXIF の回転情報を反映して正立させる
//   3. 位置情報などのメタデータを除いた解析用画像を作る（sharp は既定でメタデータを書き出さない）
//   4. 解像度を調整し、元画像との座標の対応を記録する
//   5. （機能フラグ有効時のみ）重なり付きの領域分割画像を作る

export const LIMITS = {
  maxBytes: 15 * 1024 * 1024,
  minEdge: 64,
  maxEdge: 12000,
  maxPixels: 60_000_000,
};

// 全体解析に使う画像の長辺。Rekognition に直接送れる 5MB 以内に収まる大きさ。実写真の評価で決める
export const ANALYSIS_MAX_EDGE = 2048;
// 領域分割のときに元にする画像の長辺上限（小さな人物を拾うため、全体解析より高い解像度を使う）
export const TILE_SOURCE_MAX_EDGE = 4800;

export class PhotoValidationError extends Error {}

export type Preprocessed = {
  format: "jpeg" | "png" | "webp";
  mime: string;
  sha256: string;
  bytes: number;
  orientation: number;
  raw: { width: number; height: number };        // ファイルに格納されている向きのまま
  upright: { width: number; height: number };    // 回転補正後
  analysis: { buffer: Buffer; width: number; height: number; scale: number };
  tiles: (TileRect & { buffer: Buffer; width: number; height: number })[];
  tiling: (TilingOptions & { source_width: number; source_height: number }) | null;
  stats: { mean_luma: number };
};

const MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function preprocessPhoto(input: Buffer, opts: { tiling?: boolean; tilingOptions?: TilingOptions } = {}): Promise<Preprocessed> {
  if (input.byteLength > LIMITS.maxBytes) throw new PhotoValidationError("1枚15MBまでです。");
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(input, { limitInputPixels: LIMITS.maxPixels }).metadata();
  } catch {
    throw new PhotoValidationError("画像として読み込めません。");
  }
  const format = meta.format as string;
  if (!["jpeg", "png", "webp"].includes(format)) throw new PhotoValidationError("JPEG / PNG / WebP の画像を選んでください。");
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (Math.min(w, h) < LIMITS.minEdge) throw new PhotoValidationError("画像が小さすぎます。");
  if (Math.max(w, h) > LIMITS.maxEdge || w * h > LIMITS.maxPixels) throw new PhotoValidationError("画像の縦横サイズが大きすぎます。");
  const orientation = meta.orientation ?? 1;
  const swap = orientation >= 5 && orientation <= 8;
  const upright = { width: swap ? h : w, height: swap ? w : h };

  // rotate() は EXIF の Orientation を反映して正立させる。出力にはメタデータ（位置情報を含む）を付けない
  const base = () => sharp(input, { limitInputPixels: LIMITS.maxPixels }).rotate();
  const scale = Math.min(1, ANALYSIS_MAX_EDGE / Math.max(upright.width, upright.height));
  const aw = Math.round(upright.width * scale);
  const ah = Math.round(upright.height * scale);
  const analysisBuf = await base().resize(aw, ah, { fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const stats = await sharp(analysisBuf).greyscale().stats();

  let tiles: Preprocessed["tiles"] = [];
  let tiling: Preprocessed["tiling"] = null;
  if (opts.tiling) {
    const ts = Math.min(1, TILE_SOURCE_MAX_EDGE / Math.max(upright.width, upright.height));
    const sw = Math.round(upright.width * ts);
    const sh = Math.round(upright.height * ts);
    const topt = opts.tilingOptions ?? DEFAULT_TILING;
    const rects = computeTiles(sw, sh, topt);
    if (rects.length) {
      const source = await base().resize(sw, sh, { fit: "fill" }).toBuffer();
      tiles = await Promise.all(rects.map(async (r) => {
        const left = Math.round(r.x * sw);
        const top = Math.round(r.y * sh);
        const width = Math.min(sw - left, Math.round(r.w * sw));
        const height = Math.min(sh - top, Math.round(r.h * sh));
        const buffer = await sharp(source).extract({ left, top, width, height })
          .resize({ width: Math.min(width, ANALYSIS_MAX_EDGE), height: Math.min(height, ANALYSIS_MAX_EDGE), fit: "inside" })
          .jpeg({ quality: 90 }).toBuffer();
        // 実際に切り出した範囲（丸め後）で比率を記録し直す
        return { index: r.index, x: left / sw, y: top / sh, w: width / sw, h: height / sh, buffer, width, height };
      }));
      tiling = { ...topt, source_width: sw, source_height: sh };
    }
  }

  return {
    format: format as Preprocessed["format"],
    mime: MIME[format],
    sha256: createHash("sha256").update(input).digest("hex"),
    bytes: input.byteLength,
    orientation,
    raw: { width: w, height: h },
    upright,
    analysis: { buffer: analysisBuf, width: aw, height: ah, scale },
    tiles,
    tiling,
    stats: { mean_luma: Math.round(stats.channels[0].mean * 10) / 10 },
  };
}

/** photos.analysis_meta に保存する内容（画像本体は含めない） */
export function analysisMeta(p: Preprocessed, paths: { analysis: string; tiles: string[] }) {
  return {
    version: 2,
    original: { format: p.format, raw_width: p.raw.width, raw_height: p.raw.height, orientation: p.orientation },
    upright: p.upright,
    analysis: { path: paths.analysis, width: p.analysis.width, height: p.analysis.height, scale: p.analysis.scale },
    // 検出枠は正立画像に対する比率で保存する。元ファイルの座標へは counting.ts の uprightToRaw で戻せる
    coordinates: "upright_normalized",
    metadata_stripped: true,
    tiling: p.tiling,
    tiles: p.tiles.map((t, i) => ({ index: t.index, x: t.x, y: t.y, w: t.w, h: t.h, width: t.width, height: t.height, path: paths.tiles[i] })),
    stats: p.stats,
  };
}
