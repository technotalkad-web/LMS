import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadTemplate, mdToHtml, DEFAULT_CTAS, DEFAULT_TEMPLATES } from "./templates";
import { substitute } from "./placeholders";
import { renderEmailShell, type EmailBranding } from "./layout";
import { CLAIM_IN_FLIGHT_MS, IN_FLIGHT_WORD, SMTP_SEND_WAIT_MS, accountRequests, classifySmtpError, dispatchSmtp, exactCount, isCallLimitMessage, type CountSince, type SmtpErrorClass } from "@/lib/email/smtp-function";
import { MAX_REQUESTS_PER_DAY, MAX_REQUESTS_PER_HOUR } from "@/lib/auth/password-reset";
import { isTenantEvent } from "./routing";
import { ADMIN_REQUEST_OWN_CALLS, gateSettingsTest, markNotSentAlert, noteCallLimit, openRun, refreshRun, requestBudget, runMail, runReading, settleSettingsTest, spendCalls, MAIL_CALL_COSTS, type GroupHooks, type MailRun, type NotAttemptedClass, type RunItemResult } from "./smtp-state";
import type { TenantReading } from "@/lib/ops/health-status";
import type {
  NotificationEvent,
  NotificationContext,
  NotificationSettings,
} from "./types";

// SMTP sending was moved out of this process. The main app runs on
// Cloudflare Workers, which has no raw TCP sockets, so nodemailer
// can't open SMTP connections from here. The actual socket lives in
// the `send-smtp` Supabase Edge Function (Deno + denomailer). This
// file does everything else — templates, branding, pause checks,
// audit logging — and POSTs the rendered email to that function for
// the final send, through dispatchSmtp in lib/email/smtp-function.ts.
//
// See: supabase/functions/send-smtp/index.ts
//
// Tenant mail only, through the organisation's own SMTP (ADR 0029 sections
// A and B). There is no fallback: a send that cannot go is recorded as not
// sent, with a message that names the organisation's SMTP, and no other
// sender is tried. Every send goes through a run (lib/notifications/smtp-state.ts),
// which reads the organisation's state and 24-hour count once, applies the
// pause, the deleted-organisation rule, the stop rule and the daily limit,
// and records the state. One send waits at most SMTP_SEND_WAIT_MS (rule T1).

export type SendArgs = {
  organizationId: string;
  event: NotificationEvent;
  to: { user_id?: string | null; email: string };
  context: NotificationContext;
  /** When provided, override the template (used for custom_broadcast). */
  override?: {
    subject: string;
    body_md: string;
    cta_label?: string | null;
    // Multi-button CTA for broadcasts. When non-empty, the email
    // renders these instead of the single cta_label/derived URL.
    // First button is primary (filled), rest are secondary (outlined).
    // Backward-compatible: omit or leave empty to keep the legacy
    // single-CTA path used by all 10 transactional email types.
    buttons?: Array<{ label: string; url: string }>;
  };
};

/** One mail of a run: what sendMany is given for each recipient (the organisation is the run's). */
export type MailSpec = Omit<SendArgs, "organizationId">;

/**
 * Why a mail did not go (ADR 0029 section C, step 10): the class of a send
 * that failed (auth, quota, timeout, unreachable, rejected, unknown), or why
 * it was not attempted: paused; not_configured (settings incomplete, or the
 * organisation deleted); not_ready (the stop rule: the SMTP is failing);
 * daily_limit; settings_unreadable; left (the request's budgets had no room;
 * no row is written for it).
 */
export type SendErrorClass = SmtpErrorClass | NotAttemptedClass;

export type SendResult = {
  status: "sent" | "failed" | "queued" | "paused";
  error?: string;
  /** Set whenever the mail did not go. */
  errorClass?: SendErrorClass;
  /** Whether send-smtp was called for it. */
  attempted?: boolean;
  to: string;
};

type Template = { subject: string; body_md: string; cta_label: string | null };

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/** The template of an event, read once in a run (the promise is kept, so two sends at once read it once). */
function templateFor(run: MailRun, event: NotificationEvent): Promise<Template> {
  const cached = run.templates.get(event) as Promise<Template> | undefined;
  if (cached) return cached;
  const read = loadTemplate(run.organizationId, event);
  run.templates.set(event, read);
  return read;
}

