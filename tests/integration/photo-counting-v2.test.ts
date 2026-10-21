// 写真の人数カウント強化（必須テスト）
import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { admin, drainJobs, must, newOrg, newUser, setFeatures, type TestUser } from "./helpers";
import { analysisMeta, preprocessPhoto } from "@/lib/photo/preprocess";
import { mapBox, rawToUpright, reviewReasons, suppressDuplicates, uprightToRaw, type RawDetection } from "@shared/counting";

let u: TestUser, other: TestUser;
let org: string, orgOther: string;

/** アップロード完了処理（API ルートと同じ手順）を行い、写真IDを返す */
async function uploadV2(img: Buffer, eventId: string | null = null) {
  const pre = await preprocessPhoto(img);
  const r = must(await u.client.rpc("reserve_photo_upload", { org, event: eventId, file_name: "p.jpg", mime: pre.mime, size_bytes: img.byteLength })) as { photo_id: string; path: string };
  must(await admin.storage.from("photos").upload(r.path, img, { contentType: pre.mime }));
  const analysisPath = `${org}/analysis/${r.photo_id}.jpg`;
  must(await admin.storage.from("photos").upload(analysisPath, pre.analysis.buffer, { contentType: "image/jpeg" }));
  const done = must(await admin.rpc("complete_photo_upload_v2", {
    photo: r.photo_id, org, actual_size: pre.bytes, actual_mime: pre.mime, sha256: pre.sha256, p_width: pre.upright.width,
    p_height: pre.upright.height, p_orientation: pre.orientation, p_analysis_path: analysisPath,
    p_analysis_meta: analysisMeta(pre, { analysis: analysisPath, tiles: [] }),
  })) as { job_id: string; duplicate_of: string | null };
  return { photoId: r.photo_id, jobId: done.job_id, duplicateOf: done.duplicate_of, pre };
}

/** ワーカーと同じ手順で解析ランを保存する（検出結果は与えたもの） */
async function runWorker(jobId: string, raw: RawDetection[], calls = 1) {
  const claimed = must(await admin.rpc("worker_claim", { batch_size: 20, visibility_seconds: 60 })) as { job_id: string; msg_id: number }[];
  for (const c of claimed.filter((c) => c.job_id !== jobId)) must(await admin.rpc("worker_requeue", { job: c.job_id, msg: c.msg_id }));
  const mine = claimed.find((c) => c.job_id === jobId);
  if (!mine) throw new Error("job not claimed");
  for (let i = 0; i < calls; i++) must(await admin.rpc("worker_note_provider_calls", { job: jobId, p_provider: "test", calls: 1, units: 1 }));
  const processed = suppressDuplicates(raw);
  const run = {
    estimated_count: processed.filter((d) => d.status === "kept").length, raw_count: raw.length, provider: "test", model: "fixture",
    model_version: "1", duration_ms: 12, provider_calls: calls, tiles_used: 0, review_reasons: reviewReasons({ detections: processed }),
    settings: { min_score: 60 }, detections: processed.map((d) => ({ ...d, tile: d.tile ?? null, reason: d.reason ?? null, dup_of: d.dup_of ?? null })),
  };
  const rid = must(await admin.rpc("worker_save_analysis_run", { job: jobId, run })) as string;
  must(await admin.rpc("worker_complete", { job: jobId, msg: mine.msg_id, job_result: { estimated_count: run.estimated_count } }));
  return { rid, run, msg: mine.msg_id };
}

const det = (x: number, y: number, w: number, h: number, score = 90): RawDetection => ({ x, y, w, h, score, source: "full" });

async function image(w: number, h: number, orientation = 1, color = "#888") {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().withMetadata({ orientation }).toBuffer();
}

beforeAll(async () => {
  u = await newUser("photo-v2");
  other = await newUser("photo-v2-other");
  org = await newOrg(u, "写真v2");
  orgOther = await newOrg(other, "別団体");
  await setFeatures(org, { photo_pipeline_v2: true });
  await drainJobs();
});

