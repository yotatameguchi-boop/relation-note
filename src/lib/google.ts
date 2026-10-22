import "server-only";

// Google OAuth（サーバー側）。URL は環境変数で差し替え可能（ローカルの疑似サーバーでの検証用）
export const google = {
  clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  authorizeUrl: process.env.GOOGLE_OAUTH_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
};

export const googleConfigured = () => Boolean(google.clientId && google.clientSecret);

// 読み取り専用の権限だけを求める
export const SCOPES: Record<string, string[]> = {
  google_forms: ["openid", "email", "https://www.googleapis.com/auth/forms.body.readonly", "https://www.googleapis.com/auth/forms.responses.readonly"],
  google_sheets: ["openid", "email", "https://www.googleapis.com/auth/spreadsheets.readonly"],
};

/** id_token の中身（メールアドレスだけ使う。トークンは Google から TLS で直接受け取ったもの） */
export function emailFromIdToken(idToken: string | undefined) {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
