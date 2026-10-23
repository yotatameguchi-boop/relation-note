import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getFeatures, requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toMessage } from "@/lib/errors";
import { fmtBytes, nowMs } from "@/lib/format";
import { USAGE_LABEL, type Usage } from "@/lib/usage";
import { Flash, Meter } from "@/components/ui";

async function save(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error, count } = await supabase.from("organizations").update({
    name: String(fd.get("name") ?? "").trim(),
    relation_window_days: Number(fd.get("relation_window_days")),
    repeat_threshold: Number(fd.get("repeat_threshold")),
    photo_retention_days: Number(fd.get("photo_retention_days")),
    email_sender_info: String(fd.get("email_sender_info") ?? "").trim() || null,
  }, { count: "exact" }).eq("id", orgId);
  if (error || !count) redirect(`/orgs/${orgId}/settings?error=${encodeURIComponent(toMessage(error, "保存できませんでした（オーナーのみ変更できます）。"))}`);
  revalidatePath(`/orgs/${orgId}`, "layout");
  redirect(`/orgs/${orgId}/settings?ok=${encodeURIComponent("保存しました。")}`);
}

async function destroy(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const confirm = String(fd.get("confirm") ?? "");
  const supabase = await createClient();
  // オーナー確認と名前確認を先に（実際の削除はRPCが再確認する）
  const { data: isOwner } = await supabase.rpc("has_role", { org: orgId, min_role: "owner" });
  const { data: org } = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
  if (!isOwner || org?.name !== confirm) redirect(`/orgs/${orgId}/settings?error=${encodeURIComponent(isOwner ? "確認用の組織名が一致しません。" : "この操作を行う権限がありません。")}`);
  // 写真・出力ファイル（組織IDフォルダ配下）を削除してから組織を削除
  const admin = createAdminClient();
  for (const bucket of ["photos", "exports"]) {
    for (;;) {
      const { data: files } = await admin.storage.from(bucket).list(orgId, { limit: 1000 });
      if (!files?.length) break;
      await admin.storage.from(bucket).remove(files.map((f) => `${orgId}/${f.name}`));
      if (files.length < 1000) break;
    }
  }
  const { error } = await supabase.rpc("delete_organization", { org: orgId, confirm_name: confirm });
  if (error) redirect(`/orgs/${orgId}/settings?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs?ok=deleted`);
}

