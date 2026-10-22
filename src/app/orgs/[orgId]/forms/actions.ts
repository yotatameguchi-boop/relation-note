"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";

export async function createConnection(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { data, error } = await supabase.from("form_connections").insert({
    organization_id: orgId,
    name: String(fd.get("name") ?? "").trim(),
    kind: ["webhook", "google_forms", "google_sheets", "typeform", "tally"].includes(String(fd.get("kind"))) ? String(fd.get("kind")) : "csv",
    event_id: String(fd.get("event_id") ?? "") || null,
  }).select("id").single();
  if (error) redirect(`/orgs/${orgId}/forms?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/forms/${data.id}`);
}

/** CSV取り込み画面から呼ぶ（項目対応表の保存） */
export async function saveMapping(orgId: string, connId: string, mapping: Record<string, string>, defaultTagIds?: string[]) {
  const supabase = await createClient();
  const patch: Record<string, unknown> = { field_mapping: mapping };
  if (defaultTagIds) patch.default_tag_ids = defaultTagIds;
  const { error } = await supabase.from("form_connections").update(patch).eq("organization_id", orgId).eq("id", connId);
  if (error) return { error: toMessage(error, "項目対応を保存できませんでした（管理者のみ変更できます）。") };
  revalidatePath(`/orgs/${orgId}/forms/${connId}`);
  return { ok: true };
}

export async function updateConnection(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const connId = String(fd.get("connId"));
  const supabase = await createClient();
  const mapping: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith("map:") && String(v)) mapping[k.slice(4)] = String(v);
  }
  const newCol = String(fd.get("new_column") ?? "").trim();
  if (newCol) mapping[newCol] = String(fd.get("new_target") ?? "ignore");
  const { error } = await supabase.from("form_connections").update({
    name: String(fd.get("name") ?? "").trim(),
    event_id: String(fd.get("event_id") ?? "") || null,
    is_active: fd.get("is_active") === "on",
    field_mapping: mapping,
    default_tag_ids: fd.getAll("default_tag_ids").map(String),
  }).eq("organization_id", orgId).eq("id", connId);
  const url = `/orgs/${orgId}/forms/${connId}`;
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  // 氏名の対応が決まったら、対応待ちで保留にしていた回答をそのまま処理に回す
  let held = 0;
  if (Object.values(mapping).includes("full_name")) {
    const { data } = await supabase.rpc("reprocess_connection", { conn: connId });
    held = Number(data ?? 0);
  }
  revalidatePath(url);
  redirect(`${url}?ok=${encodeURIComponent(held ? `保存しました。保留中の回答 ${held}件を処理に回しました。` : "保存しました。")}`);
}

export async function rotateSecret(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const connId = String(fd.get("connId"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("rotate_webhook_secret", { conn: connId });
  const url = `/orgs/${orgId}/forms/${connId}`;
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  // 秘密は一度だけ表示する（DBにはハッシュのみ保存）
  redirect(`${url}?secret=${encodeURIComponent(data as string)}`);
}

export async function deleteConnection(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.from("form_connections").delete().eq("organization_id", orgId).eq("id", String(fd.get("connId")));
  if (error) redirect(`/orgs/${orgId}/forms?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/forms?ok=${encodeURIComponent("削除しました。")}`);
}

// ------------------------------------------------------------
// 外部データとのコネクト
// ------------------------------------------------------------
const connUrl = (orgId: string, connId: string) => `/orgs/${orgId}/forms/${connId}`;

export async function saveConnectorSource(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const connId = String(fd.get("connId"));
  const { parseGoogleFormId, parseSpreadsheetId } = await import("@shared/connectors");
  const supabase = await createClient();
  const { data: c } = await supabase.from("form_connections").select("kind, provider_config").eq("organization_id", orgId).eq("id", connId).single();
  const src = String(fd.get("source") ?? "");
  let cfg: Record<string, unknown>;
  if (c?.kind === "google_forms") {
    const id = parseGoogleFormId(src);
    if (!id) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent("Google フォームの URL（編集画面の URL）を貼り付けてください。")}`);
    cfg = { ...(c.provider_config ?? {}), form_id: id };
  } else {
    const id = parseSpreadsheetId(src);
    if (!id) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent("Google スプレッドシートの URL を貼り付けてください。")}`);
    cfg = { ...(c?.provider_config ?? {}), spreadsheet_id: id, sheet: String(fd.get("sheet") ?? "").trim() || null };
  }
  const { error } = await supabase.from("form_connections").update({ provider_config: cfg }).eq("organization_id", orgId).eq("id", connId);
  if (error) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent(toMessage(error))}`);
  // 保存したらすぐ質問（列）を読み込む
  const { error: e2 } = await supabase.rpc("request_connector_sync", { conn: connId, p_mode: "discover" });
  if (e2) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent(toMessage(e2))}`);
  revalidatePath(connUrl(orgId, connId));
  redirect(`${connUrl(orgId, connId)}?ok=${encodeURIComponent("保存しました。質問（列）を読み込んでいます。1分ほどで項目の対応が表示されます。")}`);
}

