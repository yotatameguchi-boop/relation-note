import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { Flash, TagChip } from "@/components/ui";

async function createTag(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.from("tags").insert({ organization_id: orgId, name: String(fd.get("name") ?? "").trim(), color: String(fd.get("color") ?? "#6b7280") });
  if (error) redirect(`/orgs/${orgId}/tags?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(`/orgs/${orgId}/tags`);
  redirect(`/orgs/${orgId}/tags`);
}

async function deleteTag(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error, count } = await supabase.from("tags").delete({ count: "exact" }).eq("organization_id", orgId).eq("id", String(fd.get("tagId")));
  if (error || !count) redirect(`/orgs/${orgId}/tags?error=${encodeURIComponent(toMessage(error, "削除できませんでした（管理者のみ削除できます）。"))}`);
  redirect(`/orgs/${orgId}/tags?ok=${encodeURIComponent("タグを削除しました。")}`);
}

const SUGGEST = ["ボランティア", "寄付者", "イベント参加者", "協力企業担当者", "関心:子ども", "関心:環境"];

export default async function Tags({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const { data: tags } = await supabase.from("tags").select("id, name, color, person_tags(count)").eq("organization_id", orgId).order("name");
  return (
    <>
      <h1>タグ</h1>
      <p className="muted small">同じ人物に複数のタグを付けられます（例：ボランティアかつ寄付者）。</p>
      <Flash sp={sp} />
      {can(m, "editor") && (
        <form action={createTag} className="card row">
          <input type="hidden" name="orgId" value={orgId} />
          <input name="name" required maxLength={60} placeholder="タグ名" list="tag-suggest" style={{ flex: 1 }} />
          <datalist id="tag-suggest">{SUGGEST.map((s) => <option key={s} value={s} />)}</datalist>
          <input type="color" name="color" defaultValue="#1f6f5c" style={{ width: 50, padding: 2 }} aria-label="色" />
          <button>追加</button>
        </form>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>タグ</th><th className="num">人数</th><th /></tr></thead>
          <tbody>
            {(tags ?? []).length === 0 && <tr><td colSpan={3} className="muted">タグはまだありません。</td></tr>}
            {(tags ?? []).map((t) => (
              <tr key={t.id}>
                <td><a href={`/orgs/${orgId}/people?tag=${t.id}`}><TagChip name={t.name} color={t.color} /></a></td>
                <td className="num">{(t.person_tags as unknown as { count: number }[])[0]?.count ?? 0}</td>
                <td className="right">
                  {can(m, "admin") && (
                    <form action={deleteTag}><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="tagId" value={t.id} /><button className="link-btn small">削除</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
