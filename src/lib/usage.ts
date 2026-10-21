export type UsageItem = { used: number; limit: number };
export type Usage = {
  plan: { id: string; name: string };
  period: string;
  staff: UsageItem;
  people: UsageItem;
  photo_analysis: UsageItem;
  storage_bytes: UsageItem;
};

export const USAGE_LABEL: Record<keyof Omit<Usage, "plan" | "period">, string> = {
  staff: "スタッフ",
  people: "登録人物",
  photo_analysis: "今月の写真解析",
  storage_bytes: "写真保存容量",
};

/** 上限の8割で事前通知、上限で新規処理を停止（既存データの閲覧・出力は可能） */
export function usageWarnings(u: Usage) {
  return (Object.keys(USAGE_LABEL) as (keyof typeof USAGE_LABEL)[])
    .map((k) => ({ key: k, label: USAGE_LABEL[k], ...u[k], ratio: u[k].limit ? u[k].used / u[k].limit : 0 }))
    .filter((x) => x.ratio >= 0.8);
}
