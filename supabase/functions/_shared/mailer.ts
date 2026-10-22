// メールの送信（SMTP）。設定は環境変数から読む。
//   MAIL_TRANSPORT=smtp のときだけ送信する。未設定なら「送信は設定されていません」として扱う
//   SMTP_HOST / SMTP_PORT（Gmail は 465）/ SMTP_SECURE（465 なら true）/ SMTP_USER / SMTP_PASS / MAIL_FROM
// Supabase の Edge Functions は 25・587 番ポートへの接続ができないため、465（SMTPS）を使う。
import { NonRetryableError } from "./detector.ts";

export type OutgoingMail = {
  to: string; subject: string; text: string; html: string;
  fromName?: string | null; replyTo?: string | null; unsubscribeUrl?: string | null;
};

/** メールサーバーにつながらない（送信は確実に行われていない）エラー。宛先を送信待ちに戻して再試行する */
export class TransportError extends Error {}

const CONNECTION_CODES = ["ECONNREFUSED", "ECONNECTION", "ETIMEDOUT", "EDNS", "ESOCKET", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET"];

export interface Mailer {
  configured: boolean;
  send(m: OutgoingMail): Promise<{ messageId: string | null }>;
}

export async function createMailer(): Promise<Mailer> {
  if (Deno.env.get("MAIL_TRANSPORT") !== "smtp") {
    return {
      configured: false,
      send() { throw new NonRetryableError("メール送信が設定されていません（MAIL_TRANSPORT）"); },
    };
  }
  const nodemailer = (await import("npm:nodemailer@6.9.16")).default;
  const port = Number(Deno.env.get("SMTP_PORT") ?? "465");
  const transport = nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST"),
    port,
    secure: (Deno.env.get("SMTP_SECURE") ?? (port === 465 ? "true" : "false")) === "true",
    auth: Deno.env.get("SMTP_USER") ? { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") } : undefined,
    connectionTimeout: 15000,
  });
  const fromAddr = Deno.env.get("MAIL_FROM") ?? Deno.env.get("SMTP_USER") ?? "";
  return {
    configured: true,
    async send(m) {
      try {
        const info = await transport.sendMail({
          from: m.fromName ? { name: m.fromName, address: fromAddr } : fromAddr,
          to: m.to,
          replyTo: m.replyTo ?? undefined,
          subject: m.subject,
          text: m.text,
          html: m.html,
          headers: m.unsubscribeUrl ? { "List-Unsubscribe": `<${m.unsubscribeUrl}>` } : undefined,
        });
        return { messageId: info.messageId ?? null };
      } catch (e) {
        const errCode = (e as { code?: string }).code ?? "";
        const message = (e as Error).message ?? "";
        // 接続前の失敗（名前解決・接続拒否・タイムアウト）は送信されていないので、再試行してよい
        if (CONNECTION_CODES.includes(errCode) || /queryA|getaddrinfo|connect ECONNREFUSED|Greeting never received/i.test(message)) {
          throw new TransportError(`メールサーバーに接続できません：${message}`);
        }
        const code = (e as { responseCode?: number; code?: string }).responseCode;
        // 宛先が存在しないなど（5xx）は再試行しない。認証失敗も同様
        if ((code && code >= 500 && code < 600) || (e as { code?: string }).code === "EAUTH") {
          throw new NonRetryableError(`送信できませんでした：${(e as Error).message}`);
        }
        throw e;
      }
    },
  };
}
