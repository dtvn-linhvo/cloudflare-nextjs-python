import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Không tự sinh AGENTS.md / CLAUDE.md
  agentRules: false,
};

// Cho phép gọi getCloudflareContext() (R2 / D1 / service binding) ngay trong `next dev`.
initOpenNextCloudflareForDev();

export default nextConfig;
