import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* CI では環境変数で渡す */
}

export const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { persistSession: false } });

export async function newUser(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.example`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: label } });
  if (error) throw error;
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, email, password, client };
}

export type TestUser = Awaited<ReturnType<typeof newUser>>;

export async function newOrg(owner: TestUser, name = "テスト団体") {
  const { data, error } = await owner.client.rpc("create_organization", { org_name: name });
  if (error) throw error;
  return data as string;
}

export async function join(org: string, inviter: TestUser, invitee: TestUser, role: string, permissions: string[] = []) {
  const { data: token, error } = await inviter.client.rpc("create_invitation", {
    org, invitee_email: invitee.email, invitee_role: role, invitee_permissions: permissions,
  });
  if (error) throw error;
  const { error: e2 } = await invitee.client.rpc("accept_invitation", { raw_token: token });
  if (e2) throw e2;
}

export function must<R extends { data: unknown; error: unknown }>(r: R): NonNullable<R["data"]> {
  if (r.error) throw r.error;
  return r.data as NonNullable<R["data"]>;
}

/** テスト用にワーカーを1回分動かす（Edge Function と同じ RPC を使う） */
export async function drainJobs() {
  for (let i = 0; i < 20; i++) {
    const jobs = must(await admin.rpc("worker_claim", { batch_size: 10, visibility_seconds: 30 })) as {
      msg_id: number; job_id: string; kind: string;
    }[];
    if (!jobs.length) return;
    for (const j of jobs) {
      if (j.kind === "photo_analysis") {
        // テスト用の検出結果（7人）
        must(await admin.rpc("worker_save_photo_result", {
          job: j.job_id, estimated: 7, dets: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.2, confidence: 90 }],
          provider: "test", model: "fixed", version: "1", min_conf: 60,
        }));
        must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id, job_result: { estimated_count: 7 } }));
        continue;
      }
      if (j.kind !== "process_submissions") {
        must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id, job_result: {} }));
        continue;
      }
      const r = must(await admin.rpc("worker_process_submissions", { job: j.job_id, max_rows: 500 })) as { remaining: number };
      if (r.remaining > 0) must(await admin.rpc("worker_requeue", { job: j.job_id, msg: j.msg_id }));
      else must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id, job_result: r }));
    }
  }
}

export async function csvConnection(owner: TestUser, org: string, mapping: Record<string, string>) {
  return must(await owner.client.from("form_connections").insert({ organization_id: org, name: "CSV", kind: "csv", field_mapping: mapping }).select("id").single()).id as string;
}

export async function importRows(user: TestUser, conn: string, rows: Record<string, string | undefined>[], dedupe?: (r: Record<string, string | undefined>) => string) {
  const batch = must(await user.client.rpc("create_import_batch", { conn, file_name: "t.csv" })) as string;
  const res = must(await user.client.rpc("append_import_rows", {
    batch, rows: rows.map((raw) => ({ raw, dedupe_key: dedupe?.(raw) ?? null, external_id: dedupe?.(raw) ?? null })),
  })) as { inserted: number; duplicates: number };
  must(await user.client.rpc("start_import_batch", { batch }));
  await drainJobs();
  return { batch, ...res };
}

export async function setFeatures(org: string, flags: Partial<Record<"partner_sharing" | "photo_pipeline_v2" | "photo_tiling", boolean>>) {
  must(await admin.from("organization_features").upsert({ organization_id: org, ...flags }));
}

export async function partnerCode(user: TestUser, org: string) {
  return must(await user.client.from("organizations").select("partner_code").eq("id", org).single()).partner_code as string;
}

/** a の団体から b の団体へ連携を申請し、b が承認する */
export async function partner(a: TestUser, orgA: string, b: TestUser, orgB: string) {
  const id = must(await a.client.rpc("request_partnership", { org: orgA, code: await partnerCode(b, orgB), msg: "test" })) as string;
  must(await b.client.rpc("respond_partnership", { partnership: id, accept: true }));
  return id;
}
