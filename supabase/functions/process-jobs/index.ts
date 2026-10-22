// 非同期処理ワーカー（Supabase Cron から毎分起動）
//   * キュー（pgmq）からジョブを受け取り、団体ごとの同時実行上限を守って処理する
//   * 結果を保存してからメッセージを処理済みにする
//   * 失敗は指数バックオフで再試行し、上限を超えたら隔離（dead）する
//   * サービスロールで動くので、ジョブ・対象データ・保存先の団体の一致を必ず確認する
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createDetector, NonRetryableError } from "../_shared/detector.ts";
import { csvCell } from "../_shared/csv.ts";
import { createMailer, TransportError } from "../_shared/mailer.ts";
import { escapeHtml, renderEmail } from "../_shared/email-render.ts";
import {
  DEFAULT_SETTINGS, mapTileDetection, reviewReasons, suppressDuplicates, type RawDetection, type TileRect,
} from "../_shared/counting.ts";

// 領域分割を使う場合の上限（外部APIの呼び出し回数・処理時間）
const MAX_PROVIDER_CALLS_PER_JOB = Number(Deno.env.get("PHOTO_MAX_PROVIDER_CALLS") ?? "7");
const PHOTO_TIME_BUDGET_MS = Number(Deno.env.get("PHOTO_TIME_BUDGET_MS") ?? "25000");
// API 側にはしきい値より低めの候補まで返させ、整理（suppressDuplicates）で min_score を適用する
const PROVIDER_MIN_CONFIDENCE = Number(Deno.env.get("DETECTOR_CANDIDATE_MIN_CONFIDENCE") ?? "40");

const TIME_BUDGET_MS = Number(Deno.env.get("WORKER_TIME_BUDGET_MS") ?? "40000");
const VISIBILITY_SECONDS = 120;

