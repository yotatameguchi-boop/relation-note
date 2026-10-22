// 外部データとのコネクト（自動取り込み）
import { beforeAll, describe, expect, it } from "vitest";
import { admin, join, must, newOrg, newUser, type TestUser } from "./helpers";

let owner: TestUser, editor: TestUser, other: TestUser;
let org: string, orgOther: string;

async function connection(kind: string, mapping: Record<string, string> = {}) {
  return must(await owner.client.from("form_connections").insert({ organization_id: org, name: kind, kind, field_mapping: mapping }).select("id").single()).id as string;
}

/** 同期ジョブを1件取り出す（他のジョブは戻す） */
async function claim(connId: string) {
  const claimed = must(await admin.rpc("worker_claim", { batch_size: 20, visibility_seconds: 60 })) as { job_id: string; msg_id: number; target_id: string; kind: string; payload: { mode: string } }[];
  for (const c of claimed.filter((c) => c.target_id !== connId)) must(await admin.rpc("worker_requeue", { job: c.job_id, msg: c.msg_id }));
  const mine = claimed.find((c) => c.target_id === connId && c.kind === "sync_connector");
  if (!mine) throw new Error("job not claimed");
  return mine;
}

/** 処理ジョブ（名寄せ）を流す */
async function drainProcessing() {
  for (let i = 0; i < 10; i++) {
    const jobs = must(await admin.rpc("worker_claim", { batch_size: 20, visibility_seconds: 30 })) as { job_id: string; msg_id: number; kind: string }[];
    if (!jobs.length) return;
    for (const j of jobs) {
      if (j.kind !== "process_submissions") { must(await admin.rpc("worker_requeue", { job: j.job_id, msg: j.msg_id })); continue; }
      const r = must(await admin.rpc("worker_process_submissions", { job: j.job_id, max_rows: 500 })) as { remaining: number };
      if (r.remaining > 0) must(await admin.rpc("worker_requeue", { job: j.job_id, msg: j.msg_id }));
      else must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id, job_result: r }));
    }
    if (jobs.every((j) => j.kind !== "process_submissions")) return;
  }
}

beforeAll(async () => {
  owner = await newUser("conn-owner");
  editor = await newUser("conn-editor");
  other = await newUser("conn-other");
  org = await newOrg(owner, "コネクト");
  orgOther = await newOrg(other, "別組織");
  await join(org, owner, editor, "editor");
});

describe("連携の鍵", () => {
  it("鍵は Vault に保存され、利用者からは読めない（RPC・テーブル・他組織のいずれからも）", async () => {
    const conn = await connection("google_forms");
    expect((await owner.client.rpc("store_connector_secret", { conn, p_purpose: "google_refresh_token", secret: "x" })).error).not.toBeNull();
    must(await admin.rpc("store_connector_secret", { conn, p_purpose: "google_refresh_token", secret: "refresh-123", account: "staff@example.org" }));
    expect(must(await admin.rpc("get_connector_secret", { conn }))).toBe("refresh-123");
    expect((await owner.client.rpc("get_connector_secret", { conn })).error).not.toBeNull();
    expect(must(await owner.client.from("connector_credentials").select("*"))).toEqual([]);
    expect(must(await owner.client.from("oauth_states").select("*"))).toEqual([]);
    const st = must(await editor.client.rpc("connector_status", { conn })) as { connected: boolean };
    expect(st.connected).toBe(true);
    expect((await other.client.rpc("connector_status", { conn })).error).not.toBeNull();
    // 連携を削除すると Vault の鍵も消える
    must(await owner.client.from("form_connections").delete().eq("id", conn));
    expect(must(await admin.from("connector_credentials").select("connection_id").eq("connection_id", conn))).toEqual([]);
    expect((await admin.rpc("get_connector_secret", { conn })).data).toBeNull();
  });

  it("同期の状態（取得日時・エラー）は利用者が書き換えられない", async () => {
    const conn = await connection("google_sheets");
    const { error } = await owner.client.from("form_connections").update({ last_sync_status: "ok", sync_cursor: "x" } as never).eq("id", conn);
    expect(error).not.toBeNull();
  });
});

