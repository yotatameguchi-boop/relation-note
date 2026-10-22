import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDateTime, todayJst } from "@/lib/format";
import { Flash } from "@/components/ui";
import { CAMPAIGN_STATUS } from "@/lib/crm";

async function createCampaign(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("email_campaigns").insert({
    organization_id: orgId, name: String(fd.get("name") ?? "").trim(), created_by: u.user?.id,
    body_text: "{{氏名}} 様\n\nいつもありがとうございます。{{組織名}}です。\n\n（ここに本文）\n",
  }).select("id").single();
  if (error) redirect(`/orgs/${orgId}/emails?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${orgId}/emails/${data.id}`);
}

async function addOptout(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_email_optout", { org: orgId, addr: String(fd.get("email") ?? "") });
  if (error) redirect(`/orgs/${orgId}/emails?error=${encodeURIComponent(toMessage(error, "メールアドレスの形式が正しくありません。"))}`);
  revalidatePath(`/orgs/${orgId}/emails`);
  redirect(`/orgs/${orgId}/emails?ok=${encodeURIComponent("配信停止に登録しました。")}`);
}

async function removeOptout(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error, count } = await supabase.from("email_optouts").delete({ count: "exact" }).eq("organization_id", orgId).eq("email", String(fd.get("email")));
  if (error || !count) redirect(`/orgs/${orgId}/emails?error=${encodeURIComponent("解除できませんでした（管理者のみ）。")}`);
  redirect(`/orgs/${orgId}/emails?ok=${encodeURIComponent("配信停止を解除しました。")}`);
}

export default async function Emails({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const [{ data: campaigns }, { data: optouts }, { data: usage }] = await Promise.all([
    supabase.from("email_campaigns").select("id, name, subject, status, recipient_count, send_requested_at, created_at").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(100),
    supabase.from("email_optouts").select("email, source, created_at").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(200),
    supabase.from("usage_records").select("quantity").eq("organization_id", orgId).eq("metric", "email").eq("status", "committed")
      .eq("period", todayJst().slice(0, 7)),
  ]);
  const used = (usage ?? []).reduce((s, r) => s + Number(r.quantity), 0);
  const hidden = <input type="hidden" name="orgId" value={orgId} />;
  return (
    <>
      <h1>メール配信</h1>
      <Flash sp={sp} />
      <p className="small muted">タグで宛先を絞って、案内メールを一斉に送ります。今月の送信数：{used.toLocaleString()}通</p>
      {can(m, "editor") && (
        <form action={createCampaign} className="card row">
          {hidden}
          <label className="inline-field" style={{ flex: 1 }}>配信名（社内用）<input name="name" required maxLength={120} placeholder="例：11月の清掃活動のご案内" /></label>
          <button>新しい配信を作成</button>
        </form>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>配信名</th><th>件名</th><th>状態</th><th className="num">宛先</th><th>送信</th></tr></thead>
          <tbody>
            {(campaigns ?? []).length === 0 && <tr><td colSpan={5} className="muted">配信はまだありません。</td></tr>}
            {(campaigns ?? []).map((c) => (
              <tr key={c.id}>
                <td><Link href={`/orgs/${orgId}/emails/${c.id}`}>{c.name}</Link></td>
                <td className="small">{c.subject || "（未入力）"}</td>
                <td><span className={`badge ${CAMPAIGN_STATUS[c.status]?.[1] ?? ""}`}>{CAMPAIGN_STATUS[c.status]?.[0] ?? c.status}</span></td>
                <td className="num">{c.status === "draft" ? "—" : c.recipient_count}</td>
                <td className="small">{fmtDateTime(c.send_requested_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>配信停止</h2>
      <p className="small muted">メール内のリンクから停止した人と、手動で登録した人には送りません。</p>
      {can(m, "editor") && (
        <form action={addOptout} className="row" style={{ marginBottom: 8 }}>
          {hidden}
          <input name="email" type="email" required placeholder="メールアドレス" style={{ maxWidth: 320 }} aria-label="配信停止にするメールアドレス" />
          <button className="btn-secondary btn-small">配信停止に登録</button>
        </form>
      )}
      <table className="small"><tbody>
        {(optouts ?? []).length === 0 && <tr><td className="muted">登録はありません。</td></tr>}
        {(optouts ?? []).map((o) => (
          <tr key={o.email}>
            <td>{o.email}</td><td>{o.source === "link" ? "本人がリンクから停止" : "手動で登録"}</td><td>{fmtDateTime(o.created_at)}</td>
            <td className="right">{can(m, "admin") && <form action={removeOptout}>{hidden}<input type="hidden" name="email" value={o.email} /><button className="link-btn small">解除</button></form>}</td>
          </tr>
        ))}
      </tbody></table>
    </>
  );
}
