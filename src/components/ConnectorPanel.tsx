import { env } from "@/lib/env";
import { fmtDateTime } from "@/lib/format";
import { issueSigningSecret, reprocessConnection, requestConnectorSync, saveConnectorSource, setConnectorSync } from "@/app/orgs/[orgId]/forms/actions";

export const CONNECTOR_LABEL: Record<string, string> = {
  csv: "CSV取り込み",
  webhook: "汎用の自動連携（Webhook）",
  google_forms: "Google フォーム（自動取得）",
  google_sheets: "Google スプレッドシート（自動取得）",
  typeform: "Typeform（自動受信）",
  tally: "Tally（自動受信）",
};

const STATUS: Record<string, [string, string]> = {
  ok: ["取り込み中", "badge-ok"],
  needs_mapping: ["項目の対応を確認してください", "badge-warn"],
  error: ["エラー（自動で再試行）", "badge-danger"],
  reauth_required: ["連携し直してください", "badge-danger"],
};

type Conn = {
  id: string; kind: string; provider_config: { form_id?: string; spreadsheet_id?: string; sheet?: string | null; title?: string; columns?: string[] };
  sync_enabled: boolean; sync_interval_minutes: number; last_synced_at: string | null; last_sync_status: string | null;
  last_sync_error: string | null; external_account: string | null; field_mapping: Record<string, string>;
};
type Status = { connected: boolean; held: number; total: number; job: { status: string; mode: string; last_error: string | null } | null };

