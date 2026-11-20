/**
 * A tenant's SMTP state, the run of its mail, and its alert (ADR 0029
 * sections C, E and G; rules T1 to T5 and FP2 to FP4 of the notes of
 * 2026-11-18; the notes of 2026-11-19 and 2026-11-20).
 *
 * A run is the mail of one organisation inside one request or cron call. It
 * opens with three reads made together: the organisation's notification
 * settings, its name and deleted_at, and tenant_mail_status (migration 0114),
 * which gives the stored state row and the organisation's sent mail of the
 * last 24 hours in one call. Every mail of the run is decided on what was
 * read then, and the run carries its own count:
 *   - the reading (section C): not_configured (host, port or From missing,
 *     or the organisation deleted), configured, healthy, failing;
 *   - the pause, which never stops password_reset and magic_link (D1); the
 *     old pass of custom_broadcast is kept as it was;
 *   - the stop rule: on an organisation already failing, the run's first
 *     send is a probe and a failed probe ends the run; otherwise the run
 *     ends when nextState() turns the organisation failing (auth and quota
 *     do so on the first failure; timeout, unreachable and unknown need
 *     FLIP_AFTER_PEOPLE different recipients; rejected never does);
 *   - the daily limit (rule FP4): routine events halt at routineStop, the
 *     limit minus a reserve of max(25, ceil(limit / 10)); the events of
 *     RESERVE_EVENTS may use that reserve; once the full limit is reached
 *     no event is attempted;
 *   - the shape (rule T4): the first send goes alone, the rest at most
 *     SENDS_AT_ONCE at a time, one log insert for each group;
 *   - the two budgets of the request or the cron call (rules T4, T5, FP2):
 *     no send starts past its window, and the call sum stays within
 *     CALL_SUM_LIMIT. What a budget leaves is reported as left, never
 *     dropped in silence.
 * nextState() decides when the state row is written (see there). An alert
 * is never sent from here during a run: markAlertDue sets alert_due_at with
 * one conditional update that respects section E's spacing, and
 * sendDueAlert, called only by a scheduled job (rule FP3), mails at most
 * one such alert per call.
 *
 * Without migration 0114 (production until its own sitting): the RPC
 * tenant_mail_status does not exist, which isSchemaMissing recognises by
 * the error code. The run then treats complete settings as ready, skips the
 * daily limit, writes no state and marks no alert. An error of any other
 * kind is "unreadable", deliberately distinct: sends still go ahead without
 * a limit, the stored state is left alone, and a cron records a failed
 * mail_status_read step. If a state write reports the table itself as
 * absent, writes are switched off for the rest of the run.
 *
 * recordRecipientsUnreadable (at the end of this file, ADR 0029 note of
 * 2026-11-19) is called once by a request whose recipient read failed and
 * which therefore sends nothing.
 *
 * This module never sends tenant mail itself: lib/notifications/send.ts
 * renders and dispatches through the run (runMail), so the two files do not
 * import each other in a cycle. The one platform mail sent here is the
 * alert, by the platform sender. Nothing here logs or stores an address.
 */
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelation, isSchemaMissing } from "@/lib/scoring/attempt-kind";
import { WORKERS_SUBREQUEST_BUDGET } from "@/lib/integrations/webhook-hold";
import { isCallLimitMessage, type SmtpErrorClass } from "@/lib/email/smtp-function";
import { sendPlatformEmail } from "@/lib/email/platform-sender";
import type { AlertErrorClass, AlertReading } from "@/lib/email/platform-templates";
import { countingMemberIds } from "@/lib/auth/org-membership";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { MAIL_RECIPIENTS_HEARTBEAT, type CronErrorCounts, type CronErrorWord, type TenantReading } from "@/lib/ops/health-status";
import type { NotificationEvent, NotificationSettings } from "./types";

type Env = Record<string, string | undefined>;

/* ------------------------------------------------------------------ numbers */

/** N: sends at once after the first (rule FP1: 4 on the free plan; gate G2 measures it). */
export const SENDS_AT_ONCE = 4;
/** No send starts later than this into a request an administrator makes (rule T4). */
export const REQUEST_SEND_WINDOW_MS = 45_000;
/** No send starts later than this into a cron call (rule T5). */
export const CRON_SEND_WINDOW_MS = 240_000;
/** A request's or a cron call's outbound calls, at most: 0.8 of the plan's budget (rule FP2). */
export const CALL_SUM_LIMIT = Math.floor(WORKERS_SUBREQUEST_BUDGET * 0.8);
/** A ready organisation turns failing after timeouts, unreachables or unknowns to this many different people. */
export const FLIP_AFTER_PEOPLE = 3;
/** An alert for a flip (or for the run in which routine mail reaches its daily line) is not marked within this of the last alert. */
export const ALERT_BOUND_FLIP_MS = 6 * 3_600_000;
/** An alert for mail not sent while not ready is not marked within this of the last alert. */
export const ALERT_BOUND_NOT_SENT_MS = 24 * 3_600_000;
/** An alert goes to at most this many administrators, super owners first. */
export const ALERT_MAX_RECIPIENTS = 5;
/** The daily limit where none is set and TENANT_EMAIL_DEFAULT_DAILY_LIMIT is not given (rule FP4). */
export const DEFAULT_TENANT_DAILY_LIMIT = 375;
/** The reserve kept for mail a person waits for: a tenth of the limit, rounded up, and at least this. */
export const DAILY_LIMIT_RESERVE_MIN = 25;
/** A healthy delivery refreshes the stored last delivery at most this often. */
export const LAST_SUCCESS_REFRESH_MS = 24 * 3_600_000;

/** The events that may draw on the daily limit's reserve: what a person is waiting for. */
export const RESERVE_EVENTS: readonly NotificationEvent[] = ["password_reset", "magic_link", "account_creation", "account_invite"];
/** The events no pause stops (D1): the person asked for them. They still go only through the tenant's SMTP. */
export const PAUSE_EXEMPT_EVENTS: readonly NotificationEvent[] = ["password_reset", "magic_link"];

/**
 * Outbound calls, as counted for the budgets (rule FP2). Estimates until
 * gate G3 measures them; the sums are asserted in tests/unit/mail-budget.test.ts.
 */
export const MAIL_CALL_COSTS = {
  /** Opening a run: the settings, the organisation, tenant_mail_status. */
  open: 3,
  /** The first mail of an event in a run reads its template. */
  template: 1,
  /** One send-smtp call. */
  send: 1,
  /** One notification_log insert for a group. */
  logInsert: 1,
  /** One tenant_smtp_state write. */
  stateWrite: 1,
  /** Marking an alert: one conditional update, two when the state row is not there yet. */
  alertMark: 2,
} as const;

/**
 * An alert sent by a scheduled call (rule FP3), at most: the read for the
 * oldest due alert, the state with its count, the settings, the
 * organisation, the members that count (two reads for each of two roles),
 * their addresses, the claim, and five platform mails of three calls each.
 */
export const ALERT_CALL_COST = 1 + 3 + 4 + 1 + 1 + ALERT_MAX_RECIPIENTS * 3;

/* ------------------------------------------------------------- the budgets */

