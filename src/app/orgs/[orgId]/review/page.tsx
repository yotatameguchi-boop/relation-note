import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDateTime, MATCH_REASON_LABEL } from "@/lib/format";
import { Flash, StatusBadge } from "@/components/ui";
import { TARGET_FIELDS } from "@/lib/csv";

const FIELD_LABEL: Record<string, string> = Object.fromEntries(TARGET_FIELDS.map((f) => [f.value, f.label]));

async function resolve(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const raw = String(fd.get("decision") ?? "");
  const [action, person] = raw.split(":");
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_submission", { sub_id: String(fd.get("subId")), action, target_person: person || null });
  if (error) redirect(`/orgs/${orgId}/review?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(`/orgs/${orgId}/review`);
  redirect(`/orgs/${orgId}/review?ok=${encodeURIComponent("処理しました。")}`);
}

async function retryHeld(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("retry_held_submissions", { org: orgId });
  if (error) redirect(`/orgs/${orgId}/review?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/review?ok=${encodeURIComponent("保留中の回答を再処理に回しました。")}`);
}

type Cand = { id: string; full_name: string; region: string | null; attendance_count: number; person_contacts: { kind: string; value: string }[] };

export default async function Review({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string; status?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  await requireMembership(orgId, "editor");
  const status = sp.status === "error" ? "error" : "needs_review";
  const supabase = await createClient();
  const [{ data: subs }, { count: held }] = await Promise.all([
    supabase.from("form_submissions")
      .select("id, raw, status, error, match_reason, candidate_person_ids, received_at, submitted_at, form_connections(name, field_mapping)")
      .eq("organization_id", orgId).eq("status", status).order("received_at").limit(50),
    supabase.from("form_submissions").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("status", "pending").not("error", "is", null),
  ]);
  const candIds = [...new Set((subs ?? []).flatMap((s) => s.candidate_person_ids as string[]))];
  const { data: cands } = candIds.length
    ? await supabase.from("people").select("id, full_name, region, attendance_count, person_contacts(kind, value)").eq("organization_id", orgId).in("id", candIds)
    : { data: [] as Cand[] };
  const byId = new Map((cands as Cand[]).map((c) => [c.id, c]));

  return (
    <>
      <h1>確認待ちの回答</h1>
      <p className="muted small">
        メール・電話は一致するが氏名が違う回答（家族で共有している場合など）や、氏名だけが一致する回答は自動で統合せず、ここで判断します。
      </p>
      <Flash sp={sp} />
      <div className="row" style={{ marginBottom: 12 }}>
        <Link className={status === "needs_review" ? "btn" : "btn btn-secondary"} href={`/orgs/${orgId}/review`}>確認待ち</Link>
        <Link className={status === "error" ? "btn" : "btn btn-secondary"} href={`/orgs/${orgId}/review?status=error`}>エラー</Link>
        {(held ?? 0) > 0 && (
          <form action={retryHeld}><input type="hidden" name="orgId" value={orgId} /><button className="btn-secondary">上限で保留中の {held} 件を再処理</button></form>
        )}
      </div>
      {(subs ?? []).length === 0 && <div className="card muted">該当する回答はありません。</div>}
      {(subs ?? []).map((s) => {
        const conn = s.form_connections as unknown as { name: string; field_mapping: Record<string, string> } | null;
        return (
          <div key={s.id} className="card">
            <div className="spread small">
              <span>{conn?.name}・{fmtDateTime(s.submitted_at ?? s.received_at)}</span>
              <span><StatusBadge status={s.status} /> {s.error ?? MATCH_REASON_LABEL[s.match_reason ?? ""]}</span>
            </div>
            <table className="small" style={{ margin: "8px 0" }}><tbody>
              {Object.entries(s.raw as Record<string, string>).filter(([, v]) => v).slice(0, 12).map(([k, v]) => (
                <tr key={k}>
                  <th style={{ width: "30%" }}>{k}{conn?.field_mapping?.[k] && !conn.field_mapping[k].startsWith("attr:") && <span className="muted">（{FIELD_LABEL[conn.field_mapping[k]] ?? conn.field_mapping[k]}）</span>}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody></table>
            <form action={resolve} className="stack">
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="subId" value={s.id} />
              {(s.candidate_person_ids as string[]).map((pid) => {
                const c = byId.get(pid);
                if (!c) return null;
                return (
                  <label key={pid} className="row" style={{ color: "var(--text)" }}>
                    <input type="radio" name="decision" value={`link:${pid}`} required />
                    既存の <Link href={`/orgs/${orgId}/people/${pid}`} target="_blank">{c.full_name}</Link>
                    <span className="small muted">（{c.region ?? "地域未登録"}・参加{c.attendance_count}回・{c.person_contacts.map((x) => x.value).join(" / ")}）</span>
                    に紐づける
                  </label>
                );
              })}
              {s.status === "needs_review" && (
                <label className="row" style={{ color: "var(--text)" }}><input type="radio" name="decision" value="create" required />別人として新しく登録する</label>
              )}
              {s.status === "error" && (
                <label className="row" style={{ color: "var(--text)" }}><input type="radio" name="decision" value="retry" required />（項目対応を直した後に）再処理する</label>
              )}
              <label className="row" style={{ color: "var(--text)" }}><input type="radio" name="decision" value="ignore" required />取り込まない</label>
              <button className="btn-small">決定</button>
            </form>
          </div>
        );
      })}
    </>
  );
}
