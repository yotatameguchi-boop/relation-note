import Link from "next/link";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/ui";
import { createEvent } from "./actions";

export default async function Events({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const { data: events } = await supabase.from("events")
    .select("id, title, starts_at, location, anonymous_count, confirmed_headcount, event_participations(status)")
    .eq("organization_id", orgId).order("starts_at", { ascending: false }).limit(200);
  return (
    <>
      <h1>イベント・参加履歴</h1>
      <Flash sp={sp} />
      {can(m, "editor") && (
        <details className="card">
          <summary>イベントを登録</summary>
          <form action={createEvent} style={{ marginTop: 10 }}>
            <input type="hidden" name="orgId" value={orgId} />
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="inline-field" style={{ flex: 2 }}>イベント名 *<input name="title" required /></label>
              <label className="inline-field">開始 *<input type="datetime-local" name="starts_at" required /></label>
              <label className="inline-field">終了<input type="datetime-local" name="ends_at" /></label>
              <label className="inline-field" style={{ flex: 1 }}>場所<input name="location" /></label>
            </div>
            <label className="field" style={{ marginTop: 10 }}>説明<textarea name="description" style={{ minHeight: 50 }} /></label>
            <button>登録</button>
          </form>
        </details>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>日時</th><th>イベント</th><th>場所</th><th className="num">申込</th><th className="num">参加確認</th><th className="num">匿名</th><th className="num">参加人数</th></tr></thead>
          <tbody>
            {(events ?? []).length === 0 && <tr><td colSpan={7} className="muted">イベントはまだありません。</td></tr>}
            {(events ?? []).map((e) => {
              const ps = e.event_participations as { status: string }[];
              const attended = ps.filter((p) => p.status === "attended").length;
              return (
                <tr key={e.id}>
                  <td className="small">{fmtDateTime(e.starts_at)}</td>
                  <td><Link href={`/orgs/${orgId}/events/${e.id}`}>{e.title}</Link></td>
                  <td className="small">{e.location ?? "—"}</td>
                  <td className="num">{ps.filter((p) => p.status === "applied").length}</td>
                  <td className="num">{attended}</td>
                  <td className="num">{e.anonymous_count}</td>
                  <td className="num">
                    {e.confirmed_headcount ?? attended + e.anonymous_count}
                    {e.confirmed_headcount != null && <span className="badge badge-ok" style={{ marginLeft: 4 }}>確定</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
