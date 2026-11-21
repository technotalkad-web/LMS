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
 * of that date; widened by ADR 0029, the owner's answer of 2026-11-20): a job
 * in `erroredWarn` (lrs-forward, reminders and journey-nudges) whose
 * heartbeat is not stale and whose last_status is not "ok" reads "warn", on
 * production only. Staleness is read first and keeps its rules. Any other
 * job's errored last run still reads "ok"; its state says last-run-errored.
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

/**
 * `levels` holds what each job adds to the status (ok, warn or fail); the
 * route keeps it out of checks.crons, whose shape does not change, and reads
 * the two mail crons' levels for `mail_crons` from the same call.
 */
export function classifyCrons(input: {
  cadenceMin: Record<string, number>;
  staleWarnOnly: readonly string[];
  staleDegradedAfterMin: number;
  erroredWarn: readonly string[];
  rows: HeartbeatRow[];
  nowMs: number;
  expectCrons: boolean;
}): { status: "ok" | "warn" | "fail"; jobs: Record<string, CronJobState>; levels: Record<string, "ok" | "warn" | "fail"> } {
  const byName = new Map(input.rows.map((r) => [r.name, r]));
  const warnOnly = new Set(input.staleWarnOnly);
  const erroredWarn = new Set(input.erroredWarn);
  const jobs: Record<string, CronJobState> = {};
  const levels: Record<string, "ok" | "warn" | "fail"> = {};
  for (const [name, cadence] of Object.entries(input.cadenceMin)) {
    levels[name] = "ok";
    const row = byName.get(name);
    if (!row) {
      jobs[name] = { status: "never-seen" };
      if (input.expectCrons) levels[name] = "fail";
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
      if (erroredWarn.has(name) && row.last_status !== "ok") levels[name] = "warn";
      continue;
    }
    levels[name] = warnOnly.has(name) && ageMin <= input.staleDegradedAfterMin ? "warn" : "fail";
  }
  const all = Object.values(levels);
  return { status: all.includes("fail") ? "fail" : all.includes("warn") ? "warn" : "ok", jobs, levels };
}

/* ------------------------------------------------------------------------
 * ADR 0029 pull request B: the pure rules the health route, the console and
 * the two mail crons share. No I/O here; the callers read and write.
 * ---------------------------------------------------------------------- */

/**
 * The one ops_heartbeats row that is not a job (ADR 0029, note of 2026-11-19
 * on a skipped run): a request that mails nobody because the read of its
 * recipients failed writes it as an error, with one fixed word naming the
 * site. It is in no cadence list, so `crons` never shows it as a job.
 */
export const MAIL_RECIPIENTS_HEARTBEAT = "mail-recipients-unreadable";
/** How long the last such skip keeps `mail_recipients` at warn. */
export const MAIL_RECIPIENTS_WARN_HOURS = 24;

/**
 * `mail_recipients` (returned under email_checks). A skip row younger than
 * MAIL_RECIPIENTS_WARN_HOURS gives "warn"; a missing or older row gives
 * "ok"; a heartbeats read that failed gives "unknown". It never gives
 * "fail", nobody has to clear it, and OPS_EXPECT_CRONS does not gate it.
 */
export function classifyMailRecipients(input: {
  rows: Array<{ name: string; last_run_at: string }> | "unreadable";
  nowMs: number;
}): { status: "ok" | "warn" | "unknown"; last_skip_at: string | null } {
  if (input.rows === "unreadable") return { status: "unknown", last_skip_at: null };
  const row = input.rows.find((r) => r.name === MAIL_RECIPIENTS_HEARTBEAT);
  const at = row ? Date.parse(row.last_run_at) : NaN;
  if (!Number.isFinite(at)) return { status: "ok", last_skip_at: null };
  const iso = new Date(at).toISOString();
  const fresh = input.nowMs - at <= MAIL_RECIPIENTS_WARN_HOURS * 3_600_000;
  return { status: fresh ? "warn" : "ok", last_skip_at: iso };
}

/**
 * The vocabulary for a mail cron's own failed steps (ADR 0029). A heartbeat
 * or a page names a failure with one of these words and a count, so no
 * identifier, address, title or database text travels with it.
 */