describe("取りに行く型（Google）", () => {
  let conn: string;
  beforeAll(async () => {
    conn = await connection("google_forms");
    must(await owner.client.from("form_connections").update({ provider_config: { form_id: "FORM123456789012345678" } }).eq("id", conn));
  });

  it("連携前は取得できず、質問の読み込みは管理者だけ", async () => {
    expect((await owner.client.rpc("request_connector_sync", { conn, p_mode: "discover" })).error?.message).toBe("not_connected");
    must(await admin.rpc("store_connector_secret", { conn, p_purpose: "google_refresh_token", secret: "r" }));
    expect((await editor.client.rpc("request_connector_sync", { conn, p_mode: "discover" })).error).not.toBeNull();
    must(await owner.client.rpc("request_connector_sync", { conn, p_mode: "discover" }));
    expect((await owner.client.rpc("request_connector_sync", { conn, p_mode: "sync" })).error?.message).toBe("already_queued");
  });

  it("質問の読み込みで対応を提案し、確認されるまでは「対応の確認待ち」", async () => {
    const j = await claim(conn);
    expect(j.payload.mode).toBe("discover");
    must(await admin.rpc("worker_store_discovery", { job: j.job_id, columns: ["お名前", "メール", "参加曜日"],
      suggested: { お名前: "full_name", メール: "email", 参加曜日: "attr:参加曜日" }, title: "募集フォーム" }));
    must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id }));
    const c = must(await owner.client.from("form_connections").select("field_mapping, provider_config, last_sync_status, sync_enabled").eq("id", conn).single());
    expect(c.field_mapping).toEqual({ お名前: "full_name", メール: "email", 参加曜日: "attr:参加曜日" });
    expect(c.provider_config).toMatchObject({ title: "募集フォーム", columns: ["お名前", "メール", "参加曜日"] });
    expect(c.last_sync_status).toBe("needs_mapping");
    expect(c.sync_enabled).toBe(false);
  });

  it("取得した回答は回答IDで二重に入らず、既存の名寄せに流れる", async () => {
    must(await owner.client.from("form_connections").update({ sync_enabled: true }).eq("id", conn));
    must(await owner.client.rpc("request_connector_sync", { conn }));
    const rows = [
      { external_id: "resp-1", submitted_at: "2026-10-20T01:00:00Z", raw: { お名前: "連携 太郎", メール: "renkei@example.org", 参加曜日: "土" } },
      { external_id: "resp-2", submitted_at: "2026-10-21T01:00:00Z", raw: { お名前: "連携 花子", メール: "hanako@example.org" } },
    ];
    let j = await claim(conn);
    const r1 = must(await admin.rpc("worker_ingest_connector_rows", { job: j.job_id, rows, new_cursor: "2026-10-21T01:00:00Z" })) as { inserted: number };
    must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id }));
    expect(r1.inserted).toBe(2);
    must(await owner.client.rpc("request_connector_sync", { conn }));
    j = await claim(conn);
    const r2 = must(await admin.rpc("worker_ingest_connector_rows", { job: j.job_id, rows, new_cursor: "2026-10-21T01:00:00Z" })) as { inserted: number };
    must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id }));
    expect(r2.inserted).toBe(0);
    await drainProcessing();
    const people = must(await owner.client.from("people").select("full_name, attributes").eq("organization_id", org).in("full_name", ["連携 太郎", "連携 花子"]));
    expect(people.map((p) => p.full_name).sort()).toEqual(["連携 太郎", "連携 花子"]);
    const c = must(await owner.client.from("form_connections").select("sync_cursor, last_sync_status").eq("id", conn).single());
    expect(c).toEqual({ sync_cursor: "2026-10-21T01:00:00Z", last_sync_status: "ok" });
  });

  it("連携が取り消されたら自動取り込みを止め、連携し直すまで同期を作らない", async () => {
    must(await owner.client.rpc("request_connector_sync", { conn }));
    const j = await claim(conn);
    must(await admin.rpc("worker_connector_error", { job: j.job_id, err: "invalid_grant", reauth: true }));
    must(await admin.rpc("worker_fail", { job: j.job_id, msg: j.msg_id, err: "invalid_grant", retryable: false }));
    const c = must(await owner.client.from("form_connections").select("sync_enabled, last_sync_status").eq("id", conn).single());
    expect(c).toEqual({ sync_enabled: false, last_sync_status: "reauth_required" });
    must(await admin.from("form_connections").update({ sync_enabled: true, next_sync_at: null }).eq("id", conn));
    must(await admin.rpc("enqueue_connector_syncs"));
    expect(must(await admin.from("jobs").select("id").eq("target_id", conn).eq("status", "queued"))).toEqual([]);
    // 連携し直すと状態が戻る
    must(await admin.rpc("store_connector_secret", { conn, p_purpose: "google_refresh_token", secret: "new" }));
    const c2 = must(await owner.client.from("form_connections").select("last_sync_status").eq("id", conn).single());
    expect(c2.last_sync_status).toBeNull();
  });

  it("定期実行は期限が来た連携だけに、1件ずつジョブを作る", async () => {
    must(await admin.from("form_connections").update({ sync_enabled: true, next_sync_at: new Date(Date.now() - 1000).toISOString() }).eq("id", conn));
    must(await admin.rpc("enqueue_connector_syncs"));
    must(await admin.rpc("enqueue_connector_syncs"));
    const jobs = must(await admin.from("jobs").select("id").eq("target_id", conn).in("status", ["queued", "running"]));
    expect(jobs).toHaveLength(1);
    const c = must(await admin.from("form_connections").select("next_sync_at").eq("id", conn).single());
    expect(new Date(c.next_sync_at!).getTime()).toBeGreaterThan(Date.now() + 10 * 60e3);
    const j = await claim(conn);
    must(await admin.rpc("worker_complete", { job: j.job_id, msg: j.msg_id }));
  });
});

