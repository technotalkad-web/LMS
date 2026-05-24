/**
 * Runs once after the entire suite finishes (pass or fail).
 *
 * Idempotent. Only purges rows that match the qa-* slug or
 * @example.test email convention, so it's safe to skip if you want
 * to inspect residue from a failed run (set E2E_KEEP_DATA=1).
 */

import { purgeAllTestData } from "./helpers/supabase";

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_KEEP_DATA === "1") {
    console.log("[e2e] global-teardown: skipping purge (E2E_KEEP_DATA=1)");
    return;
  }
  const purged = await purgeAllTestData();
  const summary = "users=" + purged.users + " orgs=" + purged.orgs + " otps=" + purged.otps;
  console.log("[e2e] global-teardown: purged { " + summary + " }");
}
