import { describe, expect, it } from "vitest";
import {
  computeTiles, DEFAULT_SETTINGS, iou, mapBox, mapTileDetection, rawToUpright, reviewReasons, suppressDuplicates,
  uprightToRaw, type RawDetection,
} from "../../supabase/functions/_shared/counting";

const det = (x: number, y: number, w: number, h: number, score = 90, extra: Partial<RawDetection> = {}): RawDetection =>
  ({ x, y, w, h, score, source: "full", ...extra });
const kept = (ds: ReturnType<typeof suppressDuplicates>) => ds.filter((d) => d.status === "kept").length;

describe("重複検出の抑制", () => {
  it("同じ人物への重複検出（ほぼ同じ枠）は1つにまとめ、スコアの高い枠を残す", () => {
    const out = suppressDuplicates([det(0.1, 0.1, 0.1, 0.3, 80), det(0.101, 0.102, 0.1, 0.298, 95)]);
    expect(kept(out)).toBe(1);
    expect(out[0]).toMatchObject({ status: "suppressed", reason: "duplicate", dup_of: 1 });
  });

  it("同じ解析の中ではほぼ同じ枠だけを重複とし、全体解析と領域解析の間ではより広く重複とみなす", () => {
    const a = det(0.1, 0.1, 0.1, 0.3, 90);
    const b = det(0.106, 0.11, 0.1, 0.29, 85); // IoU ≈ 0.8
    expect(iou(a, b)).toBeGreaterThan(DEFAULT_SETTINGS.iou_threshold);
    expect(iou(a, b)).toBeLessThan(DEFAULT_SETTINGS.same_source_iou_threshold);
    expect(kept(suppressDuplicates([a, b]))).toBe(2);                                   // 同じ全体解析：別人の可能性を残す
    expect(kept(suppressDuplicates([a, { ...b, source: "tile", tile: 0 }]))).toBe(1);  // 全体と領域：同じ人物の二重計上
  });

  it("重なっている別人（肩を寄せた2人、前後に重なる2人）は過剰にまとめない", () => {
    const side = [det(0.30, 0.2, 0.10, 0.40), det(0.36, 0.2, 0.10, 0.40)];         // IoU ≈ 0.25
    const front = [det(0.50, 0.30, 0.12, 0.45), det(0.53, 0.22, 0.10, 0.38, 70)];   // 後ろの人が半分隠れる
    expect(iou(side[0], side[1])).toBeLessThan(DEFAULT_SETTINGS.iou_threshold);
    expect(kept(suppressDuplicates(side))).toBe(2);
    expect(kept(suppressDuplicates(front))).toBe(2);
  });

  it("密集した10人の列を1人にまとめない", () => {
    const row = Array.from({ length: 10 }, (_, i) => det(0.05 + i * 0.085, 0.4, 0.1, 0.3, 85));
    expect(kept(suppressDuplicates(row))).toBe(10);
  });

  it("しきい値未満のスコアは数えない（理由を残す）", () => {
    const out = suppressDuplicates([det(0.1, 0.1, 0.1, 0.1, 40), det(0.5, 0.5, 0.1, 0.1, 61)]);
    expect(kept(out)).toBe(1);
    expect(out[0].reason).toBe("below_threshold");
  });
});