/** The text of a mail whose send did not start because the caller's job had no time left (rule T3). */
export const NO_TIME_LEFT_TEXT = "Left: the job had no time left to send this mail.";

/**
 * The time a caller's job has left for a send, read just before the send
 * starts (rule T3): the send waits the smaller of SMTP_SEND_WAIT_MS and this;
 * zero or less starts no send.
 */
export type TimeLeftMs = () => number;

/** Render and dispatch one mail through the run's settings, waiting at most SMTP_SEND_WAIT_MS, or the caller's time left when that is less. */
async function attemptOne(
  run: MailRun,
  args: SendArgs,
  timeLeftMs?: TimeLeftMs
): Promise<{ ok: true } | { ok: false; error: string; cls: SmtpErrorClass; callLimit?: boolean; notStarted?: boolean }> {
  const { event, to, context, override } = args;
  const cfg = run.settings as NotificationSettings;
  const tpl: Template = override
    ? { subject: override.subject, body_md: override.body_md, cta_label: override.cta_label ?? null }
    : await templateFor(run, event);
  // Ensure {Org_Name} always resolves even if the caller didn't pass it; an
  // explicit context.org_name still wins.
  const ctx = { org_name: run.orgName, ...context };
  const subject = substitute(tpl.subject, ctx);
  const body_md = substitute(tpl.body_md, ctx);
  const bodyHtml = mdToHtml(body_md);
  const ctaLabel =
    (tpl.cta_label && substitute(tpl.cta_label, ctx)) ||
    DEFAULT_CTAS[event] ||
    null;
  const ctaUrl = context.direct_link || context.portal_url || null;

  const branding: EmailBranding = {
    orgName: run.orgName,
    logoUrl: cfg.logo_url ?? null,
    brandColor: cfg.brand_color ?? "#1a1816",
    footerText: cfg.footer_text ?? null,
  };
  // Multi-button mode is exclusively driven by override.buttons (broadcasts).
  // When present and non-empty, layout.ts ignores ctaLabel/ctaUrl entirely.
  const ctaButtons = override?.buttons?.filter((b) => b.label && b.url) ?? [];
  const html = renderEmailShell({
    subject,
    bodyHtml,
    branding,
    ctaLabel: ctaLabel && ctaUrl ? ctaLabel : null,
    ctaUrl: ctaLabel && ctaUrl ? ctaUrl : null,
    ctaButtons: ctaButtons.length > 0 ? ctaButtons : undefined,
  });

  // Rule T3: read last, just before the send starts.
  const waitMs = Math.floor(Math.min(SMTP_SEND_WAIT_MS, timeLeftMs ? timeLeftMs() : Number.POSITIVE_INFINITY));
  if (!(waitMs > 0)) return { ok: false, cls: "unknown", error: NO_TIME_LEFT_TEXT, notStarted: true };
  const result = await dispatchSmtp(
    {
      host: cfg.smtp_host!,
      port: cfg.smtp_port!,
      secure: cfg.smtp_secure,
      user: cfg.smtp_user ?? undefined,
      pass: cfg.smtp_password ?? undefined,
      from: cfg.from_name ? `"${cfg.from_name}" <${cfg.from_email}>` : cfg.from_email!,
      to: to.email,
      replyTo: cfg.reply_to ?? undefined,
      subject,
      text: body_md,
      html,
    },
    { timeoutMs: waitMs }
  );
  if (result.ok) return { ok: true };
  if (isCallLimitMessage(result.error)) return { ok: false, cls: "unknown", error: "call_limit", callLimit: true };
  return { ok: false, cls: classifySmtpError(result.error), error: `tenant SMTP failed: ${result.error ?? "unknown"}` };
}

/** The subject a row is logged with: the template's, the default's when no template was read, or "(paused)". */
async function loggedSubjectTemplate(run: MailRun, args: SendArgs, result: RunItemResult): Promise<string> {
  if (result.status === "not_attempted" && result.cls === "paused") return "(paused)";
  if (args.override) return args.override.subject;
  const cached = run.templates.get(args.event) as Promise<Template> | undefined;
  if (cached) return (await cached).subject;
  return DEFAULT_TEMPLATES[args.event]?.subject ?? "";
}

