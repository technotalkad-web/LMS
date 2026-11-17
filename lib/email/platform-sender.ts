import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { classifySmtpError, dispatchSmtp, type SmtpErrorClass } from "./smtp-function";
import {
  PLATFORM_EVENTS,
  isPlatformEvent,
  renderPlatformEmail,
  type PlatformContent,
  type PlatformEvent,
} from "./platform-templates";

export { PLATFORM_EVENTS, isPlatformEvent, type PlatformContent, type PlatformEvent };

/**
 * The platform sender (ADR 0029 section F): the only code that sends
 * platform mail. Platform mail goes from the platform to platform owners
 * and to tenant owners and administrators. It is never a tenant's mail and
 * never a fallback for it, and a tenant's SMTP is never a fallback for it.
 *
 * Transport: a mailbox of the owner's, through the send-smtp Edge
 * Function (dispatchSmtp), with the platform's settings taken from the
 * deployment's secrets on every call. The credential lives only there:
 * never in the database, a log line, a log row, a page, an answer or an
 * error message. Nothing in this module returns a setting's value; the
 * readiness read below returns variable names only.
 *
 * Order inside the sender (section F), each step writing one row of
 * public.platform_email_log (migration 0113) with a user id, never an
 * address or message content:
 *   1. the account limit (refused, account_limit; one such row an hour for
 *      an account and kind, then none);
 *   2. the reserved test domains and the allow-list (suppressed,
 *      test_domain or not_allowed): nothing is ever dispatched to a reserved
 *      test domain, on any environment, and nothing at all while the
 *      allow-list is unset;
 *   3. the organisation limit, then the daily ceiling (refused, org_limit or
 *      ceiling);
 *   4. "not configured" (failed, not_configured);
 *   5. the send, at most 8 s (sent, or failed with the error class).
 * The limits are read from the log before every send. A limit that cannot
 * be read sends nothing and writes nothing: the answer is "log_unreadable"
 * and the platform_email health check reads fail. The platform mailbox is
 * never used without its limits.
 *
 * Not a relay: no caller chooses the subject or the body. The text is fixed
 * per event (lib/email/platform-templates.ts) and carries only values the
 * server made. Which people may receive platform mail is the callers' rule
 * (section F's list); this module enforces only that the test goes to a
 * platform owner.
 */

/** Present and valid: the sender is configured (section F). */
export const PLATFORM_REQUIRED_SETTINGS = [
  "PLATFORM_SMTP_HOST",
  "PLATFORM_SMTP_PORT",
  "PLATFORM_SMTP_USER",
  "PLATFORM_SMTP_PASSWORD",
  "PLATFORM_SMTP_FROM",
  "PLATFORM_EMAIL_ALLOW_DOMAINS",
] as const;
/**
 * Optional. PLATFORM_SMTP_SECURE: implicit TLS, "true" or "false"; unset
 * reads true on port 465 and false otherwise. The two limits fall back to
 * their defaults when unset or not a positive whole number.
 */
export const PLATFORM_OPTIONAL_SETTINGS = [
  "PLATFORM_SMTP_SECURE",
  "PLATFORM_EMAIL_REPLY_TO",
  "PLATFORM_EMAIL_DAILY_CEILING",
  "PLATFORM_EMAIL_ORG_DAILY_LIMIT",
] as const;

/**
 * Three quarters of the smallest daily cap the owner may choose (a
 * gmail.com mailbox, about 500 a day). The owner sets
 * PLATFORM_EMAIL_DAILY_CEILING to three quarters of the mailbox's confirmed
 * cap (ADR 0029 section G and default D4; ops/RUNBOOK.md §6.3).
 */
export const DEFAULT_DAILY_CEILING = 375;
/** Codes and links for one organisation's administrators in 24 hours (default D4). */
export const DEFAULT_ORG_DAILY_LIMIT = 50;
/** One send waits at most this long (default D4); send-smtp may still deliver later. */
export const PLATFORM_SEND_TIMEOUT_MS = 8_000;

