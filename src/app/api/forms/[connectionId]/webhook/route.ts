import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { tallyToRow, typeformToRow } from "@shared/connectors";

export const runtime = "nodejs";

/**
 * 外部フォームからの受信口。保存先の組織は接続（URL の ID）で決まり、送信側からは指定できない。
 *   汎用（kind=webhook）：Authorization: Bearer <送信用の秘密>
 *     本文 { "response_id": "...", "submitted_at": "ISO8601", "answers": { "氏名": "...", ... } }（answers が無ければ本文全体）
 *   Typeform：Typeform-Signature: sha256=<base64(HMAC-SHA256(秘密, 本文))>
 *   Tally   ：Tally-Signature: <base64(HMAC-SHA256(秘密, 本文))>
 * 回答原文はログに出さない。
 */
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest("base64");

export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const text = await req.text();
  if (text.length > 512 * 1024) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const db = createAdminClient();
  const { data: conn } = await db.from("form_connections").select("id, kind, is_active").eq("id", connectionId).maybeSingle();
  if (!conn || !conn.is_active) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (conn.kind === "typeform" || conn.kind === "tally") {
    const { data: secret } = await db.rpc("get_connector_secret", { conn: conn.id });
    if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 401 });
    const header = conn.kind === "typeform" ? req.headers.get("typeform-signature") ?? "" : req.headers.get("tally-signature") ?? "";
    const expected = conn.kind === "typeform" ? `sha256=${sign(secret as string, text)}` : sign(secret as string, text);
    if (!header || !safeEqual(header, expected)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (conn.kind === "tally" && body.eventType && body.eventType !== "FORM_RESPONSE") return NextResponse.json({ status: "ignored" });
    const row = conn.kind === "typeform" ? typeformToRow(body as never) : tallyToRow(body as never);
    const { data, error } = await db.rpc("ingest_verified_submission", {
      conn: conn.id, ext_id: row.external_id, payload: row.raw, sent_at: row.submitted_at,
    });
    if (error) {
      console.error("webhook ingest failed", conn.kind, error.code);
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
    return NextResponse.json(data, { status: (data as { status: string }).status === "duplicate" ? 200 : 202 });
  }

  if (conn.kind !== "webhook") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const secret = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const answers = (body.answers && typeof body.answers === "object" ? body.answers : body) as Record<string, unknown>;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) flat[k] = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
  const extId = typeof body.response_id === "string" ? body.response_id : null;
  const sentAt = typeof body.submitted_at === "string" && !Number.isNaN(Date.parse(body.submitted_at)) ? body.submitted_at : null;
  const { data, error } = await db.rpc("ingest_webhook_submission", { conn: connectionId, secret, ext_id: extId, payload: flat, sent_at: sentAt });
  if (error) {
    if (error.message === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (error.message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    console.error("webhook ingest failed", error.code);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
  return NextResponse.json(data, { status: (data as { status: string }).status === "duplicate" ? 200 : 202 });
}