/**
 * One notification_log insert for a group of rows (a single row is inserted
 * as one object), on this module's own service client: the route guard scan
 * (tests/unit/org-route-guards.test.ts) follows the insert to it.
 */
async function writeLogRows(run: MailRun, entries: Array<{ item: SendArgs; result: RunItemResult }>): Promise<boolean | "call_limit"> {
  const rows = await Promise.all(
    entries.map(async ({ item, result }) =>
      logRow({
        organizationId: run.organizationId,
        orgName: run.orgName,
        event: item.event,
        to: item.to,
        subjectTemplate: await loggedSubjectTemplate(run, item, result),
        status: result.status === "sent" ? "sent" : result.status === "not_attempted" && result.cls === "paused" ? "paused" : "failed",
        error: result.status === "sent" ? undefined : result.error,
        context: item.context,
      })
    )
  );
  try {
    const { error } = await svc().from("notification_log").insert(rows.length === 1 ? rows[0] : rows);
    if (error) {
      if (isCallLimitMessage(error.message)) return "call_limit";
      console.warn(JSON.stringify({ event: "notification_log_write_failed", org_id: run.organizationId, code: String(error.code ?? "unknown") }));
      return false;
    }
    return true;
  } catch (e) {
    if (isCallLimitMessage(e instanceof Error ? e.message : String(e))) return "call_limit";
    console.warn(JSON.stringify({ event: "notification_log_write_failed", org_id: run.organizationId, code: "thrown" }));
    return false;
  }
}

function toSendResult(args: SendArgs, r: RunItemResult): SendResult {
  if (r.status === "sent") return { status: "sent", attempted: true, to: args.to.email };
  if (r.status === "failed") return { status: "failed", error: r.error, errorClass: r.cls, attempted: true, to: args.to.email };
  return { status: r.cls === "paused" ? "paused" : "failed", error: r.error, errorClass: r.cls, attempted: false, to: args.to.email };
}

function runIO(run: MailRun, rowForDailyLimit: boolean, hooks?: GroupHooks<SendArgs>, timeLeftMs?: TimeLeftMs) {
  return {
    eventOf: (a: SendArgs) => a.event,
    recipientOf: (a: SendArgs) => a.to.user_id ?? null,
    attempt: (a: SendArgs) => attemptOne(run, a, timeLeftMs),
    writeLog: (entries: Array<{ item: SendArgs; result: RunItemResult }>) => writeLogRows(run, entries),
    rowForDailyLimit,
    // attemptOne reads no template for a mail whose text is given.
    needsTemplate: (a: SendArgs) => !a.override,
    hooks,
  };
}

function refuseNonTenant(event: unknown, where: string): void {
  if (!isTenantEvent(event)) throw new TypeError(`${where}: not a tenant event`);
}

/**
 * Render + dispatch a single notification through the organisation's own
 * SMTP, and write its notification_log row. With no `run` it opens one for
 * this mail alone (one read more than before: the state and the 24-hour
 * count). Throws only for an event that is not a tenant event, before
 * anything is read; every send or database outcome is in the result.
 * `timeLeftMs`: a job with one deadline (rule T3); the send waits no longer
 * than the time it has left, and with none left it is not started (left,
 * NO_TIME_LEFT_TEXT, no row).
 */
export async function sendNotification(args: SendArgs, opts: { run?: MailRun; timeLeftMs?: TimeLeftMs } = {}): Promise<SendResult> {
  refuseNonTenant(args.event, "sendNotification");
  if (opts.run && opts.run.organizationId !== args.organizationId) {
    throw new TypeError("sendNotification: the run is another organisation's");
  }
  const run = opts.run ?? (await openRun({ organizationId: args.organizationId }));
  const [r] = await runMail(run, [args], runIO(run, true, undefined, opts.timeLeftMs));
  return toSendResult(args, r);
}

/**
 * The run's one helper for a loop of tenant mail (rule T4; ADR 0029 step 10):
 * every loop sends through it, so pull request E changes this helper and
 * not the call sites. The mails go through the run's shape and budgets; the
 * results come back in the order of `recipients`, and what the budgets left
 * reads errorClass "left". A mail stopped by the daily limit writes no row
 * here (the caller reports the count).
 */
