import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getUser, requireMembership, can, hasPerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { CAMPAIGN_STATUS, RECIPIENT_STATUS } from "@/lib/crm";
import { renderEmail, PLACEHOLDERS } from "@shared/email-render";
import { env } from "@/lib/env";
import { Flash } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";

const url = (orgId: string, id: string) => `/orgs/${orgId}/emails/${id}`;

async function save(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId")); const id = String(fd.get("id"));
  const supabase = await createClient();
  const ids = (k: string) => fd.getAll(k).map(String).filter((x) => /^[0-9a-f-]{36}$/.test(x));
  const { error } = await supabase.from("email_campaigns").update({
    name: String(fd.get("name") ?? "").trim(),
    subject: String(fd.get("subject") ?? "").trim(),
    body_text: String(fd.get("body_text") ?? ""),
    from_name: String(fd.get("from_name") ?? "").trim() || null,
    reply_to: String(fd.get("reply_to") ?? "").trim() || null,
    audience: { tag_ids: ids("tag_ids"), match: fd.get("match") === "all" ? "all" : "any", exclude_tag_ids: ids("exclude_tag_ids") },
  }).eq("organization_id", orgId).eq("id", id);
  if (error) redirect(`${url(orgId, id)}?error=${encodeURIComponent(toMessage(error, "保存できませんでした。返信先のメールアドレスの形式も確認してください。"))}`);
  revalidatePath(url(orgId, id));
  redirect(`${url(orgId, id)}?ok=${encodeURIComponent("保存しました。")}`);
}

async function testSend(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId")); const id = String(fd.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("send_test_email", { campaign: id });
  if (error) redirect(`${url(orgId, id)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId, id)}?ok=${encodeURIComponent("テスト送信を受け付けました。1〜2分であなたのメールアドレスに届きます。")}`);
}

async function send(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId")); const id = String(fd.get("id"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("send_campaign", { campaign: id, consent: fd.get("consent") === "on" });
  if (error) redirect(`${url(orgId, id)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId, id)}?ok=${encodeURIComponent(`${data}人への送信を開始しました。`)}`);
}

async function remove(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId")); const id = String(fd.get("id"));
  const supabase = await createClient();
  await supabase.from("email_campaigns").delete().eq("organization_id", orgId).eq("id", id);
  redirect(`/orgs/${orgId}/emails?ok=${encodeURIComponent("下書きを削除しました。")}`);
}

type Preview = { recipients: number; no_email: number; opted_out: number; duplicate_email: number;
  sample: { name: string; display_name: string | null; email: string }[]; usage: { used: number; limit: number } };

