import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  EMAIL_CHECK_IGNORED_EVENTS,
  classifyCrons,
  classifyMailCrons,
  classifyMailJobs,
  classifyMailRecipients,
  classifyTenantSmtp,
  overallStatus,
  type CheckStatus,
  type CronJobState,
  type HeartbeatRow,
} from "@/lib/ops/health-status";
import { readPlatformEmailHealth } from "@/lib/email/platform-health";
import { readMailJobCounts, readTenantSmtpOverview } from "@/lib/notifications/smtp-state";

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
 *   email       notification_log failures in last 24h,        breach → WARN
 *               password_reset and magic_link not counted, nor
 *               rows with the error daily_limit
 *
 * Under email_checks, not checks (ADR 0029 section H), with the secret only:
 *   platform_email   the platform sender (lib/email/platform-health.ts)
 *                    fail → DEGRADED, warn → WARN
 *   tenant_smtp      organisations by reading: warn while one with an
 *                    active member is failing, not configured, past the
 *                    line where its routine mail stops (a line above 0),
 *                    or at its full limit; a limit with routine mail off
 *                    below it is a setting (routine_off); never fail
 *   mail_jobs        code and link jobs the platform ended (today and
 *                    yesterday, UTC); warn, never fail
 *   mail_recipients  warn for 24 hours after a request skipped its mail
 *                    because its recipients could not be read; never fail
 *   mail_crons       the two mail crons: state, last run, last successful
 *                    run, failure details and pending reminders. Its
 *                    status repeats what crons reads for them; it is no
 *                    input of the overall status
 * tenant_smtp and mail_jobs read unknown without migration 0114, and
 * unknown moves nothing. The watchdog's public summary prints checks only,
 * so it never names them. The unauthenticated { status } is computed
 * without them, they are not run for a caller without the secret, and the
 * heartbeats' last_detail is read only for a caller with it: no
 * unauthenticated request moves the unauthenticated status.
 *
 * *Cron staleness only affects overall status when OPS_EXPECT_CRONS=1 is set on
 * the worker (true on PROD, where cron.yml fires; staging has no schedule, so
 * heartbeats there are naturally stale and must not page anyone). A stale job
 * of SUBDAILY_STALE_WARN reads WARN instead, up to SUBDAILY_STALE_DEGRADED_MIN;
 * a job never seen reads DEGRADED; a job of ERRORED_WARN whose last run errored
 * reads WARN (lib/ops/health-status.ts).
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

/**
 * The jobs whose errored last run reads "warn" while their heartbeat is fresh
 * (the owner's decision of 2026-11-15; ADR 0024, the note of that date;
 * widened by the owner's answer of 2026-11-20, ADR 0029, note of that date,
 * part 2). lrs-forward reports not-OK when its preview check or its park
 * write fails (app/api/cron/lrs-forward/route.ts); reminders and
 * journey-nudges when one of their own database reads or writes failed or
 * they met the platform's call limit, never for a tenant's failed send. Any
 * other job's errored run still reads "ok". Production only, as every
 * heartbeat rule. tests/unit/cron-cadence.test.ts checks the list.
 */
const ERRORED_WARN = ["lrs-forward", "reminders", "journey-nudges"];

const OUTBOX_BACKLOG_WARN = 50; // overdue-but-undelivered statements
const EMAIL_FAILURES_WARN = 5; // failed sends in the last 24h

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/**
 * For the checks of email_checks that never read fail: a throw reads
 * "unknown", with no message.
 */
async function timedUnknown(fn: () => Promise<Omit<Check, "latency_ms">>): Promise<Check> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, latency_ms: Date.now() - t0 };
  } catch {
    return { status: "unknown", latency_ms: Date.now() - t0 };
  }
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

type HeartbeatRows = Array<HeartbeatRow & { last_detail?: unknown }> | "unreadable";

/**
 * The crons check, from one read of ops_heartbeats. last_detail is selected
 * only for a caller with the secret (the mail crons' details); the same
 * rows serve mail_recipients and mail_crons. `levels` is the one call's
 * answer for each job, kept out of checks.crons.
 */