export async function sendMany<R>(
  run: MailRun,
  recipients: readonly R[],
  mail: (recipient: R) => MailSpec,
  opts: { hooks?: GroupHooks<R> } = {}
): Promise<SendResult[]> {
  const list: SendArgs[] = recipients.map((r) => ({ ...mail(r), organizationId: run.organizationId }));
  for (const a of list) refuseNonTenant(a.event, "sendMany");
  // The caller's hooks see its own recipients, not the rendered arguments.
  const byArgs = new Map<SendArgs, R>(list.map((a, k) => [a, recipients[k]]));
  const h = opts.hooks;
  const hooks: GroupHooks<SendArgs> | undefined = h
    ? {
        before: h.before ? (items) => h.before!(items.map((a) => byArgs.get(a)!)) : undefined,
        beforeCalls: h.beforeCalls,
        after: h.after ? (entries) => h.after!(entries.map((e) => ({ item: byArgs.get(e.item)!, result: e.result }))) : undefined,
        afterCalls: h.afterCalls,
      }
    : undefined;
  const results = await runMail(run, list, runIO(run, false, hooks));
  return results.map((r, k) => toSendResult(list[k], r));
}

/** The two events anyone can start without signing in (section C): a reset code and a sign-in link. */
export type CredentialEvent = "password_reset" | "magic_link";

/** Why a reset code or sign-in link was not attempted: the organisation is not ready, or it is at its daily limit. */
export type CredentialNotAttempted = "smtp_not_ready" | "daily_limit";

/**
 * The record of a reset code or sign-in link that was not attempted (ADR
 * 0029 section C; rule FP4): one failed notification_log row with the fixed
 * error, written only when that account has no such row for this kind in
 * this organisation in the last 24 hours, so repeated requests cannot fill
 * the log. The row is the administrators' view of who was affected; it holds
 * no credential (nothing was made). The alert is marked as due either way,
 * under section E's bound. Nothing is sent. A read that fails writes
 * nothing. Never throws.
 */
export async function recordCredentialNotAttempted(
  run: MailRun,
  args: { event: CredentialEvent; to: { user_id: string; email: string } },
  error: CredentialNotAttempted
): Promise<"written" | "exists" | "unreadable" | "write_failed"> {
  const db = svc();
  let answer: "written" | "exists" | "unreadable" | "write_failed";
  try {
    spendCalls(run.budget, 1);
    const since = new Date(run.now() - 24 * 3_600_000).toISOString();
    const { data, error: readError } = await db
      .from("notification_log")
      .select("id")
      .eq("organization_id", run.organizationId)
      .eq("to_user_id", args.to.user_id)
      .eq("event_type", args.event)
      .eq("error", error)
      .gte("sent_at", since)
      .limit(1);
    if (readError || !Array.isArray(data)) {
      answer = "unreadable";
    } else if (data.length > 0) {
      answer = "exists";
    } else {
      spendCalls(run.budget, MAIL_CALL_COSTS.logInsert);
      const row = logRow({
        organizationId: run.organizationId,
        orgName: run.orgName,
        event: args.event,
        to: args.to,
        subjectTemplate: DEFAULT_TEMPLATES[args.event]?.subject ?? "",
        status: "failed",
        error,
        context: {},
      });
      const { error: writeError } = await db.from("notification_log").insert(row);
      answer = writeError ? "write_failed" : "written";
    }
  } catch {
    answer = "unreadable";
  }
  if (answer === "unreadable" || answer === "write_failed") {
    console.warn(JSON.stringify({ event: "credential_record_failed", org_id: run.organizationId, kind: args.event, step: answer }));
  }
  await markNotSentAlert(run);
  return answer;
}

/** The error word of a tenant's claim: a `queued` row of notification_log that queues nothing and holds no credential. */
export const CREDENTIAL_CLAIM_ERROR = "claim";

/**
 * The account's claimed sign-in links through its organisation's SMTP, as
 * an exact count from a time on (accountRequests): the `queued` rows of
 * magic_link whose word is `claim`. An in-flight row is not a request, and
 * neither is the record row of a link that was not attempted: neither is
 * counted here.
 */
