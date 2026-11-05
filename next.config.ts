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
  //
  // ADR 0018: the same loader applies React's upstream fix for a hydration
  // replay that re-claims a host element, so a hard load whose layout <main>
  // waits on the error boundary's chunk can throw #418 and remount the course
  // iframe. All these fixes are in the canary Next 16.4.5 bundles, the replay's
  // by Next 16.2.0 and the ping's by 16.3.0; each hunk is checked and removed on
  // its own (tests/unit/react-dom-ping-fix.test.ts).
  webpack(config) {
    config.module.rules.push({
      test: REACT_DOM_CLIENT_FILE,
      use: [{ loader: path.join(process.cwd(), "scripts", "react-dom-ping-fix.cjs") }],
    });
    return config;
  },
};

export default nextConfig;
