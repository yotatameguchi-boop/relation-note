import { describe, expect, it } from "vitest";
import { admin, must, newOrg, newUser } from "./helpers";

const orgRow = async (org: string) =>
  must(await admin.from("organizations").select("status, billing_suspended, subscription_status, billing_cycle, current_period_end, cancel_at_period_end, stripe_customer_id").eq("id", org).single());
const days = (n: number) => new Date(Date.now() + n * 86400e3).toISOString();

describe("課金・契約", () => {
  it("新しい組織は30日間の無料期間から始まる", async () => {
    const o = await newUser("bill-owner");
    const org = await newOrg(o);
    const { data } = await admin.from("organizations").select("subscription_status, trial_ends_at").eq("id", org).single();
    expect(data!.subscription_status).toBe("trialing");
    const left = (Date.parse(data!.trial_ends_at) - Date.now()) / 86400e3;
    expect(left).toBeGreaterThan(29.9);
    expect(left).toBeLessThanOrEqual(30);
  });

  it("無料期間が終わると停止中（閲覧のみ）になり、申し込むと再開する", async () => {
    const o = await newUser("bill-trial");
    const org = await newOrg(o);
    must(await admin.from("organizations").update({ trial_ends_at: days(-1) }).eq("id", org));
    expect(must(await admin.rpc("refresh_org_access", { org }))).toBe("suspended");
    expect(await orgRow(org)).toMatchObject({ status: "suspended", billing_suspended: true });
    // 停止中は登録できないが、閲覧はできる
    const ins = await o.client.from("people").insert({ organization_id: org, full_name: "停止中の登録" });
    expect(ins.error).not.toBeNull();
    expect((await o.client.from("people").select("id").eq("organization_id", org)).error).toBeNull();

    must(await admin.rpc("apply_stripe_subscription", { org, customer: `cus_${org.slice(0, 8)}`, subscription: `sub_${org.slice(0, 8)}`,
      sub_status: "active", cycle: "yearly", period_end: days(365), cancel_at_end: false }));
    expect(await orgRow(org)).toMatchObject({ status: "active", billing_suspended: false, subscription_status: "active", billing_cycle: "yearly" });
    const { data: logs } = await admin.from("audit_logs").select("action").eq("organization_id", org).eq("action", "billing.subscription_updated");
    expect(logs!.length).toBe(1);
  });

  it("支払い失敗は猶予期間中は使え、期間末を過ぎた解約は停止中になる", async () => {
    const o = await newUser("bill-pastdue");
    const org = await newOrg(o);
    const base = { org, customer: `cus_p${org.slice(0, 8)}`, subscription: `sub_p${org.slice(0, 8)}`, cycle: "monthly", cancel_at_end: false };
    must(await admin.rpc("apply_stripe_subscription", { ...base, sub_status: "past_due", period_end: days(-3) }));
    expect(await orgRow(org)).toMatchObject({ status: "active", subscription_status: "past_due" });
    must(await admin.rpc("apply_stripe_subscription", { ...base, sub_status: "past_due", period_end: days(-15) }));
    expect((await orgRow(org)).status).toBe("suspended");
    // 解約予約中は期間末まで使える
    must(await admin.rpc("apply_stripe_subscription", { ...base, sub_status: "active", period_end: days(20), cancel_at_end: true }));
    expect(await orgRow(org)).toMatchObject({ status: "active", cancel_at_period_end: true });
    must(await admin.rpc("apply_stripe_subscription", { ...base, sub_status: "canceled", period_end: days(-1) }));
    expect(await orgRow(org)).toMatchObject({ status: "suspended", subscription_status: "canceled" });
  });

  it("運営者が手で止めた組織は、契約の更新で勝手に再開しない", async () => {
    const o = await newUser("bill-manual");
    const org = await newOrg(o);
    must(await admin.from("organizations").update({ status: "suspended" }).eq("id", org));
    must(await admin.rpc("refresh_all_org_access"));
    expect(await orgRow(org)).toMatchObject({ status: "suspended", billing_suspended: false });
  });

  it("Stripe の通知は同じイベントIDで2回処理しない", async () => {
    const o = await newUser("bill-event");
    const org = await newOrg(o);
    const id = `evt_${crypto.randomUUID()}`;
    expect(must(await admin.rpc("record_billing_event", { event_id: id, org, event_type: "customer.subscription.updated", det: { status: "active" } }))).toBe(true);
    expect(await admin.rpc("record_billing_event", { event_id: id, org, event_type: "customer.subscription.updated", det: {} }).then((r) => r.data)).toBe(false);
    // 履歴はオーナーだけが見られる
    const { data } = await o.client.from("billing_events").select("id").eq("id", id);
    expect(data!.length).toBe(1);
  });

  it("利用者は契約状態を書き換えられず、課金・監視の関数も呼べない", async () => {
    const o = await newUser("bill-attack");
    const org = await newOrg(o);
    const up = await o.client.from("organizations").update({ subscription_status: "complimentary" }).eq("id", org);
    expect(up.error).not.toBeNull();
    const up2 = await o.client.from("organizations").update({ trial_ends_at: days(3650) }).eq("id", org);
    expect(up2.error).not.toBeNull();
    for (const [fn, args] of [
      ["apply_stripe_subscription", { org, customer: "c", subscription: "s", sub_status: "active", cycle: "monthly", period_end: days(30), cancel_at_end: false }],
      ["refresh_org_access", { org }],
      ["record_billing_event", { event_id: "evt_x", org, event_type: "x", det: {} }],
      ["set_stripe_customer", { org, customer: "c", email: "e" }],
      ["ops_health", {}],
      ["worker_heartbeat", { p_processed: 0, p_failed: 0, p_ms: 0 }],
    ] as const) {
      const r = await o.client.rpc(fn, args);
      expect(r.error, fn).not.toBeNull();
    }
    expect((await orgRow(org)).subscription_status).toBe("trialing");
  });

  it("登録時に同意した規約の版を記録し、後から同意し直せる", async () => {
    const email = `terms-${crypto.randomUUID().slice(0, 8)}@test.example`;
    const { data } = await admin.auth.admin.createUser({ email, password: `pw-${crypto.randomUUID()}`, email_confirm: true, user_metadata: { terms_version: "2026-10-25" } });
    const { data: u } = await admin.from("users").select("terms_version, terms_accepted_at").eq("id", data.user!.id).single();
    expect(u!.terms_version).toBe("2026-10-25");
    expect(u!.terms_accepted_at).not.toBeNull();
    const o = await newUser("terms-later");
    must(await o.client.rpc("accept_terms", { version: "2026-10-25" }));
    const { data: u2 } = await admin.from("users").select("terms_version").eq("id", o.id).single();
    expect(u2!.terms_version).toBe("2026-10-25");
  });

  it("監視の集計は件数だけを返す", async () => {
    must(await admin.rpc("worker_heartbeat", { p_processed: 1, p_failed: 0, p_ms: 12 }));
    const h = must(await admin.rpc("ops_health")) as Record<string, unknown>;
    expect(Number(h.worker_minutes_since_run)).toBeLessThanOrEqual(1);
    expect(Object.keys(h).sort()).toEqual(["checked_at", "connectors_in_error", "cron_failures_1h", "db_size_mb", "emails_failed_24h", "jobs_dead_24h",
      "jobs_running_stuck", "orgs", "queue_length", "queue_oldest_minutes", "worker_last_run", "worker_minutes_since_run"]);
  });

  it("人数カウンター：同時に追加しても上限を超えず、削除後も実数と一致する", async () => {
    const o = await newUser("counter");
    const org = await newOrg(o);
    await admin.from("plans").upsert({ id: "test-five", name: "テスト5", max_staff: 2, max_people: 5, max_photo_analyses_per_month: 1, max_storage_bytes: 1000 });
    must(await admin.from("organizations").update({ plan_id: "test-five" }).eq("id", org));
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => o.client.rpc("create_person", { org, data: { full_name: `同時${i}` } })));
    expect(results.filter((r) => !r.error).length).toBe(5);
    expect(results.filter((r) => r.error).every((r) => r.error!.message === "quota_exceeded:people")).toBe(true);
    // 複数行の一括追加で上限を超えると、文ごと取り消す
    const bulk = await admin.from("people").insert([{ organization_id: org, full_name: "a" }, { organization_id: org, full_name: "b" }]);
    expect(bulk.error?.message).toBe("quota_exceeded:people");
    const ids = must(await admin.from("people").select("id").eq("organization_id", org)).map((r: { id: string }) => r.id);
    must(await admin.from("people").delete().in("id", ids.slice(0, 2)));
    const { data: c } = await admin.from("org_counters").select("people").eq("organization_id", org).single();
    expect(c!.people).toBe(3);
    const usage = must(await o.client.rpc("org_usage", { org })) as { people: { used: number } };
    expect(usage.people.used).toBe(3);
  });
});