export type MailBudget = {
  kind: "request" | "cron" | "unbounded";
  startedAt: number;
  windowMs: number;
  callLimit: number;
  calls: number;
  now: () => number;
};

function budget(kind: MailBudget["kind"], windowMs: number, callLimit: number, opts: { spent?: number; now?: () => number }): MailBudget {
  const now = opts.now ?? Date.now;
  return { kind, startedAt: now(), windowMs, callLimit, calls: Math.max(0, opts.spent ?? 0), now };
}

/**
 * An administrator's request's own outbound calls before its mail part
 * starts (the session, the caller's membership, the route's reads and its
 * writes): an estimate until gate G3 measures each route (rule FP2). The
 * mail part adds the reads it makes itself with spendCalls.
 */
export const ADMIN_REQUEST_OWN_CALLS = 10;

/** The budgets of a request an administrator makes. `spent`: the route's own calls before its mail. */
export function requestBudget(opts: { spent?: number; now?: () => number } = {}): MailBudget {
  return budget("request", REQUEST_SEND_WINDOW_MS, CALL_SUM_LIMIT, opts);
}

/** The budgets of one cron call, shared by every organisation's run in it. */
export function cronBudget(opts: { spent?: number; now?: () => number } = {}): MailBudget {
  return budget("cron", CRON_SEND_WINDOW_MS, CALL_SUM_LIMIT, opts);
}

/**
 * No window and no count: one send on its own (sendNotification with no
 * run), and pull request B's bulk file, which keeps today's shape until
 * pull request C (rule T4).
 */
export function unboundedBudget(now: () => number = Date.now): MailBudget {
  return budget("unbounded", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, { now });
}

export function spendCalls(b: MailBudget, n: number): void {
  b.calls += n;
}

/** Whether `calls` more fit the count, and the window has not passed. */
export function hasRoom(b: MailBudget, calls: number): boolean {
  return b.now() - b.startedAt < b.windowMs && b.calls + calls <= b.callLimit;
}

/* ----------------------------------------------------- reading and the limit */

const SETTINGS_COLUMNS =
  "smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure, from_email, from_name, reply_to, email_paused, event_paused, logo_url, brand_color, footer_text";

/** The organisation's notification settings; null when it has none; "unreadable" when the read failed. */
export async function readNotificationSettings(db: SupabaseClient, organizationId: string): Promise<NotificationSettings | null | "unreadable"> {
  try {
    const { data, error } = await db.from("notification_settings").select(SETTINGS_COLUMNS).eq("organization_id", organizationId).maybeSingle();
    if (error) return "unreadable";
    if (!data) return null;
    const row = data as unknown as NotificationSettings;
    return { ...row, event_paused: (row.event_paused as Record<string, boolean> | null) ?? {} };
  } catch {
    return "unreadable";
  }
}

/** Host, port and From present: the test of section C (send.ts kept it as smtpConfigComplete). */
export function settingsComplete(cfg: NotificationSettings | null | "unreadable"): boolean {
  return Boolean(cfg && cfg !== "unreadable" && cfg.smtp_host && cfg.smtp_port && cfg.from_email);
}

/** The reading of section C. A deleted organisation reads not_configured whatever its stored row says. */
export function readingOf(input: { settingsComplete: boolean; deleted: boolean; state: "healthy" | "failing" | null }): TenantReading {
  if (input.deleted || !input.settingsComplete) return "not_configured";
  if (input.state === "failing") return "failing";
  if (input.state === "healthy") return "healthy";
  return "configured";
}

export type DailyLimit = { limit: number; reserve: number; routineStop: number };

function positiveInt(v: unknown, max: number): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max) return v;
  if (typeof v === "string" && /^\d{1,6}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n >= 1 && n <= max ? n : null;
  }
  return null;
}

/**
 * The organisation's daily limit (rule FP4): the stored number, else
 * TENANT_EMAIL_DEFAULT_DAILY_LIMIT, else 375. The reserve is a tenth of it,
 * rounded up, and at least 25; routine mail stops at the limit less the
 * reserve, never below 0 (337 of 375, 1,350 of 1,500, 5 of 30).
 */
export function tenantDailyLimit(stored: number | null | undefined, env: Env = process.env): DailyLimit {
  const limit = positiveInt(stored, 100_000) ?? positiveInt(env.TENANT_EMAIL_DEFAULT_DAILY_LIMIT, 100_000) ?? DEFAULT_TENANT_DAILY_LIMIT;
  const reserve = Math.max(DAILY_LIMIT_RESERVE_MIN, Math.ceil(limit / 10));
  return { limit, reserve, routineStop: Math.max(0, limit - reserve) };
}

export function drawsOnReserve(event: NotificationEvent): boolean {
  return RESERVE_EVENTS.includes(event);
}

/** Whether one more mail of this event fits under the line that applies to it, with `count` sent in 24 hours. */
export function dailyLimitAllows(count: number, limit: DailyLimit, event: NotificationEvent): boolean {
  return count < (drawsOnReserve(event) ? limit.limit : limit.routineStop);
}

/* ----------------------------------------------------- the state, read once */

export type SmtpStateSnapshot = {
  state: "healthy" | "failing" | null;
  state_changed_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string | null;
  failed_recipients: string[];
};

export type TenantMailStatusRow = SmtpStateSnapshot & {
  organization_id: string;
  last_alert_at: string | null;
  alert_due_at: string | null;
  daily_limit: number | null;
  sent_24h: number;
};

export type StatusRead = { kind: "ok"; row: TenantMailStatusRow } | { kind: "missing" } | { kind: "unreadable"; code: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function statusRow(raw: Record<string, unknown>): TenantMailStatusRow {
  const state = raw.state === "healthy" || raw.state === "failing" ? raw.state : null;
  return {
    organization_id: String(raw.organization_id ?? ""),
    state,
    state_changed_at: str(raw.state_changed_at),
    last_success_at: str(raw.last_success_at),
    last_failure_at: str(raw.last_failure_at),
    last_error_code: str(raw.last_error_code),
    failed_recipients: Array.isArray(raw.failed_recipients) ? raw.failed_recipients.filter((x): x is string => typeof x === "string") : [],
    last_alert_at: str(raw.last_alert_at),
    alert_due_at: str(raw.alert_due_at),
    daily_limit: typeof raw.daily_limit === "number" && Number.isInteger(raw.daily_limit) ? raw.daily_limit : null,
    sent_24h: typeof raw.sent_24h === "number" && Number.isInteger(raw.sent_24h) && raw.sent_24h >= 0 ? raw.sent_24h : 0,
  };
}

/**
 * tenant_mail_status for one organisation: exactly one row. "missing" only
 * when the error says the function is not on this database
 * (isSchemaMissing: 0114 not pasted); any other failure, and any answer that
 * is not one row, is "unreadable". Each of the two writes one fixed log line.
 */
export async function readTenantMailStatus(db: SupabaseClient, organizationId: string): Promise<StatusRead> {
  let answer: StatusRead;
  try {
    const { data, error } = await db.rpc("tenant_mail_status", { p_org: organizationId });
    if (error) {
      answer = isSchemaMissing(error) ? { kind: "missing" } : { kind: "unreadable", code: String(error.code ?? "unknown") };
    } else if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object") {
      answer = { kind: "unreadable", code: "not_one_row" };
    } else {
      answer = { kind: "ok", row: statusRow(data[0] as Record<string, unknown>) };
    }
  } catch {
    answer = { kind: "unreadable", code: "thrown" };
  }
  if (answer.kind === "missing") {
    console.warn(JSON.stringify({ event: "tenant_mail_status_missing", org_id: organizationId }));
  } else if (answer.kind === "unreadable") {
    console.warn(JSON.stringify({ event: "tenant_mail_status_unreadable", org_id: organizationId, code: answer.code }));
  }
  return answer;
}

