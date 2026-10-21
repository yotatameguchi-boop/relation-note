/** DB（RPC）のエラーを画面向けの日本語にする */
type PgError = { message?: string; hint?: string | null; code?: string; details?: string | null } | null | undefined;

const MESSAGES: Record<string, string> = {
  forbidden: "この操作を行う権限がありません。",
  not_found: "対象が見つかりません。",
  last_owner: "最後のオーナーは削除・変更できません。先に所有権を移譲してください。",
  "quota_exceeded:people": "登録人物数がプランの上限に達しています。",
  "quota_exceeded:staff": "スタッフ数がプランの上限に達しています。",
  "quota_exceeded:photo_analysis": "今月の写真解析枠に達しています。",
  "quota_exceeded:storage": "写真の保存容量の上限に達しています。",
  invitation_invalid: "招待が無効か、期限切れです。",
  invitation_email_mismatch: "招待されたメールアドレスでログインしてください。",
  confirm_mismatch: "確認用の組織名が一致しません。",
  invalid_role: "その権限は設定できません。",
  batch_already_started: "この取り込みはすでに開始されています。",
  already_resolved: "この回答はすでに処理済みです。",
  already_queued: "すでに解析待ちです。",
  not_dead: "隔離されたジョブのみ再実行できます。",
  upload_expired: "アップロードの期限が切れました。もう一度選び直してください。",
  upload_mismatch: "ファイルの形式またはサイズが申告と一致しません。",
  invalid_file: "対応していないファイルです。",
  feature_disabled: "この機能は組織で有効になっていません。",
  partner_not_found: "連携コードに該当する組織が見つかりません。",
  partnership_exists: "この組織とはすでに連携中か、申請中です。",
  partnership_inactive: "連携中の組織ではありません。",
  no_valid_authorization: "選んだ項目・期限を含む有効な共有根拠がありません。",
  share_not_active: "この共有は現在有効ではありません。",
  invalid_fields: "項目を1つ以上選んでください。",
  invalid_adjustment: "修正内容が正しくありません。画面を再読み込みしてください。",
};

export function toMessage(err: PgError, fallback = "処理に失敗しました。"): string {
  if (!err) return fallback;
  // DB 側のメッセージは旧表記（団体）のものがあるので、画面の表記（組織）にそろえる
  if (err.hint && !/^(role|permission) /.test(err.hint)) return err.hint.replace(/団体/g, "組織");
  const key = err.message ?? "";
  if (MESSAGES[key]) return MESSAGES[key];
  if (err.code === "42501" || /row-level security/.test(key)) return MESSAGES.forbidden;
  if (err.code === "23505") return "同じ内容がすでに登録されています。";
  return fallback;
}
