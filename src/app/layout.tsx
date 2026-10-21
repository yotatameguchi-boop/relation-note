import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "つながり台帳",
  description: "NPO向け 顧客・関係人口管理",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
