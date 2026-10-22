// メールの一斉配信
import { beforeAll, describe, expect, it } from "vitest";
import { admin, join, must, newOrg, newUser, type TestUser } from "./helpers";

let owner: TestUser, adminU: TestUser, editor: TestUser, other: TestUser;
let org: string, orgOther: string;
let tagA: string, tagB: string, tagNo: string;
const people: Record<string, string> = {};

async function campaign(audience: Record<string, unknown>, by = editor) {
  return must(await by.client.from("email_campaigns").insert({ organization_id: org, name: "案内", subject: "{{表示名}}さんへ", body_text: "{{氏名}} 様 本文",
    audience, created_by: by.id }).select("id").single()).id as string;
}

/** ワーカーと同じ手順で、指定した配信を送ったことにする（送信そのものは行わない） */
async function workerSend(campaignId: string, fail: string[] = []) {
  const job = must(await admin.from("jobs").select("id").eq("kind", "send_campaign").eq("target_id", campaignId).single()).id;
  const rows = must(await admin.rpc("worker_claim_recipients", { job, max_rows: 100 })) as { recipient_id: string; email: string; subject: string }[];
  for (const r of rows) {
    must(await admin.rpc("worker_mark_email", { recipient: r.recipient_id, ok: !fail.includes(r.email), err: fail.includes(r.email) ? "550 no such user" : null, message_id: "test" }));
  }
  return { job, rows, fin: must(await admin.rpc("worker_finish_campaign", { job })) as { remaining: number; sent: number } };
}

beforeAll(async () => {
  owner = await newUser("mail-owner");
  adminU = await newUser("mail-admin");
  editor = await newUser("mail-editor");
  other = await newUser("mail-other");
  org = await newOrg(owner, "配信テスト");
  orgOther = await newOrg(other, "別組織");
  await join(org, owner, adminU, "admin", ["bulk_export"]);
  await join(org, owner, editor, "editor");
  must(await owner.client.from("organizations").update({ email_sender_info: "東京都千代田区1-1 ／ info@example.org" }).eq("id", org));
  tagA = must(await owner.client.from("tags").insert({ organization_id: org, name: "会員" }).select("id").single()).id;
  tagB = must(await owner.client.from("tags").insert({ organization_id: org, name: "ボランティア" }).select("id").single()).id;
  tagNo = must(await owner.client.from("tags").insert({ organization_id: org, name: "配信不要" }).select("id").single()).id;
  const add = async (name: string, email: string | null, tags: string[]) => {
    people[name] = must(await editor.client.rpc("create_person", { org, data: { full_name: name, emails: email ? [email] : [], tag_ids: tags } })) as string;
  };
  await add("会員 一郎", "ichiro@example.com", [tagA]);
  await add("会員 花子", "hanako@example.com", [tagA, tagB]);
  await add("家族 共有", "HANAKO@example.com", [tagA]);   // 同じアドレス
  await add("連絡先 なし", null, [tagA]);
  await add("配信 不要", "nomail@example.com", [tagA, tagNo]);
  await add("停止 済み", "stopped@example.com", [tagA]);
  await add("ボラ 太郎", "bora@example.com", [tagB]);
  must(await editor.client.rpc("add_email_optout", { org, addr: "Stopped@Example.com" }));
});

describe("宛先の決定", () => {
  it("タグのいずれか・すべて・除外、メールなし・重複・配信停止を正しく扱う", async () => {
    const any = must(await editor.client.rpc("campaign_audience", { org, aud: { tag_ids: [tagA], match: "any", exclude_tag_ids: [tagNo] } })) as
      { full_name: string; email: string | null; excluded_reason: string | null }[];
    const ok = any.filter((a) => !a.excluded_reason).map((a) => a.full_name).sort();
    expect(ok).toEqual(["会員 一郎", "会員 花子"].sort());
    const reasons = Object.fromEntries(any.filter((a) => a.excluded_reason).map((a) => [a.full_name, a.excluded_reason]));
    expect(reasons).toEqual({ "家族 共有": "duplicate_email", "連絡先 なし": "no_email", "停止 済み": "opted_out" });
    expect(any.some((a) => a.full_name === "配信 不要")).toBe(false);
    const all = must(await editor.client.rpc("campaign_audience", { org, aud: { tag_ids: [tagA, tagB], match: "all" } })) as { full_name: string; excluded_reason: string | null }[];
    expect(all.filter((a) => !a.excluded_reason).map((a) => a.full_name)).toEqual(["会員 花子"]);
    const none = must(await editor.client.rpc("campaign_audience", { org, aud: { tag_ids: [] } }));
    expect(none).toEqual([]);
  });
});