export function countLinkClaims(db: SupabaseClient, userId: string): CountSince {
  return (sinceIso) =>
    db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("to_user_id", userId)
      .eq("event_type", "magic_link")
      .eq("status", "queued")
      .eq("error", CREDENTIAL_CLAIM_ERROR)
      .gte("sent_at", sinceIso);
}

/** A tenant claim's answer: its time, or why nothing is sent (its record row, if one is owed, is already written). */
export type CredentialClaim =
  | { ok: true; at: number }
  | { ok: false; why: "claim_failed" | "limit_read_failed" | "account_limit" | CredentialNotAttempted };

/** One notification_log insert of a public request's own row (its claim or its in-flight row): `queued`, no context. false when it was not written. */
async function writeQueuedRow(db: SupabaseClient, run: MailRun, args: { event: CredentialEvent; to: { user_id: string; email: string } }, word: string): Promise<{ ok: true } | { ok: false; code: string }> {
  spendCalls(run.budget, MAIL_CALL_COSTS.logInsert);
  try {
    const { error } = await db.from("notification_log").insert(
      logRow({
        organizationId: run.organizationId,
        orgName: run.orgName,
        event: args.event,
        to: args.to,
        subjectTemplate: DEFAULT_TEMPLATES[args.event]?.subject ?? "",
        status: "queued",
        error: word,
        context: {},
      })
    );
    return error ? { ok: false, code: String(error.code ?? "unknown") } : { ok: true };
  } catch {
    return { ok: false, code: "thrown" };
  }
}

/**
 * Claim a public reset code or sign-in link on the organisation's own SMTP
 * before it is made (ADR 0029, the notes of 2026-11-22). In this order:
 *   - for a link: its claim, a `queued` row with the word `claim` and no
 *     context; then the account's claims again, two exact counts
 *     (countLinkClaims), its own claim among them: past 5 in the hour or 10
 *     in the day nothing is sent;
 *   - the in-flight row, a `queued` row with IN_FLIGHT_WORD and no context,
 *     written only by a request that passed its account's count (for a code,
 *     its closed code row is its account's claim, so it is called only once
 *     that row has passed its own count);
 *   - two reads together: the run again (refreshRun), and an exact count of
 *     the organisation's in-flight rows from CLAIM_IN_FLIGHT_MS ago on, its
 *     own among them;
 *   - an organisation that now reads failing or not configured is not
 *     attempted (smtp_not_ready, with its record row and the alert mark);
 *   - with a daily limit in the run, whether the run was read again or not:
 *     the run's 24-hour count plus the in-flight rows above the limit is not
 *     attempted (daily_limit, with its record row and the alert mark). So
 *     the daily limit counts the rows sent and the rows of requests that
 *     passed their account's count, never a claim.
 * A claim or an in-flight row that cannot be written, or an account count
 * that cannot be read, sends nothing. A status read again that fails keeps
 * the run's first reading (status_unread); in-flight rows that cannot be
 * counted are not a reading of the limit: no check is made here, no record
 * row is written and no alert is marked for it (claims_unread), and the
 * run's own gate applies the 24-hour count, as rule FP4 has it. The account
 * limits have no such fallback. Every call is charged to the run. Never
 * throws.
 */
export async function claimCredentialMail(
  run: MailRun,
  args: { event: CredentialEvent; to: { user_id: string; email: string } },
  opts: { link: boolean }
): Promise<CredentialClaim> {
  const db = svc();
  const warn = (step: string, code?: string) =>
    console.warn(JSON.stringify({ event: "credential_claim", org_id: run.organizationId, kind: args.event, step, ...(code ? { code } : {}) }));
  const at = run.now();
  if (opts.link) {
    const claim = await writeQueuedRow(db, run, args, CREDENTIAL_CLAIM_ERROR);
    if (!claim.ok) {
      warn("claim_failed", claim.code);
      return { ok: false, why: "claim_failed" };
    }
    spendCalls(run.budget, 2);
    const account = await accountRequests(countLinkClaims(db, args.to.user_id), run.now());
    if (!account) {
      warn("limit_read_failed");
      return { ok: false, why: "limit_read_failed" };
    }
    if (account.hour > MAX_REQUESTS_PER_HOUR || account.day > MAX_REQUESTS_PER_DAY) return { ok: false, why: "account_limit" };
  }
  const flight = await writeQueuedRow(db, run, args, IN_FLIGHT_WORD);
  if (!flight.ok) {
    warn("claim_failed", flight.code);
    return { ok: false, why: "claim_failed" };
  }

  spendCalls(run.budget, 1);
  const flightSince = new Date(run.now() - CLAIM_IN_FLIGHT_MS).toISOString();
  const [status, inFlight] = await Promise.all([
    refreshRun(run),
    exactCount(() =>
      db
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", run.organizationId)
        .eq("status", "queued")
        .eq("error", IN_FLIGHT_WORD)
        .gte("sent_at", flightSince)
    ),
  ]);

  const reading = runReading(run);
  if (reading === "failing" || reading === "not_configured") {
    await recordCredentialNotAttempted(run, args, "smtp_not_ready");
    return { ok: false, why: "smtp_not_ready" };
  }
  if (status === "unreadable") warn("status_unread");
  if (inFlight === null) warn("claims_unread");
  if (run.limit && inFlight !== null && run.sent24h + inFlight > run.limit.limit) {
    await recordCredentialNotAttempted(run, args, "daily_limit");
    return { ok: false, why: "daily_limit" };
  }
  return { ok: true, at };
}

