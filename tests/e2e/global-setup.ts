/**
 * Runs once before the entire test suite.
 *
 * Hard-fails early if the environment is misconfigured — much friendlier
 * than 30 cryptic test failures saying "fetch failed".
 *
 * Also: blocks any attempt to run against a production-shaped Supabase
 * URL unless E2E_ALLOW_PROD=1 is explicitly set. Cheap insurance against
 * the "oh no I just nuked prod" foot-cannon.
 */

import { FullConfig } from "@playwright/test";
import { svc, purgeAllTestData } from "./helpers/supabase";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // 1. Sanity: required env present?
  const required = [
    "E2E_BASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing env vars: ${missing.join(", ")}\n` +
        `Copy .env.test.example to .env.test.local and fill in your STAGING values.`
    );
  }

  // 2. Production-blast guard.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const looksLikeProd =
    /prod|production/.test(url) ||
    process.env.NEXT_PUBLIC_SITE_URL?.includes("yourcompany.com") ||
    process.env.E2E_BASE_URL?.includes("yourcompany.com");
  if (looksLikeProd && process.env.E2E_ALLOW_PROD !== "1") {
    throw new Error(
      `Refusing to run E2E against what looks like a production env:\n` +
        `  SUPABASE_URL=${url}\n` +
        `  BASE_URL=${process.env.E2E_BASE_URL}\n` +
        `Set E2E_ALLOW_PROD=1 if you're certain.`
    );
  }

  // 3. Round-trip the service-role key by hitting a harmless query.
  try {
    const { error } = await svc()
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) throw error;
  } catch (e) {
    throw new Error(
      `Supabase service-role key check failed: ${(e as Error).message}\n` +
        `Confirm SUPABASE_SERVICE_ROLE_KEY in .env.test.local matches your STAGING project.`
    );
  }

  // 4. Wait for the deployed worker to be STABLE, not just up. The suite
  // targets the live staging worker, and a merge to main redeploys it —
  // requests landing during the swap flake with slow/failed renders (the
  // login mount-gate timeout seen 2026-08-21 and again 2026-09-02). Require
  // two consecutive healthy /login responses a few seconds apart before
  // letting any test run; a swap in progress fails the first probe and we
  // ride it out instead of burning test retries.
  const base = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
  const healthy = async (): Promise<boolean> => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10_000);
      const res = await fetch(`${base}/login`, { signal: ctl.signal, redirect: "manual" });
      clearTimeout(t);
      return res.status === 200 || (res.status >= 300 && res.status < 400);
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 120_000;
  let streak = 0;
  while (Date.now() < deadline) {
    if (await healthy()) {
      streak++;
      if (streak >= 2) break;
    } else {
      streak = 0;
    }
    await new Promise((r) => setTimeout(r, 4_000));
  }
  if (streak < 2) {
    throw new Error(
      `[e2e] staging at ${base} did not stabilize within 120s — a deploy may be stuck; retry the run.`
    );
  }

  // 5. Sweep up anything left from a previous run.
  const purged = await purgeAllTestData();
  console.log(
    `[e2e] global-setup: env OK + staging stable, purged residue { users:${purged.users}, orgs:${purged.orgs}, otps:${purged.otps} }`
  );
}