/** Per account and kind (section G). Events with null have no account limit. */
export const ACCOUNT_LIMITS: Record<PlatformEvent, { hour: number; day: number } | null> = {
  platform_reset_code: { hour: 5, day: 10 },
  platform_sign_in_link: { hour: 5, day: 10 },
  platform_test: { hour: 5, day: 10 },
  platform_admin_welcome: null,
  tenant_smtp_alert: null,
};
/** A platform owner's own code and link keep the hourly limit only. */
const OWNER_HOURLY_ONLY: ReadonlySet<PlatformEvent> = new Set(["platform_reset_code", "platform_sign_in_link"]);
/** A platform owner's own code, link and test are never refused by the ceiling. */
const OWNER_CEILING_EXEMPT: ReadonlySet<PlatformEvent> = new Set(["platform_reset_code", "platform_sign_in_link", "platform_test"]);
/** The events the organisation limit counts and refuses: administrators' codes and links. */
export const ORG_LIMITED_EVENTS: readonly PlatformEvent[] = ["platform_reset_code", "platform_sign_in_link"];
/**
 * The classes of a failed row that reached the mail server (the send was
 * tried). The test's account limit counts only rows that reached it.
 */
const DISPATCHED_FAILURE_CLASSES: ReadonlySet<string> = new Set<SmtpErrorClass>(["auth", "quota", "timeout", "unreachable", "rejected", "unknown"]);

/** Reserved for testing and documentation (RFC 2606 and RFC 6761). */
export const RESERVED_TEST_TLDS = ["test", "example", "invalid", "localhost"] as const;
export const RESERVED_TEST_DOMAINS = ["example.com", "example.net", "example.org"] as const;

export type PlatformErrorCode =
  | "not_configured"
  | SmtpErrorClass
  | "test_domain"
  | "not_allowed"
  | "account_limit"
  | "org_limit"
  | "ceiling";
/** The log row's status (migration 0113's check). */
export type PlatformLogStatus = "sent" | "failed" | "suppressed" | "refused";

export type PlatformSendResult =
  | { status: PlatformLogStatus; errorCode: PlatformErrorCode | null; logged: boolean }
  /** The limits could not be read: nothing was sent and no row was written. */
  | { status: "failed"; errorCode: "log_unreadable"; logged: false };

export type PlatformRecipient = {
  userId: string;
  email: string;
  /**
   * The recipient is a platform owner (public.platform_owners). Set only by
   * a caller that read it there (the platform guard, or rule 2 of section
   * A); it decides the exemptions of section G.
   */
  platformOwner: boolean;
};

export type PlatformSendRequest<E extends PlatformEvent = PlatformEvent> = {
  event: E;
  to: PlatformRecipient;
  /** The organisation the mail is about; null for a platform owner's own mail. */
  organizationId: string | null;
  content: PlatformContent[E];
};

type Env = Record<string, string | undefined>;

const present = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

function parsePort(v: string | undefined): number | null {
  if (!present(v) || !/^\d{1,5}$/.test(v!.trim())) return null;
  const n = Number(v!.trim());
  return n >= 1 && n <= 65535 ? n : null;
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!present(v) || !/^\d{1,9}$/.test(v!.trim())) return fallback;
  const n = Number(v!.trim());
  return n >= 1 ? n : fallback;
}

/** The allow-list: "*" allows every domain; otherwise exact domains, comma or space separated. Null when unset. */
function parseAllowList(v: string | undefined): { all: boolean; domains: Set<string> } | null {
  if (!present(v)) return null;
  const items = v!
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, ""))
    .filter(Boolean);
  if (items.length === 0) return null;
  return { all: items.includes("*"), domains: new Set(items.filter((d) => d !== "*")) };
}

/**
 * Whether the sender is configured, and which required variables are
 * missing or invalid. Names only: never a value.
 */
export function platformSenderReadiness(env: Env = process.env): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const name of PLATFORM_REQUIRED_SETTINGS) {
    if (name === "PLATFORM_SMTP_PORT" ? parsePort(env[name]) === null : name === "PLATFORM_EMAIL_ALLOW_DOMAINS" ? parseAllowList(env[name]) === null : !present(env[name])) {
      missing.push(name);
    }
  }
  return { configured: missing.length === 0, missing };
}

