export type FieldType = "text" | "long_text" | "number" | "date" | "select" | "multi_select" | "checkbox" | "url" | "email" | "phone";

export type FieldDef = {
  id: string; entity: "person" | "company"; key: string; label: string; field_type: FieldType;
  options: string[]; required: boolean; position: number; archived: boolean;
};

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "文字（1行）", long_text: "文字（複数行）", number: "数値", date: "日付", select: "選択肢（1つ）",
  multi_select: "選択肢（複数）", checkbox: "チェック", url: "URL", email: "メールアドレス", phone: "電話番号",
};

/** フォームの cf:<key> 入力から、保存用の値を作る（検証は DB 側で行う） */
export function customValuesFromForm(fd: FormData, defs: FieldDef[]) {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    if (d.archived) continue;
    const name = `cf:${d.key}`;
    if (d.field_type === "checkbox") {
      if (fd.has(`${name}:present`)) out[d.key] = fd.get(name) === "on";
    } else if (d.field_type === "multi_select") {
      if (fd.has(`${name}:present`)) out[d.key] = fd.getAll(name).map(String);
    } else if (fd.has(name)) {
      const v = String(fd.get(name) ?? "").trim();
      out[d.key] = v === "" ? null : d.field_type === "number" ? v.replace(/,/g, "") : v;
    }
  }
  return out;
}

export function formatCustomValue(d: FieldDef, v: unknown): string {
  if (v == null || v === "") return "—";
  if (d.field_type === "checkbox") return v ? "はい" : "いいえ";
  if (Array.isArray(v)) return v.join("、");
  if (d.field_type === "number" && typeof v === "number") return v.toLocaleString("ja-JP");
  return String(v);
}

/** 機械向けのキー（英小文字・数字・_）をラベルから作る。日本語だけのラベルは連番にする */
export function keyFromLabel(label: string, existing: string[]) {
  let base = label.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  if (!/^[a-z]/.test(base)) base = `field${base ? `_${base}` : ""}`;
  let key = base;
  for (let i = 2; existing.includes(key); i++) key = `${base}_${i}`;
  return key;
}
