// 受け入れ条件：同じ回答やジョブを再送しても二重登録されない／名寄せが曖昧な人物を無条件に統合しない
import { beforeAll, describe, expect, it } from "vitest";
import { admin, csvConnection, drainJobs, importRows, must, newOrg, newUser, type TestUser } from "./helpers";

let u: TestUser;
let org: string;
let conn: string;
const MAP = { 氏名: "full_name", メール: "email", 電話: "phone", 地域: "region", タグ: "tags", 回答ID: "external_id" };

beforeAll(async () => {
  u = await newUser("staff");
  org = await newOrg(u);
  conn = await csvConnection(u, org, MAP);
});

async function statusOf(batch: string) {
  return must(await u.client.from("form_submissions").select("status, match_reason, person_id, raw").eq("batch_id", batch));
}

describe("フォーム取り込みと名寄せ", () => {
  it("同じ回答を再送しても二重登録されない（回答ID・原文ハッシュの両方）", async () => {
    const rows = [{ 回答ID: "r-1", 氏名: "佐藤 一郎", メール: "ichiro@example.org" }, { 氏名: "鈴木 二郎", メール: "jiro@example.org" }];
    const first = await importRows(u, conn, rows, (r) => r["回答ID"] ?? "");
    expect(first.inserted).toBe(2);
    const second = await importRows(u, conn, rows, (r) => r["回答ID"] ?? "");
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);
    const { count } = await u.client.from("people").select("id", { count: "exact", head: true }).eq("organization_id", org);
    expect(count).toBe(2);
  });

  it("連絡先と氏名が一致すれば既存人物に紐づけ、情報を上書きしない", async () => {
    const { batch } = await importRows(u, conn, [{ 氏名: "佐藤一郎", メール: "ICHIRO@example.org", 電話: "０９０-１２３４-５６７８", 地域: "別の市" }]);
    const [s] = await statusOf(batch);
    expect(s.status).toBe("linked");
    const p = must(await u.client.from("people").select("region, person_contacts(kind, value)").eq("id", s.person_id).single());
    expect(p.person_contacts.map((c: { kind: string }) => c.kind).sort()).toEqual(["email", "phone"]);
    expect(p.region).toBe("別の市"); // 空欄だったので補完
    await importRows(u, conn, [{ 氏名: "佐藤一郎", メール: "ichiro@example.org", 地域: "さらに別の市" }]);
    const p2 = must(await u.client.from("people").select("region").eq("id", s.person_id).single());
    expect(p2.region).toBe("別の市"); // 既存値は上書きしない
    const subs = must(await u.client.from("form_submissions").select("id").eq("person_id", s.person_id));
    expect(subs.length).toBe(3); // 同じ人物の複数回答を保持
  });

  it("メールが一致しても氏名が違えば自動統合しない（家族の共有）", async () => {
    const { batch } = await importRows(u, conn, [{ 氏名: "佐藤 花子", メール: "ichiro@example.org" }]);
    const [s] = await statusOf(batch);
    expect(s.status).toBe("needs_review");
    expect(s.match_reason).toBe("contact_only");
    expect(s.person_id).toBeNull();
  });

  it("氏名だけ一致しても自動統合しない（同姓同名）", async () => {
    const { batch } = await importRows(u, conn, [{ 氏名: "鈴木 二郎", メール: "jiro2@example.org" }]);
    const [s] = await statusOf(batch);
    expect(s.status).toBe("needs_review");
    expect(s.match_reason).toBe("name_only");
  });

  it("確認待ちをスタッフが「別人として登録」できる", async () => {
    const sub = must(await u.client.from("form_submissions").select("id").eq("organization_id", org).eq("match_reason", "name_only").single());
    must(await u.client.rpc("resolve_submission", { sub_id: sub.id, action: "create" }));
    const after = must(await u.client.from("form_submissions").select("status, person_id").eq("id", sub.id).single());
    expect(after.status).toBe("created");
    expect(after.person_id).not.toBeNull();
  });

  it("氏名のない行はエラーとして記録され、他の行は処理される", async () => {
    const { batch } = await importRows(u, conn, [{ 氏名: "", メール: "x@example.org" }, { 氏名: "高橋 三郎", メール: "not-an-email" }, { 氏名: "田中 四郎" }]);
    const rows = await statusOf(batch);
    expect(rows.map((r) => r.status).sort()).toEqual(["created", "error", "error"]);
    const b = must(await u.client.from("import_batches").select("status").eq("id", batch).single());
    expect(b.status).toBe("completed");
  });

  it("タグ列と接続の既定タグが付く", async () => {
    const { batch } = await importRows(u, conn, [{ 氏名: "伊藤 五郎", タグ: "ボランティア、寄付者" }]);
    const [s] = await statusOf(batch);
    const tags = must(await u.client.from("person_tags").select("tags(name)").eq("person_id", s.person_id));
    expect(tags.map((t) => (t.tags as unknown as { name: string }).name).sort()).toEqual(["ボランティア", "寄付者"]);
  });

  it("外部フォームの受信：秘密が違えば拒否、同じ回答IDの再送は重複扱い", async () => {
    const wh = must(await u.client.from("form_connections").insert({ organization_id: org, name: "WH", kind: "webhook", field_mapping: { name: "full_name", mail: "email" } }).select("id").single()).id;
    const secret = must(await u.client.rpc("rotate_webhook_secret", { conn: wh })) as string;
    const bad = await admin.rpc("ingest_webhook_submission", { conn: wh, secret: "wrong", ext_id: "w1", payload: { name: "渡辺 六郎" }, sent_at: null });
    expect(bad.error?.message).toBe("unauthorized");
    const ok = must(await admin.rpc("ingest_webhook_submission", { conn: wh, secret, ext_id: "w1", payload: { name: "渡辺 六郎", mail: "r@example.org" }, sent_at: null })) as { status: string };
    expect(ok.status).toBe("accepted");
    const dup = must(await admin.rpc("ingest_webhook_submission", { conn: wh, secret, ext_id: "w1", payload: { name: "渡辺 六郎", mail: "r@example.org" }, sent_at: null })) as { status: string };
    expect(dup.status).toBe("duplicate");
    await drainJobs();
    const subs = must(await u.client.from("form_submissions").select("status").eq("connection_id", wh));
    expect(subs).toEqual([{ status: "created" }]);
  });
});

