import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LogLens",
  description:
    "Demo web application trên Cloudflare: Next.js ở Workers (R2 + D1) và service Python cho việc nặng.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