export default async function Settings({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId);
  const supabase = await createClient();
  const [{ data: org }, { data: usage }] = await Promise.all([
    supabase.from("organizations").select("*, plans(*)").eq("id", orgId).single(),
    supabase.rpc("org_usage", { org: orgId }),
  ]);
  const u = usage as Usage;
  const features = await getFeatures(orgId);
  const { data: apiCalls } = await supabase.from("analysis_usage_records").select("provider, provider_calls, billable_units, created_at")
    .eq("organization_id", orgId).gte("created_at", new Date(nowMs() - 31 * 86400e3).toISOString());
  const calls = (apiCalls ?? []).reduce((s, r) => s + r.provider_calls, 0);
  const plan = org.plans as { name: string; monthly_price_jpy: number | null; yearly_price_jpy: number | null };
  const owner = m.role === "owner";
  return (
    <>
      <h1>組織設定・利用量</h1>
      <Flash sp={sp} />
      <div className="card">
        <div className="spread"><h2 style={{ margin: 0 }}>{plan.name}</h2>
          <span className="small muted">
            {plan.monthly_price_jpy ? `月払い ${plan.monthly_price_jpy.toLocaleString()}円／年払い ${plan.yearly_price_jpy?.toLocaleString()}円（税別）` : "個別契約"}
            {owner && <>・<a href={`/orgs/${orgId}/billing`}>料金・契約</a></>}
          </span>
        </div>
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          {(Object.keys(USAGE_LABEL) as (keyof typeof USAGE_LABEL)[]).map((k) => (
            <Meter key={k} label={USAGE_LABEL[k]} used={u[k].used} limit={u[k].limit} format={k === "storage_bytes" ? fmtBytes : undefined} />
          ))}
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          上限の8割で画面上でお知らせします。上限に達すると新規の登録・解析を停止し、既存データの閲覧・出力は引き続き行えます。
          追加利用はプラン変更のお申し込みで対応し、無断で追加請求することはありません。写真解析の枠は {u.period} の利用分です。
        </p>
      </div>

      {m.role !== "viewer" && (m.role === "owner" || m.role === "admin") && (
        <p><a className="btn btn-secondary" href={`/orgs/${orgId}/settings/fields`}>人物・企業の項目を設定する</a></p>
      )}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>機能の有効化状況</h2>
        <table className="small"><tbody>
          <tr><th>組織間の連携・活動者データ共有</th><td>{features.partner_sharing ? <span className="badge badge-ok">有効</span> : <span className="badge">無効</span>}</td></tr>
          <tr><th>写真解析 v2（向きの補正・重複の整理・修正UI）</th><td>{features.photo_pipeline_v2 ? <span className="badge badge-ok">有効</span> : <span className="badge">無効</span>}</td></tr>
          <tr><th>写真の領域分割解析（評価中）</th><td>{features.photo_tiling ? <span className="badge badge-warn">有効（評価中）</span> : <span className="badge">無効</span>}</td></tr>
          {apiCalls && <tr><th>直近31日の外部API呼び出し（人物検出）</th><td>{calls}回（利用枠の「写真解析」枚数とは別に記録）</td></tr>}
        </tbody></table>
        <p className="small muted">機能の有効化は運営側で行います。実データで使う前に検証用の組織で確認します。</p>
      </div>

      <form action={save} className="card">
        <input type="hidden" name="orgId" value={orgId} />
        <h2 style={{ marginTop: 0 }}>組織設定</h2>
        {!owner && <p className="notice notice-info small">変更はオーナーのみ行えます。</p>}
        <fieldset disabled={!owner} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field">組織名<input name="name" defaultValue={org.name} required /></label>
          <h3>「関係人口」の定義</h3>
          <div className="row">
            <label className="inline-field">対象期間（日）：この期間に参加・応募した人物を関係人口とする<input type="number" name="relation_window_days" min={1} max={3650} defaultValue={org.relation_window_days} /></label>
            <label className="inline-field">継続参加とみなす参加回数<input type="number" name="repeat_threshold" min={2} max={100} defaultValue={org.repeat_threshold} /></label>
          </div>
          <h3>写真</h3>
          <label className="inline-field">写真の保存期間（日）：過ぎると画像を削除（人数の記録は残す）<input type="number" name="photo_retention_days" min={1} max={3650} defaultValue={org.photo_retention_days} /></label>
          <h3>メール配信</h3>
          <label className="field">送信者情報（住所または連絡先。一斉配信メールの末尾に表示します）
            <textarea name="email_sender_info" defaultValue={org.email_sender_info ?? ""} maxLength={500} style={{ minHeight: 60 }} placeholder="例：〒000-0000 東京都○○区… ／ お問い合わせ：info@example.org" />
          </label>
          <div style={{ marginTop: 12 }}><button>保存</button></div>
        </fieldset>
      </form>

      {owner && (
        <form action={destroy} className="card" style={{ borderColor: "var(--danger)" }}>
          <input type="hidden" name="orgId" value={orgId} />
          <h2 style={{ marginTop: 0, color: "var(--danger)" }}>組織の削除</h2>
          <p className="small">人物・回答・イベント・写真を含むすべてのデータを削除します。元に戻せません。必要なデータは先に出力してください。</p>
          <div className="row">
            <input name="confirm" placeholder={`確認のため「${org.name}」と入力`} required style={{ flex: 1 }} />
            <button className="btn-danger">削除する</button>
          </div>
        </form>
      )}
    </>
  );
}
