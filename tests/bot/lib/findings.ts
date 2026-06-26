/**
 * Findings sink.
 *
 * Playwright runs each spec file in a separate worker *process*, so an
 * in-memory collector cannot aggregate across the whole run. Instead each
 * worker appends newline-delimited JSON to its own shard file under
 * bot-report/raw/. global-teardown reads every shard, dedupes by fingerprint,
 * and renders the final report. Per-worker filenames avoid interleaved-write
 * corruption that a single shared file would risk on Windows.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { RAW_DIR, SCREENSHOT_DIR } from "./paths";
import type {
  BotRole,
  CrawlStat,
  Finding,
  FindingCategory,
  Severity,
} from "./types";

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

const FINDING_SHARD = path.join(RAW_DIR, `findings-${process.pid}.jsonl`);
const STAT_SHARD = path.join(RAW_DIR, `stats-${process.pid}.jsonl`);

let counter = 0;

export function fingerprint(parts: Array<string | undefined>): string {
  return createHash("sha1")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 12);
}

export interface RecordInput {
  severity: Severity;
  category: FindingCategory;
  title: string;
  detail: string;
  role: BotRole;
  url: string;
  area?: string;
  repro?: string[];
  logs?: string[];
  meta?: Record<string, unknown>;
  /** Override the auto-derived fingerprint (e.g. to dedupe across pages). */
  fingerprint?: string;
  /** When provided, a screenshot is captured and linked. */
  page?: Page;
}

/** Record a finding. Best-effort: never throws (a sink failure must not fail the run). */
export async function record(input: RecordInput): Promise<void> {
  try {
    ensureDir(RAW_DIR);

    const fp =
      input.fingerprint ??
      fingerprint([input.category, input.title, input.area ?? input.url]);

    let screenshot: string | undefined;
    if (input.page) {
      try {
        ensureDir(SCREENSHOT_DIR);
        const name = `${fp}-${process.pid}-${counter++}.png`;
        await input.page.screenshot({
          path: path.join(SCREENSHOT_DIR, name),
          fullPage: true,
          timeout: 8_000,
        });
        screenshot = path.posix.join("screenshots", name);
      } catch {
        /* screenshot is best-effort */
      }
    }

    const finding: Finding = {
      fingerprint: fp,
      severity: input.severity,
      category: input.category,
      title: input.title,
      detail: input.detail,
      role: input.role,
      url: input.url,
      area: input.area,
      repro: input.repro ?? [],
      screenshot,
      logs: input.logs,
      meta: input.meta,
      at: new Date().toISOString(),
    };

    fs.appendFileSync(FINDING_SHARD, JSON.stringify(finding) + "\n");
  } catch {
    /* swallow: the bot observing a defect must never crash the bot */
  }
}

/** Record a successful/attempted page visit for coverage accounting. */
export function recordStat(stat: CrawlStat): void {
  try {
    ensureDir(RAW_DIR);
    fs.appendFileSync(STAT_SHARD, JSON.stringify(stat) + "\n");
  } catch {
    /* best-effort */
  }
}