export default async function Campaign({ params, searchParams }: {
  params: Promise<{ orgId: string; campaignId: string }>; searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { orgId, campaignId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const me = await getUser();
  const supabase = await createClient();
  const { data: c } = await supabase.from("email_campaigns").select("*").eq("organization_id", orgId).eq("id", campaignId).maybeSingle();
  if (!c) notFound();
  const draft = c.status === "draft";
  const editor = can(m, "editor") && draft;
  const canSend = can(m, "admin") && hasPerm(m, "bulk_email");
  const [{ data: tags }, { data: org }, preview, stats, { data: recipients }] = await Promise.all([
    supabase.from("tags").select("id, name, color").eq("organization_id", orgId).order("name"),
    supabase.from("organizations").select("name, email_sender_info").eq("id", orgId).single(),
    draft ? supabase.rpc("preview_campaign", { campaign: campaignId }) : Promise.resolve({ data: null }),
    draft ? Promise.resolve({ data: null }) : supabase.rpc("campaign_stats", { campaign: campaignId }),
    draft ? Promise.resolve({ data: null }) : supabase.from("email_recipients").select("id, email, name, status, error, sent_at, opened_at, open_count, person_id")
      .eq("organization_id", orgId).eq("campaign_id", campaignId).order("status").order("email").limit(500),
  ]);
  const aud = (c.audience ?? {}) as { tag_ids?: string[]; match?: string; exclude_tag_ids?: string[] };
  const pv = preview.data as Preview | null;
  const st = stats.data as { total: number; queued: number; sent: number; failed: number; opened: number } | null;
  const sample = pv?.sample[0];
  const rendered = renderEmail({
    subject: c.subject || "（件名未入力）", body: c.body_text || "", name: sample?.display_name ?? sample?.name ?? "山田 太郎",
    fullName: sample?.name ?? "山田 太郎", orgName: org?.name ?? "", senderInfo: org?.email_sender_info || "（組織設定で送信者情報を入力してください）",
    unsubscribeUrl: "https://relationnote.vercel.app/u/（宛先ごとのリンク）", openPixelUrl: null,
  });
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="id" value={campaignId} /></>);
  const overQuota = pv ? pv.usage.used + pv.recipients > pv.usage.limit : false;

  return (
    <>
      {c.status === "sending" && <AutoRefresh seconds={5} />}
      <div className="spread"><h1>{c.name}</h1><Link href={`/orgs/${orgId}/emails`}>← メール配信</Link></div>
      <p className="small"><span className={`badge ${CAMPAIGN_STATUS[c.status]?.[1] ?? ""}`}>{CAMPAIGN_STATUS[c.status]?.[0]}</span>
        {c.send_requested_at && <span className="muted">・送信開始 {fmtDateTime(c.send_requested_at)}</span>}
        {c.completed_at && <span className="muted">・完了 {fmtDateTime(c.completed_at)}</span>}</p>
      <Flash sp={sp} />
      {c.status === "failed" && (
        <div className="notice notice-danger">送信を止めました：{c.last_error}<br />
          <span className="small">メール送信の設定を確認したうえで、管理者が「処理状況」から再実行できます。送信済みの宛先には再送しません。</span></div>
      )}

      {st && (
        <div className="grid grid-4" style={{ marginBottom: 12 }}>
          <div className="stat"><div className="label">宛先</div><div className="value">{st.total}</div></div>
          <div className="stat"><div className="label">送信済み</div><div className="value">{st.sent}</div><div className="note">送信待ち {st.queued}</div></div>
          <div className="stat"><div className="label">失敗</div><div className="value">{st.failed}</div></div>
          <div className="stat"><div className="label">開封（推定）</div><div className="value">{st.opened}</div>
            <div className="note">{st.sent ? `${Math.round((st.opened / st.sent) * 100)}%` : "—"}。画像を表示しないメールソフトでは数えられず、自動で画像を読み込むサービスでは多めに出ます</div></div>
        </div>
      )}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <form action={save} className="card">
          {hidden}
          <fieldset disabled={!editor} style={{ border: 0, padding: 0, margin: 0 }}>
            <h2 style={{ marginTop: 0 }}>内容</h2>
            <label className="field">配信名（社内用）<input name="name" defaultValue={c.name} required /></label>
            <label className="field">件名<input name="subject" defaultValue={c.subject} maxLength={200} /></label>
            <label className="field">本文<textarea name="body_text" defaultValue={c.body_text} style={{ minHeight: 220 }} maxLength={20000} /></label>
            <p className="small muted">差し込み：{PLACEHOLDERS.join("　")}。末尾には送信者情報と配信停止リンクが自動で付きます。</p>
            <div className="grid grid-2">
              <label className="field">差出人名<input name="from_name" defaultValue={c.from_name ?? ""} placeholder={org?.name} /></label>
              <label className="field">返信先メールアドレス<input name="reply_to" type="email" defaultValue={c.reply_to ?? ""} /></label>
            </div>
            <h2>宛先</h2>
            <fieldset className="field" style={{ border: 0, padding: 0 }}>
              <legend className="small muted">送るタグ</legend>
              <div className="row">{(tags ?? []).map((t) => (
                <label key={t.id} className="tag" style={{ margin: 0 }}><input type="checkbox" name="tag_ids" value={t.id} defaultChecked={aud.tag_ids?.includes(t.id)} />
                  <span className="dot" style={{ background: t.color }} />{t.name}</label>
              ))}</div>
            </fieldset>
            <label className="field">条件
              <select name="match" defaultValue={aud.match ?? "any"}><option value="any">どれかのタグが付いている人</option><option value="all">すべてのタグが付いている人</option></select>
            </label>
            <fieldset className="field" style={{ border: 0, padding: 0 }}>
              <legend className="small muted">除外するタグ</legend>
              <div className="row">{(tags ?? []).map((t) => (
                <label key={t.id} className="tag" style={{ margin: 0 }}><input type="checkbox" name="exclude_tag_ids" value={t.id} defaultChecked={aud.exclude_tag_ids?.includes(t.id)} />{t.name}</label>
              ))}</div>
            </fieldset>
            {editor && <button>保存して宛先を確認</button>}
          </fieldset>
        </form>

        <div>
          {pv && (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>宛先の確認</h2>
              <p><strong style={{ fontSize: 22 }}>{pv.recipients}</strong> 人に送ります</p>
              <p className="small muted">除外：メールアドレスなし {pv.no_email}人・配信停止 {pv.opted_out}人・同じアドレスの重複 {pv.duplicate_email}人</p>
              <p className="small">今月の送信数 {pv.usage.used} / {pv.usage.limit}通{overQuota && <span className="badge badge-danger" style={{ marginLeft: 6 }}>枠を超えます</span>}</p>
              {pv.sample.length > 0 && <p className="small muted">例：{pv.sample.map((s) => `${s.name}（${s.email}）`).join("、")}</p>}
            </div>
          )}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>プレビュー</h2>
            <p className="small"><strong>件名：</strong>{rendered.subject}</p>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13 }}>{rendered.text}</pre>
            {sample && <p className="small muted">「{sample.name}」さんあての差し込み例です。</p>}
          </div>
          {draft && (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>送信</h2>
              {!env.mailConfigured && (
                <div className="notice notice-warn small">メール送信の設定（送信用のメールアカウント）がまだ済んでいないため、送信できません。運営者による設定後に送れるようになります。</div>
              )}
              {can(m, "editor") && (
                <form action={testSend} style={{ marginBottom: 12 }}>{hidden}
                  <button className="btn-secondary" disabled={!env.mailConfigured}>自分あてにテスト送信（{me?.email}）</button></form>
              )}
              {!org?.email_sender_info && (
                <div className="notice notice-warn small">送信には、組織設定の「送信者情報（住所または連絡先）」が必要です。<Link href={`/orgs/${orgId}/settings`}>組織設定へ</Link></div>
              )}
              {canSend ? (
                <form action={send}>
                  {hidden}
                  <label className="row small" style={{ color: "var(--text)", alignItems: "flex-start" }}>
                    <input type="checkbox" name="consent" required style={{ marginTop: 4 }} />
                    宛先の人がこの組織からのメールの受け取りに同意していることを確認しました（広告・宣伝を含むメールは、事前の同意が必要です）。
                  </label>
                  <button style={{ marginTop: 8 }} disabled={!pv?.recipients || overQuota || !env.mailConfigured}>{pv?.recipients ?? 0}人に送信する</button>
                  <p className="small muted" style={{ marginTop: 6 }}>送信を始めると取り消せません。送った記録は各人物のタイムラインに残ります。</p>
                </form>
              ) : (
                <p className="small muted">一斉送信は、管理者のうち「一斉メール配信」の権限を持つスタッフが行えます。</p>
              )}
              {can(m, "editor") && <form action={remove} style={{ marginTop: 12 }}>{hidden}<button className="link-btn small">この下書きを削除</button></form>}
            </div>
          )}
        </div>
      </div>

      {recipients && (
        <>
          <h2>宛先ごとの結果</h2>
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>宛先</th><th>状態</th><th>送信</th><th>開封（推定）</th></tr></thead>
              <tbody>
                {recipients.map((r) => (
                  <tr key={r.id}>
                    <td>{r.person_id ? <Link href={`/orgs/${orgId}/people/${r.person_id}`}>{r.name}</Link> : r.name}<div className="muted">{r.email}</div></td>
                    <td><span className={`badge ${RECIPIENT_STATUS[r.status]?.[1] ?? ""}`}>{RECIPIENT_STATUS[r.status]?.[0] ?? r.status}</span>
                      {r.error && <div className="muted">{r.error}</div>}</td>
                    <td>{fmtDateTime(r.sent_at)}</td>
                    <td>{r.opened_at ? `${fmtDateTime(r.opened_at)}（${r.open_count}回）` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
