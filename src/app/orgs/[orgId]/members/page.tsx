import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership, can, hasPerm, getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import { env } from "@/lib/env";
import { fmtDateTime } from "@/lib/format";
import { ALL_PERMISSIONS, PERMISSION_LABEL, ROLE_LABEL, type Permission, type Role } from "@/lib/roles";
import { Flash } from "@/components/ui";

const url = (orgId: string) => `/orgs/${orgId}/members`;

async function invite(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const role = String(fd.get("role")) as Role;
  const perms = fd.getAll("permissions").map(String);
  const { data, error } = await supabase.rpc("create_invitation", {
    org: orgId, invitee_email: String(fd.get("email") ?? ""), invitee_role: role, invitee_permissions: perms,
  });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}`);
  revalidatePath(url(orgId));
  redirect(`${url(orgId)}?invite=${encodeURIComponent(`${env.appUrl}/invite/${data}`)}`);
}

async function revokeInvite(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_invitation", { inv: String(fd.get("invId")) });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId)}?ok=${encodeURIComponent("招待を取り消しました。")}`);
}

async function updateMember(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_member_role", {
    org: orgId, member: String(fd.get("userId")), new_role: String(fd.get("role")), new_permissions: fd.getAll("permissions").map(String),
  });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId)}?ok=${encodeURIComponent("権限を変更しました。")}`);
}

async function removeMember(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_member", { org: orgId, member: String(fd.get("userId")) });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId)}?ok=${encodeURIComponent("スタッフを削除しました。")}`);
}

async function transfer(fd: FormData) {
  "use server";
  const orgId = String(fd.get("orgId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("transfer_ownership", { org: orgId, new_owner: String(fd.get("userId")) });
  if (error) redirect(`${url(orgId)}?error=${encodeURIComponent(toMessage(error))}`);
  redirect(`${url(orgId)}?ok=${encodeURIComponent("所有権を移譲しました。あなたは管理者になりました。")}`);
}

export default async function Members({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; ok?: string; invite?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const m = await requireMembership(orgId, "admin");
  const me = await getUser();
  const supabase = await createClient();
  const [{ data: members }, { data: invites }] = await Promise.all([
    supabase.from("memberships").select("user_id, role, permissions, created_at, users(email, display_name)").eq("organization_id", orgId).order("created_at"),
    supabase.from("invitations").select("id, email, role, permissions, expires_at, accepted_at, revoked_at, created_at").eq("organization_id", orgId)
      .is("accepted_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }),
  ]);
  const canPerm = hasPerm(m, "manage_permissions");
  const isOwner = m.role === "owner";
  const hidden = <input type="hidden" name="orgId" value={orgId} />;

  return (
    <>
      <h1>スタッフと権限</h1>
      <Flash sp={sp} />
      {sp.invite && (
        <div className="notice notice-ok">
          招待リンクを作成しました（7日間有効・1回限り）。招待した方に送ってください：<br /><code>{sp.invite}</code>
        </div>
      )}
      <div className="card small">
        <strong>権限の目安</strong>：オーナー＝団体設定・契約・所有権移譲・団体削除／管理者＝スタッフ招待・通常の権限管理・業務データ管理／
        編集者＝人物・イベント・写真の登録と編集／閲覧者＝業務データの閲覧。
        一括出力・一括削除・人物統合・権限変更は、役割とは別に個別に付与します。
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>スタッフ</th><th>役割と個別権限</th><th /></tr></thead>
          <tbody>
            {(members ?? []).map((x) => {
              const u = x.users as unknown as { email: string; display_name: string };
              const self = x.user_id === me?.id;
              const editable = canPerm && x.role !== "owner" && !self;
              return (
                <tr key={x.user_id}>
                  <td>{u.display_name}{self && <span className="badge" style={{ marginLeft: 4 }}>あなた</span>}<div className="small muted">{u.email}</div></td>
                  <td>
                    {editable ? (
                      <form action={updateMember} className="row small">
                        {hidden}<input type="hidden" name="userId" value={x.user_id} />
                        <select name="role" defaultValue={x.role} style={{ width: 110 }}>
                          {(["admin", "editor", "viewer"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                        {ALL_PERMISSIONS.map((p) => (
                          <label key={p} className="row" style={{ margin: 0, color: "var(--text)" }}>
                            <input type="checkbox" name="permissions" value={p} defaultChecked={(x.permissions as Permission[]).includes(p)} />{PERMISSION_LABEL[p]}
                          </label>
                        ))}
                        <button className="btn-secondary btn-small">変更</button>
                      </form>
                    ) : (
                      <span className="small">
                        <span className="badge">{ROLE_LABEL[x.role as Role]}</span>{" "}
                        {(x.role === "owner" ? ALL_PERMISSIONS : (x.permissions as Permission[])).map((p) => PERMISSION_LABEL[p]).join("・")}
                      </span>
                    )}
                  </td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {isOwner && !self && (
                        <form action={transfer}>{hidden}<input type="hidden" name="userId" value={x.user_id} /><button className="btn-secondary btn-small">所有権を移譲</button></form>
                      )}
                      {(self || (x.role !== "owner" && (x.role !== "admin" || canPerm)) || isOwner) && (
                        <form action={removeMember}>{hidden}<input type="hidden" name="userId" value={x.user_id} />
                          <button className="btn-secondary btn-small">{self ? "脱退" : "削除"}</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">最後のオーナーは削除・脱退できません。先に所有権を移譲してください。</p>

      {can(m, "admin") && (
        <form action={invite} className="card">
          {hidden}
          <h2 style={{ marginTop: 0 }}>スタッフを招待</h2>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="inline-field" style={{ flex: 2 }}>メールアドレス<input type="email" name="email" required /></label>
            <div className="inline-field">
              <label>役割</label>
              <select name="role" defaultValue="editor" aria-label="役割">
                {(canPerm ? ["admin", "editor", "viewer"] : ["editor", "viewer"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r as Role]}</option>)}
              </select>
            </div>
            <button>招待リンクを作成</button>
          </div>
          {canPerm && (
            <div className="row small" style={{ marginTop: 8 }}>
              <span className="muted">個別権限:</span>
              {ALL_PERMISSIONS.map((p) => (
                <label key={p} className="row" style={{ margin: 0, color: "var(--text)" }}><input type="checkbox" name="permissions" value={p} />{PERMISSION_LABEL[p]}</label>
              ))}
            </div>
          )}
        </form>
      )}
      {(invites ?? []).length > 0 && (
        <>
          <h2>未使用の招待</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>メール</th><th>役割</th><th>有効期限</th><th /></tr></thead>
              <tbody>
                {(invites ?? []).map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td><td>{ROLE_LABEL[i.role as Role]}</td><td className="small">{fmtDateTime(i.expires_at)}</td>
                    <td className="right"><form action={revokeInvite}>{hidden}<input type="hidden" name="invId" value={i.id} /><button className="link-btn small">取り消し</button></form></td>
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
