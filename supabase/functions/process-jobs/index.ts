// 非同期処理ワーカー（Supabase Cron から毎分起動）
//   * キュー（pgmq）からジョブを受け取り、団体ごとの同時実行上限を守って処理する
//   * 結果を保存してからメッセージを処理済みにする
//   * 失敗は指数バックオフで再試行し、上限を超えたら隔離（dead）する
//   * サービスロールで動くので、ジョブ・対象データ・保存先の団体の一致を必ず確認する
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createDetector, NonRetryableError } from "../_shared/detector.ts";
import { csvCell } from "../_shared/csv.ts";

const TIME_BUDGET_MS = Number(Deno.env.get("WORKER_TIME_BUDGET_MS") ?? "40000");
const VISIBILITY_SECONDS = 120;

type Claimed = {
  msg_id: number;
  job_id: string;
  kind: "process_submissions" | "photo_analysis" | "export_people";
  organization_id: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  attempt: number;
};

function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

async function rpc<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function handlePhoto(db: SupabaseClient, job: Claimed, deadline: number) {
  const { data: photo, error } = await db.from("photos")
    .select("id, organization_id, storage_path, size_bytes, mime_type")
    .eq("id", job.target_id!).eq("organization_id", job.organization_id).maybeSingle();
  if (error) throw error;
  if (!photo) throw new NonRetryableError("写真が見つかりません（削除済みの可能性）");
  if (!photo.storage_path.startsWith(`${job.organization_id}/`)) throw new NonRetryableError("tenant_mismatch");
  const { data: blob, error: dlErr } = await db.storage.from("photos").download(photo.storage_path);
  if (dlErr || !blob) throw new Error(`画像を取得できません: ${dlErr?.message}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (Date.now() > deadline) throw new Error("time_budget_exceeded");

  // 外部APIの呼び出しを試行単位で記録（結果保存に失敗して再試行すると料金が再発生しうるため）
  await rpc(db, "worker_note_external_call", { job: job.job_id });
  const result = await createDetector().detect(bytes);

  await rpc(db, "worker_save_photo_result", {
    job: job.job_id,
    estimated: result.count,
    dets: result.detections,
    provider: result.provider,
    model: result.model,
    version: result.version,
    min_conf: result.minConfidence,
  });
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { estimated_count: result.count } });
}

async function handleSubmissions(db: SupabaseClient, job: Claimed, deadline: number) {
  let processed = 0;
  let last: { processed: number; remaining: number; held: number } = { processed: 0, remaining: 0, held: 0 };
  while (Date.now() < deadline) {
    last = await rpc(db, "worker_process_submissions", { job: job.job_id, max_rows: 200 });
    processed += last.processed;
    if (last.remaining === 0 || last.processed === 0) break;
  }
  if (last.remaining > 0 && last.processed > 0) {
    // 残りは次回へ（分割処理）
    await rpc(db, "worker_requeue", { job: job.job_id, msg: job.msg_id, progress: { processed, remaining: last.remaining } });
    return;
  }
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { processed, held: last.held } });
}

async function handleExport(db: SupabaseClient, job: Claimed) {
  const org = job.organization_id;
  const filters = (job.payload.filters ?? {}) as { tag_ids?: string[]; region?: string; q?: string };
  const { data: tags } = await db.from("tags").select("id, name").eq("organization_id", org);
  const tagName = new Map((tags ?? []).map((t) => [t.id, t.name]));

  const lines = [["人物ID", "氏名", "ふりがな", "居住地域", "メール", "電話", "タグ", "参加回数", "最終参加日", "登録日"].map(csvCell).join(",")];
  const pageSize = 1000;
  let rows = 0;
  for (let from = 0; ; from += pageSize) {
    let q = db.from("people")
      .select("id, full_name, full_name_kana, region, attendance_count, last_attended_at, created_at, person_contacts(kind, value), person_tags(tag_id)")
      .eq("organization_id", org) // サービスロールなので団体の絞り込みを必ず明示する
      .order("created_at").order("id")
      .range(from, from + pageSize - 1);
    if (filters.region) q = q.ilike("region", `%${filters.region}%`);
    const { data, error } = await q;
    if (error) throw error;
    for (const p of data ?? []) {
      const tagIds = (p.person_tags as { tag_id: string }[]).map((t) => t.tag_id);
      if (filters.tag_ids?.length && !filters.tag_ids.every((t) => tagIds.includes(t))) continue;
      const contacts = p.person_contacts as { kind: string; value: string }[];
      lines.push([
        p.id, p.full_name, p.full_name_kana, p.region,
        contacts.filter((c) => c.kind === "email").map((c) => c.value).join(" / "),
        contacts.filter((c) => c.kind === "phone").map((c) => c.value).join(" / "),
        tagIds.map((t) => tagName.get(t)).filter(Boolean).join(" / "),
        p.attendance_count, p.last_attended_at?.slice(0, 10), p.created_at.slice(0, 10),
      ].map(csvCell).join(","));
      rows++;
    }
    if (!data || data.length < pageSize) break;
  }
  const path = `${org}/${job.job_id}.csv`;
  const body = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" });
  const { error: upErr } = await db.storage.from("exports").upload(path, body, { contentType: "text/csv", upsert: true });
  if (upErr) throw upErr;
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { path, rows } });
}

async function maintenance(db: SupabaseClient) {
  const expired = await rpc<{ photo_id: string; storage_path: string; reason: string }[]>(db, "worker_expired_photos", { max_rows: 100 });
  if (!expired.length) return 0;
  await db.storage.from("photos").remove(expired.map((e) => e.storage_path));
  for (const e of expired) await rpc(db, "worker_mark_photo_removed", { photo: e.photo_id, reason: e.reason });
  return expired.length;
}

export async function runWorker(db: SupabaseClient) {
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const summary = { processed: 0, failed: 0, removed_photos: 0 };
  while (Date.now() < deadline - 5000) {
    const jobs = await rpc<Claimed[]>(db, "worker_claim", { batch_size: 5, visibility_seconds: VISIBILITY_SECONDS });
    if (!jobs.length) break;
    await Promise.all(jobs.map(async (job) => {
      try {
        if (job.kind === "photo_analysis") await handlePhoto(db, job, deadline);
        else if (job.kind === "process_submissions") await handleSubmissions(db, job, deadline);
        else if (job.kind === "export_people") await handleExport(db, job);
        summary.processed++;
      } catch (e) {
        summary.failed++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`job ${job.job_id} (${job.kind}) failed: ${msg}`);
        await rpc(db, "worker_fail", { job: job.job_id, msg: job.msg_id, err: msg, retryable: !(e instanceof NonRetryableError) })
          .catch((err) => console.error("worker_fail failed", err));
      }
    }));
  }
  summary.removed_photos = await maintenance(db).catch((e) => (console.error("maintenance", e), 0));
  return { ...summary, ms: Date.now() - started };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("WORKER_SECRET");
  if (!secret || req.headers.get("Authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const run = runWorker(admin()).then((r) => (console.log("worker", JSON.stringify(r)), r));
  // Cron（pg_net）は応答を待たずに切断するので、処理は裏で続ける。?sync=1 なら結果を返す（確認用）
  if (new URL(req.url).searchParams.get("sync") === "1") return Response.json(await run);
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(run);
  return Response.json({ accepted: true }, { status: 202 });
});
