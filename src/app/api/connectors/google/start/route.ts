import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { google, googleConfigured, SCOPES } from "@/lib/google";

// Google との連携を始める（組織の管理者だけ）
export async function GET(req: NextRequest) {
  const conn = req.nextUrl.searchParams.get("conn") ?? "";
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return NextResponse.redirect(new URL("/login", req.url));
  const { data: c } = await supabase.from("form_connections").select("id, organization_id, kind").eq("id", conn).maybeSingle();
  if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const back = `/orgs/${c.organization_id}/forms/${c.id}`;
  const { data: isAdmin } = await supabase.rpc("has_role", { org: c.organization_id, min_role: "admin" });
  if (!isAdmin) return NextResponse.redirect(new URL(`${back}?error=${encodeURIComponent("連携は管理者が行います。")}`, req.url));
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL(`${back}?error=${encodeURIComponent("Google 連携の設定（OAuth クライアント）がまだありません。運営者に連絡してください。")}`, req.url));
  }
  if (!SCOPES[c.kind]) return NextResponse.json({ error: "not_supported" }, { status: 400 });

  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const { error } = await createAdminClient().from("oauth_states").insert({
    state, organization_id: c.organization_id, connection_id: c.id, user_id: u.user.id, code_verifier: verifier,
  });
  if (error) return NextResponse.redirect(new URL(`${back}?error=${encodeURIComponent("連携を開始できませんでした。")}`, req.url));

  const url = new URL(google.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: `${env.appUrl}/api/connectors/google/callback`,
    response_type: "code",
    scope: SCOPES[c.kind].join(" "),
    access_type: "offline",          // 定期取得のためにリフレッシュトークンを受け取る
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return NextResponse.redirect(url);
}
