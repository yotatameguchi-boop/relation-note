// 人物検出。最初の検証候補は Amazon Rekognition（DetectLabels の Person）。
// 実写真で精度を確認してから採用を決める前提なので、差し替えやすいよう境界をここに閉じる。

export type Detection = { x: number; y: number; w: number; h: number; confidence: number };
export type DetectResult = {
  count: number;
  detections: Detection[];
  provider: string;
  model: string;
  version: string | null;
  minConfidence: number;
};

export class NonRetryableError extends Error {}

export type DetectOptions = { minConfidence?: number };

export interface PersonDetector {
  /** 人物クラスの検出枠（画像に対する 0〜1 の比率）とモデルのスコアを返す。顔検出は使わない */
  detect(image: Uint8Array, opts?: DetectOptions): Promise<DetectResult>;
}

const MIN_CONFIDENCE = Number(Deno.env.get("DETECTOR_MIN_CONFIDENCE") ?? "60");

export function createDetector(): PersonDetector {
  const kind = Deno.env.get("DETECTOR") ?? (Deno.env.get("AWS_ACCESS_KEY_ID") ? "rekognition" : "none");
  if (kind === "rekognition") return new RekognitionDetector();
  if (kind === "mock") return new MockDetector();
  return {
    detect() {
      throw new NonRetryableError("人物検出APIが設定されていません（DETECTOR / AWS認証情報）");
    },
  };
}

class RekognitionDetector implements PersonDetector {
  async detect(image: Uint8Array, opts: DetectOptions = {}): Promise<DetectResult> {
    const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE;
    if (image.byteLength > 5 * 1024 * 1024) {
      throw new NonRetryableError("Rekognition に直接送れるのは5MBまでです。縮小してから再アップロードしてください。");
    }
    const { RekognitionClient, DetectLabelsCommand } = await import("npm:@aws-sdk/client-rekognition@3");
    const client = new RekognitionClient({ region: Deno.env.get("AWS_REGION") ?? "ap-northeast-1" });
    try {
      const out = await client.send(new DetectLabelsCommand({
        Image: { Bytes: image },
        MinConfidence: minConfidence,
        Settings: { GeneralLabels: { LabelInclusionFilters: ["Person"] } },
        Features: ["GENERAL_LABELS"],
      }));
      const person = (out.Labels ?? []).find((l) => l.Name === "Person");
      const detections: Detection[] = (person?.Instances ?? [])
        .filter((i) => i.BoundingBox && (i.Confidence ?? 0) >= minConfidence)
        .map((i) => ({
          x: i.BoundingBox!.Left ?? 0,
          y: i.BoundingBox!.Top ?? 0,
          w: i.BoundingBox!.Width ?? 0,
          h: i.BoundingBox!.Height ?? 0,
          confidence: Math.round((i.Confidence ?? 0) * 10) / 10,
        }));
      return {
        count: detections.length,
        detections,
        provider: "aws-rekognition",
        model: "DetectLabels/Person",
        version: out.LabelModelVersion ?? null,
        minConfidence,
      };
    } catch (e) {
      const name = (e as { name?: string }).name ?? "";
      if (["InvalidImageFormatException", "ImageTooLargeException", "InvalidParameterException", "AccessDeniedException",
           "UnrecognizedClientException", "InvalidSignatureException"].includes(name)) {
        throw new NonRetryableError(`${name}: ${(e as Error).message}`);
      }
      throw e; // スロットリング・一時障害は再試行
    }
  }
}

/** 開発・検証用。画像のバイト列から決まった結果を返す（実際の人物検出ではない）。
 *  重複抑制の動作を画面で確認できるよう、1つ目の枠には少しずらした重複枠を付ける。 */
class MockDetector implements PersonDetector {
  async detect(image: Uint8Array, _opts: DetectOptions = {}): Promise<DetectResult> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(image)));
    const n = 2 + (digest[0] % 9);
    const detections: Detection[] = Array.from({ length: n }, (_, i) => {
      const w = 0.06 + (digest[(i * 3 + 1) % 32] / 255) * 0.08;
      const h = w * 2.2;
      return {
        x: Math.min(0.94 - w, ((i + 0.5) / n) * 0.9 + 0.02),
        y: Math.min(0.96 - h, 0.25 + (digest[(i * 3 + 2) % 32] / 255) * 0.35),
        w,
        h,
        confidence: 60 + (digest[(i * 3 + 3) % 32] % 40),
      };
    });
    if (Deno.env.get("MOCK_FAIL") === "1") throw new Error("ServiceUnavailableException: mock outage");
    const d0 = detections[0];
    detections.push({ x: d0.x + d0.w * 0.04, y: d0.y + d0.h * 0.03, w: d0.w, h: d0.h * 0.97, confidence: Math.max(55, d0.confidence - 12) });
    return { count: detections.length, detections, provider: "mock", model: "mock-detector", version: "dev-2", minConfidence: MIN_CONFIDENCE };
  }
}
