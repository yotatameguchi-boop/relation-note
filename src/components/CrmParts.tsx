import Link from "next/link";
import { addInteraction, addTask, deleteInteraction, setTaskStatus } from "@/app/orgs/[orgId]/crm-actions";
import { DIRECTION_LABEL, dueState, INTERACTION_KIND_LABEL, PRIORITY_LABEL, TASK_STATUS_LABEL } from "@/lib/crm";
import { fmtDate, fmtDateTime, isoToJstLocal, STATUS_LABEL } from "@/lib/format";

type Target = { orgId: string; back: string; personId?: string | null; companyId?: string | null };

function Hidden({ t }: { t: Target }) {
  return (
    <>
      <input type="hidden" name="orgId" value={t.orgId} />
      <input type="hidden" name="back" value={t.back} />
      {t.personId && <input type="hidden" name="person_id" value={t.personId} />}
      {t.companyId && <input type="hidden" name="company_id" value={t.companyId} />}
    </>
  );
}

/** やりとりの記録フォーム（次の連絡予定のタスクも同時に作れる） */
export function InteractionForm({ t, now }: { t: Target; now: string }) {
  return (
    <form action={addInteraction} className="card">
      <Hidden t={t} />
      <h3 style={{ marginTop: 0 }}>やりとりを記録</h3>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="inline-field">種類
          <select name="kind" defaultValue="call">{Object.entries(INTERACTION_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label className="inline-field">向き
          <select name="direction" defaultValue="outbound"><option value="">—</option>
            {Object.entries(DIRECTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label className="inline-field">日時<input type="datetime-local" name="occurred_at" defaultValue={isoToJstLocal(now)} /></label>
      </div>
      <label className="field" style={{ marginTop: 8 }}>件名<input name="subject" maxLength={200} placeholder="例：イベントの協力について打ち合わせ" /></label>
      <label className="field">内容<textarea name="body" maxLength={20000} placeholder="話した内容、決まったこと" /></label>
      <details>
        <summary className="small">次の連絡予定をタスクにする</summary>
        <div className="row" style={{ marginTop: 6 }}>
          <label className="inline-field" style={{ flex: 2 }}>タスク<input name="follow_title" placeholder="例：見積もりを送る" /></label>
          <label className="inline-field">期限<input type="date" name="follow_due" /></label>
        </div>
      </details>
      <button style={{ marginTop: 8 }}>記録する</button>
    </form>
  );
}

export type TimelineItem = { kind: string; item_id: string; occurred_at: string; title: string; body: string | null; meta: Record<string, unknown> };

const TL_LABEL = (kind: string) =>
  kind.startsWith("interaction:") ? INTERACTION_KIND_LABEL[kind.slice(12)] ?? "やりとり"
  : kind === "note" ? "メモ" : kind === "participation" ? "イベント" : kind === "submission" ? "フォーム回答" : kind;

/** タイムライン（やりとり・メモ・参加・回答を時系列で） */
export function Timeline({ items, t, canEdit, myId }: { items: TimelineItem[]; t: Target; canEdit: boolean; myId?: string }) {
  if (!items.length) return <p className="muted small">まだ記録はありません。</p>;
  return (
    <ol className="timeline">
      {items.map((it) => (
        <li key={`${it.kind}-${it.item_id}`} className={`tl-${it.kind.split(":")[0]}`}>
          <div className="spread small">
            <span>
              <span className="badge">{TL_LABEL(it.kind)}</span>{" "}
              {typeof it.meta?.direction === "string" && <span className="muted">{DIRECTION_LABEL[it.meta.direction]}・</span>}
              <span className="muted">{fmtDateTime(it.occurred_at)}</span>
              {it.meta?.from_campaign === true && <span className="muted">・一斉配信</span>}
            </span>
            {canEdit && it.kind.startsWith("interaction:") && it.meta?.from_campaign !== true && (it.meta?.created_by === myId || !it.meta?.created_by) && (
              <form action={deleteInteraction}><Hidden t={t} /><input type="hidden" name="id" value={it.item_id} />
                <button className="link-btn small">削除</button></form>
            )}
          </div>
          <div>
            {it.kind === "participation" && typeof it.meta?.event_id === "string"
              ? <Link href={`/orgs/${t.orgId}/events/${it.meta.event_id}`}>{it.title}</Link>
              : <strong>{it.title}</strong>}
            {it.kind === "participation" && typeof it.meta?.status === "string" && <span className="small muted">（{STATUS_LABEL[it.meta.status]}）</span>}
            {it.kind === "submission" && typeof it.meta?.status === "string" && <span className="small muted">（{STATUS_LABEL[it.meta.status]}）</span>}
          </div>
          {it.body && <div className="small" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}

export type Member = { user_id: string; name: string };

export function TaskForm({ t, members, myId }: { t: Target; members: Member[]; myId: string }) {
  return (
    <form action={addTask} className="card">
      <Hidden t={t} />
      <h3 style={{ marginTop: 0 }}>タスクを追加</h3>
      <label className="field">内容 *<input name="title" required maxLength={200} placeholder="例：来週お礼の電話をする" /></label>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="inline-field">期限<input type="date" name="due_date" /></label>
        <label className="inline-field">担当
          <select name="assignee_id" defaultValue={myId}>{members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select>
        </label>
        <label className="inline-field">優先度
          <select name="priority" defaultValue="normal">{Object.entries(PRIORITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <button>追加</button>
      </div>
    </form>
  );
}

export type TaskRow = {
  id: string; title: string; due_date: string | null; status: string; priority: string;
  assignee_id: string | null; person_id: string | null; company_id: string | null;
  people?: { full_name: string } | null; companies?: { name: string } | null;
};

export function TaskList({ tasks, t, names, canEdit, showTarget = true }: {
  tasks: TaskRow[]; t: Target; names: Map<string, string>; canEdit: boolean; showTarget?: boolean;
}) {
  if (!tasks.length) return <p className="muted small">タスクはありません。</p>;
  return (
    <div className="table-wrap">
      <table className="small">
        <thead><tr><th style={{ width: 32 }} /><th>内容</th>{showTarget && <th>対象</th>}<th>期限</th><th>担当</th><th>優先度</th></tr></thead>
        <tbody>
          {tasks.map((x) => {
            const st = dueState(x.due_date, x.status);
            return (
              <tr key={x.id} style={x.status !== "open" ? { opacity: .6 } : undefined}>
                <td>
                  {canEdit && x.status !== "cancelled" && (
                    <form action={setTaskStatus}><Hidden t={t} /><input type="hidden" name="id" value={x.id} />
                      <input type="hidden" name="status" value={x.status === "done" ? "open" : "done"} />
                      <button className="task-check" aria-label={x.status === "done" ? `「${x.title}」を未完了に戻す` : `「${x.title}」を完了にする`}>
                        {x.status === "done" ? "✓" : ""}
                      </button>
                    </form>
                  )}
                </td>
                <td style={x.status === "done" ? { textDecoration: "line-through" } : undefined}>{x.title}
                  {x.status !== "open" && <span className="muted">（{TASK_STATUS_LABEL[x.status]}）</span>}</td>
                {showTarget && (
                  <td>
                    {x.person_id && <Link href={`/orgs/${t.orgId}/people/${x.person_id}`}>{x.people?.full_name ?? "人物"}</Link>}
                    {x.person_id && x.company_id && "・"}
                    {x.company_id && <Link href={`/orgs/${t.orgId}/companies/${x.company_id}`}>{x.companies?.name ?? "企業"}</Link>}
                    {!x.person_id && !x.company_id && "—"}
                  </td>
                )}
                <td>
                  {fmtDate(x.due_date)}
                  {st === "overdue" && <span className="badge badge-danger" style={{ marginLeft: 4 }}>期限切れ</span>}
                  {st === "today" && <span className="badge badge-warn" style={{ marginLeft: 4 }}>今日</span>}
                </td>
                <td>{x.assignee_id ? names.get(x.assignee_id) ?? "—" : "—"}</td>
                <td>{PRIORITY_LABEL[x.priority]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
