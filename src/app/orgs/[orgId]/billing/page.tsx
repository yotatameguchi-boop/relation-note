import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMembership, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { PRICING, withTax, yen } from "@/lib/legal";
import { BILLING_EVENT_LABEL, STRIPE_STATUS_LABEL, SUBSCRIPTION_LABEL } from "@/lib/billing";
import { billingConfigured, createCheckoutSession, createCustomer, createPortalSession, isTestMode } from "@/lib/stripe";
import { Flash } from "@/components/ui";

const fail = (orgId: string, msg: string) => redirect(`/orgs/${orgId}/billing?error=${encodeURIComponent(msg)}`);

/** 申し込み：Stripe の決済画面へ移動する（カード情報は Stripe の画面で入力し、当サービスには届かない） */
async function subscribe(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const cycle = fd.get("cycle") === "yearly" ? "yearly" : "monthly";
  await requireMembership(orgId, "owner");
  const user = await requireUser();
  if (!billingConfigured()) fail(orgId, "決済の設定が済んでいません。");
  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations").select("name, stripe_customer_id, subscription_status, trial_ends_at").eq("id", orgId).single();
  if (!org) fail(orgId, "組織が見つかりません。");
  if (["active", "past_due", "unpaid", "complimentary"].includes(org!.subscription_status)) fail(orgId, "すでに契約中です。変更は「契約の変更・解約」から行えます。");
  let url = "";
  try {
    let customer = org!.stripe_customer_id as string | null;
    if (!customer) {
      customer = (await createCustomer(orgId, org!.name, user.email ?? "")).id;
      await admin.rpc("set_stripe_customer", { org: orgId, customer, email: user.email });
    }
    const trialEnd = org!.subscription_status === "trialing" ? new Date(org!.trial_ends_at) : null;
    const base = `${env.appUrl}/orgs/${orgId}/billing`;
    const session = await createCheckoutSession({
      orgId, customer, cycle, trialEnd,
      successUrl: `${base}?ok=${encodeURIComponent("お申し込みを受け付けました。反映まで数秒かかることがあります。")}`,
      cancelUrl: base,
    });
    url = session.url;
  } catch (e) {
    console.error("checkout failed", (e as Error).message);
    fail(orgId, "決済画面を開けませんでした。時間をおいてもう一度お試しください。");
  }
  redirect(url);
}

/** 契約の変更・解約・支払い方法の変更・請求書：Stripe のカスタマーポータルへ */
async function portal(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  await requireMembership(orgId, "owner");
  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations").select("stripe_customer_id").eq("id", orgId).single();
  if (!org?.stripe_customer_id) fail(orgId, "まだお申し込みがありません。");
  let url = "";
  try {
    url = (await createPortalSession(org!.stripe_customer_id!, `${env.appUrl}/orgs/${orgId}/billing`)).url;
  } catch (e) {
    console.error("portal failed", (e as Error).message);
    fail(orgId, "契約の管理画面を開けませんでした。時間をおいてもう一度お試しください。");
  }
  redirect(url);
}

