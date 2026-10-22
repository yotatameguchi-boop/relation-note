import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDate } from "@/lib/format";
import { Flash, Pager } from "@/components/ui";
import { SortSelect } from "@/components/SortSelect";

const SORTS = [
  { v: "name", l: "名前順" },
  { v: "recent_contact", l: "最近やりとりした順" },
  { v: "created", l: "登録が新しい順" },
];
const PAGE = 50;

async function createCompany(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_company", { org: orgId, data: {
    name: fd.get("name"), name_kana: fd.get("name_kana"), industry: fd.get("industry"), website: fd.get("website"), phone: fd.get("phone"),
  } });
  if (error) redirect(`/orgs/${orgId}/companies?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/companies/${data}?ok=${encodeURIComponent("企業を登録しました。")}`);
}

type Row = { id: string; name: string; name_kana: string | null; industry: string | null; phone: string | null;
  contact_count: number; open_tasks: number; last_interaction_at: string | null; total_count: number };

export default async function Companies({ params, searchParams }: {
  params: Promise<{ orgId: string }>; searchParams: Promise<{ q?: string; sort?: string; page?: string; error?: string; ok?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const sort = SORTS.some((s) => s.v === sp.sort) ? sp.sort! : "name";
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();
  const { data } = await supabase.rpc("search_companies", { org: orgId, q: sp.q || null, sort, page_size: PAGE, page });
  const rows = (data ?? []) as Row[];
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (sp.q) u.set("q", sp.q);
    if (sp.sort) u.set("sort", sp.sort);
    if (p > 1) u.set("page", String(p));
    return u.toString() ? `?${u}` : "";
  };
  return (
    <>
      <h1>企業</h1>
      <Flash sp={sp} />
      <form className="card row" style={{ alignItems: "flex-end" }}>
        <label className="inline-field" style={{ flex: 2 }}>企業名・業種<input name="q" defaultValue={sp.q} /></label>
        {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
        <button>検索</button>
        <label className="inline-field" style={{ marginLeft: "auto" }}>並べ替え<SortSelect options={SORTS} value={sort} defaultKey="name" /></label>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>企業名</th><th>業種</th><th>電話</th><th className="num">担当者</th><th className="num">未完了タスク</th><th>最終やりとり</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="muted">企業はまだ登録されていません。</td></tr>}
            {rows.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/orgs/${orgId}/companies/${c.id}`}><strong>{c.name}</strong></Link>{c.name_kana && <div className="small muted">{c.name_kana}</div>}</td>
                <td className="small">{c.industry ?? "—"}</td>
                <td className="small">{c.phone ?? "—"}</td>
                <td className="num">{c.contact_count}</td>
                <td className="num">{c.open_tasks}</td>
                <td className="small">{fmtDate(c.last_interaction_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={rows[0]?.total_count ?? 0} pageSize={PAGE} hrefFor={(p) => `/orgs/${orgId}/companies${qs(p)}`} />
      {can(m, "editor") && (
        <details className="card" style={{ marginTop: 16 }}>
          <summary>企業を登録</summary>
          <form action={createCompany} style={{ marginTop: 10 }}>
            <input type="hidden" name="orgId" value={orgId} />
            <div className="grid grid-2">
              <label className="field">企業名 *<input name="name" required maxLength={200} /></label>
              <label className="field">ふりがな<input name="name_kana" /></label>
              <label className="field">業種<input name="industry" /></label>
              <label className="field">電話<input name="phone" type="tel" /></label>
              <label className="field">ウェブサイト<input name="website" type="url" placeholder="https://" /></label>
            </div>
            <button>登録</button>
          </form>
        </details>
      )}
    </>
  );
}