/**
 * A welcome's outcome on the Users answers and rows (ADR 0029 section C, step
 * 16): sent, or not sent with its class. A timeout is "not_sent" with the
 * class timeout, which the page reads as "not confirmed: the mail may still
 * arrive" (rule T2); a paused event has the class paused; a person whose
 * membership does not count, inactive (no row, no state).
 */
export type WelcomeOutcome = { status: "sent" } | { status: "not_sent"; class: string };

export function welcomeOutcome(r: SendResult): WelcomeOutcome {
  if (r.status === "sent") return { status: "sent" };
  return { status: "not_sent", class: r.errorClass ?? "unknown" };
}

/**
 * What an administrator's answer says of a loop of mail (rule T4): how many
 * people were emailed, how many were not, and how many sends timed out
 * ("not confirmed: the mail may still arrive", rule T2). A person with no
 * address on file is one not emailed (`noAddress`). Counts only: no address,
 * id or error text.
 */
export type MailCounts = { recipients_unreadable: false; emailed: number; not_emailed: number; not_confirmed: number };
/** The recipients could not be read: nobody was emailed (ADR 0029, hand-over note of 2026-11-19, point 1). */
export type MailUnread = { recipients_unreadable: true };
export type MailOutcome = MailCounts | MailUnread;

export const RECIPIENTS_UNREADABLE: MailUnread = { recipients_unreadable: true };

export function mailCounts(results: readonly SendResult[], noAddress = 0): MailCounts {
  let emailed = 0;
  let notConfirmed = 0;
  let notEmailed = Math.max(0, noAddress);
  for (const r of results) {
    if (r.status === "sent") emailed++;
    else if (r.errorClass === "timeout") notConfirmed++;
    else notEmailed++;
  }
  return { recipients_unreadable: false, emailed, not_emailed: notEmailed, not_confirmed: notConfirmed };
}

/**
 * One more single mail's outcome added to a request's total, for a request
 * that sends several one at a time. A mail part that failed (null) or that
 * could not read its one recipient counts as one not emailed.
 */
export function addMailOutcome(total: MailCounts, one: MailOutcome | null): MailCounts {
  if (!one || one.recipients_unreadable) return { ...total, not_emailed: total.not_emailed + 1 };
  return {
    recipients_unreadable: false,
    emailed: total.emailed + one.emailed,
    not_emailed: total.not_emailed + one.not_emailed,
    not_confirmed: total.not_confirmed + one.not_confirmed,
  };
}

/** The event a Settings test is logged with. It is no NotificationEvent: no template, no pause, no routing row. */
export const SETTINGS_TEST_LOG_EVENT = "smtp_test";

const SETTINGS_TEST_SUBJECT = "Test message from your LMS";

/** The text of a mail the platform's call limit left (the run's own words for it). */
const CALL_LIMIT_LEFT_TEXT = "Left: the request met the platform's limit on outbound calls.";

