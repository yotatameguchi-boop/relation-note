import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime, isoToJstLocal } from "@/lib/format";
import { Flash, StatusBadge } from "@/components/ui";
import { addParticipants, confirmHeadcount, deleteEvent, setParticipationStatus, updateEvent } from "../actions";

export default async function EventPage({ params, searchParams }: {
  params: Promise<{ orgId: string; eventId: string }>; searchParams: Promise<{ error?: string; ok?: string; q?: string }>;
}) {
  const { orgId, eventId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const { data: e } = await supabase.from("events").select("*").eq("organization_id", orgId).eq("id", eventId).maybeSingle();
  if (!e) notFound();
  const editor = can(m, "editor");
  const [{ data: parts }, { data: photos }, search] = await Promise.all([
    supabase.from("event_participations").select("id, status, status_changed_at, person_id, people(full_name, full_name_kana)")
      .eq("organization_id", orgId).eq("event_id", eventId),
    supabase.from("photos").select("id, status, original_filename, photo_analysis_results(estimated_count, analyzed_at), photo_reviews(confirmed_count, reviewed_at)")
      .eq("organization_id", orgId).eq("event_id", eventId).order("created_at"),
    sp.q && editor
      ? supabase.rpc("search_people", { org: orgId, q: sp.q, page_size: 20, page: 1 })
      : Promise.resolve({ data: null }),
  ]);
  const list = (parts ?? []).map((p) => ({ ...p, person: p.people as unknown as { full_name: string; full_name_kana: string | null } }))
    .sort((a, b) => (a.person.full_name_kana ?? a.person.full_name).localeCompare(b.person.full_name_kana ?? b.person.full_name, "ja"));
  const attended = list.filter((p) => p.status === "attended").length;
  const already = new Set(list.map((p) => p.person_id));
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="eventId" value={eventId} /></>);
  const latest = <T extends { analyzed_at?: string; reviewed_at?: string }>(xs: T[]) =>
    [...xs].sort((a, b) => String(b.analyzed_at ?? b.reviewed_at).localeCompare(String(a.analyzed_at ?? a.reviewed_at)))[0];

  return (
    <>
      <div className="spread"><h1>{e.title}</h1><Link href={`/orgs/${orgId}/events`}>← イベント一覧</Link></div>
      <p className="muted small">{fmtDateTime(e.starts_at)}{e.location && `・${e.location}`}</p>
      <Flash sp={sp} />

      <div className="grid grid-4">
        <div className="stat"><div className="label">申込</div><div className="value">{list.filter((p) => p.status === "applied").length}</div></div>
        <div className="stat"><div className="label">参加確認</div><div className="value">{attended}</div></div>
        <div className="stat"><div className="label">匿名参加者</div><div className="value">{e.anonymous_count}</div></div>
        <div className="stat">
          <div className="label">イベント参加人数</div>
          <div className="value">{e.confirmed_headcount ?? attended + e.anonymous_count}</div>
          <div className="note">{e.confirmed_headcount != null ? `スタッフ確定（${fmtDateTime(e.headcount_confirmed_at)}）` : "参加確認＋匿名から算出"}</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        {editor && (
          <form action={updateEvent} className="card">
            {hidden}
            <h2 style={{ marginTop: 0 }}>イベント情報</h2>
            <div className="field"><label>イベント名</label><input name="title" defaultValue={e.title} required /></div>
            <div className="row">
              <div className="inline-field" style={{ flex: 1 }}><label>開始</label><input type="datetime-local" name="starts_at" defaultValue={isoToJstLocal(e.starts_at)} required /></div>
              <div className="inline-field" style={{ flex: 1 }}><label>終了</label><input type="datetime-local" name="ends_at" defaultValue={isoToJstLocal(e.ends_at)} /></div>
            </div>
            <div className="field" style={{ marginTop: 10 }}><label>場所</label><input name="location" defaultValue={e.location ?? ""} /></div>
            <div className="field"><label>匿名参加者数（名簿に載らない参加者）</label><input type="number" min={0} name="anonymous_count" defaultValue={e.anonymous_count} /></div>
            <div className="field"><label>説明</label><textarea name="description" defaultValue={e.description ?? ""} /></div>
            <button>保存</button>
          </form>
        )}
        <div className="card">
          <h2 style={{ marginTop: 0 }}>参加人数の確定</h2>
          <p className="small muted">
            受付記録と実際の人数が違う場合に、スタッフが参加人数を確定します。写真の推定人数は参考値で、写っていない参加者もいるため自動では反映しません。
          </p>
          {editor && (
            <form action={confirmHeadcount} className="row">
              {hidden}
              <input type="number" min={0} name="headcount" defaultValue={e.confirmed_headcount ?? ""} placeholder={String(attended + e.anonymous_count)} style={{ width: 120 }} />
              <button className="btn-small">確定</button>
              <span className="small muted">空欄で確定を取り消し</span>
            </form>
          )}
          <h3>このイベントの写真</h3>
          {(photos ?? []).length === 0 && <p className="small muted">写真はありません。<Link href={`/orgs/${orgId}/photos?event=${eventId}`}>写真を追加</Link></p>}
          <table className="small"><tbody>
            {(photos ?? []).map((p) => {
              const r = latest(p.photo_analysis_results as { estimated_count: number; analyzed_at: string }[]);
              const v = latest(p.photo_reviews as { confirmed_count: number; reviewed_at: string }[]);
              return (
                <tr key={p.id}>
                  <td><Link href={`/orgs/${orgId}/photos/${p.id}`}>{p.original_filename ?? "写真"}</Link></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="num">推定 {r?.estimated_count ?? "—"}</td>
                  <td className="num">確定 {v?.confirmed_count ?? "—"}</td>
                </tr>
              );
            })}
          </tbody></table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>参加者（{list.length}人）</h2>
        <form action={setParticipationStatus}>
          {hidden}
          {editor && (
            <div className="row small" style={{ marginBottom: 8 }}>
              <span className="muted">選択した人を:</span>
              <button name="status" value="attended" className="btn-small">参加確認</button>
              <button name="status" value="absent" className="btn-secondary btn-small">欠席</button>
              <button name="status" value="cancelled" className="btn-secondary btn-small">キャンセル</button>
              <button name="status" value="applied" className="btn-secondary btn-small">申込に戻す</button>
              <button name="status" value="remove" className="btn-secondary btn-small">記録を削除</button>
            </div>
          )}
          <table>
            <thead><tr>{editor && <th style={{ width: 30 }} />}<th>氏名</th><th>状態</th><th>更新</th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={4} className="muted">まだ登録されていません。</td></tr>}
              {list.map((p) => (
                <tr key={p.id}>
                  {editor && <td><input type="checkbox" name="partIds" value={p.id} aria-label={p.person.full_name} /></td>}
                  <td><Link href={`/orgs/${orgId}/people/${p.person_id}`}>{p.person.full_name}</Link></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="small muted">{fmtDateTime(p.status_changed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </form>

        {editor && (
          <>
            <h3>参加者を追加</h3>
            <form className="row">
              <input name="q" defaultValue={sp.q} placeholder="氏名・メール・電話で検索" style={{ flex: 1 }} />
              <button className="btn-secondary btn-small">検索</button>
            </form>
            {search.data && (
              <form action={addParticipants} style={{ marginTop: 8 }}>
                {hidden}
                {(search.data as { id: string; full_name: string; emails: string[] }[]).filter((p) => !already.has(p.id)).map((p) => (
                  <label key={p.id} className="row" style={{ color: "var(--text)" }}>
                    <input type="checkbox" name="personIds" value={p.id} />{p.full_name}<span className="small muted">{p.emails[0]}</span>
                  </label>
                ))}
                <div className="row" style={{ marginTop: 8 }}>
                  <select name="status" style={{ width: 140 }} defaultValue="attended">
                    <option value="applied">申込として</option>
                    <option value="attended">参加として</option>
                  </select>
                  <button className="btn-small">追加</button>
                </div>
              </form>
            )}
          </>
        )}
      </div>

      {editor && (
        <form action={deleteEvent} className="card">
          {hidden}
          <p className="small muted">イベントを削除すると参加履歴も削除され、各人物の参加回数が再計算されます。写真は残ります。</p>
          <button className="btn-danger btn-small">このイベントを削除</button>
        </form>
      )}
    </>
  );
}
