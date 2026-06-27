/**
 * Lifecycle global-setup: validates env + refuses to run against production.
 * Unlike the bot's global-setup, it does NOT purge or seed — the lifecycle
 * suite seeds its own world per run and (per the user's choice) LEAVES the data
 * in place for manual inspection. There is intentionally no teardown.
 */
import { FullConfig } from "@playwright/test";
import { svc } from "../../e2e/helpers/supabase";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const required = [
    "E2E_BASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `[lifecycle] Missing env vars: ${missing.join(", ")}\n` +
        `Fill them into .env.test.local (STAGING values).`
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const looksLikeProd =
    /prod|production/.test(url) ||
    process.env.E2E_BASE_URL?.includes("-prod.");
  if (looksLikeProd && process.env.E2E_ALLOW_PROD !== "1") {
    throw new Error(
      `[lifecycle] Refusing to run against what looks like production:\n` +
        `  SUPABASE_URL=${url}\n  BASE_URL=${process.env.E2E_BASE_URL}\n` +
        `This suite creates orgs/users/courses. Point it at STAGING.`
    );
  }

  const { error } = await svc()
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .limit(1);
  if (error) {
    throw new Error(`[lifecycle] service-role check failed: ${error.message}`);
  }

  console.log(`[lifecycle] setup OK — target ${process.env.E2E_BASE_URL}`);
}
