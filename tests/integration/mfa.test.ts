import { describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { URL as SB_URL, join, must, newOrg, newUser, type TestUser } from "./helpers";

// 認証アプリと同じ計算で6桁のコードを作る（RFC 6238、30秒・SHA-1）
function totp(secret: string, t = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function enrollTotp(u: TestUser) {
  const { data, error } = await u.client.auth.mfa.enroll({ factorType: "totp", friendlyName: `test-${randomUUID().slice(0, 6)}` });
  if (error) throw error;
  must(await u.client.auth.mfa.challengeAndVerify({ factorId: data.id, code: totp(data.totp.secret) }));
  return data.totp.secret;
}

describe("二段階認証", () => {
  it("必須の組織は、二段階認証を済ませたログインでしかデータを読めない（DB で強制）", async () => {
    const owner = await newUser("mfa-owner");
    const org = await newOrg(owner);
    must(await owner.client.rpc("create_person", { org, data: { full_name: "見せたくない人" } }));
    const staff = await newUser("mfa-staff");
    await join(org, owner, staff, "editor");

    // 自分が二段階認証していないオーナーは必須にできない（締め出し防止）
    expect((await owner.client.rpc("set_org_require_mfa", { org, required: true })).error?.message).toBe("mfa_required_self");
    await enrollTotp(owner);
    must(await owner.client.rpc("set_org_require_mfa", { org, required: true }));
    expect((await owner.client.from("people").select("id").eq("organization_id", org)).data!.length).toBe(1);

    // 未設定のスタッフ：何も読めず、書けず、案内は「設定が必要」
    expect((await staff.client.from("people").select("id").eq("organization_id", org)).data!.length).toBe(0);
    expect((await staff.client.from("organizations").select("id").eq("id", org)).data!.length).toBe(0);
    expect((await staff.client.rpc("create_person", { org, data: { full_name: "x" } })).error).not.toBeNull();
    expect((await staff.client.rpc("org_usage", { org })).error).not.toBeNull();
    expect(must(await staff.client.rpc("mfa_gate", { org }))).toBe("enroll");
    expect((must(await staff.client.rpc("mfa_blocked_orgs")) as { id: string }[]).map((r) => r.id)).toContain(org);

    // 設定してコードを入力すると読める
    const secret = await enrollTotp(staff);
    expect(must(await staff.client.rpc("mfa_gate", { org }))).toBe("ok");
    expect((await staff.client.from("people").select("id").eq("organization_id", org)).data!.length).toBe(1);

    // 設定済みでも、パスワードだけのログイン（aal1）では読めない。案内は「コードの入力が必要」
    const again = createClient(SB_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    must(await again.auth.signInWithPassword({ email: staff.email, password: staff.password }));
    expect((await again.from("people").select("id").eq("organization_id", org)).data!.length).toBe(0);
    expect(must(await again.rpc("mfa_gate", { org }))).toBe("verify");
    const { data: f } = await again.auth.mfa.listFactors();
    must(await again.auth.mfa.challengeAndVerify({ factorId: f!.totp[0].id, code: totp(secret) }));
    expect((await again.from("people").select("id").eq("organization_id", org)).data!.length).toBe(1);

    // 所属していない人には何も教えない
    const stranger = await newUser("mfa-stranger");
    expect(must(await stranger.client.rpc("mfa_gate", { org }))).toBe("none");
    // 設定状況は管理者以上だけが見られる
    expect((await staff.client.rpc("member_mfa_status", { org })).error).not.toBeNull();
    const status = must(await owner.client.rpc("member_mfa_status", { org })) as { user_id: string; has_mfa: boolean }[];
    expect(status.every((s) => s.has_mfa)).toBe(true);
  });

  it("必須でない組織は、二段階認証なしでも従来どおり使える", async () => {
    const o = await newUser("mfa-free");
    const org = await newOrg(o);
    must(await o.client.rpc("create_person", { org, data: { full_name: "A" } }));
    expect((await o.client.from("people").select("id").eq("organization_id", org)).data!.length).toBe(1);
    expect(must(await o.client.rpc("mfa_gate", { org }))).toBe("ok");
  });

  it("弱いパスワードでは登録できない（認証サーバー側でも拒否）", async () => {
    const c = createClient(SB_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    for (const pw of ["short1", "abcdefghijkl", "1234567890123"]) {
      const { error } = await c.auth.signUp({ email: `weak-${randomUUID().slice(0, 8)}@test.example`, password: pw });
      expect(error?.code, pw).toBe("weak_password");
    }
  });
});