type Claimed = {
  msg_id: number;
  job_id: string;
  kind: "process_submissions" | "photo_analysis" | "export_people" | "send_campaign" | "send_test_email" | "task_digest";
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

type PhotoRow = {
  id: string; organization_id: string; storage_path: string; size_bytes: number; mime_type: string;
  analysis_path: string | null;
  analysis_meta: { tiles?: (TileRect & { path: string })[]; stats?: { mean_luma?: number } } | null;
};

async function download(db: SupabaseClient, org: string, path: string) {
  // サービスロールで動くので、保存先が対象団体のフォルダであることを必ず確認する
  if (!path.startsWith(`${org}/`)) throw new NonRetryableError("tenant_mismatch");
  const { data, error } = await db.storage.from("photos").download(path);
  if (error || !data) throw new Error(`画像を取得できません: ${error?.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

async function handlePhoto(db: SupabaseClient, job: Claimed, deadline: number) {
  const { data: photo, error } = await db.from("photos")
    .select("id, organization_id, storage_path, size_bytes, mime_type, analysis_path, analysis_meta")
    .eq("id", job.target_id!).eq("organization_id", job.organization_id).maybeSingle<PhotoRow>();
  if (error) throw error;
  if (!photo) throw new NonRetryableError("写真が見つかりません（削除済みの可能性）");
  if (photo.analysis_path) return await handlePhotoV2(db, job, photo, deadline);

  // v1：元ファイルをそのまま検出にかける（photo_pipeline_v2 が無効な団体）
  const bytes = await download(db, job.organization_id, photo.storage_path);
  if (Date.now() > deadline) throw new Error("time_budget_exceeded");
  await rpc(db, "worker_note_external_call", { job: job.job_id });
  const result = await createDetector().detect(bytes);
  await rpc(db, "worker_save_photo_result", {
    job: job.job_id, estimated: result.count, dets: result.detections, provider: result.provider,
    model: result.model, version: result.version, min_conf: result.minConfidence,
  });
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { estimated_count: result.count } });
}

async function handlePhotoV2(db: SupabaseClient, job: Claimed, photo: PhotoRow, deadline: number) {
  const started = Date.now();
  const stopAt = Math.min(deadline, started + PHOTO_TIME_BUDGET_MS);
  const detector = createDetector();
  const tilingOn = await rpc<boolean>(db, "feature_enabled", { org: job.organization_id, flag: "photo_tiling" });
  const tiles = tilingOn ? (photo.analysis_meta?.tiles ?? []) : [];
  let calls = 0;
  let provider = "";
  let model = "";
  let version: string | null = null;

  const call = async (bytes: Uint8Array) => {
    if (calls >= MAX_PROVIDER_CALLS_PER_JOB) throw new Error("max_provider_calls");
    calls++;
    const r = await detector.detect(bytes, { minConfidence: PROVIDER_MIN_CONFIDENCE });
    // 結果保存の前に呼び出しを記録する（保存に失敗して再試行すると、外部APIの料金が再発生しうるため）
    await rpc(db, "worker_note_provider_calls", { job: job.job_id, p_provider: r.provider, calls: 1, units: 1 });
    provider = r.provider; model = r.model; version = r.version;
    return r;
  };

  // 1) 全体画像で検出（基本）
  const full = await call(await download(db, job.organization_id, photo.analysis_path!));
  const raw: RawDetection[] = full.detections.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h, score: d.confidence, source: "full" }));
  const fullOnly = suppressDuplicates(raw, DEFAULT_SETTINGS).filter((d) => d.status === "kept").length;

  // 2) 領域分割（機能フラグ有効時のみ。上限内で、時間が残っている分だけ）
  let tilesUsed = 0;
  let tilesSkipped = 0;
  for (const t of tiles) {
    if (calls >= MAX_PROVIDER_CALLS_PER_JOB || Date.now() > stopAt - 3000) { tilesSkipped++; continue; }
    const r = await call(await download(db, job.organization_id, t.path));
    for (const d of r.detections) raw.push(mapTileDetection({ x: d.x, y: d.y, w: d.w, h: d.h, score: d.confidence }, t));
    tilesUsed++;
  }

  // 3) 整理：重複の抑制（全体と領域の件数は単純加算しない）
  const processed = suppressDuplicates(raw, DEFAULT_SETTINGS);
  const kept = processed.filter((d) => d.status === "kept").length;
  const reasons = reviewReasons({
    detections: processed, mean_luma: photo.analysis_meta?.stats?.mean_luma ?? null,
    full_only_kept: tilesUsed > 0 ? fullOnly : null,
  });
  if (tilesSkipped > 0) reasons.push("tiling_incomplete");

  await rpc(db, "worker_save_analysis_run", {
    job: job.job_id,
    run: {
      estimated_count: kept,
      raw_count: raw.length,
      provider, model, model_version: version,
      duration_ms: Date.now() - started,
      provider_calls: calls,
      tiles_used: tilesUsed,
      review_reasons: reasons,
      settings: {
        ...DEFAULT_SETTINGS, candidate_min_confidence: PROVIDER_MIN_CONFIDENCE,
        tiling: { enabled: tilingOn, available: (photo.analysis_meta?.tiles ?? []).length, used: tilesUsed, skipped: tilesSkipped,
                  max_provider_calls: MAX_PROVIDER_CALLS_PER_JOB },
        full_only_count: fullOnly,
      },
      detections: processed.map((d) => ({
        x: d.x, y: d.y, w: d.w, h: d.h, score: d.score, source: d.source, tile: d.tile ?? null,
        status: d.status, reason: d.reason ?? null, dup_of: d.dup_of ?? null,
      })),
    },
  });
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { estimated_count: kept, provider_calls: calls } });
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
  // 追加項目（使っている項目だけ、表示順に列を足す）
  const { data: defs } = await db.from("custom_field_definitions").select("key, label, field_type")
    .eq("organization_id", org).eq("entity", "person").eq("archived", false).order("position");
  const cfCell = (v: unknown, type: string) =>
    v == null ? "" : Array.isArray(v) ? v.join(" / ") : type === "checkbox" ? (v ? "はい" : "いいえ") : String(v);

  const lines = [["人物ID", "氏名", "ふりがな", "居住地域", "メール", "電話", "タグ", "参加回数", "最終参加日", "登録日",
    ...(defs ?? []).map((d) => d.label)].map(csvCell).join(",")];
  const pageSize = 1000;
  let rows = 0;
  for (let from = 0; ; from += pageSize) {
    let q = db.from("people")
      .select("id, full_name, full_name_kana, region, attendance_count, last_attended_at, created_at, custom_fields, person_contacts(kind, value), person_tags(tag_id)")
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
        ...(defs ?? []).map((d) => cfCell((p.custom_fields as Record<string, unknown> | null)?.[d.key], d.field_type)),
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

const APP_URL = () => (Deno.env.get("APP_URL") ?? "http://localhost:3080").replace(/\/$/, "");
const SEND_INTERVAL_MS = Number(Deno.env.get("MAIL_SEND_INTERVAL_MS") ?? "300");

type RecipientRow = {
  recipient_id: string; email: string; name: string | null; full_name: string | null; display_name: string | null; token: string; subject: string; body_text: string;
  from_name: string | null; reply_to: string | null; org_name: string; sender_info: string;
};

async function handleCampaign(db: SupabaseClient, job: Claimed, deadline: number) {
  const mailer = await createMailer();
  if (!mailer.configured) {
    await rpc(db, "worker_campaign_failed", { job: job.job_id, err: "メール送信が設定されていません" });
    throw new NonRetryableError("メール送信が設定されていません（MAIL_TRANSPORT）");
  }
  let sent = 0;
  let failed = 0;
  while (Date.now() < deadline - 5000) {
    const rows = await rpc<RecipientRow[]>(db, "worker_claim_recipients", { job: job.job_id, max_rows: 20 });
    if (!rows.length) break;
    for (const r of rows) {
      const unsubscribeUrl = `${APP_URL()}/u/${r.token}`;
      const m = renderEmail({
        subject: r.subject, body: r.body_text, name: r.display_name ?? r.name, fullName: r.full_name ?? r.name, orgName: r.org_name,
        senderInfo: r.sender_info, unsubscribeUrl, openPixelUrl: `${APP_URL()}/api/t/o/${r.token}`,
      });
      try {
        const info = await mailer.send({ to: r.email, ...m, fromName: r.from_name ?? r.org_name, replyTo: r.reply_to, unsubscribeUrl });
        await rpc(db, "worker_mark_email", { recipient: r.recipient_id, ok: true, message_id: info.messageId, sent_subject: m.subject });
        sent++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof TransportError) {
          // 送れていないことが確実なので宛先を戻し、ジョブごと再試行する（残りの宛先も送信待ちのまま）
          await rpc(db, "worker_mark_email", { recipient: r.recipient_id, ok: false, err: msg, requeue: true });
          throw e;
        }
        await rpc(db, "worker_mark_email", { recipient: r.recipient_id, ok: false, err: msg });
        failed++;
        // 認証の失敗は全員に影響するので、配信を止めて理由を残す
        if (/EAUTH|Invalid login|Username and Password not accepted|設定されていません/i.test(msg)) {
          await rpc(db, "worker_campaign_failed", { job: job.job_id, err: msg });
          throw new NonRetryableError(msg);
        }
      }
      await new Promise((res) => setTimeout(res, SEND_INTERVAL_MS));
      if (Date.now() > deadline - 5000) break;
    }
  }
  const fin = await rpc<{ remaining: number; sent: number }>(db, "worker_finish_campaign", { job: job.job_id });
  if (fin.remaining > 0) {
    await rpc(db, "worker_requeue", { job: job.job_id, msg: job.msg_id, progress: { sent, failed, remaining: fin.remaining } });
    return;
  }
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { sent: fin.sent, failed } });
}

async function handleTestEmail(db: SupabaseClient, job: Claimed) {
  const mailer = await createMailer();
  const p = job.payload as { campaign_id: string; to: string; name: string };
  const { data: c, error } = await db.from("email_campaigns").select("subject, body_text, from_name, reply_to, organizations(name, email_sender_info)")
    .eq("id", p.campaign_id).eq("organization_id", job.organization_id).single();
  if (error || !c) throw new NonRetryableError("配信が見つかりません");
  const org = c.organizations as unknown as { name: string; email_sender_info: string | null };
  const m = renderEmail({
    subject: `[テスト送信] ${c.subject}`, body: c.body_text, name: p.name, fullName: p.name, orgName: org.name,
    senderInfo: org.email_sender_info ?? "（送信者情報が未設定です。組織設定で入力してください）",
    unsubscribeUrl: `${APP_URL()}/u/test`, openPixelUrl: null,
  });
  const info = await mailer.send({ to: p.to, ...m, fromName: c.from_name ?? org.name, replyTo: c.reply_to });
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { to: p.to, message_id: info.messageId } });
}

const PRIORITY_LABEL: Record<string, string> = { high: "高", normal: "", low: "低" };

async function handleTaskDigest(db: SupabaseClient, job: Claimed) {
  const d = await rpc<{ email: string; name: string; enabled: boolean; org_id: string; org_name: string;
    tasks: { title: string; due_date: string; priority: string; person: string | null; company: string | null }[] } | null>(
    db, "worker_task_digest", { job: job.job_id });
  if (!d || !d.enabled || !d.tasks.length) {
    await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { skipped: true } });
    return;
  }
  const mailer = await createMailer();
  if (!mailer.configured) {
    await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { skipped: "mail_not_configured" } });
    return;
  }
  const today = (job.payload as { date: string }).date;
  const line = (t: (typeof d.tasks)[number]) =>
    `${t.due_date < today ? "【期限切れ】" : "【今日まで】"}${t.due_date} ${t.title}${PRIORITY_LABEL[t.priority] ? `（優先度：${PRIORITY_LABEL[t.priority]}）` : ""}` +
    `${t.person || t.company ? ` ／ ${[t.person, t.company].filter(Boolean).join("・")}` : ""}`;
  const url = `${APP_URL()}/orgs/${d.org_id}/tasks`;
  const text = `${d.name} さん\n\n${d.org_name} で、期限が今日までの未完了タスクが ${d.tasks.length}件あります。\n\n` +
    d.tasks.map(line).join("\n") + `\n\nタスクの一覧：${url}\n\n（この通知はタスク画面の設定で止められます）\n`;
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7">${escapeHtml(text).replace(/\n/g, "<br>").replace(escapeHtml(url), `<a href="${url}">${escapeHtml(url)}</a>`)}</div>`;
  await mailer.send({ to: d.email, subject: `【RelationNote】今日までのタスク ${d.tasks.length}件（${d.org_name}）`, text, html, fromName: "RelationNote" });
  await rpc(db, "worker_complete", { job: job.job_id, msg: job.msg_id, job_result: { tasks: d.tasks.length } });
}

async function maintenance(db: SupabaseClient) {
  const expired = await rpc<{ photo_id: string; storage_path: string; reason: string; extra_paths: string[] }[]>(
    db, "worker_expired_photos", { max_rows: 100 });
  if (!expired.length) return 0;
  await db.storage.from("photos").remove(expired.flatMap((e) => [e.storage_path, ...(e.extra_paths ?? [])]));
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
        else if (job.kind === "send_campaign") await handleCampaign(db, job, deadline);
        else if (job.kind === "send_test_email") await handleTestEmail(db, job);
        else if (job.kind === "task_digest") await handleTaskDigest(db, job);
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
