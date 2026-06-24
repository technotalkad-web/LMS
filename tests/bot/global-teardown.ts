/**
 * Bot global-teardown. Renders the aggregated report from the per-worker
 * shards, prints a console summary, then purges the test data the bot created
 * (unless BOT_KEEP_DATA=1, useful for poking at the seeded world afterwards).
 */

import fs from "node:fs";
import path from "node:path";
import { purgeAllTestData } from "../e2e/helpers/supabase";
import { generateReport } from "./lib/report";
import { OUT_HTML, OUT_JSON, OUT_MD, REPORT_ROOT } from "./lib/paths";

export default async function globalTeardown(): Promise<void> {
  // Read run-meta written by setup.
  let meta = { startedAt: new Date().toISOString(), baseURL: process.env.E2E_BASE_URL ?? "" };
  const metaFile = path.join(REPORT_ROOT, "run-meta.json");
  if (fs.existsSync(metaFile)) {
    try {
      meta = { ...meta, ...JSON.parse(fs.readFileSync(metaFile, "utf8")) };
    } catch {
      /* ignore */
    }
  }

  const summary = generateReport({
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
    baseURL: meta.baseURL,
  });

  const t = summary.totals;
  console.log(
    `\n[bot] ===== Report =====\n` +
      `  pages visited : ${summary.pagesVisited}\n` +
      `  findings      : critical ${t.critical} · high ${t.high} · medium ${t.medium} · low ${t.low} · info ${t.info}\n` +
      `  HTML  : ${OUT_HTML}\n` +
      `  JSON  : ${OUT_JSON}\n` +
      `  MD    : ${OUT_MD}\n` +
      `[bot] ==================\n`
  );

  // Cleanup unless explicitly told to keep.
  if (process.env.BOT_KEEP_DATA === "1" || process.env.E2E_KEEP_DATA === "1") {
    console.log("[bot] BOT_KEEP_DATA set — leaving seeded test data in place.");
    return;
  }
  const purged = await purgeAllTestData();
  console.log(`[bot] cleaned up {users:${purged.users}, orgs:${purged.orgs}, otps:${purged.otps}}`);
}
