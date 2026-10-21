export type Role = "owner" | "admin" | "editor" | "viewer";
export type Permission = "bulk_export" | "bulk_delete" | "merge_people" | "manage_permissions";

export const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

export const ROLE_LABEL: Record<Role, string> = {
  owner: "オーナー",
  admin: "管理者",
  editor: "編集者",
  viewer: "閲覧者",
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  bulk_export: "一括出力",
  bulk_delete: "一括削除",
  merge_people: "人物統合",
  manage_permissions: "権限変更",
};

export const ALL_PERMISSIONS = Object.keys(PERMISSION_LABEL) as Permission[];

export const DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ["bulk_export", "merge_people"],
  editor: [],
  viewer: [],
};