export const CRON_ERROR_WORDS = [
  "config_read",
  "members_read",
  "assignments_read",
  "progress_read",
  "state_read",
  "state_write",
  "profiles_read",
  "mail_status_read",
  "log_write",
  "alert",
  "call_limit",
  "unknown",
] as const;
export type CronErrorWord = (typeof CRON_ERROR_WORDS)[number];
export type CronErrorCounts = Partial<Record<CronErrorWord, number>>;

/** The counts of one run of a mail cron (reminders, journey-nudges). An unknown number is left undefined. */
export type MailCronRun = {
  errors: CronErrorCounts;
  unreadableOrgs: number;
  stoppedBeforeSend: boolean;
  due?: number;
  sent?: number;
  failed?: number;
  left?: number;
  leftComplete?: boolean;
  leftDailyLimit?: number;
  leftOrgs?: number;
  no0114: boolean;
};

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** The numeric keys of the detail, in the order they are written. */
const DETAIL_COUNT_KEYS = ["failed_steps", "unreadable_orgs", "due", "sent", "failed", "left", "left_daily_limit", "left_orgs"] as const;
const DETAIL_FLAG_KEYS = ["stopped_before_send", "left_complete", "no_0114"] as const;

/**
 * Builds what reminders and journey-nudges return to the scheduler and what
 * they store in their heartbeat (ADR 0029). The scheduler's copy is printed
 * in a public workflow log, so it is flat: numbers and booleans, including a
 * total of failed steps but not their kinds. The heartbeat copy adds
 * `errors`, the per-word counts. Counts the run never established are
 * omitted rather than reported as zero. `extra` carries a route's existing
 * named counts into the scheduler's copy only.
 */
export function buildMailCronDetail(
  run: MailCronRun,
  extra: Record<string, number | boolean> = {}
): { ok: boolean; answer: Record<string, number | boolean>; heartbeat: Record<string, unknown> } {
  const errors: CronErrorCounts = {};
  let failedSteps = 0;
  for (const word of CRON_ERROR_WORDS) {
    const n = run.errors[word];
    if (isCount(n) && n > 0) {
      errors[word] = n;
      failedSteps += n;
    }
  }
  const unreadable = isCount(run.unreadableOrgs) ? run.unreadableOrgs : 0;
  const common: Record<string, number | boolean> = { v: 1, failed_steps: failedSteps, unreadable_orgs: unreadable, stopped_before_send: run.stoppedBeforeSend === true };
  const optional: Array<[string, unknown]> = [
    ["due", run.due],
    ["sent", run.sent],
    ["failed", run.failed],
    ["left", run.left],
    ["left_daily_limit", run.leftDailyLimit],
    ["left_orgs", run.leftOrgs],
  ];
  for (const [k, v] of optional) if (isCount(v)) common[k] = v;
  if (typeof run.leftComplete === "boolean") common.left_complete = run.leftComplete;
  common.no_0114 = run.no0114 === true;
  // `ok` is the run's verdict in both copies, as the two routes answered and
  // stored it before (part (k) of tests/unit/org-membership.test.ts reads it).
  const ok = failedSteps === 0 && unreadable === 0;
  common.ok = ok;
  const answer: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(extra)) if (isCount(v) || typeof v === "boolean") answer[k] = v;
  Object.assign(answer, common);
  const heartbeat: Record<string, unknown> = { ...common };
  if (failedSteps > 0) heartbeat.errors = errors;
  return { ok, answer, heartbeat };
}

/** A mail cron's heartbeat detail as the reader lets it through. `known` false: a row without v (older code, by hand, another job). */
export type MailCronDetail = {
  known: boolean;
  failed_steps?: number;
  unreadable_orgs?: number;
  due?: number;
  sent?: number;
  failed?: number;
  left?: number;
  left_daily_limit?: number;
  left_orgs?: number;
  stopped_before_send?: boolean;
  left_complete?: boolean;
  no_0114?: boolean;
  errors?: CronErrorCounts;
  last_ok_at?: string;
};