/**
 * The Settings test (ADR 0029 section C, step 11): one fixed message through
 * the organisation's own SMTP to the administrator who asked for it, waited
 * for at most SMTP_SEND_WAIT_MS, with its notification_log row. Its outcome
 * sets the state (settleSettingsTest): a delivered test reads healthy, a
 * failed one failing at once. Not attempted when the settings are not
 * complete, could not be read, or the daily limit is used up. A send the
 * platform's call limit refused (rule FP8) is no SMTP failure: it is left,
 * with the fixed platform_call_limit line, no state settled, no alert marked
 * and no row written. Never throws.
 */
export async function sendSettingsTest(run: MailRun, to: { user_id: string; email: string }): Promise<SendResult> {
  const gate = gateSettingsTest(run);
  let result: SendResult;
  if (!gate.attempt) {
    result = { status: "failed", error: gate.error, errorClass: gate.cls, attempted: false, to: to.email };
  } else {
    const cfg = run.settings as NotificationSettings;
    const text =
      `This is a test message from ${run.orgName}'s learning platform.

` +
      "It was sent through your organisation's own email server, as every email to your learners is. " +
      "If it reached you, the server is working.";
    const html = renderEmailShell({
      subject: SETTINGS_TEST_SUBJECT,
      bodyHtml: mdToHtml(text),
      branding: { orgName: run.orgName, logoUrl: cfg.logo_url ?? null, brandColor: cfg.brand_color ?? "#1a1816", footerText: cfg.footer_text ?? null },
      ctaLabel: null,
      ctaUrl: null,
    });
    spendCalls(run.budget, MAIL_CALL_COSTS.send);
    let answer: { ok: boolean; error?: string };
    try {
      answer = await dispatchSmtp(
        {
          host: cfg.smtp_host!,
          port: cfg.smtp_port!,
          secure: cfg.smtp_secure,
          user: cfg.smtp_user ?? undefined,
          pass: cfg.smtp_password ?? undefined,
          from: cfg.from_name ? `"${cfg.from_name}" <${cfg.from_email}>` : cfg.from_email!,
          to: to.email,
          replyTo: cfg.reply_to ?? undefined,
          subject: SETTINGS_TEST_SUBJECT,
          text,
          html,
        },
        { timeoutMs: SMTP_SEND_WAIT_MS }
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e ?? "");
      answer = { ok: false, error: isCallLimitMessage(message) ? message : "The send failed before it reached the mail server." };
    }
    // The test's time on the state row: when its send answered.
    const answeredAt = run.now();
    if (answer.ok) {
      result = { status: "sent", attempted: true, to: to.email };
      await settleSettingsTest(run, { ok: true }, to.user_id, answeredAt);
    } else if (isCallLimitMessage(answer.error)) {
      // The platform refused the outbound call itself (rule FP8), as the
      // run's attemptOne reads it: the test never reached the mail server, so
      // it says nothing of the SMTP. No state is settled and no alert is
      // marked; the fixed line is logged once.
      noteCallLimit(run, "settings_test");
      result = { status: "failed", error: CALL_LIMIT_LEFT_TEXT, errorClass: "left", attempted: false, to: to.email };
    } else {
      const cls = classifySmtpError(answer.error);
      result = { status: "failed", error: `tenant SMTP failed: ${answer.error ?? "unknown"}`, errorClass: cls, attempted: true, to: to.email };
      await settleSettingsTest(run, { ok: false, cls }, to.user_id, answeredAt);
    }
  }
  // Its row: counted in the organisation's 24 hours when it was sent (rule
  // FP4). Not written once the request met the platform's call limit: the
  // insert would be refused too, as the run writes nothing after it.
  if (run.callLimited) return result;
  spendCalls(run.budget, MAIL_CALL_COSTS.logInsert);
  try {
    const { error } = await svc().from("notification_log").insert({
      organization_id: run.organizationId,
      event_type: SETTINGS_TEST_LOG_EVENT,
      channel: "email",
      to_user_id: to.user_id,
      to_address: to.email,
      subject: SETTINGS_TEST_SUBJECT,
      status: result.status === "sent" ? "sent" : "failed",
      error: result.status === "sent" ? null : result.error ?? null,
      context: {},
    });
    if (error) console.warn(JSON.stringify({ event: "notification_log_write_failed", org_id: run.organizationId, code: String(error.code ?? "unknown") }));
  } catch {
    console.warn(JSON.stringify({ event: "notification_log_write_failed", org_id: run.organizationId, code: "thrown" }));
  }
  return result;
}