/** The two platform limits in force (section G). */
export function platformEmailLimits(env: Env = process.env): { dailyCeiling: number; orgDailyLimit: number } {
  return {
    dailyCeiling: parsePositiveInt(env.PLATFORM_EMAIL_DAILY_CEILING, DEFAULT_DAILY_CEILING),
    orgDailyLimit: parsePositiveInt(env.PLATFORM_EMAIL_ORG_DAILY_LIMIT, DEFAULT_ORG_DAILY_LIMIT),
  };
}

type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  replyTo?: string;
};

/** The settings with the credential. Module-private: nothing outside this file reads them. */
function readSmtpSettings(env: Env): SmtpSettings | null {
  if (!platformSenderReadiness(env).configured) return null;
  const port = parsePort(env.PLATFORM_SMTP_PORT)!;
  const secureRaw = (env.PLATFORM_SMTP_SECURE ?? "").trim().toLowerCase();
  const secure = secureRaw === "true" || secureRaw === "1" ? true : secureRaw === "false" || secureRaw === "0" ? false : port === 465;
  return {
    host: env.PLATFORM_SMTP_HOST!.trim(),
    port,
    secure,
    user: env.PLATFORM_SMTP_USER!.trim(),
    // A secret stored with a trailing line break would read as a refused
    // sign-in; inner spaces are kept (an app password may be shown in groups).
    pass: env.PLATFORM_SMTP_PASSWORD!.replace(/[\r\n]+$/, ""),
    from: env.PLATFORM_SMTP_FROM!.trim(),
    replyTo: present(env.PLATFORM_EMAIL_REPLY_TO) ? env.PLATFORM_EMAIL_REPLY_TO!.trim() : undefined,
  };
}

/** The domain of an address, lower-case; null when the address is not one plain address. */
export function addressDomain(email: string): string | null {
  const e = String(email ?? "").trim();
  if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+$/.test(e)) return null;
  const domain = e.slice(e.lastIndexOf("@") + 1).toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain)) return null;
  return domain;
}

