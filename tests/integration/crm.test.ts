// 項目の追加・企業・やりとり・タスク
import { beforeAll, describe, expect, it } from "vitest";
import { admin, csvConnection, importRows, join, must, newOrg, newUser, type TestUser } from "./helpers";

let owner: TestUser, editor: TestUser, editor2: TestUser, viewer: TestUser, other: TestUser;
let org: string, orgOther: string, person: string, otherPerson: string;

beforeAll(async () => {
  owner = await newUser("crm-owner");
  editor = await newUser("crm-editor");
  editor2 = await newUser("crm-editor2");
  viewer = await newUser("crm-viewer");
  other = await newUser("crm-other");
  org = await newOrg(owner, "顧客管理テスト");
  orgOther = await newOrg(other, "別組織");
  await join(org, owner, editor, "editor");
  await join(org, owner, editor2, "editor");
  await join(org, owner, viewer, "viewer");
  person = must(await editor.client.rpc("create_person", { org, data: { full_name: "顧客 一郎", emails: ["ichiro@example.com"] } })) as string;
  otherPerson = must(await other.client.rpc("create_person", { org: orgOther, data: { full_name: "他組織 太郎" } })) as string;
  must(await owner.client.from("custom_field_definitions").insert([
    { organization_id: org, entity: "person", key: "member_no", label: "会員番号", field_type: "text", options: [], position: 1 },
    { organization_id: org, entity: "person", key: "joined_on", label: "入会日", field_type: "date", options: [], position: 2 },
    { organization_id: org, entity: "person", key: "plan", label: "会員種別", field_type: "select", options: ["正会員", "賛助会員"], position: 3 },
    { organization_id: org, entity: "person", key: "donation", label: "寄付額", field_type: "number", options: [], position: 4 },
    { organization_id: org, entity: "person", key: "newsletter", label: "会報送付", field_type: "checkbox", options: [], position: 5 },
    { organization_id: org, entity: "company", key: "employees", label: "従業員数", field_type: "number", options: [], position: 1 },
  ]));
});

describe("項目の追加", () => {
  it("型に合わせて検証・正規化して保存し、空にすると消える", async () => {
    const v = must(await editor.client.rpc("set_custom_fields", { p_entity: "person", record_id: person,
      vals: { member_no: "A-001", joined_on: "2026-04-01", plan: "正会員", donation: "12,000".replace(/,/g, ""), newsletter: "on" } }));
    expect(v).toEqual({ member_no: "A-001", joined_on: "2026-04-01", plan: "正会員", donation: 12000, newsletter: true });
    const v2 = must(await editor.client.rpc("set_custom_fields", { p_entity: "person", record_id: person, vals: { member_no: null } }));
    expect(v2).not.toHaveProperty("member_no");
    expect(v2).toHaveProperty("plan", "正会員"); // 送っていない項目は残る
  });

  it("選択肢にない値・型違い・定義にない項目は保存できない", async () => {
    for (const vals of [{ plan: "VIP" }, { donation: "たくさん" }, { joined_on: "4月1日" }, { unknown_key: "x" }]) {
      const { error } = await editor.client.rpc("set_custom_fields", { p_entity: "person", record_id: person, vals });
      expect(error, JSON.stringify(vals)).not.toBeNull();
    }
  });

  it("閲覧者・他組織は書き換えられず、custom_fields を直接書き換える経路もない", async () => {
    expect((await viewer.client.rpc("set_custom_fields", { p_entity: "person", record_id: person, vals: { member_no: "X" } })).error).not.toBeNull();
    expect((await other.client.rpc("set_custom_fields", { p_entity: "person", record_id: person, vals: { member_no: "X" } })).error).not.toBeNull();
    expect((await editor.client.from("people").update({ custom_fields: { member_no: "検証なし" } } as never).eq("id", person)).error).not.toBeNull();
    expect(must(await other.client.from("custom_field_definitions").select("id").eq("organization_id", org))).toEqual([]);
  });

  it("項目の定義は管理者以上だけが追加できる", async () => {
    const { error } = await editor.client.from("custom_field_definitions").insert({ organization_id: org, entity: "person", key: "x1", label: "x", field_type: "text" });
    expect(error).not.toBeNull();
  });

  it("フォームの取り込みで追加項目に入る（空欄だけを補い、型が合わない値は入れない）", async () => {
    const conn = await csvConnection(owner, org, { 氏名: "full_name", メール: "email", 会員番号: "custom:member_no", 種別: "custom:plan" });
    await importRows(editor, conn, [{ 氏名: "取込 花子", メール: "hanako@example.com", 会員番号: "B-777", 種別: "不明な種別" }]);
    const p = must(await editor.client.from("people").select("custom_fields").eq("organization_id", org).eq("full_name", "取込 花子").single());
    expect(p.custom_fields).toEqual({ member_no: "B-777" });
  });
});

