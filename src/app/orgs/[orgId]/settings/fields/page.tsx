import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { FIELD_TYPE_LABEL, keyFromLabel, type FieldDef, type FieldType } from "@/lib/customFields";
import { Flash } from "@/components/ui";

const url = (orgId: string) => `/orgs/${orgId}/settings/fields`;
const splitOptions = (v: FormDataEntryValue | null) =>
  [...new Set(String(v ?? "").split(/[\n,、]/).map((x) => x.trim()).filter(Boolean))].slice(0, 100);

async function addField(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const entity = String(fd.get("entity")) === "company" ? "company" : "person";
  const label = String(fd.get("label") ?? "").trim();
  const supabase = await createClient();
  const { data: existing } = await supabase.from("custom_field_definitions").select("key, position").eq("organization_id", orgId).eq("entity", entity);
  const { error } = await supabase.from("custom_field_definitions").insert({
    organization_id: orgId, entity, label, key: keyFromLabel(label, (existing ?? []).map((e) => e.key)),
    field_type: String(fd.get("field_type")) as FieldType, options: splitOptions(fd.get("options")),
    required: fd.get("required") === "on", position: Math.max(0, ...(existing ?? []).map((e) => e.position)) + 1,
  });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error, "追加できませんでした。選択肢の項目では選択肢を1つ以上入力してください。"))}`);
  revalidatePath(url(orgId));
  redirect(`${url(orgId)}?ok=${encodeURIComponent(`「${label}」を追加しました。`)}`);
}

async function updateField(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const patch: Record<string, unknown> = {
    label: String(fd.get("label") ?? "").trim(), required: fd.get("required") === "on",
    position: Number(fd.get("position") ?? 0) || 0, archived: fd.get("archived") === "on",
  };
  if (fd.has("options")) patch.options = splitOptions(fd.get("options"));
  const { error } = await supabase.from("custom_field_definitions").update(patch).eq("organization_id", orgId).eq("id", String(fd.get("id")));
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url(orgId));
  redirect(`${url(orgId)}?ok=${encodeURIComponent("保存しました。")}`);
}

function FieldTable({ orgId, defs }: { orgId: string; defs: FieldDef[] }) {
  if (!defs.length) return <p className="small muted">まだ項目はありません。</p>;
  return (
    <div className="table-wrap">
      <table className="small">
        <thead><tr><th>表示順</th><th>項目名</th><th>種類</th><th>選択肢</th><th>必須</th><th>使わない</th><th /></tr></thead>
        <tbody>
          {defs.map((d) => (
            <tr key={d.id} style={d.archived ? { opacity: .55 } : undefined}>
              <td colSpan={7} style={{ padding: 0 }}>
                <form action={updateField} className="row" style={{ padding: "6px 10px", flexWrap: "wrap" }}>
                  <input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="id" value={d.id} />
                  <input name="position" type="number" defaultValue={d.position} style={{ width: 64 }} aria-label={`${d.label}の表示順`} />
                  <input name="label" defaultValue={d.label} required style={{ width: 160 }} aria-label="項目名" />
                  <span className="badge">{FIELD_TYPE_LABEL[d.field_type]}</span>
                  {(d.field_type === "select" || d.field_type === "multi_select")
                    ? <input name="options" defaultValue={d.options.join("、")} style={{ flex: 1, minWidth: 160 }} aria-label={`${d.label}の選択肢`} />
                    : <span style={{ flex: 1 }} />}
                  <label className="row" style={{ margin: 0, color: "var(--text)" }}><input type="checkbox" name="required" defaultChecked={d.required} />必須</label>
                  <label className="row" style={{ margin: 0, color: "var(--text)" }}><input type="checkbox" name="archived" defaultChecked={d.archived} />使わない</label>
                  <button className="btn-secondary btn-small">保存</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Fields({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  await requireMembership(orgId, "admin");
  const supabase = await createClient();
  const { data } = await supabase.from("custom_field_definitions").select("*").eq("organization_id", orgId).order("position");
  const defs = (data ?? []) as FieldDef[];
  return (
    <>
      <div className="spread"><h1>項目の設定</h1><Link href={`/orgs/${orgId}/settings`}>← 組織設定</Link></div>
      <p className="small muted">人物・企業に、組織ごとの項目（会社名、業種、会員番号、誕生日など）を追加できます。項目の種類はあとから変えられません。使わなくなった項目は「使わない」にすると、入力欄から消えます（入力済みの値は残ります）。</p>
      <Flash sp={sp} />
      <form action={addField} className="card">
        <input type="hidden" name="orgId" value={orgId} />
        <h2 style={{ marginTop: 0 }}>項目を追加</h2>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="inline-field">対象<select name="entity"><option value="person">人物</option><option value="company">企業</option></select></label>
          <label className="inline-field" style={{ flex: 1 }}>項目名 *<input name="label" required maxLength={60} placeholder="例：会員番号" /></label>
          <label className="inline-field">種類<select name="field_type">{Object.entries(FIELD_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <label className="field" style={{ marginTop: 8 }}>選択肢（選択肢の項目のみ。読点・改行区切り）<input name="options" placeholder="例：正会員、賛助会員、学生会員" /></label>
        <label className="row small" style={{ color: "var(--text)" }}><input type="checkbox" name="required" />必須にする</label>
        <button style={{ marginTop: 8 }}>追加</button>
      </form>
      <h2>人物の項目</h2>
      <FieldTable orgId={orgId} defs={defs.filter((d) => d.entity === "person")} />
      <h2>企業の項目</h2>
      <FieldTable orgId={orgId} defs={defs.filter((d) => d.entity === "company")} />
    </>
  );
}