describe("送信", () => {
  it("編集者・権限のない管理者は送れず、オーナー（一斉配信の権限あり）は送れる。同意の確認が必須", async () => {
    const id = await campaign({ tag_ids: [tagA], match: "any", exclude_tag_ids: [tagNo] });
    expect((await editor.client.rpc("send_campaign", { campaign: id, consent: true })).error).not.toBeNull();
    expect((await adminU.client.rpc("send_campaign", { campaign: id, consent: true })).error).not.toBeNull();
    expect((await owner.client.rpc("send_campaign", { campaign: id, consent: false })).error?.message).toBe("consent_required");
    expect(must(await owner.client.rpc("send_campaign", { campaign: id, consent: true }))).toBe(2);
    // 送信後は内容を変えられず、二重に送れない
    const upd = await editor.client.from("email_campaigns").update({ subject: "変更" }).eq("id", id).select();
    expect(upd.data ?? []).toEqual([]);
    expect((await owner.client.rpc("send_campaign", { campaign: id, consent: true })).error?.message).toBe("campaign_not_draft");

    const { rows, fin } = await workerSend(id, ["hanako@example.com"]);
    expect(rows.map((r) => r.email).sort()).toEqual(["hanako@example.com", "ichiro@example.com"]);
    expect(fin).toEqual({ remaining: 0, sent: 1 });
    const c = must(await editor.client.from("email_campaigns").select("status, recipient_count").eq("id", id).single());
    expect(c.status).toBe("sent");
    // 送れたぶんだけ利用枠に計上する
    const u = must(await admin.from("usage_records").select("quantity").eq("idempotency_key", `email:campaign:${id}`).single());
    expect(Number(u.quantity)).toBe(1);
    // 送った記録は人物のタイムラインに残る
    const tl = must(await editor.client.rpc("person_timeline", { org, pid: people["会員 一郎"] })) as { kind: string; meta: { from_campaign: boolean } }[];
    expect(tl.some((x) => x.kind === "interaction:email" && x.meta.from_campaign)).toBe(true);
    // 送信の記録は、送った本人（オーナー）でも削除できない
    const rec = must(await admin.from("interactions").select("id").eq("person_id", people["会員 一郎"]).not("email_recipient_id", "is", null).limit(1).single());
    expect((await owner.client.from("interactions").delete({ count: "exact" }).eq("id", rec.id)).count ?? 0).toBe(0);
    const stats = must(await editor.client.rpc("campaign_stats", { campaign: id })) as { sent: number; failed: number };
    expect(stats).toMatchObject({ sent: 1, failed: 1 });
  });

  it("同じ宛先の結果を二重に記録せず、送信中に止まった宛先は自動で再送しない", async () => {
    const id = await campaign({ tag_ids: [tagB], match: "any" });
    must(await owner.client.rpc("send_campaign", { campaign: id, consent: true }));
    const job = must(await admin.from("jobs").select("id").eq("kind", "send_campaign").eq("target_id", id).single()).id;
    const rows = must(await admin.rpc("worker_claim_recipients", { job, max_rows: 1 })) as { recipient_id: string }[];
    expect(rows).toHaveLength(1);
    must(await admin.rpc("worker_mark_email", { recipient: rows[0].recipient_id, ok: true }));
    must(await admin.rpc("worker_mark_email", { recipient: rows[0].recipient_id, ok: true }));
    const ints = must(await admin.from("interactions").select("id").eq("email_recipient_id", rows[0].recipient_id));
    expect(ints).toHaveLength(1);
    // 2人目は「送信中」のまま止まったことにする
    const rows2 = must(await admin.rpc("worker_claim_recipients", { job, max_rows: 1 })) as { recipient_id: string }[];
    must(await admin.from("email_recipients").update({ claimed_at: new Date(Date.now() - 11 * 60e3).toISOString() }).eq("id", rows2[0].recipient_id));
    const rows3 = must(await admin.rpc("worker_claim_recipients", { job, max_rows: 10 }));
    expect(rows3).toEqual([]);
    const r2 = must(await admin.from("email_recipients").select("status").eq("id", rows2[0].recipient_id).single());
    expect(r2.status).toBe("unknown");
  });

  it("送信者情報がない・枠を超える場合は送れない", async () => {
    const id = await campaign({ tag_ids: [tagA], match: "any" });
    must(await owner.client.from("organizations").update({ email_sender_info: null }).eq("id", org));
    expect((await owner.client.rpc("send_campaign", { campaign: id, consent: true })).error?.message).toBe("sender_info_required");
    must(await owner.client.from("organizations").update({ email_sender_info: "東京都千代田区1-1" }).eq("id", org));
    await admin.from("plans").upsert({ id: "mail-tiny", name: "テスト", max_staff: 10, max_people: 100, max_photo_analyses_per_month: 1, max_storage_bytes: 1000, max_emails_per_month: 2 });
    must(await admin.from("organizations").update({ plan_id: "mail-tiny" }).eq("id", org));
    const r = await owner.client.rpc("send_campaign", { campaign: id, consent: true });
    expect(r.error?.message).toBe("quota_exceeded:email");
    must(await admin.from("organizations").update({ plan_id: "standard" }).eq("id", org));
  });
});

