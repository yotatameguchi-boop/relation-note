import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSubscription, subscriptionSummary, verifyStripeSignature, webhookSecret, type StripeSubscription } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Stripe からの通知。署名を確かめ、イベントIDで1回だけ処理する。
 * 組織は Stripe 側に保存した metadata.organization_id（無ければ顧客ID）で特定する。
 * 処理に失敗したら 500 を返し、Stripe の再送に任せる（記録したイベントは取り消す）。
 */
type Event = { id: string; type: string; data: { object: Record<string, unknown> } };

export async function POST(req: Request) {
  const text = await req.text();
  if (!verifyStripeSignature(text, req.headers.get("stripe-signature") ?? "", webhookSecret())) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  const event = JSON.parse(text) as Event;
  const db = createAdminClient();
  const obj = event.data.object;

  // 通知の順序は保証されないため、本文の状態ではなく Stripe から最新の契約を取り直して反映する
  // 請求書の契約IDは API の版によって位置が違う（2025-03 以降は parent.subscription_details 側）
  const parent = obj.parent as { subscription_details?: { subscription?: string } } | undefined;
  const linked = typeof obj.subscription === "string" ? obj.subscription : parent?.subscription_details?.subscription ?? null;
  const subId = event.type.startsWith("customer.subscription.") ? (obj.id as string)
    : ["checkout.session.completed", "invoice.paid", "invoice.payment_failed"].includes(event.type) ? linked
    : null;
  if (!subId) return NextResponse.json({ status: "ignored" });
  let sub: StripeSubscription;
  try {
    sub = await getSubscription(subId);
  } catch (e) {
    console.error("stripe webhook: subscription fetch failed", event.type, (e as Error).message);
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }

  let orgId = sub.metadata?.organization_id ?? (typeof obj.client_reference_id === "string" ? obj.client_reference_id : null);
  if (!orgId) {
    const { data } = await db.from("organizations").select("id").eq("stripe_customer_id", sub.customer).maybeSingle();
    orgId = data?.id ?? null;
  }
  if (!orgId) {
    console.error("stripe webhook: organization not found", event.type, event.id);
    return NextResponse.json({ status: "unknown_organization" });
  }

  const s = subscriptionSummary(sub);
  const { data: fresh, error: recErr } = await db.rpc("record_billing_event", {
    event_id: event.id, org: orgId, event_type: event.type,
    det: { status: s.status, cycle: s.cycle, period_end: s.periodEnd, cancel_at_period_end: s.cancelAtPeriodEnd },
  });
  if (recErr) return NextResponse.json({ error: "internal_error" }, { status: 500 });
  if (!fresh) return NextResponse.json({ status: "duplicate" });

  const { error } = await db.rpc("apply_stripe_subscription", {
    org: orgId, customer: sub.customer, subscription: sub.id, sub_status: s.status,
    cycle: s.cycle, period_end: s.periodEnd, cancel_at_end: s.cancelAtPeriodEnd,
  });
  if (error) {
    await db.from("billing_events").delete().eq("id", event.id);
    console.error("stripe webhook apply failed", event.type, error.code);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
  return NextResponse.json({ status: "ok" });
}
