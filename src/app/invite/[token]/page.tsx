import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";

async function accept(fd: FormData) {
  "use server";
  const token = String(fd.get("token"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_invitation", { raw_token: token });
  if (error) redirect(`/invite/${token}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`/orgs/${data}`);
}

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const user = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  return (
    <div className="auth-wrap">
      <h1>団体への招待</h1>
      <div className="card">
        {sp.error && <div className="notice notice-danger">{sp.error}</div>}
        <p>{user.email} として招待を受け入れます。</p>
        <form action={accept}>
          <input type="hidden" name="token" value={token} />
          <button type="submit">招待を受け入れる</button>
        </form>
      </div>
    </div>
  );
}
