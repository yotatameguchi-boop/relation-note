import "server-only";
import { notFound } from "next/navigation";
import { canManageSharing, getFeatures, hasPerm, requireMembership } from "@/lib/auth";

/** 共有画面の入口。機能フラグ・権限を確認する（DB 側でも同じ条件を確認している） */
export async function sharingContext(orgId: string, need: "manage" | "view" | "either") {
  const m = await requireMembership(orgId);
  const features = await getFeatures(orgId);
  const manage = canManageSharing(m);
  const view = hasPerm(m, "view_shared");
  const ok = need === "manage" ? manage : need === "view" ? view : manage || view;
  if (!ok) notFound();
  return { m, enabled: features.partner_sharing, manage, view };
}
