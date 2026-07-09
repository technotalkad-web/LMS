import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

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
 * heartbeats there are naturally stale and must not page anyone).
 */

type CheckStatus = "ok" | "warn" | "fail" | "unknown";
type Check = { status: CheckStatus; latency_ms?: number; detail?: unknown };

/** Expected max minutes between runs before a job counts as stale. */
const CRON_CADENCE_MIN: Record<string, number> = {
  "lrs-forward": 30, //           */5 schedule; generous for GH cron jitter
  billing: 26 * 60, //            daily 02:00 UTC
  reaper: 26 * 60, //             daily 03:00 UTC
  "refresh-report-views": 26 * 60, // daily 03:30 UTC
  reminders: 26 * 60, //          daily 06:00 UTC
  "rls-audit": 8 * 24 * 60, //    weekly (Mondays)
};

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
    const byName = new Map(
      ((data ?? []) as Array<{ name: string; last_run_at: string; last_status: string }>).map(
        (r) => [r.name, r]
      )
    );
    const jobs: Record<string, { status: string; last_run_at?: string; age_min?: number }> = {};
    let stale = 0;
    for (const [name, cadence] of Object.entries(CRON_CADENCE_MIN)) {
      const row = byName.get(name);
      if (!row) {
        jobs[name] = { status: "never-seen" };
        if (expectCrons) stale++;
        continue;
      }
      const ageMin = Math.round((Date.now() - new Date(row.last_run_at).getTime()) / 60_000);
      const isStale = ageMin > cadence;
      jobs[name] = {
        status: isStale ? "stale" : row.last_status === "ok" ? "ok" : "last-run-errored",
        last_run_at: row.last_run_at,
        age_min: ageMin,
      };
      if (isStale && expectCrons) stale++;
    }
    return {
      status: stale > 0 ? "fail" : "ok",
      detail: { expect_crons: expectCrons, jobs },
    };
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

  let status: "ok" | "warn" | "degraded" | "down" = "ok";
  if ([lrsOutbox, email].some((c) => c.status === "warn")) status = "warn";
  if (storage.status === "fail" || crons.status === "fail") status = "degraded";
  if (db.status === "fail") status = "down";

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