export function ConnectorPanel({ orgId, c, status, admin, googleReady }: { orgId: string; c: Conn; status: Status; admin: boolean; googleReady: boolean }) {
  const hidden = (<><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="connId" value={c.id} /></>);
  const hasName = Object.values(c.field_mapping ?? {}).includes("full_name");
  const st = c.last_sync_status ? STATUS[c.last_sync_status] : null;
  const busy = status.job && ["queued", "running"].includes(status.job.status);
  const isGoogle = c.kind === "google_forms" || c.kind === "google_sheets";
  const webhookUrl = `${env.appUrl}/api/forms/${c.id}/webhook`;

  return (
    <div className="card">
      <div className="spread">
        <h2 style={{ marginTop: 0 }}>{CONNECTOR_LABEL[c.kind]}</h2>
        <span className="row small">
          {st && <span className={`badge ${st[1]}`}>{st[0]}</span>}
          {busy && <span className="badge badge-warn">{status.job!.mode === "discover" ? "質問を読み込み中" : "取得中"}</span>}
        </span>
      </div>
      {c.last_sync_error && <div className="notice notice-danger small">{c.last_sync_error}</div>}

      {isGoogle && (
        <>
          {!googleReady && (
            <div className="notice notice-warn small">Google 連携の設定（OAuth クライアント）がまだありません。運営者による設定後に使えるようになります。</div>
          )}
          <ol className="small" style={{ paddingLeft: 18 }}>
            <li style={{ marginBottom: 10 }}>
              <strong>Google アカウントと連携</strong>
              <span className="muted">（読み取り専用の権限だけを求めます。フォーム・シートを編集できるアカウントで連携してください）</span>
              <div className="row" style={{ marginTop: 6 }}>
                {status.connected
                  ? <span className="badge badge-ok">連携済み{c.external_account ? `：${c.external_account}` : ""}</span>
                  : <span className="badge">未連携</span>}
                {admin && googleReady && (
                  <a className={status.connected ? "btn btn-secondary btn-small" : "btn btn-small"} href={`/api/connectors/google/start?conn=${c.id}`}>
                    {status.connected ? "連携し直す" : "Google と連携する"}
                  </a>
                )}
              </div>
            </li>
            <li style={{ marginBottom: 10 }}>
              <strong>{c.kind === "google_forms" ? "取り込むフォーム" : "取り込むシート"}</strong>
              {c.provider_config.title && <span className="muted">：{c.provider_config.title}</span>}
              {admin ? (
                <form action={saveConnectorSource} className="row" style={{ marginTop: 6 }}>
                  {hidden}
                  <input name="source" required style={{ flex: 2, minWidth: 220 }} aria-label="URL"
                    defaultValue={c.provider_config.form_id ? `https://docs.google.com/forms/d/${c.provider_config.form_id}/edit`
                      : c.provider_config.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${c.provider_config.spreadsheet_id}/edit` : ""}
                    placeholder={c.kind === "google_forms" ? "https://docs.google.com/forms/d/…/edit" : "https://docs.google.com/spreadsheets/d/…/edit"} />
                  {c.kind === "google_sheets" && <input name="sheet" defaultValue={c.provider_config.sheet ?? ""} placeholder="シート名（空欄なら最初のシート）" style={{ flex: 1, minWidth: 140 }} aria-label="シート名" />}
                  <button className="btn-small" disabled={!status.connected}>保存して読み込む</button>
                </form>
              ) : <div className="muted">{c.provider_config.form_id ?? c.provider_config.spreadsheet_id ?? "未設定"}</div>}
              {c.kind === "google_sheets" && <p className="muted" style={{ marginTop: 4 }}>1行目を見出しとして読みます。行IDがないので、内容が同じ行は二重に取り込みません（行を書き換えると新しい行として扱います）。</p>}
            </li>
            <li style={{ marginBottom: 10 }}>
              <strong>項目の対応を確認</strong>
              <span className="muted">（下の「設定と項目対応」。{c.provider_config.columns?.length ? `${c.provider_config.columns.length}項目を読み込み、対応を提案しています` : "フォーム・シートを設定すると自動で提案します"}）</span>
            </li>
            <li>
              <strong>自動取り込み</strong>
              {admin ? (
                <form action={setConnectorSync} className="row" style={{ marginTop: 6 }}>
                  {hidden}
                  <select name="interval" defaultValue={String(c.sync_interval_minutes)} aria-label="取得の間隔" style={{ width: 140 }}>
                    {[5, 15, 30, 60, 180, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m}分ごと` : m === 1440 ? "1日ごと" : `${m / 60}時間ごと`}</option>)}
                  </select>
                  {c.sync_enabled
                    ? <><input type="hidden" name="enable" value="0" /><button className="btn-secondary btn-small">止める（現在：取り込み中）</button></>
                    : <><input type="hidden" name="enable" value="1" /><button className="btn-small" disabled={!status.connected || !hasName}>この対応で自動取り込みを始める</button></>}
                </form>
              ) : <div className="muted">{c.sync_enabled ? `${c.sync_interval_minutes}分ごとに取り込み中` : "停止中"}</div>}
              {!hasName && <p className="muted" style={{ marginTop: 4 }}>「氏名」に対応する項目を設定すると始められます。</p>}
            </li>
          </ol>
          <div className="row small">
            <span className="muted">最終取得：{fmtDateTime(c.last_synced_at)}・取り込んだ回答 {status.total}件</span>
            {status.connected && !busy && (
              <form action={requestConnectorSync}>{hidden}<input type="hidden" name="mode" value="sync" /><button className="btn-secondary btn-small">今すぐ取得</button></form>
            )}
            {admin && status.connected && !busy && (c.provider_config.form_id || c.provider_config.spreadsheet_id) && (
              <form action={requestConnectorSync}>{hidden}<input type="hidden" name="mode" value="discover" /><button className="btn-secondary btn-small">質問（列）を読み込み直す</button></form>
            )}
          </div>
        </>
      )}

      {(c.kind === "typeform" || c.kind === "tally") && (
        <>
          <ol className="small" style={{ paddingLeft: 18 }}>
            <li style={{ marginBottom: 8 }}>
              <strong>署名用の秘密を発行</strong>（送信元が本物かを確かめるために使います。表示は1回だけです）
              {admin && <form action={issueSigningSecret} style={{ marginTop: 6 }}>{hidden}<button className="btn-secondary btn-small">{status.connected ? "秘密を再発行（古い秘密は無効）" : "秘密を発行"}</button></form>}
              {status.connected && <div style={{ marginTop: 4 }}><span className="badge badge-ok">発行済み</span></div>}
            </li>
            <li style={{ marginBottom: 8 }}>
              <strong>{c.kind === "typeform" ? "Typeform" : "Tally"} に受け口を登録</strong>
              <pre style={{ marginTop: 6 }}>{webhookUrl}</pre>
              {c.kind === "typeform"
                ? <span className="muted">フォームの「Connect → Webhooks」で上の URL を追加し、「Secret」に発行した秘密を入れて有効にします。</span>
                : <span className="muted">フォームの「Integrations → Webhooks」で上の URL を追加し、「Signing secret」に発行した秘密を入れます。</span>}
            </li>
            <li>
              <strong>テスト送信して項目の対応を確認</strong>
              <span className="muted">（届いた項目名が下の「設定と項目対応」に出ます。「氏名」の対応が決まるまで届いた回答は保留にし、決めた後に処理します）</span>
            </li>
          </ol>
          <p className="small muted">受信した回答 {status.total}件・最終受信 {fmtDateTime(c.last_synced_at)}</p>
        </>
      )}

      {status.held > 0 && (
        <div className="notice notice-warn small" style={{ marginTop: 10 }}>
          項目の対応が決まっていない、または登録人数の上限で保留中の回答が {status.held}件あります。
          {hasName && <form action={reprocessConnection} style={{ display: "inline", marginLeft: 8 }}>{hidden}<button className="btn-small">保留中の回答を処理する</button></form>}
        </div>
      )}
    </div>
  );
}
