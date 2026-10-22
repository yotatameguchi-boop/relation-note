// メール本文の組み立て（ワーカーと画面のプレビューで共通。外部依存なし）
//   差し込み：{{氏名}} {{表示名}} {{組織名}}
//   末尾には送信者情報と配信停止リンクを必ず付ける（特定電子メール法への配慮）

export type RenderInput = {
  subject: string;
  body: string;
  name: string | null;          // 宛先の表示名（なければ氏名）
  fullName?: string | null;
  orgName: string;
  senderInfo: string;
  unsubscribeUrl: string;
  openPixelUrl?: string | null; // 開封の記録用（テスト送信では付けない）
};

export const PLACEHOLDERS = ["{{氏名}}", "{{表示名}}", "{{組織名}}"];

export function fillPlaceholders(text: string, i: Pick<RenderInput, "name" | "fullName" | "orgName">) {
  return text
    .replaceAll("{{氏名}}", i.fullName ?? i.name ?? "")
    .replaceAll("{{表示名}}", i.name ?? i.fullName ?? "")
    .replaceAll("{{組織名}}", i.orgName);
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function linkify(escaped: string) {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#1a4a86">${u}</a>`);
}

export function renderEmail(i: RenderInput) {
  // 件名に改行が入るとヘッダーを書き換えられるので、1行にする
  const subject = fillPlaceholders(i.subject, i).replace(/[\r\n]+/g, " ").trim();
  const body = fillPlaceholders(i.body, i);
  const footerText = [
    "──────────",
    `送信者：${i.orgName}`,
    i.senderInfo,
    `今後このようなメールが不要な場合は、こちらから配信を停止できます：`,
    i.unsubscribeUrl,
  ].join("\n");
  const text = `${body}\n\n${footerText}\n`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f7fb">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;font-family:'Hiragino Sans','Noto Sans JP',sans-serif;font-size:15px;line-height:1.7;color:#14223a">
<div>${linkify(escapeHtml(body)).replace(/\n/g, "<br>")}</div>
<hr style="border:0;border-top:1px solid #dbe3ee;margin:24px 0 12px">
<div style="font-size:12px;color:#5f6b7a">送信者：${escapeHtml(i.orgName)}<br>${escapeHtml(i.senderInfo).replace(/\n/g, "<br>")}<br>
今後このようなメールが不要な場合は、<a href="${i.unsubscribeUrl}" style="color:#1a4a86">配信を停止</a>できます。</div>
</div>${i.openPixelUrl ? `<img src="${i.openPixelUrl}" width="1" height="1" alt="" style="display:block;border:0">` : ""}
</body></html>`;
  return { subject, text, html };
}
