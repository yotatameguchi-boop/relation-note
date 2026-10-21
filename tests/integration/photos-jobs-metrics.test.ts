// 受け入れ条件：推定人数と確定人数の分離／写真人数を実参加者数として扱わない／
// 利用上限到達時の状態／ジョブ再実行で結果・利用量が重複しない
import { beforeAll, describe, expect, it } from "vitest";
import { admin, drainJobs, must, newOrg, newUser, type TestUser } from "./helpers";

let u: TestUser;
let org: string;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

async function uploadPhoto(eventId: string | null) {
  const r = must(await u.client.rpc("reserve_photo_upload", { org, event: eventId, file_name: "p.jpg", mime: "image/jpeg", size_bytes: JPEG.byteLength })) as { photo_id: string; path: string };
  must(await admin.storage.from("photos").upload(r.path, new Blob([JPEG], { type: "image/jpeg" })));
  const job = must(await admin.rpc("complete_photo_upload", { photo: r.photo_id, org, actual_size: JPEG.byteLength, actual_mime: "image/jpeg" })) as string;
  return { photoId: r.photo_id, jobId: job, path: r.path };
}

async function usage() {
  return must(await u.client.rpc("org_usage", { org })) as Record<string, { used: number; limit: number }>;
}

beforeAll(async () => {
  u = await newUser("photo");
  org = await newOrg(u);
});