describe("解析パイプライン v2", () => {
  it("回転した写真は正立画像で保存され、検出位置は正立画像の座標で記録・元座標へ戻せる", async () => {
    const { photoId, jobId, pre } = await uploadV2(await image(600, 300, 6));
    const ph = must(await u.client.from("photos").select("width, height, exif_orientation, analysis_meta").eq("id", photoId).single());
    expect([ph.width, ph.height, ph.exif_orientation]).toEqual([300, 600, 6]);
    expect([pre.analysis.width, pre.analysis.height]).toEqual([300, 600]);
    // 正立画像の右上に人物がいる場合
    const box = { x: 0.6, y: 0.05, w: 0.3, h: 0.4 };
    const { rid } = await runWorker(jobId, [{ ...det(box.x, box.y, box.w, box.h) }]);
    const saved = must(await u.client.from("photo_detections").select("x, y, w, h").eq("analysis_result_id", rid).single());
    expect(saved).toEqual(box);
    // 元ファイル（回転前）の座標に戻し、再び正立へ変換すると一致する
    const raw = mapBox(box, (p) => uprightToRaw(p, 6));
    const back = mapBox(raw, (p) => rawToUpright(p, 6));
    for (const k of ["x", "y", "w", "h"] as const) expect(back[k]).toBeCloseTo(box[k], 6);
  });

  it("重複検出を抑制して数え、抑制した枠も理由付きで保存する。密集した別人はまとめない", async () => {
    const { jobId, photoId } = await uploadV2(await image(400, 300, 1, "#777"));
    const raw = [det(0.1, 0.2, 0.1, 0.4, 95), det(0.101, 0.201, 0.1, 0.399, 80), det(0.18, 0.2, 0.1, 0.4, 88), det(0.5, 0.2, 0.1, 0.4, 50)];
    const { rid } = await runWorker(jobId, raw);
    const run = must(await u.client.from("photo_analysis_results").select("estimated_count, raw_detection_count, pipeline, version_no").eq("id", rid).single());
    expect(run).toEqual({ estimated_count: 2, raw_detection_count: 4, pipeline: "v2", version_no: 1 });
    const ds = must(await u.client.from("photo_detections").select("idx, status, suppressed_reason, duplicate_of_idx").eq("analysis_result_id", rid).order("idx"));
    expect(ds.map((d) => [d.status, d.suppressed_reason])).toEqual([["kept", null], ["suppressed", "duplicate"], ["kept", null], ["suppressed", "below_threshold"]]);
    expect(ds[1].duplicate_of_idx).toBe(0);
    expect(must(await u.client.from("photos").select("status").eq("id", photoId).single()).status).toBe("analyzed");
  });

  it("同じジョブの結果保存を繰り返しても、ラン・検出枠・利用者向け利用量は重複しない。API呼び出しは試行ごとに残る", async () => {
    const usageBefore = (must(await u.client.rpc("org_usage", { org })) as { photo_analysis: { used: number } }).photo_analysis.used;
    const { jobId, photoId } = await uploadV2(await image(400, 300, 1, "#666"));
    const { run } = await runWorker(jobId, [det(0.1, 0.1, 0.1, 0.3), det(0.5, 0.1, 0.1, 0.3)], 2);
    for (let i = 0; i < 2; i++) must(await admin.rpc("worker_save_analysis_run", { job: jobId, run }));
    expect(must(await u.client.from("photo_analysis_results").select("id").eq("photo_id", photoId))).toHaveLength(1);
    expect(must(await u.client.from("photo_detections").select("id").eq("photo_id", photoId))).toHaveLength(2);
    const usageAfter = (must(await u.client.rpc("org_usage", { org })) as { photo_analysis: { used: number } }).photo_analysis.used;
    expect(usageAfter).toBe(usageBefore + 1);
    const calls = must(await u.client.from("analysis_usage_records").select("provider_calls, billable_units").eq("job_id", jobId));
    expect(calls.reduce((s, c) => s + c.provider_calls, 0)).toBe(2);
  });

  it("同じ写真ファイルの再アップロードはハッシュで検出する（人物の重複判定とは別）", async () => {
    const img = await image(320, 240, 1, "#123456");
    const first = await uploadV2(img);
    const second = await uploadV2(img);
    expect(first.duplicateOf).toBeNull();
    expect(second.duplicateOf).toBe(first.photoId);
    await drainJobs();
  });
});

