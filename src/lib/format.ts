const dtf = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
const dttf = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

export const fmtDate = (v?: string | null) => (v ? dtf.format(new Date(v)) : "—");
export const fmtDateTime = (v?: string | null) => (v ? dttf.format(new Date(v)) : "—");
export const fmtNum = (n?: number | null) => (n == null ? "—" : n.toLocaleString("ja-JP"));

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** datetime-local 入力値（日本時間）を ISO 文字列へ */
export function jstLocalToIso(v: string) {
  if (!v) return null;
  return new Date(`${v}:00+09:00`).toISOString();
}

export function isoToJstLocal(v?: string | null) {
  if (!v) return "";
  const d = new Date(new Date(v).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}

export const STATUS_LABEL: Record<string, string> = {
  applied: "申込",
  attended: "参加",
  absent: "欠席",
  cancelled: "キャンセル",
  pending: "処理待ち",
  linked: "既存人物に紐づけ",
  created: "新規作成",
  needs_review: "確認待ち",
  error: "エラー",
  ignored: "対象外",
  queued: "待機中",
  running: "実行中",
  processing: "処理中",
  completed: "完了",
  failed: "失敗",
  succeeded: "成功",
  dead: "隔離（要確認）",
  uploading: "アップロード中",
  analyzing: "解析中",
  analyzed: "解析済み",
  expired: "保存期限切れ",
};

export const MATCH_REASON_LABEL: Record<string, string> = {
  contact_and_name: "連絡先と氏名が一致",
  contact_only: "連絡先は一致するが氏名が異なる（家族で共有の可能性）",
  name_only: "氏名のみ一致（同姓同名の可能性）",
  multiple_matches: "一致する人物が複数",
  new: "一致なし（新規作成）",
  manual: "スタッフが判断",
};
