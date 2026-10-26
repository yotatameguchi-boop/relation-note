import type { NextConfig } from "next";

const supabase = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const dev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabase}`,
  `connect-src 'self' ${supabase}${dev ? " ws: http://localhost:* http://127.0.0.1:*" : ""}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // 画面はすべてログイン中スタッフ・団体ごとに内容が変わる（RLS で絞り込む）。
  // 共有キャッシュに団体のデータが載らないよう、Cache Components は使わず常に動的に描画する。
  cacheComponents: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // 読み込める先を自サイトと Supabase に限る（外部のスクリプトを埋め込まれても動かないように）。開発時は Next の再読み込みのため緩める
          { key: "Content-Security-Policy", value: csp },
        ],
      },
      {
        // 認証済みの画面・API（共有画面を含む）は共有キャッシュに載せない
        source: "/(orgs|api|invite|account|login)/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
