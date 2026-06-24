/**
 * Shared types for the LMS testing bot.
 *
 * A "finding" is any defect the bot observes: a server error, an uncaught
 * exception, a console error, a broken link, an accessibility problem, a slow
 * page, a security/RBAC leak, or a failed journey assertion. Findings are the
 * atomic unit the report is built from.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type FindingCategory =
  | "server-error" // 5xx from the app
  | "page-exception" // uncaught JS error / white screen
  | "console-error" // console.error / React runtime error
  | "hydration" // React hydration mismatch
  | "broken-link" // in-app link that 404s / errors
  | "network" // unexpected 4xx/5xx XHR/fetch
  | "access-control" // RBAC / tenant-isolation / auth leak
  | "accessibility" // a11y violations
  | "performance" // slow navigation / heavy page
  | "form" // form validation / submit defect
  | "journey" // scripted user-journey assertion failure
  | "api-contract"; // API endpoint behaved unexpectedly

/** The role context a finding was observed under. */
export type BotRole =
  | "anonymous"
  | "learner"
  | "data_analyst"
  | "admin"
  | "platform_owner";

export interface Finding {
  /** Stable-ish hash so the same defect across pages dedupes in the report. */
  fingerprint: string;
  severity: Severity;
  category: FindingCategory;
  /** Short, human title. */
  title: string;
  /** Longer description / observed-vs-expected. */
  detail: string;
  /** Where it happened. */
  role: BotRole;
  url: string;
  /** Logical area, e.g. "admin/library", "super/organizations". */
  area?: string;
  /** Step-by-step reproduction. */
  repro: string[];
  /** Relative path to a screenshot under the report dir, if captured. */
  screenshot?: string;
  /** Captured console/network log tail relevant to the finding. */
  logs?: string[];
  /** Free-form extra metadata (status code, timing ms, selector, etc.). */
  meta?: Record<string, unknown>;
  /** ISO timestamp. */
  at: string;
}

export interface CrawlStat {
  role: BotRole;
  url: string;
  status: number | null;
  loadMs: number | null;
  ok: boolean;
}

export interface BotRunSummary {
  startedAt: string;
  finishedAt: string;
  baseURL: string;
  totals: Record<Severity, number>;
  byCategory: Record<string, number>;
  pagesVisited: number;
  apisProbed: number;
  findings: Finding[];
  crawlStats: CrawlStat[];
}
