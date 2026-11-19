import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadTemplate, mdToHtml, DEFAULT_CTAS, DEFAULT_TEMPLATES } from "./templates";
import { substitute } from "./placeholders";
import { renderEmailShell, type EmailBranding } from "./layout";
import { SMTP_SEND_WAIT_MS, classifySmtpError, dispatchSmtp, type SmtpErrorClass } from "@/lib/email/smtp-function";
import { isTenantEvent } from "./routing";
import { openRun, runMail, type MailRun, type NotAttemptedClass, type RunItemResult } from "./smtp-state";
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

/** Render and dispatch one mail through the run's settings, waiting at most SMTP_SEND_WAIT_MS. */
async function attemptOne(
  run: MailRun,
  args: SendArgs
): Promise<{ ok: true } | { ok: false; error: string; cls: SmtpErrorClass }> {
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
    { timeoutMs: SMTP_SEND_WAIT_MS }
  );
  if (result.ok) return { ok: true };
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
async function writeLogRows(run: MailRun, entries: Array<{ item: SendArgs; result: RunItemResult }>): Promise<boolean> {
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
      console.warn(JSON.stringify({ event: "notification_log_write_failed", org_id: run.organizationId, code: String(error.code ?? "unknown") }));
      return false;
    }
    return true;
  } catch {
    console.warn(JSON.stringify({ event: "notification_log_write_failed", org_id: run.organizationId, code: "thrown" }));
    return false;
  }
}

function toSendResult(args: SendArgs, r: RunItemResult): SendResult {
  if (r.status === "sent") return { status: "sent", attempted: true, to: args.to.email };
  if (r.status === "failed") return { status: "failed", error: r.error, errorClass: r.cls, attempted: true, to: args.to.email };
  return { status: r.cls === "paused" ? "paused" : "failed", error: r.error, errorClass: r.cls, attempted: false, to: args.to.email };
}

function runIO(run: MailRun, rowForDailyLimit: boolean) {
  return {
    eventOf: (a: SendArgs) => a.event,
    recipientOf: (a: SendArgs) => a.to.user_id ?? null,
    attempt: (a: SendArgs) => attemptOne(run, a),
    writeLog: (entries: Array<{ item: SendArgs; result: RunItemResult }>) => writeLogRows(run, entries),
    rowForDailyLimit,
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
 */
export async function sendNotification(args: SendArgs, opts: { run?: MailRun } = {}): Promise<SendResult> {
  refuseNonTenant(args.event, "sendNotification");
  if (opts.run && opts.run.organizationId !== args.organizationId) {
    throw new TypeError("sendNotification: the run is another organisation's");
  }
  const run = opts.run ?? (await openRun({ organizationId: args.organizationId }));
  const [r] = await runMail(run, [args], runIO(run, true));
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
export async function sendMany<R>(run: MailRun, recipients: readonly R[], mail: (recipient: R) => MailSpec): Promise<SendResult[]> {
  const list: SendArgs[] = recipients.map((r) => ({ ...mail(r), organizationId: run.organizationId }));
  for (const a of list) refuseNonTenant(a.event, "sendMany");
  const results = await runMail(run, list, runIO(run, false));
  return results.map((r, k) => toSendResult(list[k], r));
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
