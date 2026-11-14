import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  classifyCrons,
  overallStatus,
  type CheckStatus,
  type HeartbeatRow,
} from "@/lib/ops/health-status";

export const dynamic = "force-dynamic";

/**
 *   GET /api/ops/health
 *
 * Deep health probe — the primary signal for the ops watchdog
 * (.github/workflows/ops-watch.yml) and the AI ops review (ops/RUNBOOK.md).
 *
 * Unauthenticated:                 { status, ts }            (safe for uptime robots)
 * With x-cron-secret: CRON_SECRET: full per-check breakdown.
 *
 * Checks (each independently try/caught; one broken probe never hides the rest):
 *   db          service-role query on organizations           fail → DOWN
 *   storage     list buckets                                  fail → DEGRADED
 *   crons       ops_heartbeats freshness vs expected cadence  stale → DEGRADED*
 *   lrs_outbox  pending/failed backlog + dead letters         breach → WARN
 *   email       notification_log failures in last 24h         breach → WARN
 *
 * *Cron staleness only affects overall status when OPS_EXPECT_CRONS=1 is set on
 * the worker (true on PROD, where cron.yml fires; staging has no schedule, so
 * heartbeats there are naturally stale and must not page anyone). A stale job
 * of SUBDAILY_STALE_WARN reads WARN instead, up to SUBDAILY_STALE_DEGRADED_MIN;
 * a job never seen reads DEGRADED (lib/ops/health-status.ts).
 */

type Check = { status: CheckStatus; latency_ms?: number; detail?: unknown };

/**
 * Expected max minutes between runs before a job counts as stale.
 *
 * An entry is added only once its .github/workflows/cron.yml schedule fires
 * and its route is live on production: a schedule fires on production as
 * soon as it is on main, and an entry whose schedule is not firing pages the
 * watchdog (docs/ARCHITECTURE.md §9, ADR 0007 step 7). So no
 * "report-card-refresh" entry yet: its schedule line and case arm are
 * removed before v1.3.0 and re-added after the deploy is verified; its entry
 * ships in the next tag. tests/unit/cron-cadence.test.ts checks this list
 * against cron.yml and the cron routes' heartbeat names.
 *
 * GitHub starts only a small share of scheduled runs (ADR 0007 Context), so
 * the sub-daily entries read stale most of the time; ADR 0007 step 17 and
 * decision 4 accept that until pg_cron replaces GitHub-driven schedules, and
 * SUBDAILY_STALE_WARN below keeps it from reading degraded.
 */
const CRON_CADENCE_MIN: Record<string, number> = {
  "lrs-forward": 30, //           */5 schedule; generous for GH cron jitter
  "gamification-refresh": 90, //  7-59/15 schedule; 6x the interval, as lrs-forward
  "journey-nudges": 6 * 60, //    hourly (since #155); 6x the interval, as lrs-forward
  billing: 26 * 60, //            daily 02:00 UTC
  reaper: 26 * 60, //             daily 03:00 UTC
  "refresh-report-views": 26 * 60, // daily 03:30 UTC
  reminders: 26 * 60, //          daily 06:00 UTC
  "rls-audit": 8 * 24 * 60, //    weekly (Mondays)
  "gamification-monthly": 32 * 24 * 60, // monthly (1st, 00:30 UTC); longest month + 1 day
};

/**
 * The jobs scheduled more than once a day. A stale heartbeat of one of these
 * reads "warn", not "degraded" (the owner's decision of 2026-11-14; ADR 0007,
 * the note of that date on decision 4), until it is older than
 * SUBDAILY_STALE_DEGRADED_MIN: GitHub's gaps between runs of one of these
 * jobs measured at most about 10.5 hours (5–14 Nov 2026), so a day and more
 * without a run is a fault, not a slow scheduler, and reads "degraded".
 * tests/unit/cron-cadence.test.ts checks this list against cron.yml.
 */
const SUBDAILY_STALE_WARN = ["lrs-forward", "gamification-refresh", "journey-nudges"];
const SUBDAILY_STALE_DEGRADED_MIN = 26 * 60;

