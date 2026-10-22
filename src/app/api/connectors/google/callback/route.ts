import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { emailFromIdToken, google, SCOPES } from "@/lib/google";

// Google から戻ってきたところ。state（1回限り・10分）と、連携を始めた本人であることを確認してから鍵を保存する
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const state = sp.get("state") ?? "";
  const admin = createAdminClient();
  const { data: st } = await admin.from("oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st) return NextResponse.redirect(new URL(`/orgs?error=${encodeURIComponent("連携の手続きが無効か、期限切れです。もう一度お試しください。")}`, req.url));
  await admin.from("oauth_states").delete().eq("state", state);
  const back = `/orgs/${st.organization_id}/forms/${st.connection_id}`;
  const fail = (msg: string) => NextResponse.redirect(new URL(`${back}?error=${encodeURIComponent(msg)}`, req.url));

  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user || u.user.id !== st.user_id || new Date(st.expires_at) < new Date()) return fail("連携の手続きが無効か、期限切れです。");
  const { data: isAdmin } = await supabase.rpc("has_role", { org: st.organization_id, min_role: "admin" });
  if (!isAdmin) return fail("連携は管理者が行います。");
  if (sp.get("error")) return fail(sp.get("error") === "access_denied" ? "Google での許可がキャンセルされました。" : "Google との連携に失敗しました。");

  const res = await fetch(google.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: sp.get("code") ?? "", code_verifier: st.code_verifier,
      client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: `${env.appUrl}/api/connectors/google/callback`,
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.refresh_token) return fail("Google から連携用の鍵を受け取れませんでした。もう一度お試しください。");
  const { data: c } = await admin.from("form_connections").select("kind").eq("id", st.connection_id).single();
  const granted = String(tok.scope ?? "");
  const missing = (SCOPES[c?.kind ?? ""] ?? []).filter((s) => s.startsWith("https://") && !granted.includes(s));
  if (missing.length) return fail("必要な権限（読み取り）が許可されませんでした。もう一度、すべての項目を許可してください。");

  const { error } = await admin.rpc("store_connector_secret", {
    conn: st.connection_id, p_purpose: "google_refresh_token", secret: tok.refresh_token, p_scopes: granted, account: emailFromIdToken(tok.id_token),
  });
  if (error) return fail("連携の保存に失敗しました。");
  await admin.from("audit_logs").insert({ organization_id: st.organization_id, actor_id: st.user_id, action: "connector.connect",
    target_type: "form_connection", target_id: st.connection_id, detail: { provider: "google", account: emailFromIdToken(tok.id_token) } });
  return NextResponse.redirect(new URL(`${back}?ok=${encodeURIComponent("Google と連携しました。続けてフォーム・シートの URL を設定してください。")}`, req.url));
}
