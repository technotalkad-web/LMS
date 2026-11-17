import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadTemplate, mdToHtml, DEFAULT_CTAS } from "./templates";
import { substitute } from "./placeholders";
import { renderEmailShell, type EmailBranding } from "./layout";
import { dispatchResend, resendConfigured } from "@/lib/email/resend";
import { dispatchSmtp } from "@/lib/email/smtp-function";
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

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function loadSettings(
  organizationId: string
): Promise<NotificationSettings | null> {
  const { data } = await svc()
    .from("notification_settings")
    .select(
      "smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure, from_email, from_name, reply_to, email_paused, event_paused, logo_url, brand_color, footer_text"
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!data) return null;
  return {
    ...(data as NotificationSettings),
    event_paused: (data.event_paused as Record<string, boolean>) ?? {},
  };
}

// Previously this returned a nodemailer Transport. We now defer the
// socket open + SMTP conversation to the send-smtp Edge Function.
// Kept as a thin sanity check so callers below get a clear "config
// is incomplete" failure before we burn a function invocation.
function smtpConfigComplete(cfg: NotificationSettings): boolean {
  return Boolean(cfg.smtp_host && cfg.smtp_port);
}

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

export type SendResult = {
  status: "sent" | "failed" | "queued" | "paused";
  error?: string;
  to: string;
};

/**
 * Render + dispatch a single notification. Always writes to notification_log
 * regardless of success/failure. Honors the org's master pause flag and
 * per-event toggles. Returns the result; callers can decide to surface
 * errors to the UI or swallow them.
 */
export async function sendNotification(args: SendArgs): Promise<SendResult> {
  const { organizationId, event, to, context, override } = args;
  const cfg = await loadSettings(organizationId);

  // Org name for branding fallback.
  const { data: orgRow } = await svc()
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();
  const orgName = (orgRow?.name as string | undefined) ?? "your org";

  // ---- Pause checks ----------------------------------------------------
  // Master pause stops everything except custom_broadcast (which is
  // always an explicit admin action and shouldn't be silently dropped).
  const isBroadcast = event === "custom_broadcast";
  if (cfg?.email_paused && !isBroadcast) {
    await logAttempt({
      organizationId,
      orgName,
      event,
      to,
      subjectTemplate: "(paused)",
      status: "paused",
      error: "Email sending is paused at the org level.",
      context,
    });
    return { status: "paused", to: to.email };
  }
  if (cfg?.event_paused?.[event] && !isBroadcast) {
    await logAttempt({
      organizationId,
      orgName,
      event,
      to,
      subjectTemplate: "(paused)",
      status: "paused",
      error: `Event "${event}" is paused.`,
      context,
    });
    return { status: "paused", to: to.email };
  }

  // ---- Template + branding --------------------------------------------
  let tpl: { subject: string; body_md: string; cta_label: string | null };
  if (override) {
    tpl = {
      subject: override.subject,
      body_md: override.body_md,
      cta_label: override.cta_label ?? null,
    };
  } else {
    tpl = await loadTemplate(organizationId, event);
  }
  // Ensure {Org_Name} always resolves even if the caller didn't pass it; an
  // explicit context.org_name still wins.
  const ctx = { org_name: orgName, ...context };
  const subject = substitute(tpl.subject, ctx);
  const body_md = substitute(tpl.body_md, ctx);
  const bodyHtml = mdToHtml(body_md);
  const ctaLabel =
    (tpl.cta_label && substitute(tpl.cta_label, ctx)) ||
    DEFAULT_CTAS[event] ||
    null;
  const ctaUrl = context.direct_link || context.portal_url || null;

  const branding: EmailBranding = {
    orgName,
    logoUrl: cfg?.logo_url ?? null,
    brandColor: cfg?.brand_color ?? "#1a1816",
    footerText: cfg?.footer_text ?? null,
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

  // ---- Send -----------------------------------------------------------
  // Tenant SMTP first (white-label). On missing config OR send failure, fall
  // back to the global Resend sender so a user is never locked out. Errors from
  // both transports are accumulated for the audit log.
  let status: SendResult["status"] = "queued";
  let errorMessage: string | undefined;
  const tenantReady = Boolean(cfg && smtpConfigComplete(cfg) && cfg.from_email);
  let sent = false;

  if (tenantReady) {
    const result = await dispatchSmtp({
      host: cfg!.smtp_host!,
      port: cfg!.smtp_port!,
      secure: cfg!.smtp_secure,
      user: cfg!.smtp_user ?? undefined,
      pass: cfg!.smtp_password ?? undefined,
      from: cfg!.from_name
        ? `"${cfg!.from_name}" <${cfg!.from_email}>`
        : cfg!.from_email!,
      to: to.email,
      replyTo: cfg!.reply_to ?? undefined,
      subject,
      text: body_md,
      html,
    });
    if (result.ok) {
      sent = true;
    } else {
      errorMessage = `tenant SMTP failed: ${result.error ?? "unknown"}`;
    }
  } else {
    errorMessage = "tenant SMTP not configured";
  }

  if (!sent && resendConfigured()) {
    const fb = await dispatchResend({
      to: to.email,
      subject,
      text: body_md,
      html,
      replyTo: cfg?.reply_to ?? undefined,
    });
    if (fb.ok) {
      sent = true;
      errorMessage = undefined; // delivered via fallback
    } else {
      errorMessage = `${errorMessage}; resend fallback failed: ${fb.error ?? "unknown"}`;
    }
  }

  status = sent ? "sent" : "failed";
  if (!sent && !resendConfigured() && !tenantReady) {
    errorMessage =
      "No email transport: configure Settings → Notifications SMTP, or set the platform Resend fallback.";
  }

  await logAttempt({
    organizationId,
    orgName,
    event,
    to,
    subjectTemplate: tpl.subject,
    status,
    error: errorMessage,
    context,
  });

  return { status, error: errorMessage, to: to.email };
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
 * Writes the audit row. Its subject is rendered from the stored context
 * only, never from the full one: a template whose subject names a
 * credential token ({Password}, {OTP_Code}, {Direct_Link}) is logged with
 * the token left literal, while the emailed subject carries the value.
 */
async function logAttempt(args: {
  organizationId: string;
  orgName: string;
  event: NotificationEvent;
  to: { user_id?: string | null; email: string };
  subjectTemplate: string;
  status: "sent" | "failed" | "queued" | "paused";
  error?: string;
  context: NotificationContext;
}) {
  const context = storedContext(args.context);
  const subject = substitute(args.subjectTemplate, { org_name: args.orgName, ...context });
  await svc()
    .from("notification_log")
    .insert({
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
    });
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