/**
 * What the SMTP tab shows after a Settings test (section C, rule T2): sent;
 * not confirmed (a timeout: the mail may still arrive); not sent, with its
 * class; then the organisation's reading as the test left it. No address and
 * no server text.
 */
export type SettingsTestOutcome = {
  status: "sent" | "not_confirmed" | "not_sent";
  errorClass: string | null;
  attempted: boolean;
  reading: TenantReading;
};

/**
 * The Settings test of the save route and of the test route: one run for
 * the organisation, one send to the administrator's own address. With no
 * address on the session the outcome is not_sent with the class no_address
 * and nothing is attempted.
 */
export async function runSettingsTest(args: { organizationId: string; user: { id: string; email: string | null } }): Promise<SettingsTestOutcome> {
  const run = await openRun({ organizationId: args.organizationId, budget: requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS }) });
  if (!args.user.email) return { status: "not_sent", errorClass: "no_address", attempted: false, reading: runReading(run) };
  const r = await sendSettingsTest(run, { user_id: args.user.id, email: args.user.email });
  const status = r.status === "sent" ? "sent" : r.errorClass === "timeout" ? "not_confirmed" : "not_sent";
  // A test the platform's call limit stopped is named for what it is: the
  // settings were not tested, and the reading is the one before the test.
  const errorClass = r.status === "sent" ? null : run.callLimited ? "call_limit" : r.errorClass ?? null;
  return { status, errorClass, attempted: r.attempted === true, reading: runReading(run) };
}

/**
 * The only context keys stored in notification_log.context. Sign-in links,
 * reset codes and passwords are never stored in the notification log: every
 * key not listed here (direct_link, portal_url, otp_code, password, the
 * learner's name and email, and any key a caller adds later) is dropped
 * before the insert. The email itself is unchanged; it is rendered from the
 * full context. No reader of the table needs a context key (the admin pages
 * and the health checks read its own columns); these stay as a plain record
 * of what the email was about.
 *
 * tests/unit/notification-context-keys.test.ts classifies every key passed
 * at every call site, so a new key fails until it is placed on one side.
 */
export const STORED_CONTEXT_KEYS = [
  "course_id",
  "course_name",
  "path_id",
  "path_name",
  "journey_name",
  "org_name",
  "due_date",
  "deadline_date",
  "score",
  "otp_minutes",
] as const;

/** The part of a notification's context that may be stored (STORED_CONTEXT_KEYS). */
export function storedContext(context: NotificationContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of STORED_CONTEXT_KEYS) {
    const value = context[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * The audit row of one mail. Its subject is rendered from the stored context
 * only, never from the full one: a template whose subject names a
 * credential token ({Password}, {OTP_Code}, {Direct_Link}) is logged with
 * the token left literal, while the emailed subject carries the value.
 */
function logRow(args: {
  organizationId: string;
  orgName: string;
  event: NotificationEvent;
  to: { user_id?: string | null; email: string };
  subjectTemplate: string;
  status: "sent" | "failed" | "queued" | "paused";
  error?: string;
  context: NotificationContext;
}): Record<string, unknown> {
  const context = storedContext(args.context);
  const subject = substitute(args.subjectTemplate, { org_name: args.orgName, ...context });
  return {
    organization_id: args.organizationId,
    event_type: args.event,
    channel: "email",
    to_user_id: args.to.user_id ?? null,
    to_address: args.to.email,
    subject,
    status:
      // The DB check constraint only allows sent/failed/queued; paused
      // is an app-level meta-status, mapped to failed for the audit log
      // so admins still see it but the constraint stays satisfied.
      args.status === "paused" ? "failed" : args.status,
    error: args.error ?? null,
    context,
  };
}

/**
 * Fire-and-forget wrapper around sendNotification. API routes that
 * shouldn't block the user-facing response on email delivery use this.
 * Errors are caught + logged here so callers don't need a try/catch
 * around every call. Returns the SendResult on success; null on throw.
 */
export async function notifyBackground(
  args: SendArgs
): Promise<SendResult | null> {
  try {
    return await sendNotification(args);
  } catch (e) {
    console.error("[notifyBackground] uncaught:", e);
    return null;
  }
}