const OUTBOX_BACKLOG_WARN = 50; // overdue-but-undelivered statements
const EMAIL_FAILURES_WARN = 5; // failed sends in the last 24h

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function timed(fn: () => Promise<Omit<Check, "latency_ms">>): Promise<Check> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, latency_ms: Date.now() - t0 };
  } catch (e) {
    return {
      status: "fail",
      latency_ms: Date.now() - t0,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkDb(): Promise<Check> {
  return timed(async () => {
    const { error } = await svc()
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .limit(1);
    return error ? { status: "fail", detail: error.message } : { status: "ok" };
  });
}

async function checkStorage(): Promise<Check> {
  return timed(async () => {
    const { error } = await svc().storage.listBuckets();
    return error ? { status: "fail", detail: error.message } : { status: "ok" };
  });
}

async function checkCrons(expectCrons: boolean): Promise<Check> {
  return timed(async () => {
    const { data, error } = await svc()
      .from("ops_heartbeats")
      .select("name, last_run_at, last_status");
    if (error) {
      // Table missing (migration 0050 not applied) — visible, but not a page.
      return { status: "unknown", detail: error.message };
    }
    const { status, jobs } = classifyCrons({
      cadenceMin: CRON_CADENCE_MIN,
      staleWarnOnly: SUBDAILY_STALE_WARN,
      staleDegradedAfterMin: SUBDAILY_STALE_DEGRADED_MIN,
      rows: (data ?? []) as HeartbeatRow[],
      nowMs: Date.now(),
      expectCrons,
    });
    return { status, detail: { expect_crons: expectCrons, jobs } };
  });
}

async function checkLrsOutbox(): Promise<Check> {
  return timed(async () => {
    const db = svc();
    const overdueIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const { count: backlog, error: e1 } = await db
      .from("lrs_forward_outbox")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "failed"])
      .lte("next_attempt_at", overdueIso);
    if (e1) return { status: "unknown", detail: e1.message };
    const { count: dead } = await db
      .from("lrs_forward_outbox")
      .select("id", { count: "exact", head: true })
      .eq("status", "dead");
    const breach = (backlog ?? 0) > OUTBOX_BACKLOG_WARN || (dead ?? 0) > 0;
    return {
      status: breach ? "warn" : "ok",
      detail: { overdue_backlog: backlog ?? 0, dead_letters: dead ?? 0 },
    };
  });
}

async function checkEmail(): Promise<Check> {
  return timed(async () => {
    const db = svc();
    const sinceIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { count: failed, error } = await db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("sent_at", sinceIso);
    if (error) return { status: "unknown", detail: error.message };
    const { count: sent } = await db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .gte("sent_at", sinceIso);
    return {
      status: (failed ?? 0) > EMAIL_FAILURES_WARN ? "warn" : "ok",
      detail: { failed_24h: failed ?? 0, sent_24h: sent ?? 0 },
    };
  });
}

export async function GET(request: Request) {
  const expectCrons = process.env.OPS_EXPECT_CRONS === "1";
  const [db, storage, crons, lrsOutbox, email] = await Promise.all([
    checkDb(),
    checkStorage(),
    checkCrons(expectCrons),
    checkLrsOutbox(),
    checkEmail(),
  ]);

  const status = overallStatus({
    db: db.status,
    storage: storage.status,
    crons: crons.status,
    lrsOutbox: lrsOutbox.status,
    email: email.status,
  });

  const authed =
    !!process.env.CRON_SECRET &&
    request.headers.get("x-cron-secret") === process.env.CRON_SECRET;

  const httpStatus = status === "down" ? 503 : 200;
  if (!authed) {
    return NextResponse.json({ status, ts: new Date().toISOString() }, { status: httpStatus });
  }
  return NextResponse.json(
    {
      status,
      ts: new Date().toISOString(),
      expect_crons: expectCrons,
      checks: { db, storage, crons, lrs_outbox: lrsOutbox, email },
    },
    { status: httpStatus }
  );
}
