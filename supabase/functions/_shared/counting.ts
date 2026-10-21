// 写真内の人数カウント：検出結果の整理と座標変換
//
// Deno（Edge Function）と Node（テスト・評価スクリプト）の両方から読み込むため、
// 外部依存も Deno / Node 固有 API も使わない（型注釈は消去できる構文だけ）。
//
// 座標はすべて「正立させた画像」に対する 0〜1 の比率（左上原点）で扱う。

export type Box = { x: number; y: number; w: number; h: number };

export type RawDetection = Box & {
  score: number;              // モデルのスコア（0〜100）。人数が正しい確率ではない
  source: "full" | "tile";
  tile?: number;              // 領域分割の番号
  edge?: boolean;             // 領域の内側の境界に接している（人物が切れている可能性）
};

export type ProcessedDetection = RawDetection & {
  status: "kept" | "suppressed";
  reason?: "below_threshold" | "duplicate" | "tile_boundary_duplicate";
  dup_of?: number;            // 重複とみなした相手（配列の添字）
};

export type CountSettings = {
  min_score: number;                    // これ未満の検出は数えない
  // 同じ解析（全体画像、または同じ領域）の中で、これ以上重なる枠は同じ人物への重複とみなす。
  // 検出API側でも重複はある程度除かれているため、密集した別人をまとめないよう高めにする
  same_source_iou_threshold: number;
  // 別の解析どうし（全体⇔領域、領域⇔領域）で、これ以上重なる枠は同じ人物とみなす
  iou_threshold: number;
  tile_edge_contain_threshold: number;  // 領域の境界で切れた枠が、別の枠にこの割合以上含まれていれば重複とみなす
};

// 既定値は合成データでの比較（eval/reports/）に基づく仮の値。実写真の評価で決め直す
export const DEFAULT_SETTINGS: CountSettings = {
  min_score: 60,
  same_source_iou_threshold: 0.9,
  iou_threshold: 0.55,
  tile_edge_contain_threshold: 0.7,
};

export function area(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

export function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function iou(a: Box, b: Box): number {
  const i = intersection(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/**
 * 重複検出の抑制（スコア順の貪欲法 NMS）。
 *  - 同じ人物に複数の枠が出た場合（全体解析と領域解析の両方で検出された場合を含む）は1つにする
 *  - 領域の境界で切れた枠は、別の解析で得た枠に大部分が含まれていれば重複とみなす
 *  - 同じ解析の中で重なっているだけの枠（密集した別人）は、ほぼ同じ枠（same_source_iou_threshold 以上）でない限り残す
 * 件数を単純加算せず、整理後に残った枠だけを数える。
 */
export function suppressDuplicates(dets: RawDetection[], s: CountSettings = DEFAULT_SETTINGS): ProcessedDetection[] {
  const out: ProcessedDetection[] = dets.map((d) => ({ ...d, status: "kept" as const }));
  const order = out.map((_, i) => i).sort((a, b) => out[b].score - out[a].score || area(out[b]) - area(out[a]));
  const kept: number[] = [];
  for (const i of order) {
    const d = out[i];
    if (d.score < s.min_score) {
      d.status = "suppressed";
      d.reason = "below_threshold";
      continue;
    }
    for (const k of kept) {
      const o = out[k];
      const crossSource = d.source !== o.source || d.tile !== o.tile;
      if (iou(d, o) >= (crossSource ? s.iou_threshold : s.same_source_iou_threshold)) {
        d.status = "suppressed";
        d.reason = "duplicate";
        d.dup_of = k;
        break;
      }
      // 境界で切れた枠：別の解析（全体⇔領域、または別の領域）の枠との包含関係で判定する
      if (crossSource && (d.edge || o.edge)) {
        const smaller = Math.min(area(d), area(o));
        if (smaller > 0 && intersection(d, o) / smaller >= s.tile_edge_contain_threshold) {
          d.status = "suppressed";
          d.reason = "tile_boundary_duplicate";
          d.dup_of = k;
          break;
        }
      }
    }
    if (d.status === "kept") kept.push(i);
  }
  return out;
}

// ------------------------------------------------------------
// 領域分割（高解像度画像の小さな人物向け。機能フラグで有効化し、評価で改善を確認するまで標準にしない）
// ------------------------------------------------------------
export type TileRect = Box & { index: number };  // 正立画像に対する比率

export type TilingOptions = { tile_px: number; overlap: number; max_tiles: number };

export const DEFAULT_TILING: TilingOptions = { tile_px: 1600, overlap: 0.2, max_tiles: 6 };

/** 重なり付きの格子に分割する。画像が小さい場合は分割しない（空配列）。 */
export function computeTiles(widthPx: number, heightPx: number, opt: TilingOptions = DEFAULT_TILING): TileRect[] {
  if (Math.max(widthPx, heightPx) <= opt.tile_px * 1.25) return [];
  const count = (len: number, tile: number) => Math.max(1, Math.ceil((len - tile * opt.overlap) / (tile * (1 - opt.overlap))));
  let tile = opt.tile_px;
  let cols = count(widthPx, tile);
  let rows = count(heightPx, tile);
  // 上限を超える場合は領域を大きくして枚数を減らす
  while (cols * rows > opt.max_tiles) {
    tile = Math.ceil(tile * 1.15);
    cols = count(widthPx, tile);
    rows = count(heightPx, tile);
  }
  const tw = Math.min(1, tile / widthPx);
  const th = Math.min(1, tile / heightPx);
  const tiles: TileRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = cols === 1 ? 0 : (c * (1 - tw)) / (cols - 1);
      const y = rows === 1 ? 0 : (r * (1 - th)) / (rows - 1);
      tiles.push({ index: tiles.length, x: round(x), y: round(y), w: round(tw), h: round(th) });
    }
  }
  return tiles;
}

const EDGE_EPS = 0.01;

/** 領域内の比率座標を、正立画像全体の比率座標へ変換する。内側の境界に接する枠には edge を付ける。 */
export function mapTileDetection(d: Box & { score: number }, tile: TileRect): RawDetection {
  const box = { x: tile.x + d.x * tile.w, y: tile.y + d.y * tile.h, w: d.w * tile.w, h: d.h * tile.h };
  const touches = (pos: number, tileEdge: number, imageEdge: number) =>
    Math.abs(pos - tileEdge) < EDGE_EPS * Math.max(tile.w, tile.h) && Math.abs(tileEdge - imageEdge) > 1e-6;
  const edge =
    touches(box.x, tile.x, 0) || touches(box.y, tile.y, 0) ||
    touches(box.x + box.w, tile.x + tile.w, 1) || touches(box.y + box.h, tile.y + tile.h, 1);
  return { ...clampBox(box), score: d.score, source: "tile", tile: tile.index, edge };
}

// ------------------------------------------------------------
// 回転（EXIF Orientation）の座標変換
// 解析用画像は正立させてあるので、枠はそのまま画面に重ねられる。元ファイル（回転前）の座標が必要な場合はこれで戻す。
// ------------------------------------------------------------
type Pt = { x: number; y: number };

/** 元ファイル（回転前）の比率座標 → 正立画像の比率座標 */
export function rawToUpright(p: Pt, orientation: number): Pt {
  switch (orientation) {
    case 2: return { x: 1 - p.x, y: p.y };
    case 3: return { x: 1 - p.x, y: 1 - p.y };
    case 4: return { x: p.x, y: 1 - p.y };
    case 5: return { x: p.y, y: p.x };
    case 6: return { x: 1 - p.y, y: p.x };
    case 7: return { x: 1 - p.y, y: 1 - p.x };
    case 8: return { x: p.y, y: 1 - p.x };
    default: return { ...p };
  }
}

/** 正立画像の比率座標 → 元ファイル（回転前）の比率座標 */
export function uprightToRaw(p: Pt, orientation: number): Pt {
  switch (orientation) {
    case 2: return { x: 1 - p.x, y: p.y };
    case 3: return { x: 1 - p.x, y: 1 - p.y };
    case 4: return { x: p.x, y: 1 - p.y };
    case 5: return { x: p.y, y: p.x };
    case 6: return { x: p.y, y: 1 - p.x };
    case 7: return { x: 1 - p.y, y: 1 - p.x };
    case 8: return { x: 1 - p.y, y: p.x };
    default: return { ...p };
  }
}

export function mapBox(b: Box, f: (p: Pt) => Pt): Box {
  const a = f({ x: b.x, y: b.y });
  const c = f({ x: b.x + b.w, y: b.y + b.h });
  return clampBox({ x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) });
}