export async function requestConnectorSync(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const connId = String(fd.get("connId"));
  const mode = String(fd.get("mode") ?? "sync");
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_connector_sync", { conn: connId, p_mode: mode });
  if (error) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${connUrl(orgId, connId)}?ok=${encodeURIComponent(mode === "discover" ? "質問（列）を読み込んでいます。" : "取得を始めました。1分ほどで反映されます。")}`);
}

export async function setConnectorSync(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const connId = String(fd.get("connId"));
  const enable = fd.get("enable") === "1";
  const supabase = await createClient();
  if (enable) {
    const { data: c } = await supabase.from("form_connections").select("field_mapping").eq("id", connId).single();
    if (!Object.values((c?.field_mapping ?? {}) as Record<string, string>).includes("full_name")) {
      redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent("先に「氏名」に対応する項目を設定して保存してください。")}`);
    }
  }
  const { error } = await supabase.from("form_connections").update({
    sync_enabled: enable, sync_interval_minutes: Number(fd.get("interval") ?? 15) || 15,
  }).eq("organization_id", orgId).eq("id", connId);
  if (error) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent(toMessage(error))}`);
  if (enable) {
    // 対応が決まる前に届いて保留にしていた回答も、ここで処理に回す
    await supabase.rpc("reprocess_connection", { conn: connId });
    await supabase.rpc("request_connector_sync", { conn: connId, p_mode: "sync" });
  }
  revalidatePath(connUrl(orgId, connId));
  redirect(`${connUrl(orgId, connId)}?ok=${encodeURIComponent(enable ? "自動取り込みを開始しました。これまでの回答も取り込みます。" : "自動取り込みを止めました。")}`);
}

export async function issueSigningSecret(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const connId = String(fd.get("connId"));
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("has_role", { org: orgId, min_role: "admin" });
  const { data: c } = await supabase.from("form_connections").select("id, kind").eq("organization_id", orgId).eq("id", connId).maybeSingle();
  if (!isAdmin || !c || !["typeform", "tally"].includes(c.kind)) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent("この操作を行う権限がありません。")}`);
  const { randomBytes } = await import("node:crypto");
  const secret = randomBytes(24).toString("hex");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { error } = await createAdminClient().rpc("store_connector_secret", { conn: connId, p_purpose: "webhook_signing_secret", secret });
  if (error) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent("秘密を保存できませんでした。")}`);
  redirect(`${connUrl(orgId, connId)}?secret=${encodeURIComponent(secret)}`);
}

export async function reprocessConnection(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const connId = String(fd.get("connId"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reprocess_connection", { conn: connId });
  if (error) redirect(`${connUrl(orgId, connId)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${connUrl(orgId, connId)}?ok=${encodeURIComponent(`保留中の回答 ${data}件を処理に回しました。`)}`);
}
