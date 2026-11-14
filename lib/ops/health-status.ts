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
 */

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";
export type OverallStatus = "ok" | "warn" | "degraded" | "down";

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
  rows: HeartbeatRow[];
  nowMs: number;
  expectCrons: boolean;
}): { status: "ok" | "warn" | "fail"; jobs: Record<string, CronJobState> } {
  const byName = new Map(input.rows.map((r) => [r.name, r]));
  const warnOnly = new Set(input.staleWarnOnly);
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
    if (!isStale || !input.expectCrons) continue;
    if (warnOnly.has(name) && ageMin <= input.staleDegradedAfterMin) warning++;
    else failing++;
  }
  return { status: failing > 0 ? "fail" : warning > 0 ? "warn" : "ok", jobs };
}

/** db fail → down; storage or crons fail → degraded; any warn → warn. */
export function overallStatus(c: {
  db: CheckStatus;
  storage: CheckStatus;
  crons: CheckStatus;
  lrsOutbox: CheckStatus;
  email: CheckStatus;
}): OverallStatus {
  if (c.db === "fail") return "down";
  if (c.storage === "fail" || c.crons === "fail") return "degraded";
  if ([c.crons, c.lrsOutbox, c.email].includes("warn")) return "warn";
  return "ok";
}
