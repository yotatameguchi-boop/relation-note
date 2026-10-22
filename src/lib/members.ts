import "server-only";
import { createClient } from "@/lib/supabase/server";

/** 組織のスタッフ（タスクの担当者の選択・表示用） */
export async function memberList(orgId: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("memberships").select("user_id, users(display_name, email)").eq("organization_id", orgId);
  const list = (data ?? []).map((m) => {
    const u = m.users as unknown as { display_name: string | null; email: string };
    return { user_id: m.user_id as string, name: u?.display_name || u?.email || "（スタッフ）" };
  }).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return { list, names: new Map(list.map((m) => [m.user_id, m.name])) };
}