describe("開封・配信停止", () => {
  it("開封は送信済みの宛先だけ数え、配信停止は未送信の宛先にも即時に効く", async () => {
    const sent = must(await admin.from("email_recipients").select("token, email, organization_id").eq("organization_id", org).eq("status", "sent").limit(1).single());
    must(await admin.rpc("record_email_open", { p_token: sent.token }));
    must(await admin.rpc("record_email_open", { p_token: sent.token }));
    const o = must(await admin.from("email_recipients").select("open_count, opened_at").eq("token", sent.token).single());
    expect(o.open_count).toBe(2);
    expect(o.opened_at).not.toBeNull();

    const id = await campaign({ tag_ids: [tagA], match: "any" });
    must(await owner.client.rpc("send_campaign", { campaign: id, consent: true }));
    const q = must(await admin.from("email_recipients").select("token, email").eq("campaign_id", id).eq("email", "ichiro@example.com").single());
    const info = must(await admin.rpc("lookup_unsubscribe", { p_token: q.token })) as { email: string; org_name: string };
    expect(info.email).toBe("i***@example.com"); // 画面には一部だけ表示
    expect(must(await admin.rpc("unsubscribe_by_token", { p_token: q.token }))).toBe(true);
    const after = must(await admin.from("email_recipients").select("status").eq("token", q.token).single());
    expect(after.status).toBe("skipped");
    const aud = must(await editor.client.rpc("campaign_audience", { org, aud: { tag_ids: [tagA] } })) as { email: string; excluded_reason: string | null }[];
    expect(aud.find((a) => a.email === "ichiro@example.com")?.excluded_reason).toBe("opted_out");
  });
});

describe("組織の境界と権限", () => {
  it("他組織からは配信・宛先・配信停止が見えず、ワーカー用の関数は利用者から呼べない", async () => {
    for (const t of ["email_campaigns", "email_recipients", "email_optouts"]) {
      expect(must(await other.client.from(t).select("*").eq("organization_id", org)), t).toEqual([]);
    }
    expect(must(await other.client.rpc("campaign_audience", { org, aud: { tag_ids: [tagA] } }))).toEqual([]);
    for (const [fn, args] of [
      ["worker_claim_recipients", { job: org, max_rows: 1 }], ["worker_mark_email", { recipient: org, ok: true }],
      ["record_email_open", { p_token: "x" }], ["unsubscribe_by_token", { p_token: "x" }], ["enqueue_task_digests", {}],
    ] as const) {
      expect((await editor.client.rpc(fn, args)).error, fn).not.toBeNull();
    }
    expect((await other.client.rpc("send_test_email", { campaign: await campaign({ tag_ids: [tagA] }) })).error).not.toBeNull();
    void orgOther;
  });
});
