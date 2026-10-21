import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtDateTime, MATCH_REASON_LABEL } from "@/lib/format";
import { Flash, StatusBadge, TagChip } from "@/components/ui";
import { addContact, addNote, deleteNote, deletePerson, removeContact, setTags, updatePerson } from "./actions";

const KIND_LABEL: Record<string, string> = { email: "メール", phone: "電話", address: "住所", other: "その他" };

export default async function PersonPage({ params, searchParams }: {
  params: Promise<{ orgId: string; personId: string }>; searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { orgId, personId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const { data: p } = await supabase.from("people").select("*").eq("organization_id", orgId).eq("id", personId).maybeSingle();
  if (!p) notFound();
  const editor = can(m, "editor");

  const [contacts, myTags, allTags, notes, parts, subs, merges] = await Promise.all([
    supabase.from("person_contacts").select("*").eq("organization_id", orgId).eq("person_id", personId).order("created_at"),
    supabase.from("person_tags").select("tag_id").eq("organization_id", orgId).eq("person_id", personId),
    supabase.from("tags").select("id, name, color").eq("organization_id", orgId).order("name"),
    supabase.from("person_notes").select("id, body, created_at, author_id, users(display_name)").eq("organization_id", orgId).eq("person_id", personId).order("created_at", { ascending: false }),
    supabase.from("event_participations").select("id, status, status_changed_at, events(id, title, starts_at)").eq("organization_id", orgId).eq("person_id", personId),
    editor
      ? supabase.from("form_submissions").select("id, raw, source, received_at, submitted_at, status, match_reason, form_connections(name)").eq("organization_id", orgId).eq("person_id", personId).order("received_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as never[] }),
    supabase.from("person_merge_history").select("id, merged_person_id, merged_snapshot, created_at").eq("organization_id", orgId).eq("kept_person_id", personId).order("created_at", { ascending: false }),
  ]);
  const tagSet = new Set((myTags.data ?? []).map((t) => t.tag_id));
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="personId" value={personId} /></>);
  const participations = (parts.data ?? []).map((x) => ({ ...x, event: x.events as unknown as { id: string; title: string; starts_at: string } }))
    .sort((a, b) => b.event.starts_at.localeCompare(a.event.starts_at));

  return (
    <>
      <div className="spread">
        <h1>{p.full_name}{p.full_name_kana && <span className="muted small" style={{ marginLeft: 8 }}>{p.full_name_kana}</span>}</h1>
        <Link href={`/orgs/${orgId}/people`}>← 人物一覧</Link>
      </div>
      <Flash sp={sp} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">参加回数（参加確認済み）</div><div className="value">{p.attendance_count}</div></div>
        <div className="stat"><div className="label">最終参加日</div><div className="value" style={{ fontSize: 18 }}>{fmtDate(p.last_attended_at)}</div></div>
        <div className="stat"><div className="label">初回接点</div><div className="value" style={{ fontSize: 18 }}>{fmtDate(p.first_seen_at)}</div></div>
        <div className="stat"><div className="label">応募回答</div><div className="value">{subs.data?.length ?? "—"}</div></div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>基本情報</h2>
          {editor ? (
            <form action={updatePerson}>
              {hidden}
              <div className="field"><label>氏名</label><input name="full_name" defaultValue={p.full_name} required /></div>
              <div className="field"><label>ふりがな</label><input name="full_name_kana" defaultValue={p.full_name_kana ?? ""} /></div>
              <div className="field"><label>居住地域</label><input name="region" defaultValue={p.region ?? ""} /></div>
              <button>保存</button>
            </form>
          ) : (
            <p>地域: {p.region ?? "—"}</p>
          )}
          {Object.keys(p.attributes ?? {}).length > 0 && (
            <>
              <h3>フォーム由来の項目</h3>
              <table><tbody>
                {Object.entries(p.attributes as Record<string, string>).map(([k, v]) => (
                  <tr key={k}><th style={{ width: "40%" }}>{k}</th><td>{String(v)}</td></tr>
                ))}
              </tbody></table>
            </>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>連絡先</h2>
          <table><tbody>
            {(contacts.data ?? []).length === 0 && <tr><td className="muted">登録されていません。</td></tr>}
            {(contacts.data ?? []).map((c) => (
              <tr key={c.id}>
                <td style={{ width: 70 }}>{KIND_LABEL[c.kind]}</td>
                <td>{c.value}{c.label && <div className="small muted">{c.label}</div>}</td>
                <td className="right">
                  {editor && (
                    <form action={removeContact}>{hidden}<input type="hidden" name="contactId" value={c.id} /><button className="link-btn small">削除</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody></table>
          {editor && (
            <form action={addContact} className="row" style={{ marginTop: 10 }}>
              {hidden}
              <select name="kind" style={{ width: 90 }}>
                {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input name="value" required placeholder="値" style={{ flex: 1, minWidth: 140 }} />
              <button className="btn-secondary btn-small">追加</button>
            </form>
          )}
          <h3>タグ</h3>
          {editor ? (
            <form action={setTags}>
              {hidden}
              <div className="row">
                {(allTags.data ?? []).map((t) => (
                  <label key={t.id} className="tag" style={{ margin: 0 }}>
                    <input type="checkbox" name="tag_ids" value={t.id} defaultChecked={tagSet.has(t.id)} />
                    <span className="dot" style={{ background: t.color }} />{t.name}
                  </label>
                ))}
              </div>
              {(allTags.data ?? []).length === 0 ? <p className="small muted">タグは「タグ」画面で作成できます。</p> : <button className="btn-secondary btn-small" style={{ marginTop: 8 }}>タグを保存</button>}
            </form>
          ) : (
            <div className="row">{(allTags.data ?? []).filter((t) => tagSet.has(t.id)).map((t) => <TagChip key={t.id} {...t} />)}</div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>参加履歴</h2>
        <table>
          <thead><tr><th>日付</th><th>イベント</th><th>状態</th></tr></thead>
          <tbody>
            {participations.length === 0 && <tr><td colSpan={3} className="muted">参加履歴はありません。</td></tr>}
            {participations.map((x) => (
              <tr key={x.id}>
                <td>{fmtDate(x.event.starts_at)}</td>
                <td><Link href={`/orgs/${orgId}/events/${x.event.id}`}>{x.event.title}</Link></td>
                <td><StatusBadge status={x.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>スタッフのメモ</h2>
        {editor && (
          <form action={addNote} style={{ marginBottom: 12 }}>
            {hidden}
            <textarea name="body" required maxLength={10000} placeholder="対応内容や気づいたこと" />
            <button className="btn-secondary btn-small" style={{ marginTop: 6 }}>メモを追加</button>
          </form>
        )}
        {(notes.data ?? []).length === 0 && <p className="muted">メモはありません。</p>}
        {(notes.data ?? []).map((n) => (
          <div key={n.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
            <div className="spread small muted">
              <span>{(n.users as unknown as { display_name: string } | null)?.display_name ?? "（退会したスタッフ）"}・{fmtDateTime(n.created_at)}</span>
              {editor && (
                <form action={deleteNote}>{hidden}<input type="hidden" name="noteId" value={n.id} /><button className="link-btn small">削除</button></form>
              )}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
          </div>
        ))}
      </div>

      {editor && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>応募回答（原文）</h2>
          <p className="small muted">回答は人物情報を無条件に上書きしません。空欄の補完と、連絡先・タグの追加だけを行います。</p>
          {(subs.data ?? []).length === 0 && <p className="muted">回答はありません。</p>}
          {(subs.data ?? []).map((s) => (
            <details key={s.id} style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
              <summary>
                {(s.form_connections as unknown as { name: string } | null)?.name ?? "フォーム"}・{fmtDateTime(s.submitted_at ?? s.received_at)}
                <span className="small muted">（{MATCH_REASON_LABEL[s.match_reason ?? ""] ?? s.match_reason}）</span>
              </summary>
              <table className="small"><tbody>
                {Object.entries(s.raw as Record<string, unknown>).map(([k, v]) => (
                  <tr key={k}><th style={{ width: "35%" }}>{k}</th><td style={{ whiteSpace: "pre-wrap" }}>{String(v ?? "")}</td></tr>
                ))}
              </tbody></table>
            </details>
          ))}
        </div>
      )}

      {(merges.data ?? []).length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>統合履歴</h2>
          {(merges.data ?? []).map((h) => {
            const snap = h.merged_snapshot as { person: { full_name: string }; contacts: { value: string }[] };
            return (
              <details key={h.id}>
                <summary>{fmtDateTime(h.created_at)}：「{snap.person.full_name}」を統合</summary>
                <pre>{JSON.stringify(snap, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      )}

      {can(m, "admin") && (
        <form action={deletePerson} className="card">
          {hidden}
          <h2 style={{ marginTop: 0 }}>人物の削除</h2>
          <p className="small muted">連絡先・メモ・参加履歴も削除されます。応募回答の原文は残り、人物との紐づけだけが外れます。</p>
          <button className="btn-danger">この人物を削除</button>
        </form>
      )}
    </>
  );
}