describe("写真解析", () => {
  it("推定値と確定値が別に保存され、イベント参加人数へ自動転記されない", async () => {
    const ev = must(await u.client.from("events").insert({ organization_id: org, title: "清掃活動", starts_at: new Date().toISOString(), anonymous_count: 2 }).select("id").single()).id;
    const people = await Promise.all(["A", "B", "C"].map(async (n) => must(await u.client.rpc("create_person", { org, data: { full_name: n } })) as string));
    must(await u.client.from("event_participations").insert(people.map((p) => ({ organization_id: org, event_id: ev, person_id: p, status: "attended" }))));

    const p1 = await uploadPhoto(ev);
    const p2 = await uploadPhoto(ev);
    await drainJobs();
    const results = must(await u.client.from("photo_analysis_results").select("estimated_count, model_provider").eq("photo_id", p1.photoId));
    expect(results).toEqual([{ estimated_count: 7, model_provider: "test" }]);

    must(await u.client.from("photo_reviews").insert({ organization_id: org, photo_id: p1.photoId, confirmed_count: 9, reviewed_by: u.id }));
    const est = must(await u.client.from("photo_analysis_results").select("estimated_count").eq("photo_id", p1.photoId).single());
    expect(est.estimated_count).toBe(7); // 推定値はそのまま残る

    const metrics = must(await u.client.rpc("org_metrics", { org, from_ts: new Date(Date.now() - 86400000).toISOString(), to_ts: new Date(Date.now() + 86400000).toISOString() })) as {
      unique_participants: number; total_participation: number; events: { headcount: number; photo_max_estimated: number; photo_max_confirmed: number }[];
    };
    // 写真2枚 × 7人 = 14 を合算せず、参加人数は参加確認3＋匿名2
    expect(metrics.unique_participants).toBe(3);
    expect(metrics.total_participation).toBe(5);
    expect(metrics.events[0].headcount).toBe(5);
    expect(metrics.events[0].photo_max_estimated).toBe(7);
    expect(metrics.events[0].photo_max_confirmed).toBe(9);
    void p2;

    // スタッフが参加人数を確定すれば確定値が使われる
    must(await u.client.rpc("confirm_event_headcount", { event: ev, headcount: 12 }));
    const m2 = must(await u.client.rpc("org_metrics", { org, from_ts: new Date(Date.now() - 86400000).toISOString(), to_ts: new Date(Date.now() + 86400000).toISOString() })) as { total_participation: number; unique_participants: number };
    expect(m2.total_participation).toBe(12);
    expect(m2.unique_participants).toBe(3);
  });

  it("同じジョブの結果保存を繰り返しても、結果も利用量も重複しない", async () => {
    const before = (await usage()).photo_analysis.used;
    const { photoId, jobId } = await uploadPhoto(null);
    for (let i = 0; i < 3; i++) {
      must(await admin.rpc("worker_save_photo_result", { job: jobId, estimated: 4, dets: [], provider: "test", model: "x", version: null, min_conf: 60 }));
    }
    const rs = must(await u.client.from("photo_analysis_results").select("id").eq("photo_id", photoId));
    expect(rs.length).toBe(1);
    expect((await usage()).photo_analysis.used).toBe(before + 1);
    await drainJobs(); // キューに残ったメッセージは完了済みとして処理される
    const rs2 = must(await u.client.from("photo_analysis_results").select("id").eq("photo_id", photoId));
    expect(rs2.length).toBe(1);
  });

  it("同じ写真の解析ジョブは二重に積まれない", async () => {
    const { photoId } = await uploadPhoto(null);
    const again = must(await admin.rpc("complete_photo_upload", { photo: photoId, org, actual_size: JPEG.byteLength, actual_mime: "image/jpeg" }));
    const jobs = must(await u.client.from("jobs").select("id").eq("target_id", photoId));
    expect(jobs.length).toBe(1);
    expect(again).toBe(jobs[0].id);
    await drainJobs();
  });

  it("申告と違うファイルは受け付けない", async () => {
    const r = must(await u.client.rpc("reserve_photo_upload", { org, event: null, file_name: "x.jpg", mime: "image/jpeg", size_bytes: 100 })) as { photo_id: string };
    const { error } = await admin.rpc("complete_photo_upload", { photo: r.photo_id, org, actual_size: 100, actual_mime: "image/png" });
    expect(error?.message).toBe("upload_mismatch");
    // 別団体を名乗っても完了できない
    const { error: e2 } = await admin.rpc("complete_photo_upload", { photo: r.photo_id, org: "00000000-0000-0000-0000-000000000000", actual_size: 100, actual_mime: "image/jpeg" });
    expect(e2?.message).toBe("not_found");
  });

  it("失敗したジョブは再試行待ちになり、上限回数で隔離される。隔離分は利用枠に計上せず、再実行できる", async () => {
    await drainJobs();
    const before = (await usage()).photo_analysis.used;
    const { photoId, jobId } = await uploadPhoto(null);
    expect((await usage()).photo_analysis.used).toBe(before + 1); // 予約中
    const claim = async (id: string) => {
      const claimed = must(await admin.rpc("worker_claim", { batch_size: 10, visibility_seconds: 30 })) as { job_id: string; msg_id: number }[];
      for (const c of claimed.filter((c) => c.job_id !== id)) must(await admin.rpc("worker_requeue", { job: c.job_id, msg: c.msg_id }));
      return claimed.find((c) => c.job_id === id);
    };
    // 1枚目：上限に達していなければ再試行待ち（バックオフ中は取り出されない）
    const other = await uploadPhoto(null);
    const c1 = await claim(other.jobId);
    expect(must(await admin.rpc("worker_fail", { job: other.jobId, msg: c1!.msg_id, err: "ThrottlingException", retryable: true }))).toBe("retry");
    expect(must(await u.client.from("jobs").select("status").eq("id", other.jobId).single()).status).toBe("queued");
    expect(await claim(other.jobId)).toBeUndefined();

    // 2枚目：試行上限に達すると隔離
    must(await admin.from("jobs").update({ max_attempts: 1 }).eq("id", jobId));
    const c2 = await claim(jobId);
    expect(must(await admin.rpc("worker_fail", { job: jobId, msg: c2!.msg_id, err: "ThrottlingException", retryable: true }))).toBe("dead");
    const job = must(await u.client.from("jobs").select("status, attempts").eq("id", jobId).single());
    expect(job.status).toBe("dead");
    const photo = must(await u.client.from("photos").select("status, failure_reason").eq("id", photoId).single());
    expect(photo.status).toBe("failed");
    expect((await usage()).photo_analysis.used).toBe(before + 1); // 2枚目の予約を解放（1枚目は予約中）
    const attempts = must(await admin.from("job_attempts").select("outcome, external_calls").eq("job_id", jobId));
    expect(attempts.some((a) => a.outcome === "failed")).toBe(true);

    must(await u.client.rpc("retry_job", { job: jobId }));
    await drainJobs();
    const after = must(await u.client.from("photos").select("status").eq("id", photoId).single());
    expect(after.status).toBe("analyzed");
    expect((await usage()).photo_analysis.used).toBe(before + 2);
  });
});

