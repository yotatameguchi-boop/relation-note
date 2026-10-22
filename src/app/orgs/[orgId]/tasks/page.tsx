import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getUser, requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { todayJst } from "@/lib/format";
import { memberList } from "@/lib/members";
import { Flash } from "@/components/ui";
import { TaskForm, TaskList, type TaskRow } from "@/components/CrmParts";

async function setDigest(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  await supabase.from("users").update({ task_digest: fd.get("on") === "1" }).eq("id", u.user?.id ?? "");
  revalidatePath(`/orgs/${orgId}/tasks`);
  redirect(`/orgs/${orgId}/tasks?ok=${encodeURIComponent(fd.get("on") === "1" ? "毎朝のメール通知をオンにしました。" : "毎朝のメール通知をオフにしました。")}`);
}

const VIEWS = [
  { v: "mine", l: "自分の担当" },
  { v: "all", l: "全員" },
];
const WHEN = [
  { v: "open", l: "未完了すべて" },
  { v: "overdue", l: "期限切れ" },
  { v: "today", l: "今日まで" },
  { v: "week", l: "7日以内" },
  { v: "done", l: "完了済み" },
];

export default async function Tasks({ params, searchParams }: {
  params: Promise<{ orgId: string }>; searchParams: Promise<{ view?: string; when?: string; error?: string; ok?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const me = await getUser();
  const view = sp.view === "all" ? "all" : "mine";
  const when = WHEN.some((w) => w.v === sp.when) ? sp.when! : "open";
  const today = todayJst();
  const week = todayJst(7);
  const supabase = await createClient();
  let q = supabase.from("tasks").select("id, title, due_date, status, priority, assignee_id, person_id, company_id, people(full_name), companies(name)")
    .eq("organization_id", orgId);
  if (view === "mine") q = q.eq("assignee_id", me?.id ?? "");
  if (when === "done") q = q.in("status", ["done", "cancelled"]).order("completed_at", { ascending: false }).limit(100);
  else {
    q = q.eq("status", "open");
    if (when === "overdue") q = q.lt("due_date", today);
    if (when === "today") q = q.lte("due_date", today);
    if (when === "week") q = q.lte("due_date", week);
    q = q.order("due_date", { ascending: true, nullsFirst: false }).order("priority").limit(300);
  }
  const [{ data: tasks }, members, { data: profile }, { data: counts }] = await Promise.all([
    q, memberList(orgId),
    supabase.from("users").select("task_digest").eq("id", me?.id ?? "").maybeSingle(),
    supabase.rpc("my_task_counts", { org: orgId }),
  ]);
  const c = (counts ?? { overdue: 0, today: 0, open: 0 }) as { overdue: number; today: number; open: number };
  const url = `/orgs/${orgId}/tasks?view=${view}&when=${when}`;
  const href = (v: string, w: string) => `/orgs/${orgId}/tasks?view=${v}&when=${w}`;
  return (
    <>
      <h1>タスク</h1>
      <Flash sp={sp} />
      <div className="grid grid-4" style={{ marginBottom: 12 }}>
        <div className="stat"><div className="label">自分の未完了</div><div className="value">{c.open}</div></div>
        <div className="stat"><div className="label">期限切れ</div><div className="value" style={c.overdue ? { color: "var(--danger)" } : undefined}>{c.overdue}</div></div>
        <div className="stat"><div className="label">今日が期限</div><div className="value">{c.today}</div></div>
      </div>
      <div className="row" style={{ marginBottom: 6 }} role="navigation" aria-label="担当で絞り込み">
        {VIEWS.map((x) => <Link key={x.v} href={href(x.v, when)} className={x.v === view ? "btn btn-small" : "btn btn-secondary btn-small"} aria-current={x.v === view ? "page" : undefined}>{x.l}</Link>)}
      </div>
      <div className="row" style={{ marginBottom: 12 }} role="navigation" aria-label="期限で絞り込み">
        {WHEN.map((x) => <Link key={x.v} href={href(view, x.v)} className={x.v === when ? "btn btn-small" : "btn btn-secondary btn-small"} aria-current={x.v === when ? "page" : undefined}>{x.l}</Link>)}
      </div>
      <TaskList tasks={(tasks ?? []) as unknown as TaskRow[]} t={{ orgId, back: url }} names={members.names} canEdit={can(m, "editor")} />
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        {can(m, "editor") && me && <TaskForm t={{ orgId, back: url }} members={members.list} myId={me.id} />}
        <form action={setDigest} className="card">
          <input type="hidden" name="orgId" value={orgId} />
          <h3 style={{ marginTop: 0 }}>毎朝のメール通知</h3>
          <p className="small muted">毎朝8時に、期限が今日まで（期限切れを含む）の自分のタスクをメールでお知らせします。メール送信が設定されている場合に届きます。</p>
          {profile?.task_digest !== false
            ? <><input type="hidden" name="on" value="0" /><button className="btn-secondary btn-small">オフにする（現在：オン）</button></>
            : <><input type="hidden" name="on" value="1" /><button className="btn-small">オンにする（現在：オフ）</button></>}
        </form>
      </div>
    </>
  );
}
