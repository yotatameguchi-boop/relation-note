"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";

const back = (orgId: string, qs: string) => `/orgs/${orgId}/people${qs}`;

export async function bulkAction(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const ids = fd.getAll("ids").map(String);
  const action = String(fd.get("action"));
  const ret = String(fd.get("return") ?? "");
  const sep = ret.includes("?") ? "&" : "?";
  if (ids.length === 0) redirect(back(orgId, `${ret}${sep}error=${encodeURIComponent("人物を選択してください。")}`));
  const supabase = await createClient();
  let error;
  let msg = "";
  if (action === "tag_add" || action === "tag_remove") {
    const tag = String(fd.get("tag") ?? "");
    if (!tag) redirect(back(orgId, `${ret}${sep}error=${encodeURIComponent("タグを選んでください。")}`));
    ({ error } = await supabase.rpc("bulk_tag_people", { org: orgId, ids, tag, add: action === "tag_add" }));
    msg = `${ids.length}人のタグを更新しました。`;
  } else if (action === "delete") {
    ({ error } = await supabase.rpc("bulk_delete_people", { org: orgId, ids }));
    msg = `${ids.length}人を削除しました。`;
  }
  if (error) redirect(back(orgId, `${ret}${sep}error=${encodeURIComponent(toMessage(error))}`));
  revalidatePath(`/orgs/${orgId}/people`);
  redirect(back(orgId, `${ret}${sep}ok=${encodeURIComponent(msg)}`));
}

export async function requestExport(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const filters = { tag_ids: fd.getAll("tag").map(String).filter(Boolean), region: String(fd.get("region") ?? "") || undefined };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_people_export", { org: orgId, filters });
  if (error) redirect(back(orgId, `?error=${encodeURIComponent(toMessage(error))}`));
  redirect(`/orgs/${orgId}/jobs?ok=${encodeURIComponent("出力を受け付けました。完了後にこの画面からダウンロードできます。")}&highlight=${data}`);
}

export async function createPerson(fd: FormData) {
  const orgId = String(fd.get("orgId"));
  const split = (k: string) => String(fd.get(k) ?? "").split(/[\n,、]/).map((s) => s.trim()).filter(Boolean);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_person", {
    org: orgId,
    data: {
      full_name: fd.get("full_name"),
      full_name_kana: fd.get("full_name_kana"),
      region: fd.get("region"),
      emails: split("emails"),
      phones: split("phones"),
      tag_ids: fd.getAll("tag_ids").map(String),
    },
  });
  if (error) redirect(`/orgs/${orgId}/people/new?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/people/${data}?ok=${encodeURIComponent("登録しました。")}`);
}
