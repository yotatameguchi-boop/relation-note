import Link from "next/link";
import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtNum } from "@/lib/format";

type EventRow = {
  id: string; title: string; starts_at: string; attended_records: number; applied_records: number;
  anonymous_count: number; confirmed_headcount: number | null; headcount: number;
  headcount_source: "staff_confirmed" | "attendance_records"; photo_max_estimated: number | null; photo_max_confirmed: number | null;
};
type Metrics = {
  definition: { relation_window_days: number; repeat_threshold: number };
  events_held: number; total_participation: number; attended_records: number; anonymous_attendees: number;
  unique_participants: number; repeat_participants: number; related_people: number;
  photos: { count: number; with_estimate: number; confirmed: number };
  events: EventRow[];
};

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{fmtNum(value)}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export default async function Dashboard({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  await requireMembership(orgId);
  const today = new Date();
  const defFrom = new Date(today.getFullYear(), today.getMonth() - 11, 1).toISOString().slice(0, 10);
  const defTo = today.toISOString().slice(0, 10);
  const from = sp.from || defFrom;
  const to = sp.to || defTo;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("org_metrics", {
    org: orgId,
    from_ts: `${from}T00:00:00+09:00`,
    to_ts: new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 86400000).toISOString(),
  });
  const m = data as Metrics | null;
  const { data: daily } = await supabase.from("daily_metrics")
    .select("day, people_total, attended_participations").eq("organization_id", orgId)
    .order("day", { ascending: false }).limit(30);

  return (
    <>
      <div className="spread">
        <h1>ダッシュボード</h1>
        <form className="row small">
          <input type="date" name="from" defaultValue={from} style={{ width: 150 }} />〜
          <input type="date" name="to" defaultValue={to} style={{ width: 150 }} />
          <button className="btn-secondary btn-small">期間を変更</button>
        </form>
      </div>
      {error && <div className="notice notice-danger">集計を取得できませんでした。</div>}
      {m && (
        <>
          <div className="grid grid-4">
            <Stat label="延べ参加人数" value={m.total_participation} note="各イベントの参加人数の合計" />
            <Stat label="実参加者数" value={m.unique_participants} note="名簿上の人物の重複を除く" />
            <Stat label="継続参加者数" value={m.repeat_participants} note={`期間内に${m.definition.repeat_threshold}回以上参加`} />
            <Stat label="関係人口" value={m.related_people} note={`直近${m.definition.relation_window_days}日の参加・応募者（設定で変更）`} />
            <Stat label="開催イベント" value={m.events_held} />
            <Stat label="参加確認済みの記録" value={m.attended_records} />
            <Stat label="匿名参加者" value={m.anonymous_attendees} note="個人単位の重複排除はできません" />
            <Stat label="解析済み写真" value={m.photos.with_estimate} note={`うち確定 ${m.photos.confirmed}枚`} />
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            写真の人数は同じ人が複数枚に写るため合算せず、イベント参加人数にも自動では反映しません。
            参加人数は原則として参加確認済みの記録（＋匿名参加者）を使い、スタッフが確定した人数があればそちらを優先します。
          </p>

          <h2>イベント別</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th><th>イベント</th><th className="num">申込</th><th className="num">参加確認</th>
                  <th className="num">匿名</th><th className="num">参加人数</th><th className="num">写真内（推定/確定の最大）</th>
                </tr>
              </thead>
              <tbody>
                {m.events.length === 0 && <tr><td colSpan={7} className="muted">期間内のイベントはありません。</td></tr>}
                {m.events.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.starts_at)}</td>
                    <td><Link href={`/orgs/${orgId}/events/${e.id}`}>{e.title}</Link></td>
                    <td className="num">{e.applied_records}</td>
                    <td className="num">{e.attended_records}</td>
                    <td className="num">{e.anonymous_count}</td>
                    <td className="num">
                      {e.headcount}
                      {e.headcount_source === "staff_confirmed" && <span className="badge badge-ok" style={{ marginLeft: 4 }}>確定</span>}
                    </td>
                    <td className="num muted">{e.photo_max_estimated ?? "—"} / {e.photo_max_confirmed ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {daily && daily.length > 0 && (
        <>
          <h2>日次集計（直近30日）</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>日付</th><th className="num">登録人物（累計）</th><th className="num">参加確認</th></tr></thead>
              <tbody>
                {daily.map((d) => (
                  <tr key={d.day}><td>{d.day}</td><td className="num">{fmtNum(d.people_total)}</td><td className="num">{fmtNum(d.attended_participations)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