describe("人による修正・確定と再解析", () => {
  let photoId: string, rid1: string, detIds: string[];

  beforeAll(async () => {
    const up = await uploadV2(await image(500, 400, 1, "#345"));
    photoId = up.photoId;
    rid1 = (await runWorker(up.jobId, [det(0.1, 0.1, 0.1, 0.3), det(0.3, 0.1, 0.1, 0.3), det(0.6, 0.1, 0.1, 0.3)])).rid;
    detIds = must(await u.client.from("photo_detections").select("id").eq("analysis_result_id", rid1).order("idx")).map((d) => d.id);
  });

  it("誤検出の削除・見逃しの追加・位置の修正と確定人数が、推定値とは別に保存される", async () => {
    must(await u.client.rpc("submit_photo_count_review", {
      photo: photoId, result_id: rid1, removed: [detIds[2]], added: [{ x: 0.8, y: 0.5, w: 0.08, h: 0.2 }, { x: 0.05, y: 0.6, w: 0.05, h: 0.15 }],
      moved: [{ id: detIds[0], x: 0.12, y: 0.1, w: 0.1, h: 0.3 }], p_confirmed: 4, p_note: "", p_seconds: 37,
    }));
    const r = must(await u.client.from("photo_reviews").select("confirmed_count, detected_count, adjustments, review_seconds, reviewed_by, analysis_result_id").eq("photo_id", photoId).single());
    expect(r).toMatchObject({ confirmed_count: 4, detected_count: 3, review_seconds: 37, reviewed_by: u.id, analysis_result_id: rid1 });
    expect((r.adjustments as { removed: string[]; added: unknown[]; moved: unknown[] }).added).toHaveLength(2);
    expect(must(await u.client.from("photo_analysis_results").select("estimated_count").eq("id", rid1).single()).estimated_count).toBe(3);
  });

  it("他の解析ラン・範囲外の座標は修正対象にできない", async () => {
    const otherRun = await uploadV2(await image(300, 300, 1, "#543"));
    const { rid } = await runWorker(otherRun.jobId, [det(0.2, 0.2, 0.1, 0.3)]);
    const foreign = must(await u.client.from("photo_detections").select("id").eq("analysis_result_id", rid).single()).id;
    expect((await u.client.rpc("submit_photo_count_review", { photo: photoId, result_id: rid1, removed: [foreign], added: [], moved: [], p_confirmed: 2, p_note: "" })).error?.message).toBe("invalid_adjustment");
    expect((await u.client.rpc("submit_photo_count_review", { photo: photoId, result_id: rid1, removed: [], added: [{ x: 1.5, y: 0, w: 0.1, h: 0.1 }], moved: [], p_confirmed: 2, p_note: "" })).error?.message).toBe("invalid_adjustment");
    expect((await u.client.rpc("submit_photo_count_review", { photo: photoId, result_id: rid, removed: [], added: [], moved: [], p_confirmed: 2, p_note: "" })).error?.message).toBe("not_found");
  });

  it("再解析しても確定人数は上書きされず、新しい版として保存される", async () => {
    const job2 = must(await u.client.rpc("reanalyze_photo", { photo: photoId })) as string;
    const { rid: rid2 } = await runWorker(job2, [det(0.1, 0.1, 0.1, 0.3), det(0.3, 0.1, 0.1, 0.3), det(0.6, 0.1, 0.1, 0.3), det(0.8, 0.5, 0.08, 0.2), det(0.4, 0.6, 0.08, 0.2)]);
    const runs = must(await u.client.from("photo_analysis_results").select("id, version_no, estimated_count").eq("photo_id", photoId).order("version_no"));
    expect(runs.map((r) => [r.version_no, r.estimated_count])).toEqual([[1, 3], [2, 5]]);
    const reviews = must(await u.client.from("photo_reviews").select("confirmed_count, analysis_result_id").eq("photo_id", photoId));
    expect(reviews).toEqual([{ confirmed_count: 4, analysis_result_id: rid1 }]);
    // 確認して採用すると、新しい版に対する確定として別に記録される
    must(await u.client.rpc("submit_photo_count_review", { photo: photoId, result_id: rid2, removed: [], added: [], moved: [], p_confirmed: 5, p_note: "" }));
    expect(must(await u.client.from("photo_reviews").select("id").eq("photo_id", photoId))).toHaveLength(2);
  });
});

