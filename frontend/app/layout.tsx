import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LogLens",
  description:
    "Demo web application on Cloudflare: Next.js on Workers (R2 + D1) with a Python service for the heavy work.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