export type SendOutcome = { ok: true } | { ok: false; cls: SmtpErrorClass };

/**
 * Pure transition of the stored state for one send outcome (section C).
 * `write` asks the caller to persist the result, which section G limits to
 * real changes: a new recipient added to failed_recipients, a move to or
 * from failing, or a success whose last_success_at is absent or older than
 * LAST_SUCCESS_REFRESH_MS. Anything else leaves the row untouched.
 */
export function nextState(
  prev: SmtpStateSnapshot,
  outcome: SendOutcome,
  recipientId: string | null,
  nowMs: number
): { next: SmtpStateSnapshot; write: boolean; flipped: boolean; cleared: boolean } {
  const nowIso = new Date(nowMs).toISOString();
  if (outcome.ok) {
    const lastMs = prev.last_success_at ? Date.parse(prev.last_success_at) : NaN;
    const stale = !Number.isFinite(lastMs) || nowMs - lastMs > LAST_SUCCESS_REFRESH_MS;
    const change = prev.state !== "healthy" || prev.failed_recipients.length > 0 || stale;
    if (!change) return { next: prev, write: false, flipped: false, cleared: false };
    return {
      next: {
        ...prev,
        state: "healthy",
        state_changed_at: prev.state === "healthy" ? prev.state_changed_at : nowIso,
        last_success_at: nowIso,
        failed_recipients: [],
      },
      write: true,
      flipped: false,
      cleared: prev.state === "failing",
    };
  }
  const cls = outcome.cls;
  // A recipient's refusal says nothing about the sender; an organisation
  // already failing stays so until a delivery.
  if (cls === "rejected" || prev.state === "failing") return { next: prev, write: false, flipped: false, cleared: false };
  if (cls === "auth" || cls === "quota") {
    const people = recipientId && !prev.failed_recipients.includes(recipientId) ? [...prev.failed_recipients, recipientId].slice(-FLIP_AFTER_PEOPLE) : prev.failed_recipients;
    return {
      next: { ...prev, state: "failing", state_changed_at: nowIso, last_failure_at: nowIso, last_error_code: cls, failed_recipients: people },
      write: true,
      flipped: true,
      cleared: false,
    };
  }
  // timeout, unreachable, unknown: only a different person counts.
  if (!recipientId || prev.failed_recipients.includes(recipientId)) return { next: prev, write: false, flipped: false, cleared: false };
  const people = [...prev.failed_recipients, recipientId].slice(-FLIP_AFTER_PEOPLE);
  const flips = people.length >= FLIP_AFTER_PEOPLE;
  return {
    next: {
      ...prev,
      state: flips ? "failing" : prev.state,
      state_changed_at: flips ? nowIso : prev.state_changed_at,
      last_failure_at: nowIso,
      last_error_code: cls,
      failed_recipients: people,
    },
    write: true,
    flipped: flips,
    cleared: false,
  };
}

export type AlertCause = "flip" | "not_sent" | "daily_limit";

/**
 * Whether an alert may be marked as due now (section E, rule FP4): never
 * while one is already due; for a flip, or for the run in which routine mail
 * reaches its daily line, not within 6 hours of the last alert; for mail not
 * sent (while not ready, or refused by a limit that had already stopped it),
 * not within 24 hours of it. The cause is chosen by the run (dailyLimitCause).
 */
export function alertMayBeMarked(input: { cause: AlertCause; lastAlertAt: string | null; alertDueAt: string | null; nowMs: number }): boolean {
  if (input.alertDueAt) return false;
  const last = input.lastAlertAt ? Date.parse(input.lastAlertAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return input.nowMs - last >= (input.cause === "not_sent" ? ALERT_BOUND_NOT_SENT_MS : ALERT_BOUND_FLIP_MS);
}

/**
 * The cause a mail refused by the daily limit owes (rule FP4). Routine mail
 * that stops in this run (the run opened below the routine line, and the
 * count is still under the full limit) owes "daily_limit", spaced like a
 * flip. Everything else owes "not_sent", spaced 24 hours from the last
 * alert: a reserve event, a refusal at the full limit, and a refusal in a
 * run that opened with routine mail already stopped, whose stop was alerted
 * by the run that reached the line. So a day at the limit draws one alert,
 * not one every 6 hours. `count` includes the sends already started.
 */
export function dailyLimitCause(input: { event: NotificationEvent; sentAtOpen: number; count: number; limit: DailyLimit }): AlertCause {
  if (drawsOnReserve(input.event)) return "not_sent";
  return input.sentAtOpen < input.limit.routineStop && input.count < input.limit.limit ? "daily_limit" : "not_sent";
}

/* ------------------------------------------------------------------ the run */

/**
 * Why a mail of a run was not attempted. "left": the budgets had no room, or
 * the platform's call limit stopped the run. "withdrawn": the caller's own
 * step before the group dropped it (a claim another call holds, or a claim
 * that could not be taken). Neither writes a row.
 */
export type NotAttemptedClass = "paused" | "not_configured" | "not_ready" | "daily_limit" | "settings_unreadable" | "left" | "withdrawn";

export type RunItemResult =
  | { status: "sent" }
  | { status: "failed"; cls: SmtpErrorClass; error: string }
  | { status: "not_attempted"; cls: NotAttemptedClass; error: string };

export type RunReport = {
  attempted: number;
  sent: number;
  failed: number;
  notAttempted: Record<NotAttemptedClass, number>;
  stateWrites: number;
  alertMarked: boolean;
  /** Routine mail met the daily limit less its reserve in this run. */
  routineStopped: boolean;
};

export type MailRun = {
  readonly organizationId: string;
  readonly budget: MailBudget;
  readonly db: SupabaseClient;
  readonly env: Env;
  readonly now: () => number;
  readonly settings: NotificationSettings | null | "unreadable";
  readonly orgName: string;
  readonly deleted: boolean;
  /** The organisation's own row could not be read: nothing is attempted (its deletion is not known). */
  readonly orgUnreadable: boolean;
  /** The platform's limit on outbound calls was met in this run: nothing more is attempted or written. */
  callLimited: boolean;
  /** tenant_mail_status: "ok", "missing" (no 0114) or "unreadable". */
  readonly status: StatusRead["kind"];
  /** No 0114 on this database: the run took the fallback. */
  readonly no0114: boolean;
  stored: SmtpStateSnapshot;
  rowExists: boolean;
  lastAlertAt: string | null;
  alertDueAt: string | null;
  /** Null: no daily limit applied (no 0114, or the count could not be read). */
  readonly limit: DailyLimit | null;
  readonly sent24h: number;
  sentInRun: number;
  readonly startedFailing: boolean;
  /** A run that started failing and has not yet delivered: its next send goes alone, as the probe. */
  probeOpen: boolean;
  stopped: boolean;
  stateWritable: boolean;
  alertMarked: boolean;
  /** Templates read in this run, by event (send.ts fills it): one read for each event. */
  readonly templates: Map<string, unknown>;
  /** The run's own failed reads and writes, by fixed word (a cron's failed steps). */
  readonly errors: CronErrorCounts;
  readonly report: RunReport;
};

const EMPTY_STATE: SmtpStateSnapshot = {
  state: null,
  state_changed_at: null,
  last_success_at: null,
  last_failure_at: null,
  last_error_code: null,
  failed_recipients: [],
};

function svc(): SupabaseClient {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

function countError(errors: CronErrorCounts, word: CronErrorWord): void {
  errors[word] = (errors[word] ?? 0) + 1;
}

/** The fixed log line of a request that met the platform's call limit (rule FP8): one search finds every case. */
export const CALL_LIMIT_LOG_EVENT = "platform_call_limit";

/**
 * The run met the platform's limit on outbound calls (rule FP8): the job's
 * own failed step, counted once as call_limit with one fixed log line. From
 * then on the run attempts and writes nothing, since every call would fail.
 */
export function noteCallLimit(run: MailRun, where: string): void {
  if (run.callLimited) return;
  run.callLimited = true;
  run.stopped = true;
  countError(run.errors, "call_limit");
  console.error(JSON.stringify({ event: CALL_LIMIT_LOG_EVENT, where }));
}

function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message?: unknown }).message ?? "");
  return String(e ?? "");
}

