"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { customValuesFromForm, type FieldDef } from "@/lib/customFields";

// 人物・企業・タスクの各画面から共通で使う操作。戻り先は back（同じ組織のパスだけ許可）
function back(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const b = String(fd.get("back") ?? "");
  return { orgId, url: b.startsWith(`/orgs/${orgId}/`) || b === `/orgs/${orgId}` ? b : `/orgs/${orgId}` };
}

async function done(url: string, error: { message?: string; hint?: string | null } | null, ok: string) {
  const sep = url.includes("?") ? "&" : "?";
  if (error) redirect(`${url}${sep}error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url.split("?")[0]);
  redirect(`${url}${sep}ok=${encodeURIComponent(ok)}`);
}

const idOrNull = (v: FormDataEntryValue | null) => (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v) ? v : null);

export async function addInteraction(fd: FormData) {
  const { orgId, url } = back(fd);
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const at = String(fd.get("occurred_at") ?? "");
  const { error } = await supabase.from("interactions").insert({
    organization_id: orgId,
    kind: String(fd.get("kind") ?? "other"),
    direction: String(fd.get("direction") ?? "") || null,
    occurred_at: at ? new Date(`${at}:00+09:00`).toISOString() : new Date().toISOString(),
    subject: String(fd.get("subject") ?? "").trim() || null,
    body: String(fd.get("body") ?? "").trim() || null,
    person_id: idOrNull(fd.get("person_id")),
    company_id: idOrNull(fd.get("company_id")),
    created_by: u.user?.id,
  });
  // 次の連絡予定を同時に登録できる
  const followTitle = String(fd.get("follow_title") ?? "").trim();
  if (!error && followTitle) {
    const { error: e2 } = await supabase.from("tasks").insert({
      organization_id: orgId, title: followTitle, due_date: String(fd.get("follow_due") ?? "") || null,
      assignee_id: u.user?.id, person_id: idOrNull(fd.get("person_id")), company_id: idOrNull(fd.get("company_id")), created_by: u.user?.id,
    });
    await done(url, e2, "やりとりと次の予定を記録しました。");
  }
  await done(url, error, "やりとりを記録しました。");
}

export async function deleteInteraction(fd: FormData) {
  const { orgId, url } = back(fd);
  const supabase = await createClient();
  const { error, count } = await supabase.from("interactions").delete({ count: "exact" }).eq("organization_id", orgId).eq("id", String(fd.get("id")));
  await done(url, error ?? (count ? null : { message: "forbidden" }), "削除しました。");
}

export async function addTask(fd: FormData) {
  const { orgId, url } = back(fd);
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("tasks").insert({
    organization_id: orgId,
    title: String(fd.get("title") ?? "").trim(),
    description: String(fd.get("description") ?? "").trim() || null,
    due_date: String(fd.get("due_date") ?? "") || null,
    assignee_id: idOrNull(fd.get("assignee_id")) ?? u.user?.id,
    priority: String(fd.get("priority") ?? "normal"),
    person_id: idOrNull(fd.get("person_id")),
    company_id: idOrNull(fd.get("company_id")),
    created_by: u.user?.id,
  });
  await done(url, error, "タスクを登録しました。");
}

export async function setTaskStatus(fd: FormData) {
  const { orgId, url } = back(fd);
  const supabase = await createClient();
  const status = String(fd.get("status"));
  const { error } = await supabase.from("tasks").update({ status }).eq("organization_id", orgId).eq("id", String(fd.get("id")));
  await done(url, error, status === "done" ? "完了にしました。" : status === "open" ? "未完了に戻しました。" : "更新しました。");
}

export async function saveCustomFields(fd: FormData) {
  const { orgId, url } = back(fd);
  const entity = String(fd.get("entity")) === "company" ? "company" : "person";
  const supabase = await createClient();
  const { data: defs } = await supabase.from("custom_field_definitions").select("*").eq("organization_id", orgId).eq("entity", entity);
  const { error } = await supabase.rpc("set_custom_fields", {
    p_entity: entity, record_id: String(fd.get("record_id")), vals: customValuesFromForm(fd, (defs ?? []) as FieldDef[]),
  });
  await done(url, error, "項目を保存しました。");
}

export async function linkCompany(fd: FormData) {
  const { orgId, url } = back(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("person_company_links").upsert({
    organization_id: orgId, person_id: String(fd.get("person_id")), company_id: String(fd.get("company_id")),
    title: String(fd.get("title") ?? "").trim() || null, department: String(fd.get("department") ?? "").trim() || null,
    is_primary: fd.get("is_primary") === "on",
  });
  await done(url, error, "担当者を紐づけました。");
}

export async function unlinkCompany(fd: FormData) {
  const { orgId, url } = back(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("person_company_links").delete()
    .eq("organization_id", orgId).eq("person_id", String(fd.get("person_id"))).eq("company_id", String(fd.get("company_id")));
  await done(url, error, "紐づけを外しました。");
}
