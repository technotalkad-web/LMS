/**
 * Canonical filesystem locations for bot output. Centralised so the sink
 * (writer), the report generator (reader), and the global hooks all agree.
 *
 * Override the root with BOT_REPORT_DIR if you want CI to collect it from a
 * custom path.
 */

import path from "node:path";

export const REPORT_ROOT =
  process.env.BOT_REPORT_DIR ?? path.resolve(__dirname, "..", "..", "..", "bot-report");

/** Per-worker raw finding/stat shards. Aggregated by global-teardown. */
export const RAW_DIR = path.join(REPORT_ROOT, "raw");
export const SCREENSHOT_DIR = path.join(REPORT_ROOT, "screenshots");

/** Seed handle written by global-setup, read by every spec. */
export const SEED_FILE = path.join(REPORT_ROOT, "seed.json");

export const OUT_JSON = path.join(REPORT_ROOT, "findings.json");
export const OUT_MD = path.join(REPORT_ROOT, "bug-report.md");
export const OUT_HTML = path.join(REPORT_ROOT, "index.html");