/**
 * Open a run for one organisation: three reads together (the settings, the
 * organisation, tenant_mail_status), charged to the budget. Never throws.
 * A failed organisation read is not read as live: whether the organisation
 * is deleted is not known, and a deleted organisation's SMTP is never used
 * (section C), so the run attempts nothing, as for settings that could not
 * be read.
 */
export async function openRun(opts: {
  organizationId: string;
  budget?: MailBudget;
  db?: SupabaseClient;
  env?: Env;
  now?: () => number;
}): Promise<MailRun> {
  const db = opts.db ?? svc();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const b = opts.budget ?? unboundedBudget(now);
  const errors: CronErrorCounts = {};
  const [settings, org, status] = await Promise.all([
    readNotificationSettings(db, opts.organizationId),
    (async () => {
      try {
        const { data, error } = await db.from("organizations").select("name, deleted_at").eq("id", opts.organizationId).maybeSingle();
        return error ? "unreadable" : ((data as { name?: string | null; deleted_at?: string | null } | null) ?? null);
      } catch {
        return "unreadable" as const;
      }
    })(),
    readTenantMailStatus(db, opts.organizationId),
  ]);
  spendCalls(b, MAIL_CALL_COSTS.open);
  if (settings === "unreadable") countError(errors, "config_read");
  if (org === "unreadable") countError(errors, "config_read");
  if (status.kind === "unreadable") countError(errors, "mail_status_read");
  const row = status.kind === "ok" ? status.row : null;
  const stored: SmtpStateSnapshot = row
    ? {
        state: row.state,
        state_changed_at: row.state_changed_at,
        last_success_at: row.last_success_at,
        last_failure_at: row.last_failure_at,
        last_error_code: row.last_error_code,
        failed_recipients: row.failed_recipients,
      }
    : { ...EMPTY_STATE };
  const orgRow = org && org !== "unreadable" ? org : null;
  const deleted = typeof orgRow?.deleted_at === "string" && orgRow.deleted_at.length > 0;
  const startedFailing = !deleted && stored.state === "failing";
  return {
    organizationId: opts.organizationId,
    budget: b,
    db,
    env,
    now,
    settings,
    orgName: (typeof orgRow?.name === "string" && orgRow.name) || "your org",
    deleted,
    orgUnreadable: org === "unreadable",
    callLimited: false,
    status: status.kind,
    no0114: status.kind === "missing",
    stored,
    // tenant_mail_status left-joins the state row; its not-null state_changed_at
    // is empty only when there is no row yet.
    rowExists: row !== null && row.state_changed_at !== null,
    lastAlertAt: row?.last_alert_at ?? null,
    alertDueAt: row?.alert_due_at ?? null,
    limit: row ? tenantDailyLimit(row.daily_limit, env) : null,
    sent24h: row?.sent_24h ?? 0,
    sentInRun: 0,
    startedFailing,
    probeOpen: startedFailing,
    stopped: false,
    // The state is written over only when it was read: never on "missing" or "unreadable".
    stateWritable: status.kind === "ok",
    alertMarked: false,
    templates: new Map(),
    errors,
    report: {
      attempted: 0,
      sent: 0,
      failed: 0,
      notAttempted: { paused: 0, not_configured: 0, not_ready: 0, daily_limit: 0, settings_unreadable: 0, left: 0, withdrawn: 0 },
      stateWrites: 0,
      alertMarked: false,
      routineStopped: false,
    },
  };
}

/** The reading of the organisation as this run read it. */
export function runReading(run: MailRun): TenantReading {
  return readingOf({ settingsComplete: settingsComplete(run.settings), deleted: run.deleted, state: run.stored.state });
}

/**
 * Ready, as the public answer reads it (section C): settings complete, not
 * deleted, not failing, and below the daily limit. Without 0114, or with the
 * status unreadable, it is ready when the settings are complete.
 */
export function runReady(run: MailRun): boolean {
  if (run.orgUnreadable || run.settings === "unreadable") return false;
  const reading = runReading(run);
  if (reading === "not_configured" || reading === "failing") return false;
  return !run.limit || run.sent24h + run.sentInRun < run.limit.limit;
}

const NOT_CONFIGURED_TEXT = "The organisation's SMTP is not configured (Settings, Notifications). Nothing was sent.";

/**
 * Whether one mail of this event is attempted now, and if not, why. In this
 * order: the settings or the organisation could not be read; the
 * platform's call limit was met in this run; the organisation is deleted; the
 * pause (never for password_reset and magic_link, nor, as before, for
 * custom_broadcast); the settings are incomplete; the run has stopped; the
 * daily limit, counting the sends already started (`inFlight`).
 */
export function gateSend(
  run: MailRun,
  event: NotificationEvent,
  inFlight = 0
): { attempt: true } | { attempt: false; cls: NotAttemptedClass; error: string } {
  if (run.settings === "unreadable") {
    return { attempt: false, cls: "settings_unreadable", error: "The organisation's email settings could not be read. Nothing was sent." };
  }
  if (run.orgUnreadable) {
    return { attempt: false, cls: "settings_unreadable", error: "The organisation could not be read. Nothing was sent." };
  }
  if (run.callLimited) return { attempt: false, cls: "left", error: "Left: the request met the platform's limit on outbound calls." };
  if (run.deleted) return { attempt: false, cls: "not_configured", error: "The organisation is deleted; its SMTP is not used. Nothing was sent." };
  const cfg = run.settings;
  const pauseApplies = !PAUSE_EXEMPT_EVENTS.includes(event) && event !== "custom_broadcast";
  if (pauseApplies && cfg?.email_paused) return { attempt: false, cls: "paused", error: "Email sending is paused at the org level." };
  if (pauseApplies && cfg?.event_paused?.[event]) return { attempt: false, cls: "paused", error: `Event "${event}" is paused.` };
  if (!settingsComplete(cfg)) return { attempt: false, cls: "not_configured", error: NOT_CONFIGURED_TEXT };
  if (run.stopped) {
    return { attempt: false, cls: "not_ready", error: "Not attempted: the organisation's SMTP is failing (Settings, Notifications)." };
  }
  if (run.limit && !dailyLimitAllows(run.sent24h + run.sentInRun + inFlight, run.limit, event)) {
    return { attempt: false, cls: "daily_limit", error: "daily_limit" };
  }
  return { attempt: true };
}

