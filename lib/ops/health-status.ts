/**
 * The status rules of GET /api/ops/health (app/api/ops/health/route.ts), kept
 * free of I/O so tests/unit/ops-health-status.test.ts can run them.
 *
 * Cron heartbeats (owner's decision of 2026-11-14; ADR 0007, the note of that
 * date on decision 4):
 *   - only when expectCrons is set (production) does a heartbeat count;
 *   - a job that has never written a heartbeat reads "fail" (degraded): no
 *     run at all is a fault, not a slow scheduler;
 *   - a stale job in `staleWarnOnly` (the jobs scheduled more than once a
 *     day) reads "warn" while its age is at most `staleDegradedAfterMin`,
 *     because GitHub starts only a share of their scheduled runs; past that
 *     age it reads "fail";
 *   - any other stale job reads "fail".
 *
 * An errored last run (the owner's decision of 2026-11-15; ADR 0024, the note
 * of that date): a job in `erroredWarn` whose heartbeat is not stale and whose
 * last_status is not "ok" reads "warn", on production only. Staleness is read
 * first and keeps its rules. Any other job's errored last run still reads
 * "ok"; its state says last-run-errored.
 *
 * Email (ADR 0029 section H, decision 5):
 *   - the `email` check counts failed notification_log rows of every event
 *     but password_reset and magic_link (EMAIL_CHECK_IGNORED_EVENTS), the
 *     two that a request without a session starts: the public status
 *     depends on no unauthenticated request;
 *   - `platform_email` (classifyPlatformEmail) is returned under its own key,
 *     email_checks, never under checks, so the watchdog's public summary
 *     never prints it; its "fail" makes the authenticated overall status
 *     "degraded" and its "warn" makes it "warn";
 *   - the unauthenticated status is overallStatus without platformEmail: no
 *     unauthenticated request moves it.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";
export type OverallStatus = "ok" | "warn" | "degraded" | "down";

/** The notification_log events the `email` check does not count (ADR 0029 section H). */
export const EMAIL_CHECK_IGNORED_EVENTS = ["password_reset", "magic_link"] as const;

/** A platform send that failed on the sender's side: these move `platform_email`. */
export const PLATFORM_SENDER_FAILURE_CLASSES = ["auth", "quota", "timeout", "unreachable", "unknown"] as const;
/** A failure of one of these classes means the sender is dead until someone acts. */
const PLATFORM_DEAD_AT_ONCE = new Set(["auth", "quota"]);

export type PlatformEmailReason =
  | "not_configured"
  | "log_unreadable"
  | "sender_dead"
  | "two_failures"
  | "last_failed"
  | "at_ceiling"
  | "half_ceiling";

/**
 * `platform_email` (ADR 0029 section H):
 *   fail  the sender is not configured (read from which variables are
 *         present, so it shows before anyone asks for a code);
 *   fail  the log cannot be read (the sender then sends nothing);
 *   fail  the newest sent-or-sender-failed row is a failure of class auth or
 *         quota, or the two newest such rows are both failures; no time
 *         window: it stays until a later delivery (a delivered test clears
 *         it);
 *   warn  only the newest such row is a failure of class timeout,
 *         unreachable or unknown (that mail may still have arrived);
 *   fail  at the daily ceiling; warn at half of it.
 * Suppressed, refused and rejected rows never move it, and neither does a
 * not_configured row (the variables decide that, so a stale one cannot keep
 * the check failing after the setup).
 *
 * `newest` is the newest rows, newest first; any row that is not "sent" or a
 * sender-side failure is ignored here, and only the first two of the rest
 * are read.
 */
