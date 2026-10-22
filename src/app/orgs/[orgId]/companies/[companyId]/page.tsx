import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getUser, requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { nowMs } from "@/lib/format";
import { formatCustomValue, type FieldDef } from "@/lib/customFields";
import { memberList } from "@/lib/members";
import { Flash } from "@/components/ui";
import { CustomFieldInputs } from "@/components/CustomFieldInputs";
import { InteractionForm, TaskForm, TaskList, Timeline, type TaskRow, type TimelineItem } from "@/components/CrmParts";
import { linkCompany, saveCustomFields, unlinkCompany } from "../../crm-actions";

async function updateCompany(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const id = String(fd.get("id"));
  const supabase = await createClient();
  const v = (k: string) => String(fd.get(k) ?? "").trim() || null;
  const { error } = await supabase.from("companies").update({
    name: String(fd.get("name") ?? "").trim(), name_kana: v("name_kana"), industry: v("industry"),
    website: v("website"), phone: v("phone"), address: v("address"),
  }).eq("organization_id", orgId).eq("id", id);
  const url = `/orgs/${orgId}/companies/${id}`;
  if (error) redirect(`${url}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url);
  redirect(`${url}?ok=${encodeURIComponent("保存しました。")}`);
}

async function deleteCompany(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error, count } = await supabase.from("companies").delete({ count: "exact" }).eq("organization_id", orgId).eq("id", String(fd.get("id")));
  if (error || !count) redirect(`/orgs/${orgId}/companies/${fd.get("id")}?error=${encodeURIComponent(toMessage(error, "削除できませんでした（管理者のみ削除できます）。"))}`);
  redirect(`/orgs/${orgId}/companies?ok=${encodeURIComponent("企業を削除しました。担当者の人物情報は残っています。")}`);
}

export default async function CompanyPage({ params, searchParams }: {
  params: Promise<{ orgId: string; companyId: string }>; searchParams: Promise<{ error?: string; ok?: string; q?: string }>;
}) {
  const { orgId, companyId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const me = await getUser();
  const supabase = await createClient();
  const { data: c } = await supabase.from("companies").select("*").eq("organization_id", orgId).eq("id", companyId).maybeSingle();
  if (!c) notFound();
  const editor = can(m, "editor");
  const url = `/orgs/${orgId}/companies/${companyId}`;

  const [{ data: defs }, { data: links }, { data: tasks }, members, search] = await Promise.all([
    supabase.from("custom_field_definitions").select("*").eq("organization_id", orgId).eq("entity", "company").order("position"),
    supabase.from("person_company_links").select("person_id, title, department, is_primary, people(full_name, full_name_kana)")
      .eq("organization_id", orgId).eq("company_id", companyId),
    supabase.from("tasks").select("id, title, due_date, status, priority, assignee_id, person_id, company_id, people(full_name), companies(name)")
      .eq("organization_id", orgId).eq("company_id", companyId).order("status").order("due_date", { nullsFirst: false }),
    memberList(orgId),
    sp.q && editor ? supabase.rpc("search_people", { org: orgId, q: sp.q, page_size: 10, page: 1 }) : Promise.resolve({ data: null }),
  ]);
  const contactIds = (links ?? []).map((l) => l.person_id);
  // 企業あてのやりとりと、担当者個人とのやりとりをまとめて時系列に
  let iq = supabase.from("interactions").select("id, kind, direction, occurred_at, subject, body, created_by, person_id, email_recipient_id, people(full_name)")
    .eq("organization_id", orgId).order("occurred_at", { ascending: false }).limit(100);
  iq = contactIds.length ? iq.or(`company_id.eq.${companyId},person_id.in.(${contactIds.join(",")})`) : iq.eq("company_id", companyId);
  const { data: ints } = await iq;
  const items: TimelineItem[] = (ints ?? []).map((i) => ({
    kind: `interaction:${i.kind}`, item_id: i.id, occurred_at: i.occurred_at,
    title: [i.subject, i.person_id ? `（${(i.people as unknown as { full_name: string } | null)?.full_name ?? ""}）` : ""].filter(Boolean).join(" ") || "（件名なし）",
    body: i.body, meta: { direction: i.direction, created_by: i.created_by, from_campaign: !!i.email_recipient_id },
  }));
  const fields = (defs ?? []) as FieldDef[];
  const t = { orgId, back: url, companyId };
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="back" value={url} /><input type="hidden" name="company_id" value={companyId} /></>);

  return (
    <>
      <div className="spread"><h1>{c.name}{c.name_kana && <span className="muted small" style={{ marginLeft: 8 }}>{c.name_kana}</span>}</h1>
        <Link href={`/orgs/${orgId}/companies`}>← 企業一覧</Link></div>
      <Flash sp={sp} />
      <div className="grid grid-2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>基本情報</h2>
          {editor ? (
            <form action={updateCompany}>
              <input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="id" value={companyId} />
              <label className="field">企業名<input name="name" defaultValue={c.name} required /></label>
              <label className="field">ふりがな<input name="name_kana" defaultValue={c.name_kana ?? ""} /></label>
              <label className="field">業種<input name="industry" defaultValue={c.industry ?? ""} /></label>
              <label className="field">電話<input name="phone" type="tel" defaultValue={c.phone ?? ""} /></label>
              <label className="field">ウェブサイト<input name="website" type="url" defaultValue={c.website ?? ""} /></label>
              <label className="field">住所<input name="address" defaultValue={c.address ?? ""} /></label>
              <button>保存</button>
            </form>
          ) : (
            <table className="small"><tbody>
              <tr><th>業種</th><td>{c.industry ?? "—"}</td></tr><tr><th>電話</th><td>{c.phone ?? "—"}</td></tr>
              <tr><th>ウェブサイト</th><td>{c.website ?? "—"}</td></tr><tr><th>住所</th><td>{c.address ?? "—"}</td></tr>
            </tbody></table>
          )}
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>追加項目</h2>
          {fields.filter((f) => !f.archived).length === 0 ? (
            <p className="small muted">企業の追加項目はまだありません。{can(m, "admin") && <Link href={`/orgs/${orgId}/settings/fields`}>項目を追加する</Link>}</p>
          ) : editor ? (
            <form action={saveCustomFields}>
              <input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="back" value={url} />
              <input type="hidden" name="entity" value="company" /><input type="hidden" name="record_id" value={companyId} />
              <CustomFieldInputs defs={fields} values={c.custom_fields ?? {}} />
              <button className="btn-secondary">項目を保存</button>
            </form>
          ) : (
            <table className="small"><tbody>{fields.filter((f) => !f.archived).map((f) => (
              <tr key={f.key}><th>{f.label}</th><td>{formatCustomValue(f, c.custom_fields?.[f.key])}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>担当者（{(links ?? []).length}人）</h2>
        <table className="small"><tbody>
          {(links ?? []).length === 0 && <tr><td className="muted">担当者はまだ紐づいていません。</td></tr>}
          {(links ?? []).sort((a, b) => Number(b.is_primary) - Number(a.is_primary)).map((l) => (
            <tr key={l.person_id}>
              <td><Link href={`/orgs/${orgId}/people/${l.person_id}`}>{(l.people as unknown as { full_name: string }).full_name}</Link>
                {l.is_primary && <span className="badge badge-ok" style={{ marginLeft: 6 }}>主担当</span>}</td>
              <td>{[l.department, l.title].filter(Boolean).join("・") || "—"}</td>
              <td className="right">{editor && (
                <form action={unlinkCompany}>{hidden}<input type="hidden" name="person_id" value={l.person_id} /><button className="link-btn small">外す</button></form>
              )}</td>
            </tr>
          ))}
        </tbody></table>
        {editor && (
          <>
            <form className="row" style={{ marginTop: 10 }}>
              <input name="q" defaultValue={sp.q} placeholder="担当者を追加：人物を検索（氏名・メール・電話）" style={{ flex: 1 }} aria-label="担当者を検索" />
              <button className="btn-secondary btn-small">検索</button>
              <Link className="btn btn-secondary btn-small" href={`/orgs/${orgId}/people/new`}>人物を新しく登録</Link>
            </form>
            {(search.data as { id: string; full_name: string; emails: string[] }[] | null)?.filter((p) => !contactIds.includes(p.id)).map((p) => (
              <form key={p.id} action={linkCompany} className="row small" style={{ marginTop: 6 }}>
                {hidden}<input type="hidden" name="person_id" value={p.id} />
                <strong>{p.full_name}</strong><span className="muted">{p.emails[0]}</span>
                <input name="department" placeholder="部署" style={{ width: 120 }} aria-label={`${p.full_name}の部署`} />
                <input name="title" placeholder="役職" style={{ width: 120 }} aria-label={`${p.full_name}の役職`} />
                <label className="row" style={{ margin: 0, color: "var(--text)" }}><input type="checkbox" name="is_primary" />主担当</label>
                <button className="btn-small">紐づける</button>
              </form>
            ))}
          </>
        )}
      </div>

      <div className="grid grid-2">
        <div>
          {editor && <InteractionForm t={t} now={new Date(nowMs()).toISOString()} />}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>やりとりの履歴</h2>
            <p className="small muted">この企業あてのやりとりと、担当者個人とのやりとりをまとめて表示しています。</p>
            <Timeline items={items} t={t} canEdit={editor} myId={me?.id} />
          </div>
        </div>
        <div>
          {editor && me && <TaskForm t={t} members={members.list} myId={me.id} />}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>タスク</h2>
            <TaskList tasks={(tasks ?? []) as unknown as TaskRow[]} t={t} names={members.names} canEdit={editor} />
          </div>
        </div>
      </div>

      {can(m, "admin") && (
        <form action={deleteCompany} className="card">
          <input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="id" value={companyId} />
          <p className="small muted">企業を削除すると、この企業あてのやりとり・タスク・担当者の紐づけも削除されます（人物は残ります）。</p>
          <button className="btn-danger btn-small">この企業を削除</button>
        </form>
      )}
    </>
  );
}
