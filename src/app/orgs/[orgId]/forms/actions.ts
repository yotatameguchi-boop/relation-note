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
    kind: String(fd.get("kind")) === "webhook" ? "webhook" : "csv",
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
  revalidatePath(url);
  redirect(`${url}?ok=${encodeURIComponent("保存しました。")}`);
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
