import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/ui";
import { createPerson } from "../actions";

export default async function NewPerson({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string }> }) {
  const { orgId } = await params;
  await requireMembership(orgId, "editor");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: tags } = await supabase.from("tags").select("id, name").eq("organization_id", orgId).order("name");
  return (
    <>
      <h1>人物を登録</h1>
      <Flash sp={sp} />
      <form action={createPerson} className="card" style={{ maxWidth: 640 }}>
        <input type="hidden" name="orgId" value={orgId} />
        <label className="field">氏名 *<input name="full_name" required maxLength={200} /></label>
        <label className="field">ふりがな<input name="full_name_kana" /></label>
        <label className="field">居住地域<input name="region" placeholder="例：〇〇市" /></label>
        <label className="field">メールアドレス（複数は改行区切り）<textarea name="emails" style={{ minHeight: 50 }} /></label>
        <label className="field">電話番号（複数は改行区切り）<textarea name="phones" style={{ minHeight: 50 }} /></label>
        {tags && tags.length > 0 && (
          <div className="field">
            <label>タグ</label>
            <div className="row">
              {tags.map((t) => (
                <label key={t.id} className="tag" style={{ margin: 0 }}><input type="checkbox" name="tag_ids" value={t.id} />{t.name}</label>
              ))}
            </div>
          </div>
        )}
        <p className="small muted">同じ人がすでに登録されていないか、登録後に「重複候補」で確認できます。</p>
        <button>登録</button>
      </form>
    </>
  );
}
