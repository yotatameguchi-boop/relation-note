import Link from "next/link";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtBytes, fmtDateTime } from "@/lib/format";
import { StatusBadge } from "@/components/ui";
import { PhotoUploader } from "@/components/PhotoUploader";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function Photos({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ event?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  let q = supabase.from("photos")
    .select("id, status, original_filename, size_bytes, created_at, failure_reason, events(id, title), photo_analysis_results(estimated_count, analyzed_at), photo_reviews(confirmed_count, reviewed_at)")
    .eq("organization_id", orgId).order("created_at", { ascending: false }).limit(100);
  if (sp.event) q = q.eq("event_id", sp.event);
  const [{ data: photos }, { data: events }] = await Promise.all([
    q,
    supabase.from("events").select("id, title").eq("organization_id", orgId).order("starts_at", { ascending: false }).limit(100),
  ]);
  const pending = (photos ?? []).some((p) => ["queued", "analyzing"].includes(p.status));
  const last = <T,>(xs: T[], key: keyof T) => [...xs].sort((a, b) => String(b[key]).localeCompare(String(a[key])))[0];

  return (
    <>
      {pending && <AutoRefresh seconds={5} />}
      <h1>写真と人数推定</h1>
      <p className="muted small">
        写真に写っている人数を推定し、スタッフが確認・修正して確定します。推定値と確定値は別に保存されます。
        顔による本人特定や、名簿との照合は行いません。人物の重なり・暗所・小さく写った人物では誤差が出ます。
      </p>
      {can(m, "editor") && <PhotoUploader orgId={orgId} events={events ?? []} defaultEventId={sp.event} />}
      <div className="table-wrap">
        <table>
          <thead><tr><th>写真</th><th>イベント</th><th>状態</th><th className="num">推定人数</th><th className="num">確定人数</th><th>登録</th></tr></thead>
          <tbody>
            {(photos ?? []).length === 0 && <tr><td colSpan={6} className="muted">写真はまだありません。</td></tr>}
            {(photos ?? []).map((p) => {
              const r = last(p.photo_analysis_results as { estimated_count: number; analyzed_at: string }[], "analyzed_at");
              const v = last(p.photo_reviews as { confirmed_count: number; reviewed_at: string }[], "reviewed_at");
              const ev = p.events as unknown as { id: string; title: string } | null;
              return (
                <tr key={p.id}>
                  <td><Link href={`/orgs/${orgId}/photos/${p.id}`}>{p.original_filename ?? "写真"}</Link><div className="small muted">{fmtBytes(p.size_bytes)}</div></td>
                  <td className="small">{ev ? <Link href={`/orgs/${orgId}/events/${ev.id}`}>{ev.title}</Link> : "—"}</td>
                  <td><StatusBadge status={p.status} />{p.failure_reason && <div className="small muted">{p.failure_reason}</div>}</td>
                  <td className="num">{r?.estimated_count ?? "—"}</td>
                  <td className="num">{v?.confirmed_count ?? "—"}</td>
                  <td className="small">{fmtDateTime(p.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
