import "server-only";
import { createClient } from "@/lib/supabase/server";

export const SHARE_FIELDS = [
  { key: "display_name", label: "表示名" },
  { key: "full_name", label: "氏名" },
  { key: "region", label: "居住地域" },
  { key: "interests", label: "関心分野" },
  { key: "skills", label: "スキル" },
  { key: "tags", label: "選んだタグ" },
  { key: "activities", label: "選んだ活動履歴（参加確認済み）" },
] as const;

// 連絡先は他の項目と分けて、明示的に選ばせる
export const CONTACT_FIELDS = [
  { key: "email", label: "メールアドレス" },
  { key: "phone", label: "電話番号" },
] as const;

export const ALL_SHARE_FIELDS = [...SHARE_FIELDS, ...CONTACT_FIELDS];
export const FIELD_LABEL: Record<string, string> = Object.fromEntries(ALL_SHARE_FIELDS.map((f) => [f.key, f.label]));
const KEYS = new Set<string>(ALL_SHARE_FIELDS.map((f) => f.key));

export function parseFields(values: FormDataEntryValue[] | string[]) {
  return [...new Set(values.map(String).filter((v) => KEYS.has(v)))];
}

export const BASIS_LABEL: Record<string, string> = {
  consent: "本人の同意",
  contract: "契約・規約に基づく",
  other: "その他の根拠",
};

export const GRANT_STATE_LABEL: Record<string, string> = {
  live: "共有中",
  stopped: "停止",
  expired: "期限切れ",
  feature_disabled: "機能が無効",
  partnership_inactive: "連携解除",
  authorization_withdrawn: "根拠の撤回",
  authorization_expired: "根拠の失効",
  authorization_missing: "根拠なし",
  authorization_mismatch: "根拠と範囲が不一致",
  not_published: "未公開",
  organization_inactive: "団体が無効",
};

export type Partnership = {
  id: string; partner_id: string; partner_name: string; status: string; direction: "incoming" | "outgoing";
  message: string | null; requested_at: string; responded_at: string | null; dissolved_at: string | null;
  outgoing_live: number; incoming_live: number;
};

export async function listPartnerships(orgId: string): Promise<Partnership[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("list_partnerships", { org: orgId });
  return (data ?? []) as Partnership[];
}

/** 連携・申請の相手の団体名（組織テーブルは自団体しか読めないため） */
export async function partnerNames(orgId: string) {
  const ps = await listPartnerships(orgId);
  return new Map(ps.map((p) => [p.partner_id, p.partner_name]));
}

export const SNAPSHOT_KEY_LABEL: Record<string, string> = {
  display_name: "表示名", full_name: "氏名", region: "居住地域", interests: "関心分野", skills: "スキル",
  tags: "タグ", activities: "活動履歴", emails: "メールアドレス", phones: "電話番号",
};

/** スナップショットを表示用の行にする（含まれている項目だけ） */
export function snapshotRows(s: Record<string, unknown>) {
  const rows: { label: string; value: string; contact: boolean }[] = [];
  const join = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? `${(x as { date?: string }).date ?? ""} ${(x as { title?: string }).title ?? ""}`.trim() : String(x))).join("、") : v == null || v === "" ? "（未登録）" : String(v));
  const map: [string, string, boolean][] = [
    ["display_name", "表示名", false], ["full_name", "氏名", false], ["region", "居住地域", false],
    ["interests", "関心分野", false], ["skills", "スキル", false], ["tags", "タグ", false], ["activities", "活動履歴", false],
    ["emails", "メールアドレス", true], ["phones", "電話番号", true],
  ];
  for (const [k, label, contact] of map) if (k in s) rows.push({ label, value: join(s[k]) || "（なし）", contact });
  return rows;
}
