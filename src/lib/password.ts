// パスワードの条件（Supabase Auth の設定と同じ：10文字以上、英字と数字を両方含む）
export const PASSWORD_MIN = 10;
export const PASSWORD_HINT = `${PASSWORD_MIN}文字以上で、英字と数字を両方含めてください。`;

export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < PASSWORD_MIN) return `パスワードは${PASSWORD_MIN}文字以上にしてください。`;
  if (pw.length > 72) return "パスワードは72文字以内にしてください。";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "パスワードには英字と数字を両方含めてください。";
  if (/^(.)\1+$/.test(pw)) return "同じ文字だけのパスワードは使えません。";
  if (email && pw.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) return "メールアドレスの一部を含むパスワードは使えません。";
  return null;
}