/** A time that parses, given back in one form; anything else is null. */
function parsableTime(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Parses a mail cron's stored last_detail defensively (ADR 0029). Only the
 * builder's own keys survive, and only with the right type: counts must be
 * non-negative integers, error keys must come from CRON_ERROR_WORDS, and
 * last_ok_at must be a parsable time (re-serialised). Anything else is
 * discarded, whoever wrote the row. Without `v: 1` the detail is unknown.
 */
export function readMailCronDetail(raw: unknown): MailCronDetail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { known: false };
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return { known: false };
  const out: MailCronDetail = { known: true };
  for (const k of DETAIL_COUNT_KEYS) if (isCount(r[k])) out[k] = r[k] as number;
  for (const k of DETAIL_FLAG_KEYS) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  if (r.errors && typeof r.errors === "object" && !Array.isArray(r.errors)) {
    const e = r.errors as Record<string, unknown>;
    const errors: CronErrorCounts = {};
    for (const word of CRON_ERROR_WORDS) {
      if (Object.prototype.hasOwnProperty.call(e, word) && isCount(e[word])) errors[word] = e[word] as number;
    }
    if (Object.keys(errors).length > 0) out.errors = errors;
  }
  const lastOk = parsableTime(r.last_ok_at);
  if (lastOk) out.last_ok_at = lastOk;
  return out;
}

/**
 * Works out last_ok_at for a run that failed, from the row as it stood
 * before this run (ADR 0029): a previous success contributes its own time,
 * a previous failure passes on whatever it carried. Every other case (no
 * previous row, a row without the field, a read error) yields null, which
 * the page shows as unknown; the time is never estimated.
 */
export function carriedLastOk(
  prev: { last_status: string; last_run_at: string; last_detail: unknown } | null | "unreadable"
): string | null {
  if (!prev || prev === "unreadable") return null;
  if (prev.last_status === "ok") return parsableTime(prev.last_run_at);
  return readMailCronDetail(prev.last_detail).last_ok_at ?? null;
}

/**
 * The last successful run as shown: the row's own time while it reads ok,
 * the carried one while it reads error. A row whose detail has no `v: 1`
 * shows null (not known) either way: older code wrote ok after a run whose
 * reads had failed, so its ok is not evidence of a success. carriedLastOk
 * keeps its own rule; this is the display reader only.
 */
export function lastSuccessfulRun(row: { last_status: string; last_run_at: string; last_detail?: unknown } | null): string | null {
  if (!row) return null;
  const detail = readMailCronDetail(row.last_detail);
  if (!detail.known) return null;
  return row.last_status === "ok" ? parsableTime(row.last_run_at) : detail.last_ok_at ?? null;
}

/** Pending reminders as shown: "not known" when the run did not count, "at least n" when its count was incomplete. */
export type PendingReading = { kind: "not_known" } | { kind: "exact"; n: number } | { kind: "at_least"; n: number };

export function pendingOf(detail: MailCronDetail): PendingReading {
  if (!detail.known || detail.left === undefined) return { kind: "not_known" };
  return detail.left_complete === false ? { kind: "at_least", n: detail.left } : { kind: "exact", n: detail.left };
}

/**
 * What the console shows for one mail cron (ADR 0029): when it last
 * succeeded, the parsed failure detail, and the reminders still owed. Each
 * part is null or not_known when the heartbeat row cannot supply it.
 */
export function mailCronItems(row: { last_status: string; last_run_at: string; last_detail?: unknown } | null): {
  lastOk: string | null;
  details: MailCronDetail | null;
  pending: PendingReading;
} {
  if (!row) return { lastOk: null, details: null, pending: { kind: "not_known" } };
  const detail = readMailCronDetail(row.last_detail);
  return { lastOk: lastSuccessfulRun(row), details: detail.known ? detail : null, pending: pendingOf(detail) };
}

/**
 * The pending count a mail cron reports (ADR 0029). For reminders it is the
 * mail never started, because any attempt marks the learner as reminded. For
 * journey-nudges a failed send also stays owed, since its claim is released,
 * except a timeout, whose claim is kept for the day.
 */
export function owedAfterRun(job: "reminders" | "journey-nudges", input: { notStarted: number; failedClasses: readonly string[] }): number {
  if (job === "reminders") return input.notStarted;
  return input.notStarted + input.failedClasses.filter((c) => c !== "timeout").length;
}

