// ローカル検証用の「Stripe を模した疑似サーバー」。本物の Stripe とは通信せず、請求も発生しない。
//   顧客作成・Checkout（開くと即「支払い完了」にして戻る）・カスタマーポータル（解約／支払い失敗を再現）・契約の取得だけを真似る。
//   契約が変わるたびに、本物と同じ形式で署名した Webhook をアプリへ送る。
//   STRIPE_WEBHOOK_SECRET=whsec_mock node scripts/mock-stripe.mjs   （ポート 55691）
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";

const PORT = Number(process.env.MOCK_STRIPE_PORT ?? 55691);
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_mock";
const HOOK = process.env.MOCK_STRIPE_WEBHOOK_URL ?? "http://localhost:3080/api/billing/webhook";
const id = (p) => `${p}_${randomBytes(8).toString("hex")}`;
const customers = new Map();
const sessions = new Map();
const subs = new Map();

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
// a[b][0][c]=x 形式を入れ子のオブジェクトに戻す
function parseForm(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const keys = k.replace(/\]/g, "").split("[");
    let o = out;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) o[key] = v;
      else o = o[key] ??= {};
    });
  }
  return out;
}

async function sendEvent(type, object) {
  const event = { id: id("evt"), type, created: Math.floor(Date.now() / 1000), data: { object } };
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  const r = await fetch(HOOK, { method: "POST", body, headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${sig}` } })
    .catch((e) => ({ status: `error ${e.message}` }));
  console.log(`webhook ${type} → ${r.status}`);
}

const page = (res, html) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:520px;margin:40px auto">${html}</body>`); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const auth = req.headers.authorization ?? "";
  if (u.pathname.startsWith("/v1/") && !/^Bearer sk_test_/.test(auth)) return json(res, 401, { error: { message: "Invalid API Key" } });

  if (u.pathname === "/v1/customers" && req.method === "POST") {
    const p = parseForm(await readBody(req));
    const c = { id: id("cus"), email: p.email, name: p.name, metadata: p.metadata ?? {} };
    customers.set(c.id, c);
    return json(res, 200, c);
  }
  if (u.pathname === "/v1/checkout/sessions" && req.method === "POST") {
    const p = parseForm(await readBody(req));
    if (!p.line_items?.["0"]?.price) return json(res, 400, { error: { message: "price required" } });
    const sid = id("cs_test");
    const s = { ...p, id: sid, url: `http://localhost:${PORT}/pay/${sid}` };
    sessions.set(s.id, s);
    return json(res, 200, { id: s.id, url: s.url });
  }
  if (u.pathname === "/v1/billing_portal/sessions" && req.method === "POST") {
    const p = parseForm(await readBody(req));
    const sid = `bps_${randomBytes(6).toString("hex")}`;
    sessions.set(sid, { customer: p.customer, return_url: p.return_url });
    return json(res, 200, { url: `http://localhost:${PORT}/portal/${sid}` });
  }
  const m = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
  if (m && req.method === "GET") return subs.has(m[1]) ? json(res, 200, subs.get(m[1])) : json(res, 404, { error: { message: "No such subscription" } });

  // 決済画面：開いた時点で支払い成功とみなす
  const pay = u.pathname.match(/^\/pay\/(.+)$/);
  if (pay) {
    const s = sessions.get(pay[1]);
    if (!s) return page(res, "セッションが見つかりません");
    const price = s.line_items["0"].price;
    const interval = /year/.test(price) ? "year" : "month";
    const now = Math.floor(Date.now() / 1000);
    const trialEnd = s.subscription_data?.trial_end ? Number(s.subscription_data.trial_end) : null;
    const end = trialEnd ?? now + (interval === "year" ? 365 : 30) * 86400;
    const sub = {
      id: id("sub"), object: "subscription", customer: s.customer, status: trialEnd ? "trialing" : "active",
      cancel_at_period_end: false, metadata: s.subscription_data?.metadata ?? {},
      items: { data: [{ current_period_end: end, price: { id: price, recurring: { interval } } }] },
    };
    subs.set(sub.id, sub);
    await sendEvent("checkout.session.completed", { id: s.id, object: "checkout.session", subscription: sub.id, customer: s.customer, client_reference_id: s.client_reference_id });
    res.writeHead(303, { Location: s.success_url });
    return res.end();
  }
  // カスタマーポータル：解約予約・即時解約・支払い失敗を再現
  const portal = u.pathname.match(/^\/portal\/(.+)$/);
  if (portal) {
    const s = sessions.get(portal[1]);
    const sub = [...subs.values()].find((x) => x.customer === s?.customer && x.status !== "canceled");
    const action = u.searchParams.get("do");
    if (sub && action) {
      if (action === "cancel_at_end") sub.cancel_at_period_end = true;
      if (action === "resume") sub.cancel_at_period_end = false;
      if (action === "cancel_now") { sub.status = "canceled"; sub.items.data[0].current_period_end = Math.floor(Date.now() / 1000) - 1; }
      if (action === "payment_failed") sub.status = "past_due";
      await sendEvent(action === "cancel_now" ? "customer.subscription.deleted" : "customer.subscription.updated", sub);
      res.writeHead(303, { Location: s.return_url });
      return res.end();
    }
    return page(res, `<h1>疑似カスタマーポータル</h1><p>契約：${sub ? `${sub.id}（${sub.status}${sub.cancel_at_period_end ? "・解約予約" : ""}）` : "なし"}</p>
      <ul>${["cancel_at_end", "resume", "cancel_now", "payment_failed"].map((a) => `<li><a href="?do=${a}">${a}</a></li>`).join("")}</ul>
      <p><a href="${s?.return_url}">戻る</a></p>`);
  }
  json(res, 404, { error: { message: "not found" } });
}).listen(PORT, () => console.log(`mock stripe on :${PORT} → webhook ${HOOK}`));
