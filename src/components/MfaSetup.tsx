"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

type Factor = { id: string; friendly_name?: string | null; created_at: string };

/**
 * 認証アプリの登録と解除（ブラウザから Supabase Auth を直接呼ぶ。QR コードを表示する必要があるため）。
 * 登録：QR を読み取る → 表示された6桁のコードを入力 → 確認できたら有効化。
 */
export function MfaSetup({ factors, required }: { factors: Factor[]; required: boolean }) {
  const router = useRouter();
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [name, setName] = useState("");
  const defaultName = factors.length ? "予備の端末" : "スマートフォン";
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setMsg({});
    const supabase = createBrowserSupabase();
    // 途中でやめた登録（未確認）を片付けてから始める
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const f of list?.all ?? []) if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `${name.trim() || defaultName}（${new Date().toLocaleDateString("ja-JP")}）`, issuer: "RelationNote" });
    setBusy(false);
    if (error || !data) return setMsg({ error: "登録を始められませんでした。時間をおいてもう一度お試しください。" });
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enroll) return;
    setBusy(true);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.id, code: code.replace(/\s/g, "") });
    setBusy(false);
    if (error) return setMsg({ error: "コードが違います。認証アプリに表示されている最新の6桁を入力してください。" });
    setEnroll(null);
    setCode("");
    setMsg({ ok: "二段階認証を有効にしました。次回のログインから、パスワードの後に認証アプリのコードを入力します。" });
    router.refresh();
  };

  const remove = async (f: Factor) => {
    if (!confirm_(f)) return;
    setBusy(true);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    setBusy(false);
    if (error) return setMsg({ error: "解除できませんでした。いったんログアウトし、コードを入力してログインし直してからお試しください。" });
    await supabase.auth.refreshSession();
    setMsg({ ok: "認証アプリの登録を解除しました。" });
    router.refresh();
  };

  return (
    <div>
      {msg.error && <div className="notice notice-danger" role="alert">{msg.error}</div>}
      {msg.ok && <div className="notice notice-ok">{msg.ok}</div>}
      {factors.length > 0 ? (
        <ul className="plain-list">
          {factors.map((f) => (
            <li key={f.id} className="spread">
              <span><span className="badge badge-ok">有効</span> {f.friendly_name ?? "認証アプリ"}</span>
              <button type="button" className="btn-secondary btn-small" disabled={busy || (required && factors.length === 1)} onClick={() => remove(f)}
                title={required && factors.length === 1 ? "所属組織で二段階認証が必須のため、最後の1つは解除できません" : undefined}>解除</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">まだ設定していません。{required ? <strong>所属している組織で必須になっています。</strong> : "設定すると、パスワードが漏れても他人はログインできなくなります。"}</p>
      )}

      {!enroll ? (
        <div className="row" style={{ marginTop: 10 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} aria-label="端末の名前" placeholder={`端末の名前（例：${defaultName}）`} style={{ width: 220 }} />
          <button type="button" onClick={start} disabled={busy}>{factors.length ? "予備の認証アプリを追加" : "二段階認証を設定する"}</button>
        </div>
      ) : (
        <form onSubmit={confirm} className="mfa-enroll">
          <ol className="small">
            <li>スマートフォンに認証アプリ（Google Authenticator、Microsoft Authenticator など）を入れる</li>
            <li>アプリで下の QR コードを読み取る（読み取れない場合は、下の文字列を手入力）</li>
            <li>アプリに表示された6桁のコードを入力して「確認して有効にする」</li>
          </ol>
          <div className="mfa-qr">
            {/* eslint-disable-next-line @next/next/no-img-element -- Supabase が返す SVG のデータURL */}
            <img src={enroll.qr} alt="二段階認証の登録用 QR コード" width={180} height={180} />
            <div>
              <div className="small muted">手入力用のキー</div>
              <code className="mfa-secret">{enroll.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
            </div>
          </div>
          <div className="row">
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required
              placeholder="123456" aria-label="確認コード" style={{ width: 140, fontSize: 18, letterSpacing: ".2em", textAlign: "center" }} />
            <button disabled={busy}>確認して有効にする</button>
            <button type="button" className="btn-secondary" onClick={() => { setEnroll(null); setCode(""); }}>やめる</button>
          </div>
        </form>
      )}
    </div>
  );
}

function confirm_(f: Factor) {
  return window.confirm(`「${f.friendly_name ?? "認証アプリ"}」の登録を解除しますか？`);
}