/** A tenant's SMTP reading (ADR 0029 section C). */
export type TenantReading = "not_configured" | "configured" | "healthy" | "failing";

/**
 * `tenant_smtp` (returned under email_checks; ADR 0029). Gives "warn" when
 * some organisation with members cannot send (failing or not configured) or
 * has reached the point where its routine mail stops for the day. Gives
 * "unknown" without readable status (including a database without 0114).
 * It never escalates to "fail": each tenant repairs its own server.
 */
export function classifyTenantSmtp(
  input: Array<{ reading: TenantReading; hasMembers: boolean; routineStopped: boolean }> | "unreadable" | "missing"
): { status: "ok" | "warn" | "unknown"; counts: Record<TenantReading | "routine_stopped", number> | null } {
  if (input === "unreadable" || input === "missing") return { status: "unknown", counts: null };
  const counts: Record<TenantReading | "routine_stopped", number> = { not_configured: 0, configured: 0, healthy: 0, failing: 0, routine_stopped: 0 };
  let warn = false;
  for (const o of input) {
    counts[o.reading]++;
    if (o.routineStopped) counts.routine_stopped++;
    if (o.hasMembers && (o.reading === "failing" || o.reading === "not_configured" || o.routineStopped)) warn = true;
  }
  return { status: warn ? "warn" : "ok", counts };
}

/** Code and link jobs the platform ended: `mail_jobs` warns at this many lost over today and yesterday (UTC). */
export const MAIL_JOBS_LOST_WARN = 3;
/** …or above this share lost, once this many have started (rule FP9's number). */
export const MAIL_JOBS_LOST_SHARE = 0.02;
export const MAIL_JOBS_SHARE_FROM = 50;

/**
 * `mail_jobs` (returned under email_checks; ADR 0029). "Lost" is jobs that
 * recorded a start but no finish, summed over the UTC days given (today and
 * yesterday). It warns from MAIL_JOBS_LOST_WARN lost, or once enough have
 * started for the share to mean something and the share exceeds
 * MAIL_JOBS_LOST_SHARE. Unreadable or absent counts give "unknown"; never "fail".
 */
export function classifyMailJobs(
  input: Array<{ started: number; finished: number }> | "unreadable" | "missing"
): { status: "ok" | "warn" | "unknown"; started: number | null; lost: number | null } {
  if (input === "unreadable" || input === "missing") return { status: "unknown", started: null, lost: null };
  let started = 0;
  let lost = 0;
  for (const r of input) {
    const s = isCount(r.started) ? r.started : 0;
    const f = isCount(r.finished) ? r.finished : 0;
    started += s;
    lost += Math.max(0, s - f);
  }
  const warn = lost >= MAIL_JOBS_LOST_WARN || (started >= MAIL_JOBS_SHARE_FROM && lost / started > MAIL_JOBS_LOST_SHARE);
  return { status: warn ? "warn" : "ok", started, lost };
}

/**
 * db fail → down; storage, crons or platformEmail fail → degraded; any warn →
 * warn. platformEmail, tenantSmtp, mailJobs and mailRecipients are given only
 * for a caller that holds the secret: the unauthenticated status is computed
 * without them (ADR 0029 section H). The last three never read above warn,
 * so they never make the status degraded, and "unknown" moves nothing. The
 * mail_crons check is no input: its reading is the crons check's own.
 */
export function overallStatus(c: {
  db: CheckStatus;
  storage: CheckStatus;
  crons: CheckStatus;
  lrsOutbox: CheckStatus;
  email: CheckStatus;
  platformEmail?: CheckStatus;
  tenantSmtp?: CheckStatus;
  mailJobs?: CheckStatus;
  mailRecipients?: CheckStatus;
}): OverallStatus {
  if (c.db === "fail") return "down";
  if (c.storage === "fail" || c.crons === "fail" || c.platformEmail === "fail") return "degraded";
  if ([c.crons, c.lrsOutbox, c.email, c.platformEmail, c.tenantSmtp, c.mailJobs, c.mailRecipients].includes("warn")) return "warn";
  return "ok";
}

