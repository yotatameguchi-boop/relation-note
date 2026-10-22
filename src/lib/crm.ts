export const INTERACTION_KIND_LABEL: Record<string, string> = {
  call: "電話", meeting: "面談", email: "メール", visit: "訪問", online: "オンライン", other: "その他",
};
export const DIRECTION_LABEL: Record<string, string> = { inbound: "先方から", outbound: "こちらから" };
export const PRIORITY_LABEL: Record<string, string> = { high: "高", normal: "中", low: "低" };
export const TASK_STATUS_LABEL: Record<string, string> = { open: "未完了", done: "完了", cancelled: "取りやめ" };

/** 日本時間の今日（YYYY-MM-DD） */
export const todayStr = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export function dueState(due: string | null, status: string) {
  if (status !== "open" || !due) return null;
  const t = todayStr();
  return due < t ? "overdue" : due === t ? "today" : "upcoming";
}

export const CAMPAIGN_STATUS: Record<string, [string, string]> = {
  draft: ["下書き", ""], sending: ["送信中", "badge-warn"], sent: ["送信済み", "badge-ok"], failed: ["停止（要確認）", "badge-danger"], cancelled: ["取りやめ", ""],
};
export const RECIPIENT_STATUS: Record<string, [string, string]> = {
  queued: ["送信待ち", "badge-warn"], sending: ["送信中", "badge-warn"], sent: ["送信済み", "badge-ok"],
  failed: ["失敗", "badge-danger"], unknown: ["送信不明（再送しない）", "badge-danger"], skipped: ["配信停止のため除外", ""],
};
