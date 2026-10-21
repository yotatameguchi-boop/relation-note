import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDateTime, isoToJstLocal } from "@/lib/format";
import { Flash, StatusBadge } from "@/components/ui";
import { addParticipants, confirmHeadcount, deleteEvent, setParticipationStatus, updateEvent } from "../actions";

const METHOD_LABEL: Record<string, string> = {
  reception: "受付記録",
  manual_tally: "手動集計",
  photo_assisted: "写真を参考に確認",
  other: "その他",
};

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
  const [{ data: parts }, { data: photos }, search, { data: counts }] = await Promise.all([
    supabase.from("event_participations").select("id, status, status_changed_at, person_id, people(full_name, full_name_kana)")
      .eq("organization_id", orgId).eq("event_id", eventId),
    supabase.from("photos").select("id, status, original_filename, photo_analysis_results(estimated_count, analyzed_at), photo_reviews(confirmed_count, reviewed_at)")
      .eq("organization_id", orgId).eq("event_id", eventId).order("created_at"),
    sp.q && editor
      ? supabase.rpc("search_people", { org: orgId, q: sp.q, page_size: 20, page: 1 })
      : Promise.resolve({ data: null }),
    supabase.from("event_count_records").select("id, headcount, method, basis, note, photo_ids, confirmed_at, users(display_name)")
      .eq("organization_id", orgId).eq("event_id", eventId).order("confirmed_at", { ascending: false }).limit(20),
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
            <label className="field">イベント名<input name="title" defaultValue={e.title} required /></label>
            <div className="row">
              <label className="inline-field" style={{ flex: 1 }}>開始<input type="datetime-local" name="starts_at" defaultValue={isoToJstLocal(e.starts_at)} required /></label>
              <label className="inline-field" style={{ flex: 1 }}>終了<input type="datetime-local" name="ends_at" defaultValue={isoToJstLocal(e.ends_at)} /></label>
            </div>
            <label className="field" style={{ marginTop: 10 }}>場所<input name="location" defaultValue={e.location ?? ""} /></label>
            <label className="field">匿名参加者数（名簿に載らない参加者）<input type="number" min={0} name="anonymous_count" defaultValue={e.anonymous_count} /></label>
            <label className="field">説明<textarea name="description" defaultValue={e.description ?? ""} /></label>
            <button>保存</button>
          </form>
        )}
        <div className="card">
          <h2 style={{ marginTop: 0 }}>参加人数の確定</h2>
          <p className="small muted">
            受付記録と実際の人数が違う場合などに、根拠と一緒に参加人数を確定します。
            写真の人数は参考値です。写っていない参加者がいるほか、写真だけでは同じ人が複数の写真に写っていても見分けられない（個人単位の重複を除けない）ため、自動では反映しません。
          </p>
          {editor && (
            <form action={confirmHeadcount}>
              {hidden}
              <div className="row">
                <div className="inline-field" style={{ minWidth: 110 }}><label>人数</label>
                  <input type="number" min={0} name="headcount" aria-label="人数" defaultValue={e.confirmed_headcount ?? ""} placeholder={String(attended + e.anonymous_count)} /></div>
                <label className="inline-field">計測方法<select name="method" defaultValue="reception" aria-label="計測方法">
                    {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select></label>
              </div>
              <label className="field" style={{ marginTop: 8 }}>根拠（例：受付名簿の枚数、カウンターでの計測）<input name="basis" maxLength={1000} /></label>
              {(photos ?? []).length > 0 && (
                <div className="field"><label>参考にした写真（任意）</label>
                  <div className="row">{(photos ?? []).map((ph) => (
                    <label key={ph.id} className="row small" style={{ margin: 0, color: "var(--text)" }}><input type="checkbox" name="photo_ids" value={ph.id} />{ph.original_filename ?? "写真"}</label>
                  ))}</div>
                </div>
              )}
              <label className="field">注記<input name="note" maxLength={1000} /></label>
              <div className="row"><button className="btn-small">確定</button><span className="small muted">人数を空欄にすると確定を取り消します</span></div>
            </form>
          )}
          {(counts ?? []).length > 0 && (
            <>
              <h3>確定の記録</h3>
              <table className="small"><tbody>
                {(counts ?? []).map((c) => (
                  <tr key={c.id}>
                    <td>{fmtDateTime(c.confirmed_at)}</td>
                    <td>{(c.users as unknown as { display_name: string } | null)?.display_name}</td>
                    <td className="num"><strong>{c.headcount ?? "取消"}</strong></td>
                    <td>{METHOD_LABEL[c.method] ?? (c.method === "cleared" ? "確定の取り消し" : c.method)}{c.basis && `：${c.basis}`}{c.photo_ids.length > 0 && `（写真${c.photo_ids.length}枚を参考）`}{c.note && <div className="muted">{c.note}</div>}</td>
                  </tr>
                ))}
              </tbody></table>
            </>
          )}
          <h3>このイベントの写真（写真ごとの人数・合算しません）</h3>
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