/* ------------------------------------------------------------------------
 * ADR 0029 pull request B, stage 4: the two mail crons as the health check
 * (mail_crons, with the secret) and the console's "Reminder jobs" block show
 * them. Counts and fixed words only: everything comes through
 * readMailCronDetail, and every sentence below is fixed text.
 * ---------------------------------------------------------------------- */

/** The two mail crons. */
export const MAIL_CRON_JOBS = ["reminders", "journey-nudges"] as const;
export type MailCronJob = (typeof MAIL_CRON_JOBS)[number];

/**
 * The two mail crons' schedule rules, for a reader that is not the health
 * route (the console's page). The health route's lists are the source;
 * tests/unit/cron-cadence.test.ts holds these equal to their entries there.
 */
export const MAIL_CRON_SCHEDULE = {
  cadenceMin: { reminders: 26 * 60, "journey-nudges": 6 * 60 } as Record<MailCronJob, number>,
  staleWarnOnly: ["journey-nudges"] as readonly string[],
  staleDegradedAfterMin: 26 * 60,
  erroredWarn: ["reminders", "journey-nudges"] as readonly string[],
};

/** One mail cron as mail_crons answers it and the console shows it. */
export type MailCronJobReading = {
  state: CronJobState["status"];
  /** What the job adds to the crons check: ok when crons are not expected here. */
  level: "ok" | "warn" | "fail";
  last_run_at: string | null;
  /** The last successful run; null is "not known". */
  last_ok_at: string | null;
  /** The last run's failure details, as the reader lets them through; null when the row has none it can read. */
  failure: Omit<MailCronDetail, "known" | "last_ok_at"> | null;
  pending: PendingReading;
};

/**
 * `mail_crons` (returned under email_checks with the secret; ADR 0029, note
 * of 2026-11-20, part 2, point 8). Its status repeats what the crons check
 * reads for the two jobs, from the same classifyCrons call; it is not an
 * input of the overall status. "unknown" when the heartbeats cannot be read.
 */
export function classifyMailCrons(input: {
  rows: Array<{ name: string; last_run_at: string; last_status: string; last_detail?: unknown }> | "unreadable";
  crons: { jobs: Record<string, CronJobState>; levels: Record<string, "ok" | "warn" | "fail"> } | null;
  expectCrons: boolean;
}): { status: CheckStatus; expect_crons: boolean; jobs: Partial<Record<MailCronJob, MailCronJobReading>> } {
  if (input.rows === "unreadable" || !input.crons) return { status: "unknown", expect_crons: input.expectCrons, jobs: {} };
  const rows = input.rows;
  const jobs: Partial<Record<MailCronJob, MailCronJobReading>> = {};
  let worst: "ok" | "warn" | "fail" = "ok";
  for (const job of MAIL_CRON_JOBS) {
    const state = input.crons.jobs[job];
    if (!state) continue;
    const level = input.crons.levels[job] ?? "ok";
    if (level === "fail" || (level === "warn" && worst === "ok")) worst = level;
    const row = rows.find((r) => r.name === job) ?? null;
    const items = mailCronItems(row);
    let failure: MailCronJobReading["failure"] = null;
    if (items.details) {
      failure = {};
      for (const [k, v] of Object.entries(items.details)) {
        if (k !== "known" && k !== "last_ok_at") (failure as Record<string, unknown>)[k] = v;
      }
    }
    jobs[job] = {
      state: state.status,
      level,
      last_run_at: row ? parsableTime(row.last_run_at) : null,
      last_ok_at: items.lastOk,
      failure,
      pending: items.pending,
    };
  }
  return { status: worst, expect_crons: input.expectCrons, jobs };
}

/**
 * One fixed sentence for each word of a failed step (ADR 0029, note of
 * 2026-11-20, part 2, point 5, and the note of 2026-11-21 (later)). The
 * console shows these, with a count, and never a word it does not know.
 * call_limit has two sentences: see callLimitSentence.
 */
