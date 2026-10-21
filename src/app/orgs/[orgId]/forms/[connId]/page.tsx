import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership, can } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { TARGET_FIELDS } from "@/lib/csv";
import { Flash } from "@/components/ui";
import { CsvImporter } from "@/components/CsvImporter";
import { deleteConnection, rotateSecret, updateConnection } from "../actions";

export default async function ConnectionPage({ params, searchParams }: {
  params: Promise<{ orgId: string; connId: string }>; searchParams: Promise<{ error?: string; ok?: string; secret?: string }>;
}) {
  const { orgId, connId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId, "editor");
  const supabase = await createClient();
  const { data: c } = await supabase.from("form_connections").select("*").eq("organization_id", orgId).eq("id", connId).maybeSingle();
  if (!c) notFound();
  const [{ data: events }, { data: tags }] = await Promise.all([
    supabase.from("events").select("id, title").eq("organization_id", orgId).order("starts_at", { ascending: false }).limit(100),
    supabase.from("tags").select("id, name").eq("organization_id", orgId).order("name"),
  ]);
  const mapping = (c.field_mapping ?? {}) as Record<string, string>;
  const admin = can(m, "admin");
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="connId" value={connId} /></>);
  const targetOptions = (
    <>
      {TARGET_FIELDS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
    </>
  );

  return (
    <>
      <div className="spread"><h1>{c.name}</h1><Link href={`/orgs/${orgId}/forms`}>← 一覧</Link></div>
      <Flash sp={sp} />
      {sp.secret && (
        <div className="notice notice-ok">
          新しい送信用の秘密です。この画面を離れると二度と表示されません。外部フォーム側に設定してください：<br /><code>{sp.secret}</code>
        </div>
      )}

      {c.kind === "csv" && <CsvImporter orgId={orgId} connId={connId} savedMapping={mapping} canEditMapping={admin} />}

      {c.kind === "webhook" && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>外部フォームからの自動連携</h2>
          <p className="small">次のURLへ、回答ごとに JSON を POST してください。保存先の組織は接続設定から決まります。</p>
          <pre>{`POST ${env.appUrl}/api/forms/${connId}/webhook
Authorization: Bearer <送信用の秘密>
Content-Type: application/json

{ "response_id": "回答ID（二重登録防止）", "submitted_at": "2026-10-01T10:00:00+09:00",
  "answers": { "氏名": "山田 太郎", "メールアドレス": "taro@example.org" } }`}</pre>
          <p className="small muted">Googleフォームの場合は Apps Script の送信時トリガーから上記の形式で送れます。対応サービスは実際の利用状況に合わせて順次追加します。</p>
          {admin && (
            <form action={rotateSecret}>{hidden}<button className="btn-secondary">送信用の秘密を発行（再発行すると古い秘密は無効）</button></form>
          )}
        </div>
      )}

      <form action={updateConnection} className="card">
        {hidden}
        <h2 style={{ marginTop: 0 }}>設定と項目対応</h2>
        {!admin && <p className="notice notice-info small">設定の変更は管理者のみ行えます。</p>}
        <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="inline-field" style={{ flex: 1 }}>名前<input name="name" defaultValue={c.name} required /></label>
            <div className="inline-field" style={{ flex: 1 }}>
              <label>申込先イベント（回答を「申込」として登録）</label>
              <select name="event_id" defaultValue={c.event_id ?? ""} aria-label="申込先イベント">
                <option value="">なし</option>
                {(events ?? []).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
              </select>
            </div>
            <label className="row" style={{ margin: 0 }}><input type="checkbox" name="is_active" defaultChecked={c.is_active} />有効</label>
          </div>
          {tags && tags.length > 0 && (
            <div className="field" style={{ marginTop: 10 }}>
              <label>この回答者に自動で付けるタグ</label>
              <div className="row">
                {tags.map((t) => (
                  <label key={t.id} className="tag" style={{ margin: 0 }}>
                    <input type="checkbox" name="default_tag_ids" value={t.id} defaultChecked={(c.default_tag_ids ?? []).includes(t.id)} />{t.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <h3>フォーム項目 → 共通項目</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>フォームの項目名</th><th>取り込み先</th></tr></thead>
              <tbody>
                {Object.keys(mapping).length === 0 && <tr><td colSpan={2} className="muted">未設定です（CSV取り込み時に自動で推測して保存できます）。</td></tr>}
                {Object.entries(mapping).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>
                      <select name={`map:${k}`} defaultValue={v}>
                        {targetOptions}
                        <option value={`attr:${k}`}>その他の項目として保存</option>
                        {v.startsWith("attr:") && v !== `attr:${k}` && <option value={v}>{v}</option>}
                      </select>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td><input name="new_column" placeholder="項目名を追加" /></td>
                  <td><select name="new_target" defaultValue="full_name">{targetOptions}</select></td>
                </tr>
              </tbody>
            </table>
          </div>
          <button style={{ marginTop: 10 }}>保存</button>
        </fieldset>
      </form>

      {admin && (
        <form action={deleteConnection} className="card">
          {hidden}
          <p className="small muted">フォームを削除すると、このフォームの回答原文と取り込み履歴も削除されます（登録済みの人物は残ります）。</p>
          <button className="btn-danger btn-small">このフォームを削除</button>
        </form>
      )}
    </>
  );
}
