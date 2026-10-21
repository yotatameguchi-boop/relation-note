import Papa from "papaparse";

export const TARGET_FIELDS = [
  { value: "ignore", label: "取り込まない" },
  { value: "full_name", label: "氏名" },
  { value: "full_name_kana", label: "ふりがな" },
  { value: "email", label: "メールアドレス" },
  { value: "phone", label: "電話番号" },
  { value: "region", label: "居住地域" },
  { value: "tags", label: "タグ（カンマ区切り）" },
  { value: "note", label: "備考（回答に保存）" },
  { value: "external_id", label: "回答ID（二重取り込み防止）" },
  { value: "submitted_at", label: "回答日時" },
] as const;

export type Mapping = Record<string, string>;

/** Excel 由来の Shift_JIS にも対応する */
export function decodeCsvBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; errors: string[] } {
  const res = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const headers = (res.meta.fields ?? []).filter((h) => h !== "");
  const rows = res.data.map((r) => {
    const out: Record<string, string> = {};
    for (const h of headers) out[h] = (r[h] ?? "").toString();
    return out;
  });
  const errors = res.errors.slice(0, 20).map((e) => `${e.row != null ? `${e.row + 2}行目: ` : ""}${e.message}`);
  return { headers, rows, errors };
}

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

/** 列名から対応先を推測する（スタッフが確認・修正する前提の初期値） */
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

export type ImportRow = { raw: Record<string, string>; dedupe_key: string | null; external_id: string | null };

/** 回答IDの列があればそれを重複判定キーにし、なければDB側で回答原文のハッシュを使う */
export function toImportRows(rows: Record<string, string>[], mapping: Mapping): ImportRow[] {
  const idCol = Object.entries(mapping).find(([, t]) => t === "external_id")?.[0];
  return rows.map((raw) => {
    const ext = idCol ? raw[idCol]?.trim() || null : null;
    return { raw, dedupe_key: ext, external_id: ext };
  });
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 出力用：CSV のセルを安全にエスケープする（数式インジェクション対策込み） */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