export const CRON_ERROR_SENTENCES: Record<Exclude<CronErrorWord, "call_limit">, string> = {
  config_read: "The job could not read its own settings (what has reminders on, or an organisation's time zone).",
  members_read: "The job could not read who belongs to an organisation, a team or a group, or who their line managers are.",
  assignments_read: "The job could not read the assignments or the journey enrolments.",
  progress_read: "The job could not read the learners' progress.",
  state_read: "The job could not read the record of earlier reminders.",
  state_write: "A record of mail that went could not be written, so that mail can go again.",
  profiles_read: "The job could not read the learners' or managers' email addresses.",
  mail_status_read: "The job could not read an organisation's email state and daily count; its mail was still tried, with no daily limit.",
  log_write: "The job could not write the log of the mail it tried.",
  alert: "The job could not send an organisation's SMTP alert that was due.",
  unknown: "Another step of the job failed.",
};

/**
 * call_limit, by whether the run stopped before it sent anything: the job's
 * own stop (it could not read who is due within one call), or the platform's
 * own refusal part-way through a run (rule FP8).
 */
export function callLimitSentence(stoppedBeforeSend: boolean): string {
  return stoppedBeforeSend
    ? "The job could not read who is due within one call, so nothing was sent. Waiting does not clear this."
    : "The job met the platform's limit on calls part-way through: what was sent is counted, and the rest waits for the next run.";
}

/** "n time(s)" after a sentence whose step failed more than once. */
const times = (n: number) => (n > 1 ? ` (${n} times)` : "");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The failure details of a mail cron's last run as fixed sentences: each
 * failed step's sentence with its count, the unreadable organisations, a
 * stop before any send, and, on a clean run only, the organisations or
 * programs that wait for the next run (on a failed run the step's own
 * sentence says what happens next). Counts and fixed words only; an empty
 * list when there is nothing to say.
 */
export function mailCronFailureSentences(failure: MailCronJobReading["failure"]): string[] {
  if (!failure) return [];
  const out: string[] = [];
  const errors = failure.errors ?? {};
  const clean = !CRON_ERROR_WORDS.some((w) => isCount(errors[w]) && (errors[w] as number) > 0) && !(isCount(failure.unreadable_orgs) && failure.unreadable_orgs > 0);
  for (const word of CRON_ERROR_WORDS) {
    const n = errors[word];
    if (!isCount(n) || n === 0) continue;
    const sentence = word === "call_limit" ? callLimitSentence(failure.stopped_before_send === true) : CRON_ERROR_SENTENCES[word];
    out.push(sentence + times(n));
  }
  if (isCount(failure.unreadable_orgs) && failure.unreadable_orgs > 0) {
    out.push(`${plural(failure.unreadable_orgs, "organisation", "organisations")} could not be read, so nobody there was reminded in that run.`);
  }
  if (failure.stopped_before_send === true && !(isCount(errors.call_limit) && errors.call_limit > 0)) {
    out.push("The run stopped before it sent anything.");
  }
  if (clean && isCount(failure.left_orgs) && failure.left_orgs > 0) {
    out.push(`${plural(failure.left_orgs, "organisation or program", "organisations or programs")} waited for the next run.`);
  }
  if (isCount(failure.left_daily_limit) && failure.left_daily_limit > 0) {
    out.push(`${plural(failure.left_daily_limit, "reminder was", "reminders were")} held by an organisation's daily email limit.`);
  }
  if (failure.no_0114 === true) {
    out.push("This database has no migration 0114 yet: no daily limit was applied and no email state was recorded.");
  }
  return out;
}

/** The pending reminders as shown: a number, "at least n", or "not known" with its reason. */
export function pendingSentence(pending: PendingReading, failure: MailCronJobReading["failure"]): string {
  if (pending.kind === "exact") return String(pending.n);
  if (pending.kind === "at_least") return `at least ${pending.n}`;
  return failure ? "not known: the run failed before it counted" : "not known";
}

/** The state of a mail cron as shown, and whether it counts here. */
export function cronStateSentence(state: CronJobState["status"], expectCrons: boolean): string {
  const base =
    state === "ok"
      ? "The last run ended cleanly."
      : state === "last-run-errored"
        ? "The last run failed."
        : state === "stale"
          ? "No run within its expected time."
          : "No run has been recorded.";
  return expectCrons ? base : `${base} Not scheduled here: shown, not counted.`;
}
