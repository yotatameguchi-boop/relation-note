// 団体間の連携・活動者データ共有（必須テスト）
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admin, join, must, newOrg, newUser, partner, partnerCode, setFeatures, type TestUser } from "./helpers";

let a: TestUser, b: TestUser, c: TestUser, bViewer: TestUser;
let orgA: string, orgB: string, orgC: string;
let person: string, tagVolunteer: string, tagInternal: string, eventId: string, partnershipAB: string;
const future = (days: number) => new Date(Date.now() + days * 86400e3).toISOString();

async function authorize(fields: string[], opts: { target?: string; validUntil?: string | null; pid?: string } = {}) {
  return must(await a.client.rpc("record_sharing_authorizations", {
    org: orgA, person_ids: [opts.pid ?? person], target: opts.target ?? orgB, p_basis_type: "consent", p_basis_detail: "",
    p_purpose: "合同イベントの配置調整", p_allowed_fields: fields, p_evidence_ref: "同意書 2026-10 綴り",
    p_confirmed_at: new Date().toISOString(), p_valid_until: opts.validUntil ?? null,
  }));
}

async function share(fields: string[], opts: { pid?: string; target?: string; expires?: string } = {}) {
  return must(await a.client.rpc("create_share_grants", {
    org: orgA, target: opts.target ?? orgB, person_ids: [opts.pid ?? person], p_fields: fields,
    p_tag_ids: [tagVolunteer], p_event_ids: [eventId], p_expires_at: opts.expires ?? future(30),
  })) as { created: { grant_id: string }[]; skipped: { reason: string }[] };
}

async function bList() {
  return must(await bViewer.client.rpc("shared_people_list", { org: orgB })) as { grant_id: string; label: string }[];
}

beforeAll(async () => {
  a = await newUser("share-a");
  b = await newUser("share-b");
  c = await newUser("share-c");
  bViewer = await newUser("share-b-viewer");
  orgA = await newOrg(a, "共有元A");
  orgB = await newOrg(b, "共有先B");
  orgC = await newOrg(c, "第三者C");
  for (const o of [orgA, orgB, orgC]) await setFeatures(o, { partner_sharing: true });
  await join(orgB, b, bViewer, "viewer", []);
  // 閲覧者に「共有の閲覧」権限を付与（権限変更の権限が必要）
  must(await b.client.rpc("set_member_role", { org: orgB, member: bViewer.id, new_role: "viewer", new_permissions: ["view_shared"] }));

  person = must(await a.client.rpc("create_person", { org: orgA, data: {
    full_name: "共有 花子", region: "みどり市", emails: ["hanako@example.org"], phones: ["090-1111-2222"] } })) as string;
  must(await a.client.from("people").update({ display_name: "はなちゃん", interests: ["環境"], skills: ["応急手当"] }).eq("id", person));
  must(await a.client.from("person_notes").insert({ organization_id: orgA, person_id: person, body: "内部メモ：家庭の事情あり", author_id: a.id }));
  tagVolunteer = must(await a.client.from("tags").insert({ organization_id: orgA, name: "ボランティア" }).select("id").single()).id;
  tagInternal = must(await a.client.from("tags").insert({ organization_id: orgA, name: "要配慮" }).select("id").single()).id;
  must(await a.client.from("person_tags").insert([
    { organization_id: orgA, person_id: person, tag_id: tagVolunteer }, { organization_id: orgA, person_id: person, tag_id: tagInternal }]));
  eventId = must(await a.client.from("events").insert({ organization_id: orgA, title: "河川清掃", starts_at: "2026-09-01T01:00:00Z" }).select("id").single()).id;
  const ev2 = must(await a.client.from("events").insert({ organization_id: orgA, title: "非公開の相談会", starts_at: "2026-09-10T01:00:00Z" }).select("id").single()).id;
  must(await a.client.from("event_participations").insert([
    { organization_id: orgA, event_id: eventId, person_id: person, status: "attended" },
    { organization_id: orgA, event_id: ev2, person_id: person, status: "attended" }]));
});