/** Write the run's state row (an upsert of the state columns only). A missing table stops further writes in this run. */
async function writeState(run: MailRun, next: SmtpStateSnapshot): Promise<void> {
  if (!run.stateWritable || run.callLimited) return;
  spendCalls(run.budget, MAIL_CALL_COSTS.stateWrite);
  run.report.stateWrites++;
  try {
    const { error } = await run.db.from("tenant_smtp_state").upsert(
      {
        organization_id: run.organizationId,
        state: next.state,
        state_changed_at: next.state_changed_at ?? new Date(run.now()).toISOString(),
        last_success_at: next.last_success_at,
        last_failure_at: next.last_failure_at,
        last_error_code: next.last_error_code,
        failed_recipients: next.failed_recipients,
        updated_at: new Date(run.now()).toISOString(),
      },
      { onConflict: "organization_id" }
    );
    if (error) {
      if (isCallLimitMessage(errorText(error))) return noteCallLimit(run, "state_write");
      if (isMissingRelation(error, "tenant_smtp_state")) run.stateWritable = false;
      else countError(run.errors, "state_write");
      console.warn(JSON.stringify({ event: "tenant_smtp_state_write_failed", org_id: run.organizationId, code: String(error.code ?? "unknown") }));
      return;
    }
    run.rowExists = true;
  } catch (e) {
    if (isCallLimitMessage(errorText(e))) return noteCallLimit(run, "state_write");
    countError(run.errors, "state_write");
    console.warn(JSON.stringify({ event: "tenant_smtp_state_write_failed", org_id: run.organizationId, code: "thrown" }));
  }
}

/**
 * Sets alert_due_at (rule FP3) through an update whose filters carry
 * section E's spacing (no mark pending, last alert older than the bound),
 * so concurrent requests cannot mark twice. If no state row exists yet, an
 * insert-or-ignore creates it already marked; when another writer created
 * the row first, the guarded update runs instead. Sends nothing. A run marks
 * at most once, and not at all for a deleted organisation, without 0114, or
 * when its state read failed.
 */
async function markAlertDue(run: MailRun, cause: AlertCause): Promise<void> {
  if (run.alertMarked || run.deleted || !run.stateWritable || run.callLimited) return;
  const nowMs = run.now();
  if (!alertMayBeMarked({ cause, lastAlertAt: run.lastAlertAt, alertDueAt: run.alertDueAt, nowMs })) return;
  const nowIso = new Date(nowMs).toISOString();
  const boundIso = new Date(nowMs - (cause === "not_sent" ? ALERT_BOUND_NOT_SENT_MS : ALERT_BOUND_FLIP_MS)).toISOString();
  const fail = (code: string, missing: boolean, error?: unknown) => {
    if (error !== undefined && isCallLimitMessage(errorText(error))) return noteCallLimit(run, "alert_mark");
    if (missing) run.stateWritable = false;
    else countError(run.errors, "alert");
    console.warn(JSON.stringify({ event: "tenant_smtp_alert_mark_failed", org_id: run.organizationId, code }));
  };
  try {
    if (!run.rowExists) {
      spendCalls(run.budget, 1);
      const ins = await run.db
        .from("tenant_smtp_state")
        .upsert({ organization_id: run.organizationId, alert_due_at: nowIso, updated_at: nowIso }, { onConflict: "organization_id", ignoreDuplicates: true })
        .select("organization_id");
      if (ins.error) return fail(String(ins.error.code ?? "unknown"), isMissingRelation(ins.error, "tenant_smtp_state"), ins.error);
      run.rowExists = true;
      if (Array.isArray(ins.data) && ins.data.length > 0) {
        run.alertMarked = true;
        run.alertDueAt = nowIso;
        run.report.alertMarked = true;
        return;
      }
    }
    spendCalls(run.budget, 1);
    const upd = await run.db
      .from("tenant_smtp_state")
      .update({ alert_due_at: nowIso, updated_at: nowIso })
      .eq("organization_id", run.organizationId)
      .is("alert_due_at", null)
      .or(`last_alert_at.is.null,last_alert_at.lt."${boundIso}"`)
      .select("organization_id");
    if (upd.error) return fail(String(upd.error.code ?? "unknown"), isMissingRelation(upd.error, "tenant_smtp_state"), upd.error);
    if (Array.isArray(upd.data) && upd.data.length > 0) {
      run.alertMarked = true;
      run.alertDueAt = nowIso;
      run.report.alertMarked = true;
    }
  } catch (e) {
    fail("thrown", false, e);
  }
}

/**
 * A reset code or sign-in link that was not attempted because the
 * organisation is not ready or at its daily limit (section C; rule FP4):
 * learner mail that was not sent, so an alert is marked as due under
 * section E's 24-hour bound. Sends nothing; the same guards as a run's mark
 * (deleted organisation, no 0114, a state read that failed, a mark already
 * pending). Never throws. lib/notifications/send.ts calls it with the record
 * row of such a request.
 */
export async function markNotSentAlert(run: MailRun): Promise<void> {
  await markAlertDue(run, "not_sent");
}

/**
 * Apply one group's outcomes in order, write the state once if it changed,
 * then mark an alert if a cause arose. A flip stops the run; a failed probe
 * of a run that started failing stops it; a delivered probe clears it.
 */
async function settleGroup(run: MailRun, outcomes: Array<{ recipientId: string | null; outcome: SendOutcome }>, causes: Set<AlertCause>): Promise<void> {
  let write = false;
  let flipped = false;
  for (const { recipientId, outcome } of outcomes) {
    const step = nextState(run.stored, outcome, recipientId, run.now());
    run.stored = step.next;
    write = write || step.write;
    if (step.flipped) flipped = true;
    if (run.probeOpen) {
      if (outcome.ok) run.probeOpen = false;
      else if (outcome.cls !== "rejected") run.stopped = true;
    }
  }
  if (flipped) {
    run.stopped = true;
    causes.add("flip");
  }
  if (write) await writeState(run, run.stored);
  if (causes.has("flip")) await markAlertDue(run, "flip");
  else if (causes.has("daily_limit")) await markAlertDue(run, "daily_limit");
  else if (causes.has("not_sent")) await markAlertDue(run, "not_sent");
}

/**
 * A caller's own work for one group of a run, around its sends (rule T4 and
 * the free-plan note): a nudge's claim taken for the group just before its
 * sends, and the reminders' state written with the group. Each declares the
 * most calls it makes, which the run keeps room for when it sizes a group,
 * and answers the calls it made, which the run spends.
 */
