// 契約状態の表示（画面上部のお知らせと「料金・契約」ページで使う）。サーバー・クライアントどちらからも使える純粋な関数。
import { fmtDate, nowMs } from "@/lib/format";

export type OrgBilling = {
  status: string;
  billing_suspended: boolean;
  subscription_status: string;
  trial_ends_at: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export const SUBSCRIPTION_LABEL: Record<string, string> = {
  trialing: "無料期間",
  active: "契約中",
  past_due: "支払いの確認待ち",
  canceled: "解約済み",
  unpaid: "未払い",
  incomplete: "手続き未完了",
  complimentary: "無償提供",
};

// 契約の更新履歴の表示用（Stripe 側の状態と通知の種類）
export const STRIPE_STATUS_LABEL: Record<string, string> = {
  trialing: "申し込み済み（無料期間中）",
  active: "支払い中",
  past_due: "支払い失敗（再請求中）",
  canceled: "解約",
  unpaid: "未払い",
  incomplete: "手続き未完了",
  incomplete_expired: "手続き期限切れ",
  paused: "一時停止",
};
export const BILLING_EVENT_LABEL: Record<string, string> = {
  "checkout.session.completed": "申し込み",
  "customer.subscription.created": "契約の作成",
  "customer.subscription.updated": "契約の変更",
  "customer.subscription.deleted": "契約の終了",
  "invoice.paid": "支払い完了",
  "invoice.payment_failed": "支払い失敗",
};

const DAY = 86400e3;

/** 画面上部に出すお知らせ。出す必要がなければ null */
export function billingNotice(b: OrgBilling, owner: boolean, now = nowMs()) {
  const link = owner;
  if (b.status === "suspended" && b.billing_suspended) {
    const why = b.subscription_status === "trialing" ? "無料期間が終了しました" : b.subscription_status === "canceled" ? "契約期間が終了しました" : "お支払いが確認できていません";
    return {
      tone: "notice-warn", suspended: true, link,
      text: `${why}。データの閲覧と出力のみ行えます。${owner ? "お申し込みいただくと、すぐに元どおり使えます。" : "組織のオーナーにお問い合わせください。"}`,
    };
  }
  if (b.subscription_status === "trialing") {
    const left = Math.ceil((Date.parse(b.trial_ends_at) - now) / DAY);
    if (left > 7) return null;
    return { tone: "notice-info", suspended: false, link, text: `無料期間は残り${Math.max(left, 0)}日（${fmtDate(b.trial_ends_at)}まで）です。` };
  }
  if (b.subscription_status === "past_due" || b.subscription_status === "unpaid") {
    return { tone: "notice-danger", suspended: false, link, text: "お支払いが確認できていません。お支払い方法をご確認ください。" };
  }
  if (b.cancel_at_period_end && b.current_period_end) {
    return { tone: "notice-info", suspended: false, link, text: `解約の手続き済みです。${fmtDate(b.current_period_end)}まで利用できます。` };
  }
  return null;
}
