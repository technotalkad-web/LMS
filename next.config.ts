import path from "node:path";
import type { NextConfig } from "next";
import { REACT_DOM_CLIENT_FILE } from "./scripts/react-dom-ping-fix.cjs";

const nextConfig: NextConfig = {
  // Container builds (Cloud Run, docs/CLOUD_RUN_STAGING.md) set
  // NEXT_OUTPUT=standalone to get a self-contained server.js. The Cloudflare
  // build (OpenNext) leaves it unset and is unaffected.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),

  // ADR 0013: the react-dom bundled by this Next version can drop the ping
  // that retries a suspended transition, so a router.refresh() fetches the
  // new page and never shows it (Library "Set as default" kept the old
  // header). The loader applies React's upstream one-line fix to the bundled
  // client build at bundle time; node_modules is not modified. webpack only
  // (`next build` / `next dev` without --turbopack). Remove it once the
  // bundled react-dom carries the fix (the loader then passes it through).
  webpack(config) {
    config.module.rules.push({
      test: REACT_DOM_CLIENT_FILE,
      use: [{ loader: path.join(process.cwd(), "scripts", "react-dom-ping-fix.cjs") }],
    });
    return config;
  },
};

export default nextConfig;