/** A reserved test domain: .test, .example, .invalid, .localhost, or example.com/.net/.org (and their subdomains). */
export function isReservedTestDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return (
    RESERVED_TEST_TLDS.some((t) => d === t || d.endsWith(`.${t}`)) ||
    RESERVED_TEST_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`))
  );
}

/**
 * The provider's message as stored: the credential, the recipient and the
 * sender's own address replaced, anything shaped like an address removed,
 * control characters collapsed, cut to 200 characters (0113's check).
 */
export function scrubErrorDetail(message: string, secrets: Array<string | undefined>): string {
  let s = String(message ?? "");
  for (const v of secrets) {
    if (typeof v === "string" && v.length >= 4) s = s.split(v).join("[redacted]");
  }
  s = s.replace(/[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+/g, "[address]");
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, 200).join("");
}

function svc(): SupabaseClient {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type LogRow = { sent_at: string; status: string; error_code: string | null };

/**
 * Send one platform email. Never throws for a send or a database outcome;
 * throws only on a programming error (an event that is not a platform
 * event, content that fails its template's check, a test to anyone but a
 * platform owner), before anything is read or sent.
 */
export async function sendPlatformEmail<E extends PlatformEvent>(
  req: PlatformSendRequest<E>,
  deps: { db?: SupabaseClient; env?: Env; now?: () => number } = {}
): Promise<PlatformSendResult> {
  const { event, to, organizationId } = req;
  if (!isPlatformEvent(event)) throw new TypeError("sendPlatformEmail: not a platform event");
  if (event === "platform_test" && !to.platformOwner) {
    throw new TypeError("sendPlatformEmail: the test goes to a platform owner only");
  }
  const rendered = renderPlatformEmail(event, req.content);
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const db = deps.db ?? svc();
  const dayAgo = new Date(now - DAY_MS).toISOString();
  const hourAgoMs = now - HOUR_MS;

  const unreadable = (step: string): PlatformSendResult => {
    console.warn(`[platform-email] ${event}: log_unreadable (${step}); nothing sent`);
    return { status: "failed", errorCode: "log_unreadable", logged: false };
  };
  const log = async (status: PlatformLogStatus, errorCode: PlatformErrorCode | null, detail: string | null = null): Promise<PlatformSendResult> => {
    const { error } = await db.from("platform_email_log").insert({
      event_type: event,
      organization_id: organizationId,
      to_user_id: to.userId,
      status,
      error_code: errorCode,
      error_detail: detail,
    });
    if (error) console.warn(`[platform-email] ${event}: log write failed (${error.code ?? "unknown"})`);
    return { status, errorCode, logged: !error };
  };

  // 1. The account limit.
  const accountLimit = ACCOUNT_LIMITS[event];
  if (accountLimit) {
    const { data, error } = await db
      .from("platform_email_log")
      .select("sent_at, status, error_code")
      .eq("to_user_id", to.userId)
      .eq("event_type", event)
      .gte("sent_at", dayAgo)
      .order("sent_at", { ascending: false })
      .limit(100);
    if (error || !Array.isArray(data)) return unreadable("account");
    const rows = data as LogRow[];
    const isLimitRow = (r: LogRow) => r.status === "refused" && r.error_code === "account_limit";
    // A code or link counts every request, whatever its outcome (section G).
    // The test counts only the sends that reached the mail server: a test
    // that was suppressed or found the sender not configured used nothing of
    // the mailbox, so an owner fixing the setup is not locked out of testing.
    // The read is the newest 100 rows of 24 hours; the limits are read on them.
    const reachedServer = (r: LogRow) =>
      r.status === "sent" || (r.status === "failed" && DISPATCHED_FAILURE_CLASSES.has(r.error_code ?? ""));
    const attempts = rows.filter((r) => !isLimitRow(r) && (event !== "platform_test" || reachedServer(r)));
    const inHour = attempts.filter((r) => Date.parse(r.sent_at) >= hourAgoMs).length;
    const dailyApplies = !(to.platformOwner && OWNER_HOURLY_ONLY.has(event));
    if (inHour >= accountLimit.hour || (dailyApplies && attempts.length >= accountLimit.day)) {
      const recorded = rows.some((r) => isLimitRow(r) && Date.parse(r.sent_at) >= hourAgoMs);
      if (recorded) return { status: "refused", errorCode: "account_limit", logged: false };
      return log("refused", "account_limit");
    }
  }

  // 2. Reserved test domains, then the allow-list.
  const domain = addressDomain(to.email);
  if (!domain) return log("suppressed", "not_allowed");
  if (isReservedTestDomain(domain)) return log("suppressed", "test_domain");
  const allow = parseAllowList(env.PLATFORM_EMAIL_ALLOW_DOMAINS);
  if (!allow || !(allow.all || allow.domains.has(domain))) return log("suppressed", "not_allowed");

  // 3. The organisation limit, then the ceiling.
  const limits = platformEmailLimits(env);
  if (organizationId && !to.platformOwner && ORG_LIMITED_EVENTS.includes(event)) {
    const { count, error } = await db
      .from("platform_email_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "sent")
      .in("event_type", [...ORG_LIMITED_EVENTS])
      .gte("sent_at", dayAgo);
    if (error || typeof count !== "number") return unreadable("organisation");
    if (count >= limits.orgDailyLimit) return log("refused", "org_limit");
  }
  if (!(to.platformOwner && OWNER_CEILING_EXEMPT.has(event))) {
    const { count, error } = await db
      .from("platform_email_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .gte("sent_at", dayAgo);
    if (error || typeof count !== "number") return unreadable("ceiling");
    if (count >= limits.dailyCeiling) return log("refused", "ceiling");
  }

  // 4. Configured.
  const smtp = readSmtpSettings(env);
  if (!smtp) return log("failed", "not_configured");

  // 5. The send.
  const result = await dispatchSmtp(
    {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      pass: smtp.pass,
      from: smtp.from,
      to: to.email,
      replyTo: smtp.replyTo,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    },
    { timeoutMs: PLATFORM_SEND_TIMEOUT_MS }
  );
  if (result.ok) return log("sent", null);
  const cls = classifySmtpError(result.error);
  console.warn(`[platform-email] ${event}: not sent (${cls})`);
  const detail = scrubErrorDetail(result.error ?? "", [
    smtp.pass,
    smtp.user,
    to.email,
    smtp.from,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ]);
  return log("failed", cls, detail || null);
}
