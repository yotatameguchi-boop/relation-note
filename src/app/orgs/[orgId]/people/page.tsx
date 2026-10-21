import Link from "next/link";
import { requireMembership, can, canManageSharing, getFeatures, hasPerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDate } from "@/lib/format";
import { Flash, Pager, TagChip } from "@/components/ui";
import { bulkAction, requestExport } from "./actions";

type Row = {
  id: string; full_name: string; full_name_kana: string | null; region: string | null; attendance_count: number;
  last_attended_at: string | null; created_at: string; emails: string[]; phones: string[];
  tags: { id: string; name: string; color: string }[]; total_count: number;
};

const SORTS = [
  { v: "recent", l: "登録が新しい順" },
  { v: "last_attended", l: "最終参加日が新しい順" },
  { v: "attendance_count", l: "参加回数が多い順" },
  { v: "name", l: "名前順" },
];
const PAGE_SIZE = 50;

export default async function PeoplePage({ params, searchParams }: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string; tag?: string | string[]; region?: string; sort?: string; page?: string; error?: string; ok?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const tagFilter = ([] as string[]).concat(sp.tag ?? []).filter(Boolean);
  const page = Math.max(1, Number(sp.page) || 1);
  const sort = SORTS.some((s) => s.v === sp.sort) ? sp.sort! : "recent";

  const supabase = await createClient();
  const [{ data: rows, error }, { data: tags }] = await Promise.all([
    supabase.rpc("search_people", {
      org: orgId, q: sp.q || null, tag_ids: tagFilter.length ? tagFilter : null, region_filter: sp.region || null,
      sort, page_size: PAGE_SIZE, page,
    }),
    supabase.from("tags").select("id, name, color").eq("organization_id", orgId).order("name"),
  ]);
  const list = (rows ?? []) as Row[];
  const total = list[0]?.total_count ?? 0;

  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (sp.q) u.set("q", sp.q);
    tagFilter.forEach((t) => u.append("tag", t));
    if (sp.region) u.set("region", sp.region);
    if (sort !== "recent") u.set("sort", sort);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return s ? `?${s}` : "";
  };
  const editor = can(m, "editor");
  const sharing = (await getFeatures(orgId)).partner_sharing && canManageSharing(m);

  return (
    <>
      <div className="spread">
        <h1>人物一覧</h1>
        <div className="row">
          {editor && <Link className="btn" href={`/orgs/${orgId}/people/new`}>人物を登録</Link>}
          {hasPerm(m, "bulk_export") && (
            <form action={requestExport}>
              <input type="hidden" name="orgId" value={orgId} />
              {tagFilter.map((t) => <input key={t} type="hidden" name="tag" value={t} />)}
              <input type="hidden" name="region" value={sp.region ?? ""} />
              <button className="btn-secondary">この条件でCSV出力</button>
            </form>
          )}
        </div>
      </div>
      <Flash sp={sp} />
      <form className="card">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="inline-field" style={{ flex: 2 }}>
            <label htmlFor="q">氏名・ふりがな・メール・電話</label>
            <input id="q" name="q" defaultValue={sp.q} placeholder="例：山田 / yamada@ / 090" />
          </div>
          <div className="inline-field" style={{ flex: 1 }}>
            <label htmlFor="region">居住地域</label>
            <input id="region" name="region" defaultValue={sp.region} />
          </div>
          <div className="inline-field">
            <label htmlFor="sort">並べ替え</label>
            <select id="sort" name="sort" defaultValue={sort}>
              {SORTS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
            </select>
          </div>
          <button>検索</button>
        </div>
        {tags && tags.length > 0 && (
          <div className="row small" style={{ marginTop: 10 }}>
            <span className="muted">タグ（すべて含む）:</span>
            {tags.map((t) => (
              <label key={t.id} className="tag" style={{ margin: 0, cursor: "pointer" }}>
                <input type="checkbox" name="tag" value={t.id} defaultChecked={tagFilter.includes(t.id)} />
                <span className="dot" style={{ background: t.color }} />{t.name}
              </label>
            ))}
          </div>
        )}
      </form>
      {error && <div className="notice notice-danger">検索に失敗しました。</div>}

      <form action={bulkAction}>
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="return" value={qs(page)} />
        {editor && (
          <div className="row small" style={{ marginBottom: 8 }}>
            <span className="muted">選択した人物を:</span>
            <select name="tag" style={{ width: 180 }} defaultValue="">
              <option value="">タグを選択</option>
              {(tags ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button name="action" value="tag_add" className="btn-secondary btn-small">タグを付ける</button>
            <button name="action" value="tag_remove" className="btn-secondary btn-small">タグを外す</button>
            {sharing && <>
              <button name="action" value="authorize" className="btn-secondary btn-small">共有根拠を記録</button>
              <button name="action" value="share" className="btn-secondary btn-small">他団体へ共有</button>
            </>}
            {hasPerm(m, "bulk_delete") && can(m, "admin") && (
              <button name="action" value="delete" className="btn-danger btn-small">一括削除</button>
            )}
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {editor && <th style={{ width: 30 }} />}
                <th>氏名</th><th>連絡先</th><th>地域</th><th>タグ</th><th className="num">参加回数</th><th>最終参加日</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={7} className="muted">該当する人物はいません。</td></tr>}
              {list.map((p) => (
                <tr key={p.id}>
                  {editor && <td><input type="checkbox" name="ids" value={p.id} aria-label={`${p.full_name}を選択`} /></td>}
                  <td>
                    <Link href={`/orgs/${orgId}/people/${p.id}`}><strong>{p.full_name}</strong></Link>
                    {p.full_name_kana && <div className="small muted">{p.full_name_kana}</div>}
                  </td>
                  <td className="small">{[...p.emails, ...p.phones].slice(0, 3).join(" / ") || "—"}</td>
                  <td className="small">{p.region ?? "—"}</td>
                  <td><div className="row">{p.tags.map((t) => <TagChip key={t.id} {...t} />)}</div></td>
                  <td className="num">{p.attendance_count}</td>
                  <td className="small">{fmtDate(p.last_attended_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </form>
      <Pager page={page} total={total} pageSize={PAGE_SIZE} hrefFor={(p) => `/orgs/${orgId}/people${qs(p)}`} />
    </>
  );
}
