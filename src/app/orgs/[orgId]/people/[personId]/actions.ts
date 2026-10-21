"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";

function ctx(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const personId = String(fd.get("personId"));
  return { orgId, personId, url: `/orgs/${orgId}/people/${personId}` };
}

async function done(url: string, error: { message?: string } | null, ok: string) {
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url);
  redirect(`${url}?ok=${encodeURIComponent(ok)}`);
}

function splitList(v: FormDataEntryValue | null) {
  return [...new Set(String(v ?? "").split(/[,、\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 30);
}

export async function updatePerson(fd: FormData) {
  const { orgId, personId, url } = ctx(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("people").update({
    full_name: String(fd.get("full_name") ?? "").trim(),
    full_name_kana: String(fd.get("full_name_kana") ?? "").trim() || null,
    region: String(fd.get("region") ?? "").trim() || null,
    display_name: String(fd.get("display_name") ?? "").trim() || null,
    interests: splitList(fd.get("interests")),
    skills: splitList(fd.get("skills")),
  }).eq("organization_id", orgId).eq("id", personId);
  await done(url, error, "保存しました。");
}

export async function addContact(fd: FormData) {
  const { orgId, personId, url } = ctx(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("person_contacts").insert({
    organization_id: orgId, person_id: personId,
    kind: String(fd.get("kind")), value: String(fd.get("value") ?? "").trim(), label: String(fd.get("label") ?? "") || null,
  });
  await done(url, error, "連絡先を追加しました。");
}

export async function removeContact(fd: FormData) {
  const { orgId, url } = ctx(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("person_contacts").delete().eq("organization_id", orgId).eq("id", String(fd.get("contactId")));
  await done(url, error, "連絡先を削除しました。");
}

export async function setTags(fd: FormData) {
  const { orgId, personId, url } = ctx(fd);
  const supabase = await createClient();
  const want = new Set(fd.getAll("tag_ids").map(String));
  const { data: cur } = await supabase.from("person_tags").select("tag_id").eq("organization_id", orgId).eq("person_id", personId);
  const have = new Set((cur ?? []).map((r) => r.tag_id));
  const add = [...want].filter((t) => !have.has(t));
  const del = [...have].filter((t) => !want.has(t));
  let error = null;
  if (add.length) ({ error } = await supabase.from("person_tags").insert(add.map((tag_id) => ({ organization_id: orgId, person_id: personId, tag_id }))));
  if (!error && del.length) ({ error } = await supabase.from("person_tags").delete().eq("organization_id", orgId).eq("person_id", personId).in("tag_id", del));
  await done(url, error, "タグを更新しました。");
}

export async function addNote(fd: FormData) {
  const { orgId, personId, url } = ctx(fd);
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("person_notes").insert({
    organization_id: orgId, person_id: personId, body: String(fd.get("body") ?? "").trim(), author_id: u.user?.id,
  });
  await done(url, error, "メモを追加しました。");
}

export async function deleteNote(fd: FormData) {
  const { orgId, url } = ctx(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("person_notes").delete().eq("organization_id", orgId).eq("id", String(fd.get("noteId")));
  await done(url, error, "メモを削除しました。");
}

export async function deletePerson(fd: FormData) {
  const { orgId, personId, url } = ctx(fd);
  const supabase = await createClient();
  const { error, count } = await supabase.from("people").delete({ count: "exact" }).eq("organization_id", orgId).eq("id", personId);
  if (error || !count) redirect(`${url}?error=${encodeURIComponent(toMessage(error, "削除できませんでした（権限がない可能性があります）。"))}`);
  redirect(`/orgs/${orgId}/people?ok=${encodeURIComponent("削除しました。")}`);
}