export type GroupHooks<T> = {
  /**
   * Before a group's sends, with the items the run is about to attempt.
   * Answers which of them to keep; one dropped is "withdrawn" (no row, not
   * attempted). Called only for a group with at least one send. A throw
   * withdraws the whole group.
   */
  before?: (items: readonly T[]) => Promise<{ keep: readonly boolean[]; calls: number }>;
  beforeCalls?: number;
  /** After a group's sends and its log insert, with every item the group decided, in order. A throw is ignored. */
  after?: (entries: ReadonlyArray<{ item: T; result: RunItemResult }>) => Promise<{ calls: number }>;
  afterCalls?: number;
};

/** What the run engine needs from the pipeline (lib/notifications/send.ts). */
export type RunMailIO<T> = {
  eventOf: (item: T) => NotificationEvent;
  recipientOf: (item: T) => string | null;
  /**
   * Render and dispatch one mail. A throw reads as an unknown failure.
   * `callLimit`: the platform refused the outbound call itself (rule FP8).
   */
  attempt: (item: T) => Promise<{ ok: true } | { ok: false; error: string; cls: SmtpErrorClass; callLimit?: boolean }>;
  /** One notification_log insert for these rows; false when the write failed, "call_limit" when the platform refused it. */
  writeLog: (entries: Array<{ item: T; result: RunItemResult }>) => Promise<boolean | "call_limit">;
  /** A mail refused by the daily limit writes its row (one mail on its own); a loop writes none and reports the count. */
  rowForDailyLimit: boolean;
  hooks?: GroupHooks<T>;
};

/** The calls a group of `sends` may need, beyond the sends: its log insert, a state write and an alert mark. */
const GROUP_TAIL_CALLS = MAIL_CALL_COSTS.logInsert + MAIL_CALL_COSTS.stateWrite + MAIL_CALL_COSTS.alertMark;

/**
 * The run's one loop (rule T4): every loop of tenant mail goes through it,
 * so pull request E changes this helper and not the call sites. The first
 * send goes alone, and so does a probe; then at most SENDS_AT_ONCE at a
 * time. Before each group the two budgets are read: what does not fit is
 * left (reported, no row). Each group's rows are one insert. Results come
 * back in the order of `items`.
 */
export async function runMail<T>(run: MailRun, items: readonly T[], io: RunMailIO<T>): Promise<RunItemResult[]> {
  const results: RunItemResult[] = new Array(items.length);
  const notAttempted = (cls: NotAttemptedClass, error: string): RunItemResult => ({ status: "not_attempted", cls, error });
  const hooks = io.hooks ?? {};
  const hookCalls = (hooks.before ? Math.max(0, hooks.beforeCalls ?? 0) : 0) + (hooks.after ? Math.max(0, hooks.afterCalls ?? 0) : 0);
  let i = 0;
  let first = true;
  while (i < items.length) {
    const causes = new Set<AlertCause>();
    const rows: Array<{ item: T; result: RunItemResult }> = [];
    const decided: number[] = [];
    let group: number[] = [];
    // The first send goes alone, and so does a probe. Once a failure that
    // counts toward a flip is on the row, a group holds no more sends than
    // the people still needed to flip: a dead SMTP costs at most three
    // attempts in a run (section C), never a whole group more.
    const counting = run.stored.state !== "failing" ? run.stored.failed_recipients.length : 0;
    const size = first || run.probeOpen ? 1 : counting > 0 ? Math.max(1, Math.min(SENDS_AT_ONCE, FLIP_AFTER_PEOPLE - counting)) : SENDS_AT_ONCE;
    // How many sends fit the count and the window, with the group's tail
    // and the caller's own calls around the group.
    const roomCalls = run.budget.callLimit - run.budget.calls - GROUP_TAIL_CALLS - hookCalls;
    const fit = hasRoom(run.budget, 0) ? Math.max(0, Math.floor(roomCalls / MAIL_CALL_COSTS.send)) : 0;
    let templatesNeeded = 0;
    const eventsInGroup = new Set<string>();
    while (i < items.length && group.length < size) {
      const event = io.eventOf(items[i]);
      const gate = gateSend(run, event, group.length);
      if (!gate.attempt) {
        results[i] = notAttempted(gate.cls, gate.error);
        run.report.notAttempted[gate.cls]++;
        decided.push(i);
        if (gate.cls === "daily_limit") {
          if (!drawsOnReserve(event)) run.report.routineStopped = true;
          // gateSend refuses for the daily limit only when run.limit is set.
          if (run.limit) causes.add(dailyLimitCause({ event, sentAtOpen: run.sent24h, count: run.sent24h + run.sentInRun + group.length, limit: run.limit }));
          if (io.rowForDailyLimit) rows.push({ item: items[i], result: results[i] });
        } else if (gate.cls !== "left") {
          if (gate.cls === "not_ready" || (gate.cls === "not_configured" && !run.deleted)) causes.add("not_sent");
          rows.push({ item: items[i], result: results[i] });
        }
        i++;
        continue;
      }
      const needsTemplate = !run.templates.has(event) && !eventsInGroup.has(event);
      if (group.length + templatesNeeded + (needsTemplate ? 1 : 0) + 1 > fit) break;
      if (needsTemplate) {
        templatesNeeded++;
        eventsInGroup.add(event);
      }
      group.push(i);
      i++;
    }
    if (group.length === 0 && decided.length === 0 && i < items.length) {
      // No room for the next send: the rest is left for a later request or call.
      for (; i < items.length; i++) {
        results[i] = notAttempted("left", "Left: the request had no room for this mail.");
        run.report.notAttempted.left++;
      }
      break;
    }
    // The caller's own step before the sends (a claim for this group).
    if (group.length > 0 && hooks.before) {
      let keep: readonly boolean[] = [];
      try {
        const answer = await hooks.before(group.map((idx) => items[idx]));
        spendCalls(run.budget, Math.max(0, answer.calls));
        keep = answer.keep;
      } catch {
        spendCalls(run.budget, Math.max(0, hooks.beforeCalls ?? 0));
        keep = [];
      }
      const kept: number[] = [];
      group.forEach((idx, k) => {
        if (keep[k] === true) kept.push(idx);
        else {
          results[idx] = notAttempted("withdrawn", "Withdrawn before its group: its claim was not taken.");
          run.report.notAttempted.withdrawn++;
          decided.push(idx);
        }
      });
      if (kept.length < group.length) {
        // Templates for events no longer sent are not read.
        const events = new Set(kept.map((idx) => io.eventOf(items[idx])));
        templatesNeeded = [...eventsInGroup].filter((e) => events.has(e as NotificationEvent)).length;
      }
      group = kept;
    }
    first = first && group.length === 0;
    const outcomes: Array<{ recipientId: string | null; outcome: SendOutcome }> = [];
    const countBefore = run.sent24h + run.sentInRun;
    if (group.length > 0) {
      spendCalls(run.budget, group.length * MAIL_CALL_COSTS.send + templatesNeeded * MAIL_CALL_COSTS.template);
      const answers = await Promise.all(
        group.map(async (idx) => {
          try {
            return await io.attempt(items[idx]);
          } catch (e) {
            if (isCallLimitMessage(errorText(e))) return { ok: false as const, error: "call_limit", cls: "unknown" as SmtpErrorClass, callLimit: true };
            return { ok: false as const, error: "The send failed before it reached the mail server.", cls: "unknown" as SmtpErrorClass };
          }
        })
      );
      group.forEach((idx, k) => {
        const a = answers[k];
        decided.push(idx);
        if (!a.ok && a.callLimit) {
          // The platform refused the call itself: not the tenant's SMTP, and
          // not a send. The run stops, and the rest is left.
          results[idx] = notAttempted("left", "Left: the request met the platform's limit on outbound calls.");
          run.report.notAttempted.left++;
          noteCallLimit(run, "send");
          return;
        }
        run.report.attempted++;
        if (a.ok) {
          results[idx] = { status: "sent" };
          run.report.sent++;
          run.sentInRun++;
        } else {
          results[idx] = { status: "failed", cls: a.cls, error: a.error };
          run.report.failed++;
        }
        rows.push({ item: items[idx], result: results[idx] });
        outcomes.push({ recipientId: io.recipientOf(items[idx]), outcome: a.ok ? { ok: true } : { ok: false, cls: a.cls } });
      });
      // This group's deliveries took the count to the routine line: routine
      // mail stops now, even when nothing in the run was refused for it (an
      // exact fit, or a code or welcome mail that reached the line).
      if (run.limit && countBefore < run.limit.routineStop && run.sent24h + run.sentInRun >= run.limit.routineStop) causes.add("daily_limit");
    }
    if (rows.length > 0 && !run.callLimited) {
      spendCalls(run.budget, MAIL_CALL_COSTS.logInsert);
      let logged: boolean | "call_limit" = false;
      try {
        logged = await io.writeLog(rows);
      } catch (e) {
        logged = isCallLimitMessage(errorText(e)) ? "call_limit" : false;
      }
      if (logged === "call_limit") noteCallLimit(run, "log_write");
      else if (!logged) countError(run.errors, "log_write");
    }
    if (hooks.after && decided.length > 0 && !run.callLimited) {
      decided.sort((a, b) => a - b);
      try {
        const answer = await hooks.after(decided.map((idx) => ({ item: items[idx], result: results[idx] })));
        spendCalls(run.budget, Math.max(0, answer.calls));
      } catch {
        spendCalls(run.budget, Math.max(0, hooks.afterCalls ?? 0));
      }
    }
    if (!run.callLimited) await settleGroup(run, outcomes, causes);
    if (run.callLimited) {
      for (; i < items.length; i++) {
        results[i] = notAttempted("left", "Left: the request met the platform's limit on outbound calls.");
        run.report.notAttempted.left++;
      }
      break;
    }
  }
  return results;
}

