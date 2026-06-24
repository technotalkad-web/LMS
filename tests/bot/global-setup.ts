/**
 * Bot global-setup. Validates env, refuses to run against anything that looks
 * like production, wipes the previous run's report shards, sweeps stale test
 * data, then seeds the shared test world the specs log into.
 *
 * Writes run-meta.json (start time + base URL) for global-teardown to stamp
 * and render the final report.
 */

import fs from "node:fs";
import path from "node:path";
import { FullConfig } from "@playwright/test";
import { svc, purgeAllTestData } from "../e2e/helpers/supabase";
import { seedWorld } from "./lib/seed";
import { RAW_DIR, REPORT_ROOT, SCREENSHOT_DIR, SEED_FILE } from "./lib/paths";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // 1. Required env.
  const required = [
    "E2E_BASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `[bot] Missing env vars: ${missing.join(", ")}\n` +
        `Copy tests/bot/env.bot.example into .env.test.local and fill in STAGING values.`
    );
  }

  // 2. Production-blast guard (same posture as the e2e suite).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const looksLikeProd =
    /prod|production/.test(url) ||
    process.env.NEXT_PUBLIC_SITE_URL?.includes("yourcompany.com") ||
    process.env.E2E_BASE_URL?.includes("yourcompany.com");
  if (looksLikeProd && process.env.E2E_ALLOW_PROD !== "1") {
    throw new Error(
      `[bot] Refusing to run against what looks like production:\n` +
        `  SUPABASE_URL=${url}\n  BASE_URL=${process.env.E2E_BASE_URL}\n` +
        `The bot creates orgs/users and probes write endpoints. Point it at STAGING.`
    );
  }

  // 3. Service-role round-trip.
  const { error } = await svc()
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .limit(1);
  if (error) {
    throw new Error(`[bot] Supabase service-role check failed: ${error.message}`);
  }

  // 4. Fresh report dir (keep nothing from the previous run).
  for (const dir of [RAW_DIR, SCREENSHOT_DIR]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(SEED_FILE, { force: true });

  // 5. Sweep stale test data, then seed this run's world.
  const purged = await purgeAllTestData();
  const world = await seedWorld();

  fs.writeFileSync(
    path.join(REPORT_ROOT, "run-meta.json"),
    JSON.stringify(
      { startedAt: new Date().toISOString(), baseURL: process.env.E2E_BASE_URL },
      null,
      2
    )
  );

  console.log(
    `[bot] setup OK — purged {users:${purged.users}, orgs:${purged.orgs}} · ` +
      `seeded org "${world.org.slug}" with admin/analyst/learner/owner.`
  );
}
