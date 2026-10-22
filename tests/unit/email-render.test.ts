import { describe, expect, it } from "vitest";
import { renderEmail } from "@shared/email-render";

const base = { name: "はなちゃん", fullName: "山田 花子", orgName: "みどり会", senderInfo: "東京都千代田区1-1", unsubscribeUrl: "https://example.org/u/abc" };

describe("メール本文の組み立て", () => {
  it("差し込みと、送信者情報・配信停止リンクの付与", () => {
    const m = renderEmail({ ...base, subject: "{{表示名}}さんへ", body: "{{氏名}} 様\n{{組織名}}です", openPixelUrl: "https://example.org/api/t/o/abc" });
    expect(m.subject).toBe("はなちゃんさんへ");
    expect(m.text).toContain("山田 花子 様\nみどり会です");
    expect(m.text).toContain("送信者：みどり会");
    expect(m.text).toContain("東京都千代田区1-1");
    expect(m.text).toContain("https://example.org/u/abc");
    expect(m.html).toContain('href="https://example.org/u/abc"');
    expect(m.html).toContain('src="https://example.org/api/t/o/abc"');
  });

  it("本文のHTMLは無害化し、件名の改行（ヘッダーの書き換え）を取り除く", () => {
    const m = renderEmail({ ...base, subject: "件名\r\nBcc: attacker@example.com", body: "<script>alert(1)</script> https://ok.example/?a=1&b=2" });
    expect(m.subject).toBe("件名 Bcc: attacker@example.com");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain('<a href="https://ok.example/?a=1&amp;b=2"');
  });

  it("テスト送信では開封記録の画像を付けない", () => {
    expect(renderEmail({ ...base, subject: "s", body: "b", openPixelUrl: null }).html).not.toContain("<img");
  });
});
