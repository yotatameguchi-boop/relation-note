import Link from "next/link";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime } from "@/lib/format";
import { Flash, StatusBadge } from "@/components/ui";
import { createConnection } from "./actions";

export default async function Forms({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId, "editor");
  const supabase = await createClient();
  const [{ data: conns }, { data: batches }, { data: events }, { count: review }] = await Promise.all([
    supabase.from("form_connections").select("id, name, kind, is_active, events(title)").eq("organization_id", orgId).order("created_at"),
    supabase.from("import_batches").select("id, filename, status, total_rows, duplicate_rows, created_at, form_connections(name)").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(20),
    supabase.from("events").select("id, title, starts_at").eq("organization_id", orgId).order("starts_at", { ascending: false }).limit(100),
    supabase.from("form_submissions").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "needs_review"),
  ]);
  return (
    <>
      <h1>応募フォームの取り込み・連携</h1>
      <Flash sp={sp} />
      {(review ?? 0) > 0 && (
        <div className="notice notice-warn">確認待ちの回答が {review} 件あります。<Link href={`/orgs/${orgId}/review`}>確認する</Link></div>
      )}
      <h2>フォーム（取り込み元）</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>名前</th><th>方式</th><th>申込先イベント</th><th>状態</th></tr></thead>
          <tbody>
            {(conns ?? []).length === 0 && <tr><td colSpan={4} className="muted">まだありません。まずフォームを1つ作成し、CSVを取り込んでください。</td></tr>}
            {(conns ?? []).map((c) => (
              <tr key={c.id}>
                <td><Link href={`/orgs/${orgId}/forms/${c.id}`}>{c.name}</Link></td>
                <td>{c.kind === "csv" ? "CSV取り込み" : "外部フォーム自動連携"}</td>
                <td className="small">{(c.events as unknown as { title: string } | null)?.title ?? "—"}</td>
                <td>{c.is_active ? <span className="badge badge-ok">有効</span> : <span className="badge">停止</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can(m, "admin") && (
        <form action={createConnection} className="card" style={{ marginTop: 12 }}>
          <input type="hidden" name="orgId" value={orgId} />
          <h3 style={{ marginTop: 0 }}>フォームを追加</h3>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="inline-field" style={{ flex: 2 }}><label>名前</label><input name="name" required placeholder="例：ボランティア募集フォーム" /></div>
            <div className="inline-field">
              <label>方式</label>
              <select name="kind"><option value="csv">CSV取り込み</option><option value="webhook">外部フォーム自動連携</option></select>
            </div>
            <div className="inline-field" style={{ flex: 1 }}>
              <label>申込先イベント（任意）</label>
              <select name="event_id" defaultValue="">
                <option value="">なし</option>
                {(events ?? []).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
              </select>
            </div>
            <button>追加</button>
          </div>
        </form>
      )}
      <h2>取り込み履歴</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>日時</th><th>フォーム</th><th>ファイル</th><th className="num">行数</th><th className="num">重複スキップ</th><th>状態</th></tr></thead>
          <tbody>
            {(batches ?? []).length === 0 && <tr><td colSpan={6} className="muted">まだありません。</td></tr>}
            {(batches ?? []).map((b) => (
              <tr key={b.id}>
                <td><Link href={`/orgs/${orgId}/imports/${b.id}`}>{fmtDateTime(b.created_at)}</Link></td>
                <td>{(b.form_connections as unknown as { name: string } | null)?.name}</td>
                <td className="small">{b.filename}</td>
                <td className="num">{b.total_rows}</td>
                <td className="num">{b.duplicate_rows}</td>
                <td><StatusBadge status={b.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
