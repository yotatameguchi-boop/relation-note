import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ROLE_RANK, type Permission, type Role } from "@/lib/roles";

export const getUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user;
});

export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

export type Membership = {
  organizationId: string;
  organizationName: string;
  status: "active" | "suspended" | "cancelled";
  role: Role;
  permissions: Permission[];
};

/**
 * 団体IDは URL から来るが、それだけでは信用しない。
 * ログイン中スタッフの memberships を（RLS 越しに）読み、所属と権限を確認する。
 */
export const getMembership = cache(async (orgId: string): Promise<Membership | null> => {
  const user = await getUser();
  if (!user || !/^[0-9a-f-]{36}$/i.test(orgId)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("role, permissions, organizations!inner(id, name, status)")
    .eq("organization_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return null;
  const org = data.organizations as unknown as { id: string; name: string; status: Membership["status"] };
  if (org.status === "cancelled") return null;
  return {
    organizationId: org.id,
    organizationName: org.name,
    status: org.status,
    role: data.role as Role,
    permissions: (data.role === "owner"
      ? ["bulk_export", "bulk_delete", "merge_people", "manage_permissions"]
      : data.permissions) as Permission[],
  };
});

export async function requireMembership(orgId: string, minRole: Role = "viewer") {
  await requireUser();
  const m = await getMembership(orgId);
  if (!m) notFound();
  if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) notFound();
  return m;
}

export function can(m: Membership, minRole: Role) {
  if (m.status !== "active" && minRole !== "viewer") return false;
  return ROLE_RANK[m.role] >= ROLE_RANK[minRole];
}

export function hasPerm(m: Membership, p: Permission) {
  return m.role === "owner" || m.permissions.includes(p);
}
