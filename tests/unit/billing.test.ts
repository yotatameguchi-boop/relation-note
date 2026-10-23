import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { encodeForm, subscriptionSummary, verifyStripeSignature } from "@/lib/stripe";
import { billingNotice } from "@/lib/billing";
import { evaluateHealth, type OpsHealth } from "@/lib/health";

const sign = (body: string, secret: string, t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("Stripe の署名確認", () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  it("正しい署名を受け付ける", () => {
    expect(verifyStripeSignature(body, sign(body, "whsec_a", now), "whsec_a", 300, now)).toBe(true);
  });
  it("複数の v1（鍵の切り替え中）のどれかが合えば受け付ける", () => {
    const h = `${sign(body, "whsec_a", now)},v1=${"0".repeat(64)}`;
    expect(verifyStripeSignature(body, h.replace(/v1=([0-9a-f]+),v1=/, `v1=${"f".repeat(64)},v1=$1,v1=`), "whsec_a", 300, now)).toBe(true);
  });
  it("秘密・本文・時刻が違えば拒否する", () => {
    expect(verifyStripeSignature(body, sign(body, "whsec_b", now), "whsec_a", 300, now)).toBe(false);
    expect(verifyStripeSignature(body + " ", sign(body, "whsec_a", now), "whsec_a", 300, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, "whsec_a", now - 301), "whsec_a", 300, now)).toBe(false);
    expect(verifyStripeSignature(body, "", "whsec_a", 300, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, "", now), "", 300, now)).toBe(false);
  });
});

describe("Stripe の送信形式", () => {
  it("入れ子・配列を a[b][0][c] 形式にする", () => {
    const s = encodeForm({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], subscription_data: { metadata: { organization_id: "o" }, trial_end: undefined } });
    expect(decodeURIComponent(s.join("&"))).toBe("mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&subscription_data[metadata][organization_id]=o");
  });
  it("契約の期間末は新旧どちらの API 版でも読める", () => {
    const base = { id: "sub", customer: "cus", status: "active", cancel_at_period_end: false };
    expect(subscriptionSummary({ ...base, items: { data: [{ current_period_end: 1_800_000_000, price: { id: "p", recurring: { interval: "year" } } }] } }))
      .toMatchObject({ cycle: "yearly", periodEnd: new Date(1_800_000_000_000).toISOString() });
    expect(subscriptionSummary({ ...base, current_period_end: 1_800_000_000, items: { data: [{ price: { id: "p", recurring: { interval: "month" } } }] } }))
      .toMatchObject({ cycle: "monthly", periodEnd: new Date(1_800_000_000_000).toISOString() });
  });
});

describe("契約のお知らせ", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const b = { status: "active", billing_suspended: false, subscription_status: "trialing", trial_ends_at: "2026-11-24T00:00:00Z", current_period_end: null, cancel_at_period_end: false };
  it("無料期間の残りが7日を切るまでは出さない", () => {
    expect(billingNotice(b, true, now)).toBeNull();
    expect(billingNotice({ ...b, trial_ends_at: "2026-10-28T00:00:00Z" }, true, now)?.text).toContain("残り3日");
  });
  it("契約の都合で停止したら、オーナーには申し込みを、他のスタッフにはオーナーへの連絡を案内する", () => {
    const s = { ...b, status: "suspended", billing_suspended: true, trial_ends_at: "2026-10-01T00:00:00Z" };
    expect(billingNotice(s, true, now)?.text).toContain("お申し込みいただくと");
    expect(billingNotice(s, false, now)?.text).toContain("オーナーにお問い合わせ");
  });
  it("支払い失敗・解約予約を知らせる", () => {
    expect(billingNotice({ ...b, subscription_status: "past_due" }, true, now)?.tone).toBe("notice-danger");
    expect(billingNotice({ ...b, subscription_status: "active", cancel_at_period_end: true, current_period_end: "2026-11-30T00:00:00Z" }, true, now)?.text).toContain("解約の手続き済み");
  });
});

describe("監視のしきい値", () => {
  const ok: OpsHealth = { worker_minutes_since_run: 1, queue_length: 0, queue_oldest_minutes: 0, jobs_dead_24h: 0, jobs_running_stuck: 0,
    cron_failures_1h: 0, emails_failed_24h: 0, connectors_in_error: 3, db_size_mb: 30, orgs: { active: 1, suspended: 0, past_due: 0 } };
  it("問題がなければ ok（連携のエラーは各組織の画面で知らせるので監視の対象外）", () => {
    expect(evaluateHealth(ok)).toEqual({ status: "ok", problems: [] });
  });
  it("ワーカー停止・滞留・失敗の多発を degraded にする", () => {
    expect(evaluateHealth({ ...ok, worker_minutes_since_run: "Infinity" }).problems).toEqual(["worker_stale:never"]);
    const r = evaluateHealth({ ...ok, queue_length: 40, queue_oldest_minutes: 30, jobs_dead_24h: 5, db_size_mb: 450 });
    expect(r.status).toBe("degraded");
    expect(r.problems).toEqual(["queue_backlog:40jobs/30min", "dead_jobs_24h:5", "db_size:450MB"]);
  });
});
