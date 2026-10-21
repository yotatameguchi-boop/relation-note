// 受け入れ条件：退会や権限変更が適切にアクセス制御へ反映される／最後のオーナーは削除・脱退できない
import { beforeAll, describe, expect, it } from "vitest";
import { must, newOrg, newUser, join, type TestUser } from "./helpers";

let owner: TestUser, adminU: TestUser, editor: TestUser, viewer: TestUser;
let org: string;

beforeAll(async () => {
  owner = await newUser("owner");
  adminU = await newUser("admin");
  editor = await newUser("editor");
  viewer = await newUser("viewer");
  org = await newOrg(owner);
  await join(org, owner, adminU, "admin", ["bulk_export", "merge_people"]);
  await join(org, owner, editor, "editor");
  await join(org, owner, viewer, "viewer");
});

describe("役割ごとの権限", () => {
  it("閲覧者は閲覧できるが登録できない", async () => {
    const { data } = await viewer.client.from("people").select("id").eq("organization_id", org);
    expect(data).toEqual([]);
    const { error } = await viewer.client.rpc("create_person", { org, data: { full_name: "x" } });
    expect(error).not.toBeNull();
  });

  it("編集者は人物を登録できるが、削除・一括操作・統合はできない", async () => {
    const p1 = must(await editor.client.rpc("create_person", { org, data: { full_name: "甲" } })) as string;
    const p2 = must(await editor.client.rpc("create_person", { org, data: { full_name: "乙" } })) as string;
    const { count } = await editor.client.from("people").delete({ count: "exact" }).eq("id", p1);
    expect(count ?? 0).toBe(0);
    expect((await editor.client.rpc("bulk_delete_people", { org, ids: [p1] })).error).not.toBeNull();
    expect((await editor.client.rpc("request_people_export", { org, filters: {} })).error).not.toBeNull();
    expect((await editor.client.rpc("merge_people", { org, keep_id: p1, merge_id: p2 })).error).not.toBeNull();
  });

  it("一括削除は「一括削除」の明示的な権限が必要（管理者でも既定では不可）", async () => {
    const p = must(await adminU.client.rpc("create_person", { org, data: { full_name: "丙" } })) as string;
    expect((await adminU.client.rpc("bulk_delete_people", { org, ids: [p] })).error).not.toBeNull();
    expect(must(await owner.client.rpc("bulk_delete_people", { org, ids: [p] }))).toBe(1);
  });

  it("管理者は「権限変更」なしでは役割を変えられない", async () => {
    const { error } = await adminU.client.rpc("set_member_role", { org, member: editor.id, new_role: "viewer", new_permissions: [] });
    expect(error).not.toBeNull();
    // 管理者の招待も権限変更が必要
    const x = await newUser("x");
    expect((await adminU.client.rpc("create_invitation", { org, invitee_email: x.email, invitee_role: "admin" })).error).not.toBeNull();
    // 編集者・閲覧者の招待はできる
    expect((await adminU.client.rpc("create_invitation", { org, invitee_email: x.email, invitee_role: "viewer", invitee_permissions: [] })).error).toBeNull();
  });

  it("権限変更は即座に反映される（編集者→閲覧者）", async () => {
    must(await owner.client.rpc("set_member_role", { org, member: editor.id, new_role: "viewer", new_permissions: [] }));
    expect((await editor.client.rpc("create_person", { org, data: { full_name: "丁" } })).error).not.toBeNull();
    must(await owner.client.rpc("set_member_role", { org, member: editor.id, new_role: "editor", new_permissions: [] }));
    expect((await editor.client.rpc("create_person", { org, data: { full_name: "丁" } })).error).toBeNull();
  });

  it("削除されたスタッフは即座に何も見えなくなる", async () => {
    const leaver = await newUser("leaver");
    await join(org, owner, leaver, "editor");
    expect((await leaver.client.from("people").select("id").eq("organization_id", org)).data!.length).toBeGreaterThan(0);
    must(await owner.client.rpc("remove_member", { org, member: leaver.id }));
    expect((await leaver.client.from("people").select("id").eq("organization_id", org)).data).toEqual([]);
    expect((await leaver.client.rpc("create_person", { org, data: { full_name: "x" } })).error).not.toBeNull();
  });

  it("招待は別のメールアドレスでは受け入れられず、一度しか使えない", async () => {
    const invited = await newUser("invited");
    const other = await newUser("other");
    const token = must(await owner.client.rpc("create_invitation", { org, invitee_email: invited.email, invitee_role: "viewer", invitee_permissions: [] })) as string;
    expect((await other.client.rpc("accept_invitation", { raw_token: token })).error).not.toBeNull();
    must(await invited.client.rpc("accept_invitation", { raw_token: token }));
    expect((await other.client.rpc("accept_invitation", { raw_token: token })).error).not.toBeNull();
  });

  it("最後のオーナーは脱退・降格できない。移譲後は可能", async () => {
    const e1 = (await owner.client.rpc("remove_member", { org, member: owner.id })).error;
    expect(e1?.message).toBe("last_owner");
    must(await owner.client.rpc("transfer_ownership", { org, new_owner: adminU.id }));
    const roles = must(await owner.client.from("memberships").select("user_id, role").eq("organization_id", org));
    expect(roles.find((r) => r.user_id === adminU.id)?.role).toBe("owner");
    expect(roles.find((r) => r.user_id === owner.id)?.role).toBe("admin");
    // 新オーナーは脱退できない（最後のオーナー）
    expect((await adminU.client.rpc("remove_member", { org, member: adminU.id })).error?.message).toBe("last_owner");
  });

  it("団体設定の変更はオーナーのみ。プラン・状態は利用者から変更できない", async () => {
    const { data } = await editor.client.from("organizations").update({ name: "改名" }).eq("id", org).select();
    expect(data ?? []).toEqual([]);
    const { error } = await adminU.client.from("organizations").update({ plan_id: "large" } as never).eq("id", org);
    expect(error).not.toBeNull();
  });
});