describe("人物統合", () => {
  it("統合で連絡先・参加履歴が移り、統合前の状態が履歴に残る", async () => {
    const keep = must(await u.client.rpc("create_person", { org, data: { full_name: "統合 太郎", emails: ["t1@example.org"] } })) as string;
    const gone = must(await u.client.rpc("create_person", { org, data: { full_name: "統合太郎", phones: ["080-0000-0000"], emails: ["t1@example.org"] } })) as string;
    const ev = must(await u.client.from("events").insert({ organization_id: org, title: "会", starts_at: new Date().toISOString() }).select("id").single()).id;
    must(await u.client.from("event_participations").insert({ organization_id: org, event_id: ev, person_id: gone, status: "attended" }));
    const cands = must(await u.client.rpc("duplicate_candidates", { org })) as { person_a: string; person_b: string; reasons: string[] }[];
    const pair = cands.find((c) => [c.person_a, c.person_b].sort().join() === [keep, gone].sort().join());
    expect(pair?.reasons.sort()).toEqual(["email", "name"]);

    must(await u.client.rpc("merge_people", { org, keep_id: keep, merge_id: gone }));
    const p = must(await u.client.from("people").select("attendance_count, person_contacts(value)").eq("id", keep).single());
    expect(p.attendance_count).toBe(1);
    expect(p.person_contacts.length).toBe(2);
    const hist = must(await u.client.from("person_merge_history").select("merged_person_id, merged_snapshot").eq("kept_person_id", keep));
    expect(hist[0].merged_person_id).toBe(gone);
    expect((hist[0].merged_snapshot as { person: { full_name: string } }).person.full_name).toBe("統合太郎");
    expect((await u.client.from("people").select("id").eq("id", gone)).data).toEqual([]);
  });

  it("「別人」と記録した組は候補に出ない", async () => {
    const a = must(await u.client.rpc("create_person", { org, data: { full_name: "同名 さん" } })) as string;
    const b = must(await u.client.rpc("create_person", { org, data: { full_name: "同名さん" } })) as string;
    must(await u.client.rpc("mark_people_distinct", { org, a, b }));
    const cands = must(await u.client.rpc("duplicate_candidates", { org })) as { person_a: string; person_b: string }[];
    expect(cands.some((c) => [c.person_a, c.person_b].includes(a) && [c.person_a, c.person_b].includes(b))).toBe(false);
  });
});
