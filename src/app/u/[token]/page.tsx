import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Logo } from "@/components/Logo";

// 配信停止。リンクを開いただけでは停止せず、ボタンを押したときに停止する（メールの自動チェックで誤って停止しないように）
async function unsubscribe(fd: FormData) {
  "use server";
  const token = String(fd.get("token"));
  if (!/^[0-9a-f]{36}$/.test(token)) redirect(`/u/${token}`);
  await createAdminClient().rpc("unsubscribe_by_token", { p_token: token });
  redirect(`/u/${token}?done=1`);
}

export default async function Unsubscribe({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const info = /^[0-9a-f]{36}$/.test(token)
    ? ((await createAdminClient().rpc("lookup_unsubscribe", { p_token: token })).data as { org_name: string; email: string; already: boolean } | null)
    : null;
  return (
    <div className="auth-wrap">
      <div className="auth-hero"><Logo size={36} wordSize={20} /></div>
      <div className="card">
        <h1>メールの配信停止</h1>
        {!info ? (
          <p>このリンクは無効です。テスト送信のメールの場合は、配信停止の対象ではありません。</p>
        ) : sp.done || info.already ? (
          <p>{info.email} への「{info.org_name}」からのメール配信を停止しました。</p>
        ) : (
          <form action={unsubscribe}>
            <input type="hidden" name="token" value={token} />
            <p>{info.email} への「{info.org_name}」からのメール配信を停止します。</p>
            <button>配信を停止する</button>
          </form>
        )}
      </div>
    </div>
  );
}
