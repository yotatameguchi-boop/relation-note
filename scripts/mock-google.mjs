// ローカル検証用の「Google を模した疑似サーバー」。本物の Google とは通信しない。
//   OAuth（認可画面は自動で許可して戻る）・トークン・Forms API・Sheets API の一部だけを真似る
//   node scripts/mock-google.mjs   （ポート 55690）
//   回答の追加：curl -X POST localhost:55690/mock/responses -d '{"name":"…","email":"…"}'
import http from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.MOCK_GOOGLE_PORT ?? 55690);
const codes = new Map(); // code → { challenge, scope }
const FORM_ID = "MOCKFORM1234567890abcdef";
const form = {
  formId: FORM_ID,
  info: { title: "ボランティア募集フォーム（疑似）", documentTitle: "ボランティア募集" },
  items: [
    { title: "お名前", questionItem: { question: { questionId: "q_name" } } },
    { title: "電話番号", questionItem: { question: { questionId: "q_tel" } } },
    { title: "参加できる曜日", questionItem: { question: { questionId: "q_days" } } },
  ],
};
const responses = [
  { responseId: "resp-001", lastSubmittedTime: "2026-10-20T01:00:00.000Z", respondentEmail: "kato@example.net",
    answers: { q_name: { questionId: "q_name", textAnswers: { answers: [{ value: "加藤 さとみ" }] } },
               q_days: { questionId: "q_days", textAnswers: { answers: [{ value: "土" }, { value: "日" }] } } } },
  { responseId: "resp-002", lastSubmittedTime: "2026-10-21T02:30:00.000Z", respondentEmail: "demo1@example.org",
    answers: { q_name: { questionId: "q_name", textAnswers: { answers: [{ value: "山田 太郎" }] } },
               q_tel: { questionId: "q_tel", textAnswers: { answers: [{ value: "090-0000-0000" }] } } } },
];
const sheet = [["氏名", "メールアドレス", "所属"], ["中島 健", "nakajima@example.net", "あおば大学"], ["森 しずか", "shizuka@example.org", ""]];

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
const authed = (req) => req.headers.authorization === "Bearer mock-access-token";

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === "/o/oauth2/v2/auth") {
    const code = `mock-code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { challenge: u.searchParams.get("code_challenge"), scope: u.searchParams.get("scope") });
    res.writeHead(302, { Location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(u.searchParams.get("state"))}` });
    return res.end();
  }
  if (u.pathname === "/token" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    if (p.get("client_id") !== "mock-client" || p.get("client_secret") !== "mock-secret") return json(res, 401, { error: "invalid_client" });
    if (p.get("grant_type") === "authorization_code") {
      const c = codes.get(p.get("code"));
      codes.delete(p.get("code"));
      const ok = c && createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") === c.challenge;
      if (!ok) return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { access_token: "mock-access-token", refresh_token: "mock-refresh-token", scope: c.scope,
        id_token: `${b64({ alg: "none" })}.${b64({ email: "staff@mock-google.test" })}.` });
    }
    if (p.get("grant_type") === "refresh_token") {
      if (p.get("refresh_token") !== "mock-refresh-token") return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { access_token: "mock-access-token", expires_in: 3600 });
    }
  }
  if (u.pathname === `/v1/forms/${FORM_ID}`) return authed(req) ? json(res, 200, form) : json(res, 401, {});
  if (u.pathname === `/v1/forms/${FORM_ID}/responses`) {
    if (!authed(req)) return json(res, 401, {});
    const since = (u.searchParams.get("filter") ?? "").match(/timestamp > (\S+)/)?.[1];
    return json(res, 200, { responses: responses.filter((r) => !since || r.lastSubmittedTime > since) });
  }
  if (u.pathname.startsWith("/v1/forms/")) return json(res, 404, { error: { message: "not found" } });
  if (/^\/v4\/spreadsheets\/[^/]+$/.test(u.pathname)) return authed(req) ? json(res, 200, { properties: { title: "参加者名簿（疑似）" } }) : json(res, 401, {});
  if (/^\/v4\/spreadsheets\/[^/]+\/values\//.test(u.pathname)) return authed(req) ? json(res, 200, { values: sheet }) : json(res, 401, {});
  if (u.pathname === "/mock/responses" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const id = `resp-${String(responses.length + 1).padStart(3, "0")}`;
    responses.push({ responseId: id, lastSubmittedTime: new Date().toISOString(), respondentEmail: b.email,
      answers: { q_name: { questionId: "q_name", textAnswers: { answers: [{ value: b.name }] } } } });
    return json(res, 200, { responseId: id });
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`mock google on :${PORT} (form id ${FORM_ID})`));