export function classifyPlatformEmail(input: {
  configured: boolean;
  logReadable: boolean;
  newest: Array<{ status: string; error_code: string | null }>;
  sent24h: number;
  ceiling: number;
}): { status: "ok" | "warn" | "fail"; reasons: PlatformEmailReason[] } {
  const fails: PlatformEmailReason[] = [];
  const warns: PlatformEmailReason[] = [];
  if (!input.configured) fails.push("not_configured");
  if (!input.logReadable) {
    fails.push("log_unreadable");
  } else {
    const senderFailure = (r: { status: string; error_code: string | null }) =>
      r.status === "failed" && (PLATFORM_SENDER_FAILURE_CLASSES as readonly string[]).includes(r.error_code ?? "");
    const relevant = input.newest.filter((r) => r.status === "sent" || senderFailure(r)).slice(0, 2);
    const [r0, r1] = relevant;
    if (r0 && senderFailure(r0)) {
      const dead = PLATFORM_DEAD_AT_ONCE.has(r0.error_code ?? "");
      const two = r1 !== undefined && senderFailure(r1);
      if (dead) fails.push("sender_dead");
      if (two) fails.push("two_failures");
      if (!dead && !two) warns.push("last_failed");
    }
    if (input.sent24h >= input.ceiling) fails.push("at_ceiling");
    else if (input.sent24h >= input.ceiling / 2) warns.push("half_ceiling");
  }
  const status = fails.length > 0 ? "fail" : warns.length > 0 ? "warn" : "ok";
  return { status, reasons: [...fails, ...warns] };
}

export type HeartbeatRow = { name: string; last_run_at: string; last_status: string };
export type CronJobState = {
  status: "ok" | "stale" | "never-seen" | "last-run-errored";
  last_run_at?: string;
  age_min?: number;
};

export function classifyCrons(input: {
  cadenceMin: Record<string, number>;
  staleWarnOnly: readonly string[];
  staleDegradedAfterMin: number;
  erroredWarn: readonly string[];
  rows: HeartbeatRow[];
  nowMs: number;
  expectCrons: boolean;
}): { status: "ok" | "warn" | "fail"; jobs: Record<string, CronJobState> } {
  const byName = new Map(input.rows.map((r) => [r.name, r]));
  const warnOnly = new Set(input.staleWarnOnly);
  const erroredWarn = new Set(input.erroredWarn);
  const jobs: Record<string, CronJobState> = {};
  let failing = 0;
  let warning = 0;
  for (const [name, cadence] of Object.entries(input.cadenceMin)) {
    const row = byName.get(name);
    if (!row) {
      jobs[name] = { status: "never-seen" };
      if (input.expectCrons) failing++;
      continue;
    }
    const ageMin = Math.round((input.nowMs - new Date(row.last_run_at).getTime()) / 60_000);
    const isStale = ageMin > cadence;
    jobs[name] = {
      status: isStale ? "stale" : row.last_status === "ok" ? "ok" : "last-run-errored",
      last_run_at: row.last_run_at,
      age_min: ageMin,
    };
    if (!input.expectCrons) continue;
    if (!isStale) {
      if (erroredWarn.has(name) && row.last_status !== "ok") warning++;
      continue;
    }
    if (warnOnly.has(name) && ageMin <= input.staleDegradedAfterMin) warning++;
    else failing++;
  }
  return { status: failing > 0 ? "fail" : warning > 0 ? "warn" : "ok", jobs };
}

/**
 * db fail → down; storage, crons or platformEmail fail → degraded; any warn →
 * warn. platformEmail is given only for a caller that holds the secret: the
 * unauthenticated status is computed without it (ADR 0029 section H).
 */
export function overallStatus(c: {
  db: CheckStatus;
  storage: CheckStatus;
  crons: CheckStatus;
  lrsOutbox: CheckStatus;
  email: CheckStatus;
  platformEmail?: CheckStatus;
}): OverallStatus {
  if (c.db === "fail") return "down";
  if (c.storage === "fail" || c.crons === "fail" || c.platformEmail === "fail") return "degraded";
  if ([c.crons, c.lrsOutbox, c.email, c.platformEmail].includes("warn")) return "warn";
  return "ok";
}
