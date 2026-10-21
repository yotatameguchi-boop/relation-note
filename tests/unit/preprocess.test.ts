import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { analysisMeta, preprocessPhoto, PhotoValidationError } from "@/lib/photo/preprocess";
import { mapBox, rawToUpright } from "../../supabase/functions/_shared/counting";

/** 白地に赤い四角を描いた画像（rawBox は元ファイルの比率座標） */
async function makeImage(w: number, h: number, rawBox: { x: number; y: number; w: number; h: number }, orientation: number) {
  const rect = Buffer.from(
    `<svg width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>` +
    `<rect x="${rawBox.x * w}" y="${rawBox.y * h}" width="${rawBox.w * w}" height="${rawBox.h * h}" fill="#f00"/></svg>`);
  return sharp(rect).jpeg({ quality: 95 })
    .withMetadata({ orientation })
    .withExifMerge({ IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 40/1 0/1" } })
    .toBuffer();
}

/** 解析用画像で赤い領域の範囲（比率）を求める */
async function findRed(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { x: minX / info.width, y: minY / info.height, w: (maxX - minX + 1) / info.width, h: (maxY - minY + 1) / info.height };
}

describe("写真の前処理", () => {
  for (const orientation of [1, 3, 6, 8]) {
    it(`EXIF Orientation=${orientation} の写真を正立させ、検出位置の座標変換と一致する`, async () => {
      const rawBox = { x: 0.1, y: 0.15, w: 0.2, h: 0.3 };
      const img = await makeImage(400, 240, rawBox, orientation);
      const p = await preprocessPhoto(img);
      expect(p.orientation).toBe(orientation);
      const swapped = orientation === 6 || orientation === 8;
      expect([p.upright.width, p.upright.height]).toEqual(swapped ? [240, 400] : [400, 240]);
      expect([p.analysis.width, p.analysis.height]).toEqual(swapped ? [240, 400] : [400, 240]);
      const expected = mapBox(rawBox, (pt) => rawToUpright(pt, orientation));
      const actual = await findRed(p.analysis.buffer);
      for (const k of ["x", "y", "w", "h"] as const) expect(actual[k]).toBeCloseTo(expected[k], 1);
    });
  }

  it("解析用画像から位置情報などのメタデータを除く", async () => {
    const img = await makeImage(400, 240, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 6);
    expect((await sharp(img).metadata()).exif).toBeDefined();
    const p = await preprocessPhoto(img);
    const out = await sharp(p.analysis.buffer).metadata();
    expect(out.exif).toBeUndefined();
    expect(out.orientation).toBeUndefined();
  });

  it("大きな画像は縮小し、縮小率を記録する。ハッシュは元ファイルから計算する", async () => {
    const img = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#888" } }).jpeg().toBuffer();
    const p = await preprocessPhoto(img);
    expect(Math.max(p.analysis.width, p.analysis.height)).toBe(2048);
    expect(p.analysis.scale).toBeCloseTo(2048 / 4000, 5);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    const meta = analysisMeta(p, { analysis: "org/analysis/x.jpg", tiles: [] });
    expect(meta.coordinates).toBe("upright_normalized");
    expect(JSON.stringify(meta)).not.toContain("buffer");
  });

  it("領域分割（機能フラグ有効時）は上限枚数以内で、元画像の比率座標を記録する", async () => {
    const img = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: "#777" } }).jpeg().toBuffer();
    const p = await preprocessPhoto(img, { tiling: true });
    expect(p.tiles.length).toBeGreaterThan(1);
    expect(p.tiles.length).toBeLessThanOrEqual(6);
    expect(Math.max(...p.tiles.map((t) => t.x + t.w))).toBeCloseTo(1, 2);
    const off = await preprocessPhoto(img);
    expect(off.tiles).toEqual([]);
  });

  it("画像でないファイル・小さすぎる画像は受け付けない", async () => {
    await expect(preprocessPhoto(Buffer.from("not an image"))).rejects.toBeInstanceOf(PhotoValidationError);
    const tiny = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(preprocessPhoto(tiny)).rejects.toThrow("小さすぎ");
  });
});