/* ------------------------------------------------------- the Settings test */

/**
 * Whether the Settings test is attempted now (section C, step 11). It goes
 * through the organisation's own SMTP only, so it needs settings that were
 * read and are complete, an organisation that was read and is not deleted,
 * and room under the daily limit with its reserve (rule FP4: the test draws
 * on the reserve). No pause stops it: the administrator asked for it.
 */
export function gateSettingsTest(run: MailRun): { attempt: true } | { attempt: false; cls: NotAttemptedClass; error: string } {
  if (run.settings === "unreadable") {
    return { attempt: false, cls: "settings_unreadable", error: "The organisation's email settings could not be read. Nothing was sent." };
  }
  if (run.orgUnreadable) return { attempt: false, cls: "settings_unreadable", error: "The organisation could not be read. Nothing was sent." };
  if (run.deleted || !settingsComplete(run.settings)) return { attempt: false, cls: "not_configured", error: NOT_CONFIGURED_TEXT };
  if (run.limit && run.sent24h + run.sentInRun >= run.limit.limit) return { attempt: false, cls: "daily_limit", error: "daily_limit" };
  return { attempt: true };
}

/**
 * The state after a Settings test (section C): a delivered test reads
 * healthy; a failed test turns the organisation failing at once, whatever
 * the class but rejected (one recipient's refusal says nothing about the
 * sender). A flip marks an alert as due under section E's bounds. Without
 * migration 0114 the run cannot write, and nothing is written.
 */
export async function settleSettingsTest(run: MailRun, outcome: SendOutcome, recipientId: string | null): Promise<void> {
  run.report.attempted++;
  if (outcome.ok) {
    run.report.sent++;
    run.sentInRun++;
    const step = nextState(run.stored, outcome, recipientId, run.now());
    run.stored = step.next;
    if (step.write) await writeState(run, run.stored);
    return;
  }
  run.report.failed++;
  if (outcome.cls === "rejected") return;
  const nowIso = new Date(run.now()).toISOString();
  const wasFailing = run.stored.state === "failing";
  run.stored = {
    ...run.stored,
    state: "failing",
    state_changed_at: wasFailing ? run.stored.state_changed_at : nowIso,
    last_failure_at: nowIso,
    last_error_code: outcome.cls,
  };
  run.stopped = true;
  await writeState(run, run.stored);
  if (!wasFailing) await markAlertDue(run, "flip");
}

/* ------------------------------------------------------------------- the alert */

export type DueAlertResult =
  | { kind: "none" }
  | { kind: "no_room" }
  | { kind: "taken" }
  | { kind: "dropped"; reason: "deleted" | "cleared" | "no_recipients" }
  | { kind: "sent"; reading: AlertReading; recipients: number; sent: number; failed: number }
  | { kind: "failed"; step: "config" | "read" | "recipients" | "addresses" | "claim" };

const ALERT_CLASSES: readonly string[] = ["auth", "quota", "timeout", "unreachable", "unknown"] satisfies readonly AlertErrorClass[];

/**
 * Send the oldest alert that is due (rule FP3). Only a scheduled call runs
 * it, at most once in a call. Everything is read before the claim, so a
 * failed read leaves the alert due for the next call; the claim is one
 * conditional update on the alert time that was read, so two calls never
 * both send; then the mails start together, at most five, super owners
 * first. The reading is taken now: an organisation that is ready again, or
 * deleted, gets no alert and its mark is cleared. Never throws.
 */
