import type { NextConfig } from "next";

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
