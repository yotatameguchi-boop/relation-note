// 外部サービスのデータを「項目名 → 値（文字列）」の行にそろえる。外部依存なし（Deno と Node で共通）
import { suggestMapping } from "./mapping.ts";

export type Row = { external_id: string | null; submitted_at: string | null; raw: Record<string, string> };

const joinValues = (v: unknown): string =>
  v == null ? "" : Array.isArray(v) ? v.map(joinValues).filter(Boolean).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);

// ------------------------------------------------------------
// Google フォーム（Forms API）
// ------------------------------------------------------------
type GForm = {
  formId: string;
  info?: { title?: string; documentTitle?: string };
  items?: { title?: string; questionItem?: { question: { questionId: string } };
            questionGroupItem?: { questions: { questionId: string; rowQuestion?: { title: string } }[] } }[];
};
type GResponse = {
  responseId: string; createTime?: string; lastSubmittedTime?: string; respondentEmail?: string;
  answers?: Record<string, { questionId: string; textAnswers?: { answers?: { value?: string }[] } }>;
};

export const RESPONDENT_EMAIL_COLUMN = "メールアドレス（回答者）";

/** 質問ID → 質問名（グリッド形式は「質問名：行」） */
export function googleFormQuestions(form: GForm): Map<string, string> {
  const q = new Map<string, string>();
  for (const item of form.items ?? []) {
    if (item.questionItem) q.set(item.questionItem.question.questionId, item.title ?? item.questionItem.question.questionId);
    for (const sub of item.questionGroupItem?.questions ?? []) {
      q.set(sub.questionId, `${item.title ?? ""}：${sub.rowQuestion?.title ?? sub.questionId}`);
    }
  }
  return q;
}

export function googleFormColumns(form: GForm, collectsEmail = true) {
  const cols = [...new Set(googleFormQuestions(form).values())];
  return collectsEmail ? [...cols, RESPONDENT_EMAIL_COLUMN] : cols;
}

export function googleFormResponsesToRows(form: GForm, responses: GResponse[]): Row[] {
  const q = googleFormQuestions(form);
  return responses.map((r) => {
    const raw: Record<string, string> = {};
    for (const a of Object.values(r.answers ?? {})) {
      const title = q.get(a.questionId) ?? a.questionId;
      raw[title] = joinValues((a.textAnswers?.answers ?? []).map((x) => x.value ?? ""));
    }
    if (r.respondentEmail) raw[RESPONDENT_EMAIL_COLUMN] = r.respondentEmail;
    return { external_id: r.responseId, submitted_at: r.lastSubmittedTime ?? r.createTime ?? null, raw };
  });
}

/** 回答者メールの列はメールとして提案する */
export function suggestGoogleFormMapping(columns: string[]) {
  const m = suggestMapping(columns);
  if (columns.includes(RESPONDENT_EMAIL_COLUMN) && !Object.values(m).includes("email")) m[RESPONDENT_EMAIL_COLUMN] = "email";
  return m;
}

// ------------------------------------------------------------
// Google スプレッドシート（Sheets API の values）
// 1行目を見出しとし、空行は飛ばす。行IDは無いので、内容のハッシュで重複を判定する（DB 側）
// ------------------------------------------------------------
export function sheetValuesToRows(values: string[][]): { columns: string[]; rows: Row[] } {
  const [header = [], ...body] = values ?? [];
  const columns = header.map((h, i) => (h ?? "").toString().trim() || `列${i + 1}`);
  const rows: Row[] = [];
  for (const line of body) {
    if (!line || line.every((c) => (c ?? "").toString().trim() === "")) continue;
    const raw: Record<string, string> = {};
    columns.forEach((c, i) => { raw[c] = (line[i] ?? "").toString(); });
    rows.push({ external_id: null, submitted_at: null, raw });
  }
  return { columns, rows };
}

// ------------------------------------------------------------
// Typeform（Webhook の form_response）
// ------------------------------------------------------------
type TfAnswer = {
  type: string; field: { id: string; ref?: string };
  text?: string; email?: string; phone_number?: string; number?: number; boolean?: boolean; date?: string; url?: string;
  choice?: { label?: string; other?: string }; choices?: { labels?: string[]; other?: string }; file_url?: string;
};
type TfPayload = {
  event_id?: string;
  form_response?: {
    token?: string; submitted_at?: string; landed_at?: string;
    definition?: { title?: string; fields?: { id: string; title: string }[] };
    answers?: TfAnswer[]; hidden?: Record<string, string>;
  };
};

export function typeformToRow(p: TfPayload): Row {
  const fr = p.form_response ?? {};
  const titles = new Map((fr.definition?.fields ?? []).map((f) => [f.id, f.title]));
  const raw: Record<string, string> = {};
  for (const a of fr.answers ?? []) {
    const title = titles.get(a.field.id) ?? a.field.ref ?? a.field.id;
    const v = a.text ?? a.email ?? a.phone_number ?? a.number ?? a.boolean ?? a.date ?? a.url ?? a.file_url
      ?? (a.choice ? a.choice.label ?? a.choice.other : undefined)
      ?? (a.choices ? [...(a.choices.labels ?? []), ...(a.choices.other ? [a.choices.other] : [])] : undefined);
    raw[title] = joinValues(typeof v === "boolean" ? (v ? "はい" : "いいえ") : v);
  }
  for (const [k, v] of Object.entries(fr.hidden ?? {})) raw[k] = joinValues(v);
  return { external_id: fr.token ?? p.event_id ?? null, submitted_at: fr.submitted_at ?? null, raw };
}

// ------------------------------------------------------------
// Tally（Webhook の FORM_RESPONSE）
// ------------------------------------------------------------
type TallyField = { key: string; label: string; type: string; value: unknown; options?: { id: string; text: string }[] };
type TallyPayload = { eventId?: string; createdAt?: string; data?: { responseId?: string; submissionId?: string; createdAt?: string; fields?: TallyField[] } };

export function tallyToRow(p: TallyPayload): Row {
  const raw: Record<string, string> = {};
  for (const f of p.data?.fields ?? []) {
    let v: unknown = f.value;
    // 選択式は選択肢IDの配列で届くので、表示名に置き換える
    if (f.options && Array.isArray(v)) v = v.map((id) => f.options!.find((o) => o.id === id)?.text ?? id);
    else if (f.options && typeof v === "string") v = f.options.find((o) => o.id === v)?.text ?? v;
    if (typeof v === "boolean") v = v ? "はい" : "いいえ";
    raw[f.label || f.key] = joinValues(v);
  }
  return { external_id: p.data?.responseId ?? p.data?.submissionId ?? p.eventId ?? null, submitted_at: p.data?.createdAt ?? p.createdAt ?? null, raw };
}

/** フォームのURLやIDから Google フォームのIDを取り出す（編集用URL・回答用URLのどちらでも） */
export function parseGoogleFormId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

export function parseSpreadsheetId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}
