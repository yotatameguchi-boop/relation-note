import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership, hasPerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDate } from "@/lib/format";
import { Flash } from "@/components/ui";

const REASON: Record<string, string> = { email: "メール一致", phone: "電話一致", name: "氏名一致" };

async function merge(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const keep = String(fd.get("keep"));
  const a = String(fd.get("a"));
  const b = String(fd.get("b"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("merge_people", { org: orgId, keep_id: keep, merge_id: keep === a ? b : a });
  if (error) redirect(`/orgs/${orgId}/people/duplicates?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(`/orgs/${orgId}/people`);
  redirect(`/orgs/${orgId}/people/duplicates?ok=${encodeURIComponent("統合しました。統合前の情報は統合履歴に残っています。")}`);
}

async function distinct(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_people_distinct", { org: orgId, a: String(fd.get("a")), b: String(fd.get("b")) });
  if (error) redirect(`/orgs/${orgId}/people/duplicates?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/people/duplicates?ok=${encodeURIComponent("別人として記録しました。")}`);
}

type P = { id: string; full_name: string; full_name_kana: string | null; region: string | null; attendance_count: number; created_at: string; person_contacts: { kind: string; value: string }[] };

export default async function Duplicates({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId, "editor");
  const supabase = await createClient();
  const { data: pairs } = await supabase.rpc("duplicate_candidates", { org: orgId, max_rows: 100 });
  const ids = [...new Set((pairs ?? []).flatMap((p: { person_a: string; person_b: string }) => [p.person_a, p.person_b]))];
  const { data: people } = ids.length
    ? await supabase.from("people").select("id, full_name, full_name_kana, region, attendance_count, created_at, person_contacts(kind, value)").eq("organization_id", orgId).in("id", ids)
    : { data: [] as P[] };
  const byId = new Map((people as P[]).map((p) => [p.id, p]));
  const canMerge = hasPerm(m, "merge_people");

  const Card = ({ p }: { p: P }) => (
    <div style={{ flex: 1, minWidth: 220 }}>
      <Link href={`/orgs/${orgId}/people/${p.id}`}><strong>{p.full_name}</strong></Link>
      <div className="small muted">{p.full_name_kana}</div>
      <div className="small">{p.region ?? "地域未登録"}・参加{p.attendance_count}回・登録{fmtDate(p.created_at)}</div>
      <div className="small">{p.person_contacts.map((c) => c.value).join(" / ") || "連絡先なし"}</div>
    </div>
  );

  return (
    <>
      <h1>重複候補</h1>
      <p className="muted small">
        同じメール・電話・氏名を持つ人物の組です。メールや電話は家族で共有されることもあるため、自動では統合しません。
        内容を確認し、同一人物なら統合、別人なら「別人」として記録してください。
      </p>
      <Flash sp={sp} />
      {!canMerge && <div className="notice notice-info">人物統合には「人物統合」の権限が必要です。</div>}
      {(pairs ?? []).length === 0 && <div className="card muted">重複候補はありません。</div>}
      {(pairs ?? []).map((pair: { person_a: string; person_b: string; reasons: string[] }) => {
        const a = byId.get(pair.person_a);
        const b = byId.get(pair.person_b);
        if (!a || !b) return null;
        return (
          <div key={`${pair.person_a}-${pair.person_b}`} className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              {pair.reasons.map((r) => <span key={r} className="badge badge-warn">{REASON[r] ?? r}</span>)}
            </div>
            <div className="row" style={{ alignItems: "flex-start" }}><Card p={a} /><Card p={b} /></div>
            <div className="row" style={{ marginTop: 10 }}>
              {canMerge && (
                <form action={merge} className="row">
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="a" value={a.id} />
                  <input type="hidden" name="b" value={b.id} />
                  <select name="keep" style={{ width: 240 }}>
                    <option value={a.id}>「{a.full_name}」（左）に統合</option>
                    <option value={b.id}>「{b.full_name}」（右）に統合</option>
                  </select>
                  <button className="btn-small">統合</button>
                </form>
              )}
              <form action={distinct}>
                <input type="hidden" name="orgId" value={orgId} />
                <input type="hidden" name="a" value={a.id} />
                <input type="hidden" name="b" value={b.id} />
                <button className="btn-secondary btn-small">別人として記録</button>
              </form>
            </div>
          </div>
        );
      })}
    </>
  );
}
