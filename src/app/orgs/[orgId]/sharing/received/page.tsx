import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { FIELD_LABEL } from "@/lib/sharing";
import { sharingContext } from "@/lib/sharing-guard";
import { Pager } from "@/components/ui";
import { SharingDisabled, SharingTabs } from "@/components/SharingTabs";

type Row = { grant_id: string; source_name: string; label: string; fields: string[]; version: number; published_at: string; expires_at: string; total_count: number };
const PAGE = 50;

export default async function Received({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { enabled, manage, view } = await sharingContext(orgId, "view");
  if (!enabled) return <SharingDisabled />;
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("shared_people_list", { org: orgId, q: sp.q || null, page_size: PAGE, page });
  const rows = (data ?? []) as Row[];
  return (
    <>
      <h1>他団体から共有された活動者</h1>
      <SharingTabs orgId={orgId} current="received" manage={manage} view={view} />
      <div className="notice notice-info small">
        ここに表示されるのは、他団体が共有を許可した項目だけです。自団体の人物台帳とは別に管理され、編集・取り込み・CSV出力・第三者への再共有はできません。
        共有が停止・期限切れ・連携解除になると表示されなくなります。
      </div>
      <form className="row" style={{ marginBottom: 10 }}>
        <input name="q" defaultValue={sp.q} placeholder="共有された項目の内容で検索" style={{ flex: 1 }} />
        <button className="btn-secondary btn-small">検索</button>
      </form>
      {error && <div className="notice notice-danger">一覧を取得できませんでした。</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>活動者</th><th>共有元</th><th>共有項目</th><th>公開日時</th><th>期限</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="muted">共有されている活動者はいません。</td></tr>}
            {rows.map((r) => (
              <tr key={r.grant_id}>
                <td><span className="shared-badge">共有</span> <Link href={`/orgs/${orgId}/sharing/received/${r.grant_id}`}>{r.label}</Link></td>
                <td>{r.source_name}</td>
                <td className="small">{r.fields.map((f) => FIELD_LABEL[f] ?? f).join("、")}</td>
                <td className="small">{fmtDateTime(r.published_at)}（第{r.version}版）</td>
                <td className="small">{fmtDate(r.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={rows[0]?.total_count ?? 0} pageSize={PAGE} hrefFor={(p) => `/orgs/${orgId}/sharing/received?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), page: String(p) })}`} />
    </>
  );
}
