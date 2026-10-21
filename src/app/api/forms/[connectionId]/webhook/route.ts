import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 外部フォームからの受信口。
 *   Authorization: Bearer <接続ごとの秘密>
 *   本文: { "response_id": "...", "submitted_at": "ISO8601", "answers": { "氏名": "...", ... } }
 *   （answers が無ければ本文全体を回答原文として扱う）
 * 保存先の組織は接続設定から決まり、送信側からは指定できない。
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const secret = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const text = await req.text();
  if (text.length > 256 * 1024) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const answers = (body.answers && typeof body.answers === "object" ? body.answers : body) as Record<string, unknown>;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) flat[k] = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
  const extId = typeof body.response_id === "string" ? body.response_id : null;
  const sentAt = typeof body.submitted_at === "string" && !Number.isNaN(Date.parse(body.submitted_at)) ? body.submitted_at : null;

  const { data, error } = await createAdminClient().rpc("ingest_webhook_submission", {
    conn: connectionId, secret, ext_id: extId, payload: flat, sent_at: sentAt,
  });
  if (error) {
    if (error.message === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (error.message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    console.error("webhook ingest failed", error.code); // 回答原文はログに出さない
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
  return NextResponse.json(data, { status: (data as { status: string }).status === "duplicate" ? 200 : 202 });
}