// ------------------------------------------------------------
// 確認を促す理由（スタッフに見てほしい点。精度を保証するものではない）
// ------------------------------------------------------------
export type ReviewInput = {
  detections: ProcessedDetection[];
  mean_luma?: number | null;     // 0〜255
  full_only_kept?: number | null; // 領域分割を使った場合の、全体解析だけでの人数
};

export const REVIEW_REASON_LABEL: Record<string, string> = {
  zero_detections: "人物が検出されませんでした（無人と確定したわけではありません）",
  low_scores: "スコアの低い検出が多く含まれています",
  crowded: "人物が密集・重なっています（見逃しや取り違えが起きやすい状況です）",
  small_people: "小さく写った人物が多く含まれています",
  dark_image: "暗い写真です",
  many_duplicates_removed: "重複とみなして除いた枠が多くあります",
  tiling_disagreement: "全体解析と領域分割の結果が大きく異なります",
  tiling_incomplete: "呼び出し回数・処理時間の上限により、一部の領域を解析していません",
};

export function reviewReasons(inp: ReviewInput): string[] {
  const kept = inp.detections.filter((d) => d.status === "kept");
  const reasons: string[] = [];
  if (kept.length === 0) reasons.push("zero_detections");
  if (kept.length > 0 && kept.filter((d) => d.score < 75).length / kept.length >= 0.3) reasons.push("low_scores");
  let overlapping = 0;
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) if (iou(kept[i], kept[j]) > 0.15) overlapping++;
  if (kept.length >= 15 || overlapping >= 3) reasons.push("crowded");
  if (kept.length > 0 && kept.filter((d) => d.h < 0.08).length / kept.length >= 0.3) reasons.push("small_people");
  if (inp.mean_luma != null && inp.mean_luma < 50) reasons.push("dark_image");
  if (inp.detections.filter((d) => d.reason === "duplicate" || d.reason === "tile_boundary_duplicate").length >= 3) {
    reasons.push("many_duplicates_removed");
  }
  if (inp.full_only_kept != null) {
    const diff = Math.abs(kept.length - inp.full_only_kept);
    if (diff >= Math.max(2, Math.ceil(inp.full_only_kept * 0.2))) reasons.push("tiling_disagreement");
  }
  return reasons;
}

function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

function clampBox(b: Box): Box {
  const x = Math.min(1, Math.max(0, b.x));
  const y = Math.min(1, Math.max(0, b.y));
  return { x: round(x), y: round(y), w: round(Math.max(0, Math.min(1 - x, b.w))), h: round(Math.max(0, Math.min(1 - y, b.h))) };
}