describe("イベント人数と複数写真", () => {
  it("写真ごとの人数を保持し、合算もイベント人数への自動転記もしない。確定人数は根拠つきで記録する", async () => {
    const ev = must(await u.client.from("events").insert({ organization_id: org, title: "写真の会", starts_at: new Date().toISOString() }).select("id").single()).id;
    const p1 = await uploadV2(await image(400, 300, 1, "#101010"), ev);
    const p2 = await uploadV2(await image(400, 300, 1, "#202020"), ev);
    await runWorker(p1.jobId, Array.from({ length: 6 }, (_, i) => det(0.05 + i * 0.15, 0.3, 0.1, 0.3)));
    await runWorker(p2.jobId, Array.from({ length: 5 }, (_, i) => det(0.05 + i * 0.18, 0.3, 0.1, 0.3)));
    const range = { from_ts: new Date(Date.now() - 86400e3).toISOString(), to_ts: new Date(Date.now() + 86400e3).toISOString() };
    const m = must(await u.client.rpc("org_metrics", { org, ...range })) as { events: { id: string; headcount: number; photo_max_estimated: number }[]; unique_participants: number };
    const e = m.events.find((x) => x.id === ev)!;
    expect(e.headcount).toBe(0);              // 写真の 6+5=11 は転記しない
    expect(e.photo_max_estimated).toBe(6);    // 参考表示は写真ごとの最大値（合算しない）
    expect(m.unique_participants).toBe(0);

    must(await u.client.rpc("confirm_event_headcount", { event: ev, headcount: 9, p_method: "photo_assisted", p_basis: "写真2枚と受付の目視", p_note: "途中参加あり", p_photo_ids: [p1.photoId, p2.photoId] }));
    const rec = must(await u.client.from("event_count_records").select("headcount, method, basis, photo_ids, confirmed_by").eq("event_id", ev).single());
    expect(rec).toMatchObject({ headcount: 9, method: "photo_assisted", basis: "写真2枚と受付の目視", confirmed_by: u.id });
    expect(rec.photo_ids).toHaveLength(2);
    expect(must(await u.client.from("events").select("confirmed_headcount").eq("id", ev).single()).confirmed_headcount).toBe(9);
    // 他団体の写真を根拠に指定できない
    const foreignPhoto = must(await other.client.rpc("reserve_photo_upload", { org: orgOther, event: null, file_name: "x.jpg", mime: "image/jpeg", size_bytes: 10 })) as { photo_id: string };
    expect((await u.client.rpc("confirm_event_headcount", { event: ev, headcount: 9, p_method: "photo_assisted", p_photo_ids: [foreignPhoto.photo_id] })).error).not.toBeNull();
  });
});

describe("団体境界", () => {
  it("別団体の写真・解析結果・検出枠・確定・人数記録・API利用記録を参照できない", async () => {
    for (const t of ["photos", "photo_analysis_results", "photo_detections", "photo_reviews", "event_count_records", "analysis_usage_records"]) {
      const { data } = await other.client.from(t).select("*").eq("organization_id", org);
      expect(data, t).toEqual([]);
    }
    const ph = must(await u.client.from("photos").select("id, analysis_path").eq("organization_id", org).not("analysis_path", "is", null).limit(1).single());
    const dl = await other.client.storage.from("photos").download(ph.analysis_path!);
    expect(dl.data).toBeNull();
    const rid = must(await u.client.from("photo_analysis_results").select("id").eq("photo_id", ph.id).limit(1).single()).id;
    expect((await other.client.rpc("submit_photo_count_review", { photo: ph.id, result_id: rid, removed: [], added: [], moved: [], p_confirmed: 1, p_note: "" })).error).not.toBeNull();
    expect((await other.client.rpc("reanalyze_photo", { photo: ph.id })).error).not.toBeNull();
  });
});

describe("非同期処理", () => {
  it("実行期限を過ぎたジョブは隔離され、利用枠に計上しない", async () => {
    const before = (must(await u.client.rpc("org_usage", { org })) as { photo_analysis: { used: number } }).photo_analysis.used;
    const { jobId, photoId } = await uploadV2(await image(300, 200, 1, "#999"));
    must(await admin.from("jobs").update({ deadline_at: new Date(Date.now() - 1000).toISOString() }).eq("id", jobId));
    await admin.rpc("worker_claim", { batch_size: 20, visibility_seconds: 1 });
    const j = must(await u.client.from("jobs").select("status, last_error").eq("id", jobId).single());
    expect(j.status).toBe("dead");
    expect(j.last_error).toContain("deadline_exceeded");
    expect(must(await u.client.from("photos").select("status").eq("id", photoId).single()).status).toBe("failed");
    const after = (must(await u.client.rpc("org_usage", { org })) as { photo_analysis: { used: number } }).photo_analysis.used;
    expect(after).toBe(before);
    await drainJobs();
  });
});
