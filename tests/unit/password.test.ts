import { describe, expect, it } from "vitest";
import { passwordProblem } from "@/lib/password";

describe("パスワードの条件", () => {
  it.each([
    ["abc123", "10文字以上"],
    ["abcdefghijk", "英字と数字"],
    ["12345678901", "英字と数字"],
    ["tanaka2026abc", "メールアドレス"],
  ])("%s は拒否", (pw, why) => expect(passwordProblem(pw, "tanaka@example.org")).toContain(why));
  it("条件を満たせば通る", () => expect(passwordProblem("Kawa9mori-sora", "tanaka@example.org")).toBeNull());
});