describe("連携", () => {
  it("連携の承認だけでは人物情報は見えない", async () => {
    partnershipAB = await partner(a, orgA, b, orgB);
    expect(await bList()).toEqual([]);
    expect(must(await bViewer.client.rpc("shared_people_count", { org: orgB }))).toBe(0);
    // 既存の団体内 RLS は維持されている
    expect(must(await b.client.from("people").select("id").eq("organization_id", orgA))).toEqual([]);
    expect(must(await b.client.from("person_share_grants").select("id"))).toEqual([]);
  });

  it("連携コードが分からない・自団体・機能無効の相手には申請できない（区別しない応答）", async () => {
    for (const code of ["ZZZZZZZZZZZZ", await partnerCode(a, orgA)]) {
      expect((await a.client.rpc("request_partnership", { org: orgA, code })).error?.message).toBe("partner_not_found");
    }
    const off = await newUser("off");
    const orgOff = await newOrg(off, "機能無効");
    expect((await a.client.rpc("request_partnership", { org: orgA, code: await partnerCode(off, orgOff) })).error?.message).toBe("partner_not_found");
  });

  it("申請された側しか承認できない。編集者は連携を操作できない", async () => {
    const id = must(await a.client.rpc("request_partnership", { org: orgA, code: await partnerCode(c, orgC) })) as string;
    expect((await a.client.rpc("respond_partnership", { partnership: id, accept: true })).error).not.toBeNull();
    const editorC = await newUser("editor-c");
    await join(orgC, c, editorC, "editor");
    expect((await editorC.client.rpc("respond_partnership", { partnership: id, accept: true })).error).not.toBeNull();
    must(await c.client.rpc("respond_partnership", { partnership: id, accept: true }));
  });
});

describe("共有根拠と共有の有効化", () => {
  it("共有根拠が未記録なら共有を有効化できない", async () => {
    const r = await share(["display_name"]);
    expect(r.created).toEqual([]);
    expect(r.skipped[0].reason).toBe("no_valid_authorization");
  });

  it("根拠の範囲外の項目（連絡先）や、根拠より長い期限では有効化できない", async () => {
    await authorize(["display_name", "full_name", "region", "interests", "skills", "tags", "activities"], { validUntil: future(60) });
    expect((await share(["display_name", "email"])).skipped[0].reason).toBe("no_valid_authorization");
    expect((await share(["display_name"], { expires: future(90) })).skipped[0].reason).toBe("no_valid_authorization");
  });

  it("連携していない団体への根拠記録・共有はできない", async () => {
    const outsider = await newUser("outsider");
    const orgX = await newOrg(outsider, "連携なし");
    await setFeatures(orgX, { partner_sharing: true });
    expect((await authorize(["display_name"], { target: orgX }).catch((e) => e)).message).toBe("partnership_inactive");
  });
});

