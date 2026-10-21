"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { jstLocalToIso } from "@/lib/format";

function ev(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const eventId = String(fd.get("eventId") ?? "");
  return { orgId, eventId, url: `/orgs/${orgId}/events/${eventId}` };
}

async function done(url: string, error: { message?: string } | null, ok: string) {
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url);
  redirect(`${url}?ok=${encodeURIComponent(ok)}`);
}

const fields = (fd: FormData) => ({
  title: String(fd.get("title") ?? "").trim(),
  starts_at: jstLocalToIso(String(fd.get("starts_at") ?? "")),
  ends_at: jstLocalToIso(String(fd.get("ends_at") ?? "")),
  location: String(fd.get("location") ?? "").trim() || null,
  description: String(fd.get("description") ?? "").trim() || null,
});

export async function createEvent(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("events").insert({ organization_id: orgId, created_by: u.user?.id, ...fields(fd) }).select("id").single();
  if (error) redirect(`/orgs/${orgId}/events?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/events/${data.id}`);
}

export async function updateEvent(fd: FormData) {
  const { orgId, eventId, url } = ev(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("events").update({
    ...fields(fd), anonymous_count: Math.max(0, Number(fd.get("anonymous_count") ?? 0) || 0),
  }).eq("organization_id", orgId).eq("id", eventId);
  await done(url, error, "保存しました。");
}

export async function confirmHeadcount(fd: FormData) {
  const { eventId, url } = ev(fd);
  const raw = String(fd.get("headcount") ?? "").trim();
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_event_headcount", { event: eventId, headcount: raw === "" ? null : Number(raw) });
  await done(url, error, raw === "" ? "確定人数を取り消しました。" : "参加人数を確定しました。");
}

export async function addParticipants(fd: FormData) {
  const { orgId, eventId, url } = ev(fd);
  const ids = fd.getAll("personIds").map(String);
  const status = String(fd.get("status") ?? "applied");
  if (!ids.length) redirect(`${url}?error=${encodeURIComponent("人物を選んでください。")}`);
  const supabase = await createClient();
  const { error } = await supabase.from("event_participations").upsert(
    ids.map((person_id) => ({ organization_id: orgId, event_id: eventId, person_id, status })),
    { onConflict: "event_id,person_id", ignoreDuplicates: true },
  );
  await done(url, error, `${ids.length}人を追加しました。`);
}

export async function setParticipationStatus(fd: FormData) {
  const { orgId, url } = ev(fd);
  const ids = fd.getAll("partIds").map(String);
  const status = String(fd.get("status"));
  if (!ids.length) redirect(`${url}?error=${encodeURIComponent("参加者を選んでください。")}`);
  const supabase = await createClient();
  const { error } = status === "remove"
    ? await supabase.from("event_participations").delete().eq("organization_id", orgId).in("id", ids)
    : await supabase.from("event_participations").update({ status }).eq("organization_id", orgId).in("id", ids);
  await done(url, error, "更新しました。");
}

export async function deleteEvent(fd: FormData) {
  const { orgId, eventId, url } = ev(fd);
  const supabase = await createClient();
  const { error } = await supabase.from("events").delete().eq("organization_id", orgId).eq("id", eventId);
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/events?ok=${encodeURIComponent("イベントを削除しました。")}`);
}
