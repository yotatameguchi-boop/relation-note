import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe との通信（SDK を使わず REST を直接呼ぶ）。
 *   STRIPE_SECRET_KEY        … sk_test_… / sk_live_…（未設定なら課金の画面は「準備中」）
 *   STRIPE_WEBHOOK_SECRET    … whsec_…（Webhook の署名確認）
 *   STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY … 価格ID（price_…）
 *   STRIPE_TAX_RATE_ID       … 消費税の税率ID（txr_…。任意）
 *   STRIPE_API_BASE          … ローカル検証で疑似サーバー（scripts/mock-stripe.mjs）に向ける場合だけ
 */
const cfg = () => ({
  key: process.env.STRIPE_SECRET_KEY ?? "",
  base: process.env.STRIPE_API_BASE ?? "https://api.stripe.com",
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  prices: { monthly: process.env.STRIPE_PRICE_MONTHLY ?? "", yearly: process.env.STRIPE_PRICE_YEARLY ?? "" },
  taxRate: process.env.STRIPE_TAX_RATE_ID ?? "",
});

export const billingConfigured = () => {
  const c = cfg();
  return !!(c.key && c.webhookSecret && c.prices.monthly && c.prices.yearly);
};
export const isTestMode = () => !cfg().key.startsWith("sk_live_");

/** Stripe の form-encoded 形式（a[b][0]=c）へ変換 */
export function encodeForm(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") out.push(...encodeForm(item as Record<string, unknown>, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") out.push(...encodeForm(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const c = cfg();
  if (!c.key) throw new StripeError("stripe_not_configured", 0);
  const body = params && method === "POST" ? encodeForm(params).join("&") : undefined;
  const qs = params && method === "GET" ? `?${encodeForm(params).join("&")}` : "";
  const res = await fetch(`${c.base}/v1/${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(json?.error?.message ?? `stripe_${res.status}`, res.status, json?.error?.code);
  return json as T;
}

export type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: { data: { current_period_end?: number; price: { id: string; recurring?: { interval: string } | null } }[] };
};

/** API の版によって current_period_end の位置が違う（2025-03 以降は items 側） */
export function subscriptionSummary(s: StripeSubscription) {
  const item = s.items?.data?.[0];
  const end = item?.current_period_end ?? s.current_period_end;
  return {
    status: s.status,
    cycle: item?.price?.recurring?.interval === "year" ? "yearly" : item?.price?.recurring?.interval === "month" ? "monthly" : null,
    periodEnd: end ? new Date(end * 1000).toISOString() : null,
    cancelAtPeriodEnd: !!s.cancel_at_period_end,
  };
}

export async function createCustomer(orgId: string, orgName: string, email: string) {
  return call<{ id: string }>("POST", "customers", {
    name: orgName, email, metadata: { organization_id: orgId }, preferred_locales: ["ja"],
  }, `customer-${orgId}`);
}

export async function createCheckoutSession(o: {
  orgId: string; customer: string; cycle: "monthly" | "yearly"; trialEnd: Date | null; successUrl: string; cancelUrl: string;
}) {
  const c = cfg();
  // 無料期間の残りがあるときは、その終わりまで請求しない（Stripe の制約で48時間以上先のときだけ）
  const trialEnd = o.trialEnd && o.trialEnd.getTime() - Date.now() > 49 * 3600e3 ? Math.floor(o.trialEnd.getTime() / 1000) : undefined;
  return call<{ id: string; url: string }>("POST", "checkout/sessions", {
    mode: "subscription",
    customer: o.customer,
    client_reference_id: o.orgId,
    line_items: [{ price: c.prices[o.cycle], quantity: 1 }],
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
    locale: "ja",
    metadata: { organization_id: o.orgId },
    subscription_data: {
      metadata: { organization_id: o.orgId },
      trial_end: trialEnd,
      default_tax_rates: c.taxRate ? [c.taxRate] : undefined,
    },
  });
}

export async function createPortalSession(customer: string, returnUrl: string) {
  return call<{ url: string }>("POST", "billing_portal/sessions", { customer, return_url: returnUrl, locale: "ja" });
}

export async function getSubscription(id: string) {
  return call<StripeSubscription>("GET", `subscriptions/${encodeURIComponent(id)}`);
}

/**
 * Webhook の署名確認（Stripe-Signature: t=<時刻>,v1=<HMAC-SHA256(secret, "t.本文")>）。
 * 時刻のずれが tolerance 秒を超えるものは、再送攻撃を防ぐため受け付けない。
 */
export function verifyStripeSignature(payload: string, header: string, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export const webhookSecret = () => cfg().webhookSecret;
