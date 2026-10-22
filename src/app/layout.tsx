import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "RelationNote", template: "%s | RelationNote" },
  description: "顧客・関係者のつながりをまとめて管理",
  applicationName: "RelationNote",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