describe("利用上限", () => {
  it("写真解析枠の上限に達すると新規の予約を止め、既存データは閲覧できる", async () => {
    const small = await newUser("small");
    const o = await newOrg(small);
    await admin.from("plans").upsert({ id: "test-tiny", name: "テスト", max_staff: 2, max_people: 2, max_photo_analyses_per_month: 1, max_storage_bytes: 1000 });
    must(await admin.from("organizations").update({ plan_id: "test-tiny" }).eq("id", o));
    must(await small.client.rpc("reserve_photo_upload", { org: o, event: null, file_name: "1.jpg", mime: "image/jpeg", size_bytes: 10 }));
    const { error } = await small.client.rpc("reserve_photo_upload", { org: o, event: null, file_name: "2.jpg", mime: "image/jpeg", size_bytes: 10 });
    expect(error?.message).toBe("quota_exceeded:photo_analysis");
    expect(error?.hint).toContain("写真解析枠");

    // 登録人物の上限
    must(await small.client.rpc("create_person", { org: o, data: { full_name: "1" } }));
    must(await small.client.rpc("create_person", { org: o, data: { full_name: "2" } }));
    const { error: e2 } = await small.client.rpc("create_person", { org: o, data: { full_name: "3" } });
    expect(e2?.message).toBe("quota_exceeded:people");
    // 既存データの閲覧は可能
    const { data } = await small.client.from("people").select("id").eq("organization_id", o);
    expect(data!.length).toBe(2);

    // CSV取り込みは上限到達分を保留（エラーにしない）
    const conn = must(await small.client.from("form_connections").insert({ organization_id: o, name: "c", kind: "csv", field_mapping: { n: "full_name" } }).select("id").single()).id;
    const batch = must(await small.client.rpc("create_import_batch", { conn, file_name: "x.csv" })) as string;
    must(await small.client.rpc("append_import_rows", { batch, rows: [{ raw: { n: "保留される人" } }] }));
    must(await small.client.rpc("start_import_batch", { batch }));
    await drainJobs();
    const sub = must(await small.client.from("form_submissions").select("status, error").eq("batch_id", batch).single());
    expect(sub.status).toBe("pending");
    expect(sub.error).toContain("上限");

    // スタッフ上限
    const s2 = await newUser("s2");
    must(await small.client.rpc("create_invitation", { org: o, invitee_email: s2.email, invitee_role: "viewer", invitee_permissions: [] }));
    const s3 = await newUser("s3");
    const { error: e3 } = await small.client.rpc("create_invitation", { org: o, invitee_email: s3.email, invitee_role: "viewer", invitee_permissions: [] });
    expect(e3?.message).toBe("quota_exceeded:staff");
  });

  it("停止中の団体は閲覧のみ", async () => {
    const s = await newUser("susp");
    const o = await newOrg(s);
    must(await s.client.rpc("create_person", { org: o, data: { full_name: "既存" } }));
    must(await admin.from("organizations").update({ status: "suspended" }).eq("id", o));
    expect((await s.client.from("people").select("id").eq("organization_id", o)).data!.length).toBe(1);
    expect((await s.client.rpc("create_person", { org: o, data: { full_name: "新規" } })).error).not.toBeNull();
  });
});