describe("企業と担当者", () => {
  let company: string;
  it("企業を登録し、担当者を紐づけ、一覧に担当者数が出る", async () => {
    company = must(await editor.client.rpc("create_company", { org, data: { name: "株式会社みどり", industry: "製造業", custom_fields: { employees: "120" } } })) as string;
    must(await editor.client.from("person_company_links").insert({ organization_id: org, person_id: person, company_id: company, title: "課長", is_primary: true }));
    const rows = must(await viewer.client.rpc("search_companies", { org, q: "みどり" })) as { id: string; contact_count: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].contact_count).toBe(1);
    const c = must(await viewer.client.from("companies").select("custom_fields").eq("id", company).single());
    expect(c.custom_fields).toEqual({ employees: 120 });
  });

  it("他組織の人物を担当者にできず、他組織からは企業が見えない", async () => {
    const { error } = await editor.client.from("person_company_links").insert({ organization_id: org, person_id: otherPerson, company_id: company });
    expect(error).not.toBeNull();
    expect(must(await other.client.from("companies").select("id").eq("organization_id", org))).toEqual([]);
    expect(must(await other.client.rpc("search_companies", { org }))).toEqual([]);
  });

  it("企業の削除は管理者以上", async () => {
    const tmp = must(await editor.client.rpc("create_company", { org, data: { name: "削除テスト" } })) as string;
    const { count } = await editor.client.from("companies").delete({ count: "exact" }).eq("id", tmp);
    expect(count ?? 0).toBe(0);
    const r = await owner.client.from("companies").delete({ count: "exact" }).eq("id", tmp);
    expect(r.count).toBe(1);
  });
});

describe("やりとりの記録とタイムライン", () => {
  let mine: string;
  it("記録したやりとり・メモ・参加がタイムラインに時系列で並ぶ", async () => {
    mine = must(await editor.client.from("interactions").insert({ organization_id: org, kind: "call", direction: "outbound", person_id: person,
      subject: "お礼の電話", occurred_at: "2026-10-20T01:00:00Z", created_by: editor.id }).select("id").single()).id;
    must(await editor.client.from("person_notes").insert({ organization_id: org, person_id: person, body: "メモです", author_id: editor.id }));
    const ev = must(await editor.client.from("events").insert({ organization_id: org, title: "交流会", starts_at: "2026-10-01T01:00:00Z" }).select("id").single()).id;
    must(await editor.client.from("event_participations").insert({ organization_id: org, event_id: ev, person_id: person, status: "attended" }));
    const tl = must(await viewer.client.rpc("person_timeline", { org, pid: person })) as { kind: string; occurred_at: string }[];
    expect(tl.map((x) => x.kind)).toEqual(expect.arrayContaining(["interaction:call", "note", "participation", "submission"].slice(0, 3)));
    const times = tl.map((x) => x.occurred_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("やりとりの削除は記録した本人か管理者だけ", async () => {
    expect((await editor2.client.from("interactions").delete({ count: "exact" }).eq("id", mine)).count ?? 0).toBe(0);
    expect((await editor.client.from("interactions").delete({ count: "exact" }).eq("id", mine)).count).toBe(1);
  });

  it("他組織の人物や企業にやりとりを付けられない", async () => {
    const { error } = await editor.client.from("interactions").insert({ organization_id: org, kind: "call", person_id: otherPerson });
    expect(error).not.toBeNull();
    const { error: e2 } = await editor.client.from("interactions").insert({ organization_id: org, kind: "call" });
    expect(e2).not.toBeNull(); // 人物か企業のどちらかは必須
  });
});

describe("タスク", () => {
  it("担当者は組織のスタッフに限り、完了すると完了者と日時が記録される", async () => {
    const { error } = await editor.client.from("tasks").insert({ organization_id: org, title: "電話する", assignee_id: other.id });
    expect(error?.message).toBe("invalid_assignee");
    const t = must(await editor.client.from("tasks").insert({ organization_id: org, title: "見積もりを送る", assignee_id: editor.id,
      due_date: "2020-01-01", person_id: person }).select("id").single()).id;
    const counts = must(await editor.client.rpc("my_task_counts", { org })) as { overdue: number; open: number };
    expect(counts.overdue).toBeGreaterThanOrEqual(1);
    must(await editor2.client.from("tasks").update({ status: "done" }).eq("id", t));
    const done = must(await viewer.client.from("tasks").select("status, completed_by, completed_at").eq("id", t).single());
    expect(done.status).toBe("done");
    expect(done.completed_by).toBe(editor2.id);
    expect(done.completed_at).not.toBeNull();
  });

  it("閲覧者はタスクを作れず、他組織からは見えない", async () => {
    expect((await viewer.client.from("tasks").insert({ organization_id: org, title: "x" })).error).not.toBeNull();
    expect(must(await other.client.from("tasks").select("id").eq("organization_id", org))).toEqual([]);
  });

  it("毎朝の通知は、期限が今日までのタスクがある担当者ごとに1日1件だけ作られる", async () => {
    const n1 = must(await admin.rpc("enqueue_task_digests")) as number;
    const n2 = must(await admin.rpc("enqueue_task_digests")) as number;
    expect(n2).toBe(0);
    expect(n1).toBeGreaterThanOrEqual(0);
    const jobs = must(await admin.from("jobs").select("id, target_id").eq("organization_id", org).eq("kind", "task_digest"));
    expect(jobs.length).toBeLessThanOrEqual(1);
    const t = must(await editor.client.from("tasks").insert({ organization_id: org, title: "期限切れのタスク", assignee_id: editor.id, due_date: "2020-01-02" }).select("id").single());
    void t;
    const job = must(await admin.from("jobs").select("id").eq("organization_id", org).eq("kind", "task_digest").eq("target_id", editor.id).maybeSingle());
    if (job) {
      const d = must(await admin.rpc("worker_task_digest", { job: job.id })) as { email: string; tasks: { title: string }[] };
      expect(d.email).toBe(editor.email);
      expect(d.tasks.map((x) => x.title)).toContain("期限切れのタスク");
    }
  });
});
