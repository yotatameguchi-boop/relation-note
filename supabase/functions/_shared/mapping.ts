// 列名・質問名から取り込み先を推測する（スタッフが確認・修正する前提の初期値）。CSV と外部連携で共通
export type Mapping = Record<string, string>;

const GUESSES: [RegExp, string][] = [
  [/(ふりがな|フリガナ|カナ|kana)/i, "full_name_kana"],
  [/(氏名|名前|お名前|name)/i, "full_name"],
  [/(メール|e-?mail|mail)/i, "email"],
  [/(電話|tel|phone|携帯)/i, "phone"],
  [/(住所|地域|居住|市区町村|都道府県|region|address)/i, "region"],
  [/(タイムスタンプ|回答日時|送信日時|timestamp|submitted)/i, "submitted_at"],
  [/(回答id|response.?id|応募番号|受付番号)/i, "external_id"],
  [/(タグ|分類|関心|tag)/i, "tags"],
  [/(備考|メモ|ご意見|note|comment)/i, "note"],
];

export function suggestMapping(headers: string[]): Mapping {
  const used = new Set<string>();
  const m: Mapping = {};
  for (const h of headers) {
    const hit = GUESSES.find(([re, target]) => re.test(h) && (target === "tags" || target === "note" || !used.has(target)));
    m[h] = hit ? hit[1] : `attr:${h}`;
    if (hit) used.add(hit[1]);
  }
  return m;
}
