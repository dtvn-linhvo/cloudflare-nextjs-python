import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LogLens — phân tích log",
  description:
    "Demo tách frontend/backend: Next.js trên Cloudflare Workers xử lý request nhẹ, service Python xử lý việc nặng.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
