import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluateHealth, type OpsHealth } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 稼働確認。外形監視（GitHub Actions など）から呼ぶ。
 *   認証なし：{ status: "ok" | "degraded" | "down" } だけ（中身は返さない）
 *   Authorization: Bearer <HEALTH_TOKEN>：各指標と、しきい値を超えた項目
 * DB に届かない場合は 503。
 */
function authorized(req: Request) {
  const token = process.env.HEALTH_TOKEN ?? "";
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return !!token && got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

export async function GET(req: Request) {
  const started = Date.now();
  let health: OpsHealth;
  try {
    const { data, error } = await createAdminClient().rpc("ops_health");
    if (error) throw error;
    health = data as OpsHealth;
  } catch (e) {
    console.error("health check: database unreachable", (e as Error).message);
    return NextResponse.json({ status: "down" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const { status, problems } = evaluateHealth(health);
  const body = authorized(req) ? { status, problems, db_ms: Date.now() - started, metrics: health } : { status };
  return NextResponse.json(body, { status: status === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