export default async function Billing({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  await requireMembership(orgId, "owner");
  const supabase = await createClient();
  const [{ data: org }, { data: events }] = await Promise.all([
    supabase.from("organizations").select("status, billing_suspended, subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, billing_cycle, stripe_customer_id, plans(name)").eq("id", orgId).single(),
    supabase.from("billing_events").select("id, type, detail, received_at").eq("organization_id", orgId).order("received_at", { ascending: false }).limit(10),
  ]);
  if (!org) return null;
  const ready = billingConfigured();
  // Stripe 側の解約予約中は active のまま。canceled は期間が終わった状態なので、申し込み直せる
  const subscribed = ["active", "past_due", "unpaid", "complimentary"].includes(org.subscription_status);
  const hidden = <input type="hidden" name="orgId" value={orgId} />;

  return (
    <>
      <h1>料金・契約</h1>
      <Flash sp={sp} />
      {!ready && (
        <div className="notice notice-warn small">
          オンライン決済は準備中です（運営者による決済サービスの設定が済んでいません）。お申し込みは運営者までご連絡ください。
        </div>
      )}
      {ready && isTestMode() && <div className="notice notice-info small">テストモードで動いています。実際の請求は発生しません。</div>}

      <div className="card">
        <div className="spread">
          <h2 style={{ margin: 0 }}>現在の契約</h2>
          <span className={`badge ${org.status === "active" ? "badge-ok" : "badge-warn"}`}>
            {SUBSCRIPTION_LABEL[org.subscription_status] ?? org.subscription_status}{org.status === "suspended" ? "（停止中：閲覧・出力のみ）" : ""}
          </span>
        </div>
        <table className="small" style={{ marginTop: 12 }}><tbody>
          <tr><th>プラン</th><td>{(org.plans as unknown as { name: string } | null)?.name ?? "—"}</td></tr>
          {org.subscription_status === "trialing" && <tr><th>無料期間</th><td>{fmtDateTime(org.trial_ends_at)} まで</td></tr>}
          {org.subscription_status !== "trialing" && <tr><th>支払い周期</th><td>{org.billing_cycle === "yearly" ? "年払い" : "月払い"}</td></tr>}
          {org.current_period_end && (
            org.subscription_status === "canceled"
              ? <tr><th>契約の終了日</th><td>{fmtDate(org.current_period_end)}</td></tr>
              : <tr><th>{org.cancel_at_period_end ? "利用できる期限" : "次回の更新日"}</th><td>{fmtDate(org.current_period_end)}{org.cancel_at_period_end ? "（解約の手続き済み）" : ""}</td></tr>
          )}
        </tbody></table>
      </div>

      {!subscribed && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>標準プランに申し込む</h2>
          <p className="small">
            {org.subscription_status === "trialing"
              ? "今申し込んでも、無料期間の終わりまでは請求されません。"
              : "申し込みが完了すると、すぐに元どおり使えるようになります。"}
            初期費用はかかりません。いつでも解約でき、解約後も支払い済みの期間の終わりまで使えます。
          </p>
          <div className="grid grid-2">
            {(["monthly", "yearly"] as const).map((c) => (
              <form key={c} action={subscribe} className="card" style={{ marginBottom: 0 }}>
                {hidden}
                <input type="hidden" name="cycle" value={c} />
                <h3 style={{ marginTop: 0 }}>{c === "monthly" ? "月払い" : "年払い（2か月分お得）"}</h3>
                <p style={{ fontSize: "1.4rem", margin: "4px 0" }}>{yen(PRICING[c])}<span className="small muted">／{c === "monthly" ? "月" : "年"}（税別）</span></p>
                <p className="small muted">税込 {yen(withTax(PRICING[c]))}</p>
                <button disabled={!ready}>{c === "monthly" ? "月払いで申し込む" : "年払いで申し込む"}</button>
              </form>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            お申し込みの前に<Link href="/terms" target="_blank">利用規約</Link>と<Link href="/legal" target="_blank">特定商取引法に基づく表記</Link>をご確認ください。
            カード情報は決済代行会社（Stripe）の画面で入力し、当サービスには保存されません。
          </p>
        </div>
      )}

      {org.stripe_customer_id && (
        <form action={portal} className="card">
          {hidden}
          <h2 style={{ marginTop: 0 }}>契約の変更・解約</h2>
          <p className="small">支払い周期の変更、支払い方法の変更、領収書・請求書の確認、解約は Stripe の管理画面で行えます。</p>
          <button className="btn-secondary" disabled={!ready}>契約の管理画面を開く</button>
        </form>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>停止中になった場合</h2>
        <p className="small">
          無料期間の終了・契約期間の終了・お支払いの未確認が続いた場合、組織は「停止中」になります。停止中も登録データの閲覧と出力は行えます。
          停止から90日を過ぎるとデータを削除することがあります（<Link href="/terms" target="_blank">利用規約</Link>第8条）。
        </p>
      </div>

      {!!events?.length && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>契約の更新履歴</h2>
          <table className="small"><thead><tr><th>日時</th><th>内容</th><th>状態</th></tr></thead><tbody>
            {events.map((e) => (
              <tr key={e.id}><td>{fmtDateTime(e.received_at)}</td><td>{BILLING_EVENT_LABEL[e.type] ?? e.type}{(e.detail as { cancel_at_period_end?: boolean }).cancel_at_period_end ? "（解約予約）" : ""}</td><td>{STRIPE_STATUS_LABEL[(e.detail as { status?: string }).status ?? ""] ?? (e.detail as { status?: string }).status}</td></tr>
            ))}
          </tbody></table>
        </div>
      )}
    </>
  );
}