export async function sendDueAlert(opts: {
  baseUrl: string;
  budget?: MailBudget;
  db?: SupabaseClient;
  env?: Env;
  now?: () => number;
}): Promise<DueAlertResult> {
  const base = String(opts.baseUrl ?? "").replace(/\/+$/, "");
  const db = opts.db ?? svc();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const b = opts.budget ?? unboundedBudget(now);
  if (!hasRoom(b, ALERT_CALL_COST)) return { kind: "no_room" };
  const warn = (step: string, orgId: string | null, code: string) =>
    console.warn(JSON.stringify({ event: "tenant_smtp_alert_failed", step, org_id: orgId, code }));

  // 1. The oldest alert that is due.
  spendCalls(b, 1);
  let due: { organization_id: string; alert_due_at: string } | null;
  try {
    const { data, error } = await db
      .from("tenant_smtp_state")
      .select("organization_id, alert_due_at")
      .not("alert_due_at", "is", null)
      .order("alert_due_at", { ascending: true })
      .limit(1);
    if (error) {
      if (isMissingRelation(error, "tenant_smtp_state")) return { kind: "none" };
      warn("read", null, String(error.code ?? "unknown"));
      return { kind: "failed", step: "read" };
    }
    const first = Array.isArray(data) ? (data[0] as { organization_id?: unknown; alert_due_at?: unknown } | undefined) : undefined;
    due = first && typeof first.organization_id === "string" && typeof first.alert_due_at === "string" ? { organization_id: first.organization_id, alert_due_at: first.alert_due_at } : null;
  } catch {
    warn("read", null, "thrown");
    return { kind: "failed", step: "read" };
  }
  if (!due) return { kind: "none" };
  const orgId = due.organization_id;
  // The alert's Settings link needs the platform address; without it a due
  // alert cannot be sent, and it stays due.
  if (!/^https?:\/\/[^/\s]+/.test(base)) {
    warn("config", orgId, "no_base_url");
    return { kind: "failed", step: "config" };
  }

  // 2. Its state with the count, its settings and the organisation, read now.
  spendCalls(b, 3);
  const [status, settings, org] = await Promise.all([
    readTenantMailStatus(db, orgId),
    readNotificationSettings(db, orgId),
    (async () => {
      try {
        const { data, error } = await db.from("organizations").select("name, slug, deleted_at").eq("id", orgId).maybeSingle();
        return error ? "unreadable" : ((data as { name?: string | null; slug?: string | null; deleted_at?: string | null } | null) ?? null);
      } catch {
        return "unreadable" as const;
      }
    })(),
  ]);
  if (status.kind !== "ok" || settings === "unreadable" || org === "unreadable") {
    warn("read", orgId, status.kind !== "ok" ? status.kind : "settings_or_org");
    return { kind: "failed", step: "read" };
  }

  // The mark is cleared without an alert: only alert_due_at, matched on the time read.
  const clear = async (reason: "deleted" | "cleared" | "no_recipients"): Promise<DueAlertResult> => {
    spendCalls(b, 1);
    try {
      const { error } = await db
        .from("tenant_smtp_state")
        .update({ alert_due_at: null, updated_at: new Date(now()).toISOString() })
        .eq("organization_id", orgId)
        .eq("alert_due_at", due!.alert_due_at);
      if (error) {
        warn("claim", orgId, String(error.code ?? "unknown"));
        return { kind: "failed", step: "claim" };
      }
    } catch {
      warn("claim", orgId, "thrown");
      return { kind: "failed", step: "claim" };
    }
    return { kind: "dropped", reason };
  };

  if (!org || (typeof org.deleted_at === "string" && org.deleted_at.length > 0)) return clear("deleted");
  const row = status.row;
  let reading: AlertReading | null = null;
  let errorClass: AlertErrorClass | null = null;
  const limit = tenantDailyLimit(row.daily_limit, env);
  // readingOf's order: settings that are not complete read not_configured
  // before the stored state, so the alert says what the console and the
  // banner say.
  if (!settingsComplete(settings)) {
    reading = "not_configured";
  } else if (row.state === "failing") {
    reading = "failing";
    errorClass = row.last_error_code && ALERT_CLASSES.includes(row.last_error_code) ? (row.last_error_code as AlertErrorClass) : null;
  } else if (row.sent_24h >= limit.routineStop) {
    reading = "daily_limit";
  }
  if (!reading) return clear("cleared");

  // 3. The administrators whose membership counts, super owners first, at most five.
  spendCalls(b, 2);
  const owners = await countingMemberIds(db, orgId, ["super_owner"]);
  if (owners === "unreadable") {
    warn("recipients", orgId, "unreadable");
    return { kind: "failed", step: "recipients" };
  }
  let ids = [...owners].sort();
  if (ids.length < ALERT_MAX_RECIPIENTS) {
    spendCalls(b, 2);
    const admins = await countingMemberIds(db, orgId, ["admin"]);
    if (admins === "unreadable") {
      warn("recipients", orgId, "unreadable");
      return { kind: "failed", step: "recipients" };
    }
    ids = [...ids, ...[...admins].sort().filter((id) => !owners.has(id))];
  }
  ids = ids.slice(0, ALERT_MAX_RECIPIENTS);
  if (ids.length === 0) return clear("no_recipients");
  spendCalls(b, 1);
  const emails = await resolveEmailsStrict(db, ids);
  if (emails === "unreadable") {
    warn("addresses", orgId, "unreadable");
    return { kind: "failed", step: "addresses" };
  }
  const recipients = ids.filter((id) => emails.has(id)).map((id) => ({ userId: id, email: emails.get(id)! }));
  if (recipients.length === 0) return clear("no_recipients");

  // 4. The claim, then the mails, all at once.
  spendCalls(b, 1);
  try {
    const nowIso = new Date(now()).toISOString();
    const { data, error } = await db
      .from("tenant_smtp_state")
      .update({ alert_due_at: null, last_alert_at: nowIso, updated_at: nowIso })
      .eq("organization_id", orgId)
      .eq("alert_due_at", due.alert_due_at)
      .select("organization_id");
    if (error) {
      warn("claim", orgId, String(error.code ?? "unknown"));
      return { kind: "failed", step: "claim" };
    }
    if (!Array.isArray(data) || data.length === 0) return { kind: "taken" };
  } catch {
    warn("claim", orgId, "thrown");
    return { kind: "failed", step: "claim" };
  }
  const slug = typeof org.slug === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(org.slug) ? org.slug : null;
  const settingsUrl = slug ? `${base}/${slug}/settings` : `${base}/select-org`;
  spendCalls(b, recipients.length * 3);
  const outcomes = await Promise.all(
    recipients.map(async (to) => {
      try {
        const r = await sendPlatformEmail(
          {
            event: "tenant_smtp_alert",
            to: { userId: to.userId, email: to.email, platformOwner: false },
            organizationId: orgId,
            content: {
              organizationName: org.name ?? "",
              settingsUrl,
              reading: reading!,
              errorClass: reading === "failing" ? errorClass : null,
              ...(reading === "daily_limit" ? { dailyLimit: limit.limit } : {}),
            },
          },
          { db, env, now }
        );
        return r.status === "sent";
      } catch {
        return false;
      }
    })
  );
  const sent = outcomes.filter(Boolean).length;
  return { kind: "sent", reading, recipients: recipients.length, sent, failed: recipients.length - sent };
}

/* ------------------------------------------------------------- the skip helper */

/**
 * For a request that still answers normally but sent no mail because its
 * recipient lookup failed (ADR 0029, note of 2026-11-19). It prints the
 * existing mail_recipients_unreadable log line and upserts the
 * MAIL_RECIPIENTS_HEARTBEAT row as an error, which `mail_recipients` reports
 * as warn for the next 24 hours. The row stores only `site`, a fixed word;
 * ids and addresses stay out of it. Cron routes do not use this: for them
 * an unreadable recipient list is a failed run. Never throws.
 */
export async function recordRecipientsUnreadable(site: string, organizationId: string | null): Promise<void> {
  try {
    console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site, org_id: organizationId }));
  } catch {
    /* the log line is best effort */
  }
  try {
    await recordHeartbeat(MAIL_RECIPIENTS_HEARTBEAT, { site }, false);
  } catch {
    /* recordHeartbeat never throws; this is belt and braces */
  }
}
