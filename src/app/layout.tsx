import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "RelationNote（リレーションノート）", template: "%s | RelationNote" },
  description: "NPO向け 顧客・関係人口管理",
  applicationName: "RelationNote",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
