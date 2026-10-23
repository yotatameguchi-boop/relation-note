import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { TERMS_VERSION } from "@/lib/legal";

async function accept() {
  "use server";
  const supabase = await createClient();
  await supabase.rpc("accept_terms", { version: TERMS_VERSION });
  revalidatePath("/orgs", "layout");
}

/** 現在の版の規約に同意していないスタッフ（規約の改定・同意の仕組みより前に登録した人）に同意を求める */
export async function TermsNotice({ userId }: { userId: string }) {
  const supabase = await createClient();
  const { data } = await supabase.from("users").select("terms_version").eq("id", userId).maybeSingle();
  if (data?.terms_version === TERMS_VERSION) return null;
  return (
    <form action={accept} className="notice notice-info row small" style={{ justifyContent: "space-between" }}>
      <span>
        {data?.terms_version ? "利用規約・プライバシーポリシーを改定しました。" : "利用規約・プライバシーポリシーへの同意をお願いします。"}
        <a href="/terms" target="_blank">利用規約</a>・<a href="/privacy" target="_blank">プライバシーポリシー</a>をご確認ください。
      </span>
      <button className="btn-small">同意する</button>
    </form>
  );
}
