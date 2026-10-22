// Google API（フォーム・スプレッドシート）への問い合わせ。URL は環境変数で差し替えられる（ローカルの疑似サーバーでの検証用）
import { NonRetryableError } from "./detector.ts";

/** 連携の取り消し・期限切れなど、利用者が連携し直す必要がある */
export class ReauthError extends NonRetryableError {}

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const TOKEN_URL = () => env("GOOGLE_OAUTH_TOKEN_URL", "https://oauth2.googleapis.com/token");
const FORMS_API = () => env("GOOGLE_FORMS_API", "https://forms.googleapis.com");
const SHEETS_API = () => env("GOOGLE_SHEETS_API", "https://sheets.googleapis.com");

export function googleConfigured() {
  return Boolean(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET"));
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  if (!googleConfigured()) throw new NonRetryableError("Google 連携の設定（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）がありません");
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    if (body.error === "invalid_grant") throw new ReauthError("Google の連携が取り消されたか、期限が切れました。連携し直してください。");
    throw new Error(`Google のトークンを取得できません（${res.status} ${body.error ?? ""}）`);
  }
  return body.access_token as string;
}

async function getJson(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new ReauthError("Google の連携が無効です。連携し直してください。");
  if (res.status === 403) throw new NonRetryableError("このフォーム・シートを読む権限がありません（連携したアカウントに編集権限があるか確認してください）");
  if (res.status === 404) throw new NonRetryableError("フォーム・シートが見つかりません（URL を確認してください）");
  if (!res.ok) throw new Error(`Google API エラー（${res.status}）：${body?.error?.message ?? ""}`);
  return body;
}

export const getForm = (token: string, formId: string) =>
  getJson(`${FORMS_API()}/v1/forms/${encodeURIComponent(formId)}`, token);

/** since（RFC3339）より後に送信された回答。最大 maxPages ページ */
export async function listFormResponses(token: string, formId: string, since: string | null, maxPages = 10) {
  const out: unknown[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const u = new URL(`${FORMS_API()}/v1/forms/${encodeURIComponent(formId)}/responses`);
    u.searchParams.set("pageSize", "500");
    if (since) u.searchParams.set("filter", `timestamp > ${since}`);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const body = await getJson(u.toString(), token);
    out.push(...(body.responses ?? []));
    pageToken = body.nextPageToken;
    if (!pageToken) return { responses: out, complete: true };
  }
  return { responses: out, complete: false };
}

export async function getSheetValues(token: string, spreadsheetId: string, sheet: string | null) {
  const range = sheet ? `'${sheet.replace(/'/g, "''")}'` : "A1:ZZ";
  const body = await getJson(
    `${SHEETS_API()}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, token);
  return (body.values ?? []) as string[][];
}

export async function getSpreadsheetTitle(token: string, spreadsheetId: string) {
  const body = await getJson(`${SHEETS_API()}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title`, token);
  return body?.properties?.title as string | undefined;
}
