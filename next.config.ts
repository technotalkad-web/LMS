import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Container builds (Cloud Run, docs/CLOUD_RUN_STAGING.md) set
  // NEXT_OUTPUT=standalone to get a self-contained server.js. The Cloudflare
  // build (OpenNext) leaves it unset and is unaffected.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
