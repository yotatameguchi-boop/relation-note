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
    ];
  },
};

export default nextConfig;
