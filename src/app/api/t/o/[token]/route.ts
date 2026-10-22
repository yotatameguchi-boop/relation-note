import { createAdminClient } from "@/lib/supabase/admin";

// 開封の記録（1×1 の透明画像）。宛先ごとのランダムな token でだけ照合する
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (/^[0-9a-f]{36}$/.test(token)) {
    await createAdminClient().rpc("record_email_open", { p_token: token }).then(() => {}, () => {});
  }
  return new Response(GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" } });
}