async function checkCrons(
  expectCrons: boolean,
  withDetail: boolean
): Promise<{ check: Check; rows: HeartbeatRows; crons: { jobs: Record<string, CronJobState>; levels: Record<string, "ok" | "warn" | "fail"> } | null }> {
  let rows: HeartbeatRows = "unreadable";
  let crons: { jobs: Record<string, CronJobState>; levels: Record<string, "ok" | "warn" | "fail"> } | null = null;
  const check = await timed(async () => {
    const { data, error } = await svc()
      .from("ops_heartbeats")
      .select(withDetail ? "name, last_run_at, last_status, last_detail" : "name, last_run_at, last_status");
    if (error) {
      // Table missing (migration 0050 not applied) — visible, but not a page.
      return { status: "unknown", detail: error.message };
    }
    rows = (data ?? []) as unknown as Array<HeartbeatRow & { last_detail?: unknown }>;
    const { status, jobs, levels } = classifyCrons({
      cadenceMin: CRON_CADENCE_MIN,
      staleWarnOnly: SUBDAILY_STALE_WARN,
      staleDegradedAfterMin: SUBDAILY_STALE_DEGRADED_MIN,
      erroredWarn: ERRORED_WARN,
      rows: rows.map((r) => ({ name: r.name, last_run_at: r.last_run_at, last_status: r.last_status })),
      nowMs: Date.now(),
      expectCrons,
    });
    crons = { jobs, levels };
    return { status, detail: { expect_crons: expectCrons, jobs } };
  });
  return { check, rows, crons };
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

// The check counts only events that a signed-in person or the system starts
// (ADR 0029 section H): reset codes and sign-in links, which a request
// without a session starts, are not counted, so the public status depends on
// no unauthenticated request. Every other event is counted as before.
const EMAIL_CHECK_EVENTS_FILTER = `(${EMAIL_CHECK_IGNORED_EVENTS.join(",")})`;
// A failed row whose error is daily_limit is a stop at an organisation's
// daily limit, not a failed send: tenant_smtp carries it (rule FP8). A row
// with no error is counted, as before.
const EMAIL_CHECK_NOT_DAILY_LIMIT = "error.is.null,error.neq.daily_limit";

async function checkEmail(): Promise<Check> {
  return timed(async () => {
    const db = svc();
    const sinceIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { count: failed, error } = await db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .not("event_type", "in", EMAIL_CHECK_EVENTS_FILTER)
      .or(EMAIL_CHECK_NOT_DAILY_LIMIT)
      .gte("sent_at", sinceIso);
    if (error) return { status: "unknown", detail: error.message };
    const { count: sent } = await db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .not("event_type", "in", EMAIL_CHECK_EVENTS_FILTER)
      .gte("sent_at", sinceIso);
    return {
      status: (failed ?? 0) > EMAIL_FAILURES_WARN ? "warn" : "ok",
      detail: { failed_24h: failed ?? 0, sent_24h: sent ?? 0 },
    };
  });
}

/** The platform sender (ADR 0029 section H); returned under email_checks only. */
async function checkPlatformEmail(): Promise<Check> {
  return timed(async () => {
    const h = await readPlatformEmailHealth(svc());
    return {
      status: h.status,
      detail: {
        configured: h.configured,
        missing: h.missing,
        reasons: h.reasons,
        last_at: h.newest?.sent_at ?? null,
        last_status: h.newest?.status ?? null,
        last_error_code: h.newest?.error_code ?? null,
        sent_24h: h.sent24h,
        ceiling: h.ceiling,
      },
    };
  });
}

/** `tenant_smtp` (ADR 0029 section H; rule FP8): counts by reading, from one call for every organisation. */
async function checkTenantSmtp(): Promise<Check> {
  return timedUnknown(async () => {
    const overview = await readTenantSmtpOverview(svc());
    if (overview.kind !== "ok") {
      const r = classifyTenantSmtp(overview.kind);
      return { status: r.status, detail: { no_0114: overview.kind === "missing" } };
    }
    const r = classifyTenantSmtp(
      overview.rows.map((o) => ({ reading: o.reading, hasMembers: o.hasMembers === true, routineStopped: o.routineStopped, routineOff: o.routineOff, atLimit: o.atLimit }))
    );
    return { status: r.status, detail: { organisations: overview.rows.length, ...r.counts, no_0114: false } };
  });
}

/** `mail_jobs` (rule FP3): code and link jobs started and lost, today and yesterday (UTC). */
async function checkMailJobs(): Promise<Check> {
  return timedUnknown(async () => {
    const days = await readMailJobCounts(svc());
    const r = classifyMailJobs(days);
    if (r.started === null || r.lost === null) return { status: r.status, detail: { no_0114: days === "missing" } };
    return { status: r.status, detail: { started: r.started, lost: r.lost, no_0114: false } };
  });
}

export async function GET(request: Request) {
  const expectCrons = process.env.OPS_EXPECT_CRONS === "1";
  const authed =
    !!process.env.CRON_SECRET &&
    request.headers.get("x-cron-secret") === process.env.CRON_SECRET;

  const [db, storage, cronRead, lrsOutbox, email, platformEmail, tenantSmtp, mailJobs] = await Promise.all([
    checkDb(),
    checkStorage(),
    checkCrons(expectCrons, authed),
    checkLrsOutbox(),
    checkEmail(),
    authed ? checkPlatformEmail() : Promise.resolve(null),
    authed ? checkTenantSmtp() : Promise.resolve(null),
    authed ? checkMailJobs() : Promise.resolve(null),
  ]);
  const crons = cronRead.check;

  const base = {
    db: db.status,
    storage: storage.status,
    crons: crons.status,
    lrsOutbox: lrsOutbox.status,
    email: email.status,
  };

  if (!authed || !platformEmail || !tenantSmtp || !mailJobs) {
    // Without the email_checks: no unauthenticated request moves this status.
    const status = overallStatus(base);
    return NextResponse.json(
      { status, ts: new Date().toISOString() },
      { status: status === "down" ? 503 : 200 }
    );
  }
  // From the one heartbeats read: the last skip, and the two mail crons.
  const recipients = classifyMailRecipients({ rows: cronRead.rows, nowMs: Date.now() });
  const mailRecipients: Check = { status: recipients.status, detail: { last_skip_at: recipients.last_skip_at } };
  const mc = classifyMailCrons({ rows: cronRead.rows, crons: cronRead.crons, expectCrons });
  const mailCrons: Check = { status: mc.status, detail: { expect_crons: mc.expect_crons, jobs: mc.jobs } };
  const status = overallStatus({
    ...base,
    platformEmail: platformEmail.status,
    tenantSmtp: tenantSmtp.status,
    mailJobs: mailJobs.status,
    mailRecipients: mailRecipients.status,
  });
  return NextResponse.json(
    {
      status,
      ts: new Date().toISOString(),
      expect_crons: expectCrons,
      checks: { db, storage, crons, lrs_outbox: lrsOutbox, email },
      email_checks: {
        platform_email: platformEmail,
        tenant_smtp: tenantSmtp,
        mail_jobs: mailJobs,
        mail_recipients: mailRecipients,
        mail_crons: mailCrons,
      },
    },
    { status: status === "down" ? 503 : 200 }
  );
}