describe("共有先からの閲覧", () => {
  let grantId: string;

  beforeEach(async () => {
    // 毎回、有効な共有を1つ用意する
    const active = must(await a.client.from("person_share_grants").select("id").eq("person_id", person).eq("target_organization_id", orgB).eq("status", "active"));
    if (active.length) { grantId = active[0].id; return; }
    const fields = ["display_name", "region", "tags", "activities"];
    if ((await share(fields)).created.length === 0) {
      // 前のテストで根拠を撤回・失効させた場合は、根拠を記録し直してから共有する
      await authorize(fields, { validUntil: future(60) });
    } else {
      grantId = must(await a.client.from("person_share_grants").select("id").eq("person_id", person).eq("target_organization_id", orgB).eq("status", "active").single()).id;
      return;
    }
    const r = await share(fields);
    expect(r.created.length).toBe(1);
    grantId = r.created[0].grant_id;
  });

  it("許可された共有先だけが閲覧でき、未選択の項目はレスポンスに含まれない", async () => {
    const list = await bList();
    expect(list.map((r) => r.grant_id)).toEqual([grantId]);
    expect(list[0].label).toBe("はなちゃん");
    const d = must(await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })) as { snapshot: Record<string, unknown>; source_name: string };
    expect(Object.keys(d.snapshot).sort()).toEqual(["activities", "display_name", "region", "tags"]);
    expect(d.snapshot.tags).toEqual(["ボランティア"]);                       // 選んだタグだけ
    expect(d.snapshot.activities).toEqual([{ title: "河川清掃", date: "2026-09-01" }]); // 選んだ活動だけ
    expect(d.source_name).toBe("共有元A");
    const body = JSON.stringify(d);
    for (const secret of ["共有 花子", "hanako@example.org", "090-1111-2222", "内部メモ", "要配慮", "非公開の相談会", "応急手当", person]) {
      expect(body).not.toContain(secret);
    }
    // 検索でも未公開の値には当たらない
    expect(must(await bViewer.client.rpc("shared_people_list", { org: orgB, q: "hanako" }))).toEqual([]);
    expect(must(await bViewer.client.rpc("shared_people_list", { org: orgB, q: "みどり" })).length).toBe(1);
  });

  it("第三者の団体からは見えない。ID を差し替えても取得できない", async () => {
    // C は A と連携しているが、共有先ではない
    expect((await c.client.rpc("shared_person_detail", { org: orgC, p_grant: grantId })).error?.message).toBe("not_found");
    expect(must(await c.client.rpc("shared_people_list", { org: orgC }))).toEqual([]);
    // C が B の団体IDを名乗る
    expect((await c.client.rpc("shared_people_list", { org: orgB })).error).not.toBeNull();
    expect((await c.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })).error).not.toBeNull();
    // 直接テーブルを読む
    for (const t of ["person_share_grants", "person_share_versions", "sharing_authorizations"]) {
      expect(must(await c.client.from(t).select("*")), t).toEqual([]);
      expect(must(await bViewer.client.from(t).select("*")), t).toEqual([]);
    }
    // 共有先も、共有元のプレビュー・差分・人物原本は使えない
    expect((await b.client.rpc("preview_share", { org: orgA, pid: person, p_fields: ["email"] })).error).not.toBeNull();
    expect((await b.client.rpc("share_grant_diff", { grant_id: grantId })).error).not.toBeNull();
    expect(must(await b.client.from("people").select("*").eq("id", person))).toEqual([]);
  });

  it("共有先は元の人物データを変更できず、第三者へ再共有できない", async () => {
    const upd = await b.client.from("people").update({ full_name: "改ざん" }).eq("id", person).select();
    expect(upd.data ?? []).toEqual([]);
    expect((await b.client.from("person_share_versions").update({ snapshot: {} }).eq("grant_id", grantId).select()).data ?? []).toEqual([]);
    // B が C と連携していても、A の人物を共有元とする根拠・共有は作れない
    await partner(b, orgB, c, orgC);
    expect((await b.client.rpc("record_sharing_authorizations", {
      org: orgB, person_ids: [person], target: orgC, p_basis_type: "consent", p_basis_detail: "", p_purpose: "再共有",
      p_allowed_fields: ["display_name"], p_evidence_ref: "", p_confirmed_at: new Date().toISOString(),
    })).error).not.toBeNull();
    const r = must(await b.client.rpc("create_share_grants", {
      org: orgB, target: orgC, person_ids: [person], p_fields: ["display_name"], p_tag_ids: [], p_event_ids: [], p_expires_at: future(10),
    })) as { created: unknown[]; skipped: { reason: string }[] };
    expect(r.created).toEqual([]);
    expect(r.skipped[0].reason).toBe("not_found");
    // 共有された grant を B 側から直接作る・書き換えることもできない
    expect((await b.client.from("person_share_grants").insert({ organization_id: orgA, target_organization_id: orgC, person_id: person,
      authorization_id: grantId, fields: ["display_name"], expires_at: future(5) })).error).not.toBeNull();
  });

  it("原本を変更しても、更新版を公開するまで共有先には反映されない", async () => {
    must(await a.client.from("people").update({ region: "あおば町", display_name: "はなさん" }).eq("id", person));
    const before = must(await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })) as { snapshot: Record<string, unknown>; version: number };
    expect(before.snapshot.region).toBe("みどり市");
    expect(JSON.stringify(before)).not.toContain("あおば町");
    const diff = must(await a.client.rpc("share_grant_diff", { grant_id: grantId })) as { changed_keys: string[] };
    expect(diff.changed_keys.sort()).toEqual(["display_name", "region"]);
    must(await a.client.rpc("publish_share_update", { grant_id: grantId }));
    const after = must(await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })) as { snapshot: Record<string, unknown>; version: number };
    expect(after.snapshot.region).toBe("あおば町");
    expect(after.version).toBe(before.version + 1);
  });

  it("共有範囲の拡大は根拠の範囲内に限られ、連絡先は根拠に含めて初めて共有できる", async () => {
    expect((await a.client.rpc("update_share_grant", { grant_id: grantId, p_fields: ["display_name", "email"], p_tag_ids: [], p_participation_ids: [], p_expires_at: future(20) })).error?.message)
      .toBe("no_valid_authorization");
    await authorize(["display_name", "email"], { validUntil: future(60) });
    must(await a.client.rpc("update_share_grant", { grant_id: grantId, p_fields: ["display_name", "email"], p_tag_ids: [], p_participation_ids: [], p_expires_at: future(20) }));
    const d = must(await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })) as { snapshot: Record<string, unknown> };
    expect(d.snapshot).toEqual({ display_name: "はなさん", emails: ["hanako@example.org"] });
    // 項目を狭めると即座に新しい版になり、外した項目は見えなくなる
    must(await a.client.rpc("update_share_grant", { grant_id: grantId, p_fields: ["display_name"], p_tag_ids: [], p_participation_ids: [], p_expires_at: future(20) }));
    const d2 = must(await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })) as { snapshot: Record<string, unknown> };
    expect(d2.snapshot).toEqual({ display_name: "はなさん" });
  });

  it("共有停止で閲覧できなくなる", async () => {
    must(await a.client.rpc("stop_share_grants", { org: orgA, grant_ids: [grantId] }));
    expect(await bList()).toEqual([]);
    expect((await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })).error?.message).toBe("not_found");
  });

  it("期限切れで、定期ジョブを待たずに閲覧できなくなる", async () => {
    must(await admin.from("person_share_grants").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", grantId));
    const g = must(await admin.from("person_share_grants").select("status").eq("id", grantId).single());
    expect(g.status).toBe("active"); // 状態はまだ active のまま
    expect(await bList()).toEqual([]);
    expect((await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })).error?.message).toBe("not_found");
    must(await admin.from("person_share_grants").update({ status: "expired" }).eq("id", grantId));
  });

  it("根拠の撤回で閲覧できなくなる", async () => {
    const g = must(await admin.from("person_share_grants").select("authorization_id").eq("id", grantId).single());
    must(await a.client.rpc("withdraw_sharing_authorization", { auth_id: g.authorization_id, reason: "本人から申し出" }));
    expect((await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })).error?.message).toBe("not_found");
    // 撤回済みの根拠では新たに共有できない（ほかに有効な根拠があればそちらを使う）
    const auths = must(await a.client.from("sharing_authorizations").select("id").eq("person_id", person).eq("status", "active"));
    for (const x of auths) must(await a.client.rpc("withdraw_sharing_authorization", { auth_id: x.id, reason: "テスト" }));
    expect((await share(["display_name"])).skipped[0].reason).toBe("no_valid_authorization");
  });

  it("根拠の失効（有効期限切れ）でも閲覧できなくなる", async () => {
    expect(await bList()).toHaveLength(1);
    const g = must(await admin.from("person_share_grants").select("authorization_id").eq("id", grantId).single());
    must(await admin.from("sharing_authorizations").update({ valid_until: new Date(Date.now() - 1000).toISOString() }).eq("id", g.authorization_id));
    expect(await bList()).toEqual([]);
    expect((await bViewer.client.rpc("shared_person_detail", { org: orgB, p_grant: grantId })).error?.message).toBe("not_found");
    must(await a.client.rpc("stop_share_grants", { org: orgA, grant_ids: [grantId] }));
  });

  it("スタッフの退会・権限変更が反映される", async () => {
    expect(await bList()).toHaveLength(1);
    // 権限を外す
    must(await b.client.rpc("set_member_role", { org: orgB, member: bViewer.id, new_role: "viewer", new_permissions: [] }));
    expect((await bViewer.client.rpc("shared_people_list", { org: orgB })).error).not.toBeNull();
    must(await b.client.rpc("set_member_role", { org: orgB, member: bViewer.id, new_role: "viewer", new_permissions: ["view_shared"] }));
    expect(await bList()).toHaveLength(1);
    // 退会
    const leaver = await newUser("leaver");
    await join(orgB, b, leaver, "viewer", []);
    must(await b.client.rpc("set_member_role", { org: orgB, member: leaver.id, new_role: "viewer", new_permissions: ["view_shared"] }));
    expect(must(await leaver.client.rpc("shared_people_list", { org: orgB }))).toHaveLength(1);
    must(await b.client.rpc("remove_member", { org: orgB, member: leaver.id }));
    expect((await leaver.client.rpc("shared_people_list", { org: orgB })).error).not.toBeNull();
  });

  it("機能フラグを無効にすると閲覧できなくなる", async () => {
    await setFeatures(orgA, { partner_sharing: false });
    expect((await bList())).toEqual([]);
    await setFeatures(orgA, { partner_sharing: true });
    expect(await bList()).toHaveLength(1);
  });

  it("連携解除で両方向の共有が閲覧できなくなる", async () => {
    must(await a.client.rpc("end_partnership", { partnership: partnershipAB, org: orgA }));
    expect(await bList()).toEqual([]);
    const g = must(await a.client.from("person_share_grants").select("status, stop_reason").eq("id", grantId).single());
    expect(g).toEqual({ status: "stopped", stop_reason: "partnership_dissolved" });
  });
});

describe("監査記録", () => {
  it("設定変更と閲覧が記録され、共有データ本文は保存されない", async () => {
    const logs = must(await admin.from("sharing_audit_logs").select("action, detail").eq("source_organization_id", orgA));
    const actions = new Set(logs.map((l) => l.action));
    for (const x of ["partnership.request", "authorization.record", "grant.create", "grant.publish", "grant.update", "grant.stop", "shared.view", "authorization.withdraw", "partnership.dissolve"]) {
      expect(actions.has(x), x).toBe(true);
    }
    const body = JSON.stringify(logs);
    for (const secret of ["はなちゃん", "はなさん", "みどり市", "あおば町", "hanako@example.org"]) expect(body).not.toContain(secret);
    // 共有先の管理者は自団体が関わる記録だけを読める。第三者は読めない
    const forC = must(await c.client.from("sharing_audit_logs").select("source_organization_id, target_organization_id"));
    expect(forC.every((l) => l.source_organization_id === orgC || l.target_organization_id === orgC)).toBe(true);
  });
});