describe("領域分割", () => {
  it("小さい画像は分割しない。大きい画像は上限枚数以内で全体を覆い、隣と重なる", () => {
    expect(computeTiles(1800, 1200)).toEqual([]);
    const tiles = computeTiles(6000, 4000, { tile_px: 1600, overlap: 0.2, max_tiles: 6 });
    expect(tiles.length).toBeLessThanOrEqual(6);
    expect(tiles.length).toBeGreaterThan(1);
    expect(Math.min(...tiles.map((t) => t.x))).toBe(0);
    expect(Math.max(...tiles.map((t) => t.x + t.w))).toBeCloseTo(1, 5);
    expect(Math.max(...tiles.map((t) => t.y + t.h))).toBeCloseTo(1, 5);
    const sorted = tiles.filter((t) => t.y === 0).sort((a, b) => a.x - b.x);
    expect(sorted[1].x).toBeLessThan(sorted[0].x + sorted[0].w); // 重なりがある
  });

  it("領域内の座標を元画像の座標に変換する", () => {
    const tile = { index: 3, x: 0.5, y: 0.25, w: 0.5, h: 0.5 };
    const m = mapTileDetection({ x: 0.2, y: 0.4, w: 0.1, h: 0.2, score: 90 }, tile);
    expect(m).toMatchObject({ x: 0.6, y: 0.45, w: 0.05, h: 0.1, source: "tile", tile: 3, edge: false });
  });

  it("領域の内側の境界に接する枠には印を付け、画像の外枠に接するだけなら付けない", () => {
    const left = { index: 0, x: 0, y: 0, w: 0.6, h: 1 };
    expect(mapTileDetection({ x: 0.9, y: 0.3, w: 0.1, h: 0.3, score: 90 }, left).edge).toBe(true);  // 右端＝内側の境界
    expect(mapTileDetection({ x: 0, y: 0.3, w: 0.1, h: 0.3, score: 90 }, left).edge).toBe(false);   // 左端＝画像の外枠
  });

  it("境界をまたぐ人物の重複を抑制し、全体解析と領域解析の件数を単純加算しない", () => {
    const left = { index: 0, x: 0, y: 0, w: 0.6, h: 1 };
    const right = { index: 1, x: 0.4, y: 0, w: 0.6, h: 1 };
    // 実際の人物：x=0.55〜0.65（左領域の境界 0.6 をまたぐ）と、x=0.2 の人、x=0.8 の人
    const full = [det(0.55, 0.3, 0.1, 0.3, 88), det(0.2, 0.3, 0.06, 0.3, 90), det(0.8, 0.3, 0.06, 0.3, 90)];
    const tileDets = [
      mapTileDetection({ x: 0.55 / 0.6, y: 0.3, w: 0.05 / 0.6, h: 0.3, score: 80 }, left),            // 左領域で切れた枠
      mapTileDetection({ x: (0.55 - 0.4) / 0.6, y: 0.3, w: 0.1 / 0.6, h: 0.3, score: 92 }, right),   // 右領域では全体が入る
      mapTileDetection({ x: 0.2 / 0.6, y: 0.3, w: 0.06 / 0.6, h: 0.3, score: 91 }, left),
      mapTileDetection({ x: (0.8 - 0.4) / 0.6, y: 0.3, w: 0.06 / 0.6, h: 0.3, score: 89 }, right),
      mapTileDetection({ x: (0.45 - 0.4) / 0.6, y: 0.7, w: 0.02 / 0.6, h: 0.08, score: 75 }, right),  // 全体解析で見逃した小さな人物
    ];
    expect(tileDets[0].edge).toBe(true);
    // 切れた枠は IoU だけでは重複と判定できない大きさ（0.5）なので、境界の包含判定が必要になる
    expect(iou(tileDets[0], tileDets[1])).toBeLessThan(DEFAULT_SETTINGS.iou_threshold);
    const out = suppressDuplicates([...full, ...tileDets]);
    expect(full.length + tileDets.length).toBe(8);
    expect(kept(out)).toBe(4);
    expect(out.filter((d) => d.reason === "tile_boundary_duplicate").length).toBeGreaterThanOrEqual(1);
  });
});

describe("回転（EXIF Orientation）の座標変換", () => {
  it("全8種類で、元座標→正立→元座標が一致する", () => {
    for (let o = 1; o <= 8; o++) {
      const p = { x: 0.13, y: 0.71 };
      const back = uprightToRaw(rawToUpright(p, o), o);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("右90度回転（6）の写真で、元ファイル左上の枠は正立画像の右上に来る", () => {
    const b = mapBox({ x: 0.1, y: 0.1, w: 0.1, h: 0.2 }, (p) => rawToUpright(p, 6));
    expect(b).toEqual({ x: 0.7, y: 0.1, w: 0.2, h: 0.1 });
  });
});

describe("確認を促す理由", () => {
  it("0人は「無人と確定」ではなく確認対象にする", () => {
    expect(reviewReasons({ detections: [] })).toContain("zero_detections");
  });
  it("暗い写真・小さな人物・領域分割との差を指摘する", () => {
    const small = Array.from({ length: 5 }, (_, i) => ({ ...det(i * 0.15, 0.5, 0.03, 0.05, 90), status: "kept" as const }));
    const r = reviewReasons({ detections: small, mean_luma: 30, full_only_kept: 2 });
    expect(r).toEqual(expect.arrayContaining(["small_people", "dark_image", "tiling_disagreement"]));
  });
});
