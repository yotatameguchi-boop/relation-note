// 受け入れ条件：別団体のデータを API・DB・ストレージから取得・変更できない
import { beforeAll, describe, expect, it } from "vitest";
import { admin, must, newOrg, newUser, join, type TestUser } from "./helpers";

let a: TestUser, b: TestUser;
let orgA: string, orgB: string;
let personA: string, tagB: string, eventA: string;

beforeAll(async () => {
  a = await newUser("owner-a");
  b = await newUser("owner-b");
  orgA = await newOrg(a, "団体A");
  orgB = await newOrg(b, "団体B");
  personA = must(await a.client.rpc("create_person", { org: orgA, data: { full_name: "団体Aの人", emails: ["shared@example.org"] } })) as string;
  tagB = must(await b.client.from("tags").insert({ organization_id: orgB, name: "B専用" }).select("id").single()).id;
  eventA = must(await a.client.from("events").insert({ organization_id: orgA, title: "Aの会", starts_at: new Date().toISOString() }).select("id").single()).id;
});

describe("団体間のデータ分離", () => {
  it("他団体の人物・連絡先・イベント・操作履歴が見えない", async () => {
    for (const t of ["people", "person_contacts", "events", "audit_logs", "memberships", "organizations"]) {
      const { data } = await b.client.from(t).select("*").eq(t === "organizations" ? "id" : "organization_id", orgA);
      expect(data, t).toEqual([]);
    }
  });

  it("他団体の団体IDを指定して登録できない", async () => {
    const { error } = await b.client.from("people").insert({ organization_id: orgA, full_name: "侵入" });
    expect(error).not.toBeNull();
    const { error: e2 } = await b.client.rpc("create_person", { org: orgA, data: { full_name: "侵入" } });
    expect(e2).not.toBeNull();
  });

  it("他団体の人物を更新・削除できない（0件）", async () => {
    const { data } = await b.client.from("people").update({ full_name: "改ざん" }).eq("id", personA).select();
    expect(data).toEqual([]);
    const { count } = await b.client.from("people").delete({ count: "exact" }).eq("id", personA);
    expect(count ?? 0).toBe(0);
    const p = must(await admin.from("people").select("full_name").eq("id", personA).single());
    expect(p.full_name).toBe("団体Aの人");
  });

  it("自団体の行に他団体のタグ・人物を紐づけられない（外部キーに団体IDを含む）", async () => {
    // A のオーナーが、B のタグIDを A の人物に付けようとする
    const { error } = await a.client.from("person_tags").insert({ organization_id: orgA, person_id: personA, tag_id: tagB });
    expect(error).not.toBeNull();
    // B が自団体名義で A の人物を B のタグに紐づけようとする
    const { error: e2 } = await b.client.from("person_tags").insert({ organization_id: orgB, person_id: personA, tag_id: tagB });
    expect(e2).not.toBeNull();
    // B のイベントに A の人物を参加登録しようとする
    const evB = must(await b.client.from("events").insert({ organization_id: orgB, title: "Bの会", starts_at: new Date().toISOString() }).select("id").single()).id;
    const { error: e3 } = await b.client.from("event_participations").insert({ organization_id: orgB, event_id: evB, person_id: personA });
    expect(e3).not.toBeNull();
  });

  it("organization_id を付け替えて別団体へ移せない", async () => {
    // A が B にも所属している状況を作る
    await join(orgB, b, a, "editor");
    const { error } = await a.client.from("events").update({ organization_id: orgB } as never).eq("id", eventA);
    expect(error).not.toBeNull();
  });

  it("他団体の RPC（集計・利用量・検索・重複候補）は使えない", async () => {
    const { error: e1 } = await b.client.rpc("org_usage", { org: orgA });
    expect(e1).not.toBeNull();
    const { data: m } = await b.client.rpc("search_people", { org: orgA });
    expect(m).toEqual([]);
    const { data: d } = await b.client.rpc("duplicate_candidates", { org: orgA });
    expect(d).toEqual([]);
    const { error: e4 } = await b.client.rpc("merge_people", { org: orgA, keep_id: personA, merge_id: personA });
    expect(e4).not.toBeNull();
  });

  it("同じメールアドレスでも別団体の人物は独立して管理される", async () => {
    must(await b.client.rpc("create_person", { org: orgB, data: { full_name: "団体Bの人", emails: ["shared@example.org"] } }));
    const { data } = await a.client.rpc("duplicate_candidates", { org: orgA });
    expect(data).toEqual([]);
  });

  it("他団体の写真ファイルをストレージから取得できない", async () => {
    const r = must(await a.client.rpc("reserve_photo_upload", { org: orgA, event: null, file_name: "a.jpg", mime: "image/jpeg", size_bytes: 4 })) as { path: string };
    must(await admin.storage.from("photos").upload(r.path, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" })));
    const ok = await a.client.storage.from("photos").download(r.path);
    expect(ok.error).toBeNull();
    const outsider = await newUser("outsider");
    const ng = await outsider.client.storage.from("photos").download(r.path);
    expect(ng.data).toBeNull();
    const ng2 = await outsider.client.storage.from("photos").createSignedUrl(r.path, 60);
    expect(ng2.data).toBeNull();
    // 利用者は直接アップロードできない（期限付きURLのみ）
    const up = await a.client.storage.from("photos").upload(`${orgA}/direct.jpg`, new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
    expect(up.error).not.toBeNull();
  });

  it("出力ファイルは利用者から直接取得できない", async () => {
    const path = `${orgA}/x.csv`;
    must(await admin.storage.from("exports").upload(path, new Blob(["a"], { type: "text/csv" }), { upsert: true }));
    const r = await a.client.storage.from("exports").download(path);
    expect(r.data).toBeNull();
  });

  it("ワーカー専用の関数は利用者から呼べない", async () => {
    for (const [fn, args] of [
      ["worker_claim", { batch_size: 1, visibility_seconds: 1 }],
      ["enqueue_job", { org: orgA, job_kind: "export_people", target: null, job_payload: {} }],
      ["apply_submission", { sub_id: personA }],
      ["complete_photo_upload", { photo: personA, org: orgA, actual_size: 1, actual_mime: "image/jpeg" }],
    ] as const) {
      const { error } = await a.client.rpc(fn, args);
      expect(error, fn).not.toBeNull();
    }
  });
});