describe("届けてもらう型（Typeform・Tally）", () => {
  it("対応が決まるまで保留し、氏名の対応を設定したら処理できる。同じ回答は二重に入らない", async () => {
    const conn = await connection("tally");
    const r = must(await admin.rpc("ingest_verified_submission", { conn, ext_id: "t-1", payload: { "お名前": "保留 次郎", "メール": "jiro@example.org" }, sent_at: null })) as { status: string };
    expect(r.status).toBe("accepted");
    const dup = must(await admin.rpc("ingest_verified_submission", { conn, ext_id: "t-1", payload: { "お名前": "保留 次郎" }, sent_at: null })) as { status: string };
    expect(dup.status).toBe("duplicate");
    await drainProcessing();
    let st = must(await owner.client.rpc("connector_status", { conn })) as { held: number };
    expect(st.held).toBe(1);
    const c = must(await owner.client.from("form_connections").select("provider_config, last_sync_status").eq("id", conn).single());
    expect((c.provider_config as { columns: string[] }).columns.sort()).toEqual(["お名前", "メール"].sort());
    expect(c.last_sync_status).toBe("needs_mapping");
    must(await owner.client.from("form_connections").update({ field_mapping: { お名前: "full_name", メール: "email" } }).eq("id", conn));
    expect(must(await editor.client.rpc("reprocess_connection", { conn }))).toBe(1);
    await drainProcessing();
    st = must(await owner.client.rpc("connector_status", { conn })) as { held: number };
    expect(st.held).toBe(0);
    expect(must(await owner.client.from("people").select("id").eq("organization_id", org).eq("full_name", "保留 次郎"))).toHaveLength(1);
  });

  it("受け入れ用の関数は利用者から呼べず、他組織からは連携が見えない", async () => {
    const conn = await connection("typeform");
    expect((await owner.client.rpc("ingest_verified_submission", { conn, ext_id: "x", payload: {}, sent_at: null })).error).not.toBeNull();
    expect(must(await other.client.from("form_connections").select("id").eq("organization_id", org))).toEqual([]);
    void orgOther;
  });
});

describe("内部関数の保護", () => {
  it("操作履歴への書き込みなどの内部関数は、利用者から直接呼べない", async () => {
    for (const [fn, args] of [
      ["audit", { org: orgOther, act: "fake", ttype: "x", tid: "x", det: {} }],
      ["refresh_person_stats", { org: orgOther, pid: orgOther }],
      ["feature_enabled", { org: orgOther, flag: "partner_sharing" }],
      ["staff_seats_used", { org: orgOther }],
    ] as const) {
      expect((await owner.client.rpc(fn, args)).error, fn).not.toBeNull();
    }
  });
});
