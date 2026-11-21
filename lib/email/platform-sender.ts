import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CLAIM_IN_FLIGHT_MS,
  CLAIM_SEND_WITHIN_MS,
  IN_FLIGHT_WORD,
  SMTP_SEND_WAIT_MS,
  accountRequests,
  classifySmtpError,
  dispatchSmtp,
  exactCount,
  type CountSince,
  type SmtpErrorClass,
} from "./smtp-function";
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
 *      allow-list is unset or holds no usable entry;
 *   3. the organisation limit, then the daily ceiling (refused, org_limit or
 *      ceiling);
 *   4. "not configured" (failed, not_configured);
 *   5. the send, at most 15 s (sent, or failed with the error class).
 * For a code or a link each limit is claimed before the send (ADR 0029, the
 * notes of 2026-11-22; claimPlatformSend): after steps 1 and 2 the request
 * writes its claim (suppressed, pending) and counts its account again with
 * the claim among the rows; only a request within its account's limit then
 * writes its in-flight row (suppressed, in_flight), and the organisation's
 * share and the ceiling count the sent rows and the in-flight rows. So the
 * limits hold under concurrent requests, and the shares count only the rows
 * of requests that passed their account's count. The welcome, the alert and
 * the test read their limits from the log as before and write no claim.
 * A limit that cannot be read sends nothing: the answer is "log_unreadable",
 * no row is written for it beyond a claim or an in-flight row already there,
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
/**
 * One send waits at most this long: the one wait of both systems (rule T1,
 * SMTP_SEND_WAIT_MS in lib/email/smtp-function.ts). send-smtp may still
 * deliver later.
 */
export const PLATFORM_SEND_TIMEOUT_MS = SMTP_SEND_WAIT_MS;

/** Per account and kind (section G). Events with null have no account limit. */
export const ACCOUNT_LIMITS: Record<PlatformEvent, { hour: number; day: number } | null> = {
  platform_reset_code: { hour: 5, day: 10 },
  platform_sign_in_link: { hour: 5, day: 10 },
  platform_test: { hour: 5, day: 10 },
  platform_admin_welcome: null,
  tenant_smtp_alert: null,
};
/** A platform owner's own code, link and test are never refused by the ceiling. */
const OWNER_CEILING_EXEMPT: ReadonlySet<PlatformEvent> = new Set(["platform_reset_code", "platform_sign_in_link", "platform_test"]);
/** The events the organisation limit counts and refuses: administrators' codes and links. */
export const ORG_LIMITED_EVENTS: readonly PlatformEvent[] = ["platform_reset_code", "platform_sign_in_link"];
/**
 * The classes of a failed row that reached the mail server (the send was
 * tried). The test's account limit counts only rows that reached it.
 */
const DISPATCHED_FAILURE_CLASSES: ReadonlySet<string> = new Set<SmtpErrorClass>(["auth", "quota", "timeout", "unreachable", "rejected", "unknown"]);

/**
 * Whether the send behind a result was attempted (send-smtp was called for
 * it): a sent row, or a failed row with a send's class. Any other answer (a
 * refusal, a suppression, not configured, no time, a stale claim, a limit
 * that could not be read) attempted nothing.
 */
export function platformSendAttempted(r: { status: string; errorCode: string | null }): boolean {
  return r.status === "sent" || (r.status === "failed" && DISPATCHED_FAILURE_CLASSES.has(r.errorCode ?? ""));
}

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
  | "ceiling"
  /** A claim (ADR 0029, the note of 2026-11-22): the sender holds the mail back until its limits are read. One request of its account; never a send. */
  | "pending"
  /** An in-flight row (ADR 0029, the later note of 2026-11-22): a request that passed its account's count. Counted by the share and the ceiling for two minutes; never a request and never a send. */
  | "in_flight";
/** The log row's status (migration 0113's check). */
export type PlatformLogStatus = "sent" | "failed" | "suppressed" | "refused";

export type PlatformSendResult =
  | { status: PlatformLogStatus; errorCode: PlatformErrorCode | null; logged: boolean }
  /** The limits could not be read: nothing was sent and no row was written. */
  | { status: "failed"; errorCode: "log_unreadable"; logged: false }
  /** The caller's job had no time left to start the send (rule T3): nothing was sent and no row was written. */
  | { status: "failed"; errorCode: "no_time"; logged: false }
  /** The send would start more than CLAIM_SEND_WITHIN_MS after its claim: nothing was sent and no row was written. */
  | { status: "failed"; errorCode: "claim_stale"; logged: false };

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

/** A domain as the sender reads one: labels of letters, digits and hyphens, joined by dots. */
const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

type AllowList = { all: boolean; domains: Set<string>; addresses: Set<string> };

/**
 * Parses PLATFORM_EMAIL_ALLOW_DOMAINS (ADR 0029). Entries are separated by
 * commas or white space and come in three forms:
 *   - "*" admits everyone;
 *   - a full address (a single "@" with a local part and a valid domain)
 *     admits that one address only; the comparison ignores case and
 *     surrounding blanks but nothing else, so "+tag" or dotted variants
 *     need entries of their own;
 *   - anything else is read as a domain (an optional leading "@" or
 *     trailing "." is stripped) and admits that exact domain.
 * Entries that fit none of the forms are ignored. If no entry survives, the
 * result is null, which the sender treats exactly like a missing variable,
 * so a malformed value fails closed instead of admitting more.
 * The parsed list is never echoed in logs, rows or answers.
 */
function parseAllowList(v: string | undefined): AllowList | null {
  if (!present(v)) return null;
  const list: AllowList = { all: false, domains: new Set(), addresses: new Set() };
  for (const raw of v!.split(/[\s,]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === "*") {
      list.all = true;
    } else if (entry.includes("@") && !entry.startsWith("@")) {
      if (entry.indexOf("@") === entry.lastIndexOf("@") && addressDomain(entry) !== null) list.addresses.add(entry.toLowerCase());
    } else {
      const domain = entry.toLowerCase().replace(/^@/, "").replace(/\.$/, "");
      if (DOMAIN_SHAPE.test(domain)) list.domains.add(domain);
    }
  }
  return list.all || list.domains.size > 0 || list.addresses.size > 0 ? list : null;
}

/** Whether the list lets this recipient through: "*", the exact address, or its domain. */
function allowListAdmits(list: AllowList, email: string, domain: string): boolean {
  return list.all || list.addresses.has(String(email ?? "").trim().toLowerCase()) || list.domains.has(domain);
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
  if (!DOMAIN_SHAPE.test(domain)) return null;
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

/** Who a row of the log is about: the event, the organisation and the user id (never an address). */
type RowOf = { event: PlatformEvent; organizationId: string | null; userId: string };

/** One row of platform_email_log; logged false when the insert failed. */
async function writeRow(db: SupabaseClient, of: RowOf, status: PlatformLogStatus, errorCode: PlatformErrorCode | null, detail: string | null = null): Promise<PlatformSendResult> {
  const { error } = await db.from("platform_email_log").insert({
    event_type: of.event,
    organization_id: of.organizationId,
    to_user_id: of.userId,
    status,
    error_code: errorCode,
    error_detail: detail,
  });
  if (error) console.warn(`[platform-email] ${of.event}: log write failed (${error.code ?? "unknown"})`);
  return { status, errorCode, logged: !error };
}

/** A limit that could not be read (or a claim that could not be written): nothing is sent, and no row is written for it. */
function unreadable(event: PlatformEvent, step: string): PlatformSendResult {
  console.warn(`[platform-email] ${event}: log_unreadable (${step}); nothing sent`);
  return { status: "failed", errorCode: "log_unreadable", logged: false };
}

const isLimitRow = (r: LogRow) => r.status === "refused" && r.error_code === "account_limit";

/** The reserved test domains, then the allow-list (section F): the row of a mail that is not sent, or null to go on. */
function suppression(to: PlatformRecipient, env: Env): "not_allowed" | "test_domain" | null {
  const domain = addressDomain(to.email);
  if (!domain) return "not_allowed";
  if (isReservedTestDomain(domain)) return "test_domain";
  const allow = parseAllowList(env.PLATFORM_EMAIL_ALLOW_DOMAINS);
  if (!allow || !allowListAdmits(allow, to.email, domain)) return "not_allowed";
  return null;
}

/* ------------------------------------------------------------------ the claim */

/**
 * The events whose limits are claimed before the send (ADR 0029, the note
 * of 2026-11-22): an administrator's or a platform owner's code and link.
 * The welcome, the alert and the test write no claim: a platform owner or a
 * scheduled call starts them, and they read the ceiling from sent rows.
 */
export const CLAIMED_EVENTS: readonly PlatformEvent[] = ORG_LIMITED_EVENTS;

export function isClaimedEvent(event: PlatformEvent): boolean {
  return CLAIMED_EVENTS.includes(event);
}

/** A send this request has claimed: what it names, and when the claim was taken (the job's clock, just before the claim's row). */
export type PlatformClaim = { event: PlatformEvent; userId: string; organizationId: string | null; at: number };

/** claimPlatformSend's answer: the claim, or what came of the request instead (its row, if one was written, is already there). */
export type PlatformClaimAnswer = { claimed: true; claim: PlatformClaim } | { claimed: false; result: PlatformSendResult };

/** The words of the rows that are requests of an account: its claims, and the requests the reserved domains or the list stopped. */
export const ACCOUNT_REQUEST_WORDS = ["pending", "test_domain", "not_allowed"] as const satisfies readonly PlatformErrorCode[];

/**
 * Claim one code or link before it is made (ADR 0029, the notes of
 * 2026-11-22). Each limit is claimed before the send: the request writes its
 * claim, a row with the status `suppressed` and the word `pending`, and only
 * then counts its account again, its own claim among the rows. Each count of
 * the account is exact (accountRequests): the number of the account's rows
 * of this kind whose status is `suppressed` and whose word is one of
 * ACCOUNT_REQUEST_WORDS, in the hour and in the day. In this order:
 *   1. the account's counts, read before anything is written: at the limit
 *      (5 in the hour, 10 in the day, for every account) it is refused, with
 *      one such row an hour, and no claim is written;
 *   2. the reserved test domains and the allow-list: a `suppressed` row, as
 *      before, and no claim;
 *   3. the claim;
 *   4. the account's counts again: past the limit it is refused, and the
 *      claim is the request's only row;
 *   5. the in-flight row (`suppressed`, IN_FLIGHT_WORD), written only by a
 *      request that passed its account's count, a platform owner's own too;
 *   6. up to four exact counts together, each only where its limit applies:
 *      the organisation's sent codes and links of 24 hours and its in-flight
 *      rows, all sent mail of 24 hours and every in-flight row (each
 *      in-flight row from CLAIM_IN_FLIGHT_MS ago on). A platform owner's own
 *      request reads none of them;
 *   7. the organisation's share, then the ceiling, each as its sent rows
 *      plus its in-flight rows (this request's own among them), with its
 *      `refused` row as before.
 * A claim, an in-flight row or a count that cannot be written or read sends
 * nothing (log_unreadable). A row that follows a claim (in flight, sent,
 * failed, refused) is not counted against the account, so a request counts
 * once; the shares never count a claim. Neither row holds an address or
 * content. Throws only for an event that is not claimed.
 */
export async function claimPlatformSend(
  req: { event: PlatformEvent; to: PlatformRecipient; organizationId: string | null },
  deps: { db?: SupabaseClient; env?: Env; now?: () => number } = {}
): Promise<PlatformClaimAnswer> {
  const { event, to, organizationId } = req;
  if (!isClaimedEvent(event)) throw new TypeError("claimPlatformSend: not a claimed event");
  const env = deps.env ?? process.env;
  const clock = deps.now ?? Date.now;
  const db = deps.db ?? svc();
  const limit = ACCOUNT_LIMITS[event]!;
  const of: RowOf = { event, organizationId, userId: to.userId };
  const not = (result: PlatformSendResult): PlatformClaimAnswer => ({ claimed: false, result });
  // A request of the account: a claim, or one the reserved domains or the list stopped. Never an in-flight row.
  const requestsSince: CountSince = (sinceIso) =>
    db
      .from("platform_email_log")
      .select("id", { count: "exact", head: true })
      .eq("to_user_id", to.userId)
      .eq("event_type", event)
      .eq("status", "suppressed")
      .in("error_code", [...ACCOUNT_REQUEST_WORDS])
      .gte("sent_at", sinceIso);
  const past = (n: { hour: number; day: number }, ownIncluded: boolean) =>
    ownIncluded ? n.hour > limit.hour || n.day > limit.day : n.hour >= limit.hour || n.day >= limit.day;

  // 1. The account limit, before anything is written.
  const firstMs = clock();
  const before = await accountRequests(requestsSince, firstMs);
  if (!before) return not(unreadable(event, "account"));
  if (past(before, false)) {
    // One refused row an hour for the account and kind. If that cannot be read, nothing more is written.
    const recorded = await db
      .from("platform_email_log")
      .select("id")
      .eq("to_user_id", to.userId)
      .eq("event_type", event)
      .eq("status", "refused")
      .eq("error_code", "account_limit")
      .gte("sent_at", new Date(firstMs - HOUR_MS).toISOString())
      .limit(1);
    if (recorded.error || !Array.isArray(recorded.data) || recorded.data.length > 0) return not({ status: "refused", errorCode: "account_limit", logged: false });
    return not(await writeRow(db, of, "refused", "account_limit"));
  }

  // 2. Reserved test domains, then the allow-list: no claim.
  const held = suppression(to, env);
  if (held) return not(await writeRow(db, of, "suppressed", held));

  // 3. The claim.
  const at = clock();
  const claim = await db.from("platform_email_log").insert({
    event_type: event,
    organization_id: organizationId,
    to_user_id: to.userId,
    status: "suppressed",
    error_code: "pending",
    error_detail: null,
  });
  if (claim.error) return not(unreadable(event, "claim"));

  // 4. The account's counts again, the claim among the rows.
  const again = await accountRequests(requestsSince, clock());
  if (!again) return not(unreadable(event, "account"));
  if (past(again, true)) return not({ status: "refused", errorCode: "account_limit", logged: false });

  // 5. The in-flight row: this request passed its account's count.
  const flight = await db.from("platform_email_log").insert({
    event_type: event,
    organization_id: organizationId,
    to_user_id: to.userId,
    status: "suppressed",
    error_code: IN_FLIGHT_WORD,
    error_detail: null,
  });
  if (flight.error) return not(unreadable(event, "in_flight"));

  // 6. The shares' counts, this request's in-flight row among them: exact counts, no rows read.
  const nowMs = clock();
  const dayAgo = new Date(nowMs - DAY_MS).toISOString();
  const flightSince = new Date(nowMs - CLAIM_IN_FLIGHT_MS).toISOString();
  const limits = platformEmailLimits(env);
  const orgApplies = organizationId !== null && !to.platformOwner;
  const ceilingApplies = !(to.platformOwner && OWNER_CEILING_EXEMPT.has(event));
  const count = (applies: boolean, q: () => PromiseLike<{ count: number | null; error: unknown }>) => (applies ? exactCount(q) : Promise.resolve(0));
  const inFlight = () => db.from("platform_email_log").select("id", { count: "exact", head: true }).eq("status", "suppressed").eq("error_code", IN_FLIGHT_WORD).gte("sent_at", flightSince);
  const [orgSent, orgInFlight, allSent, allInFlight] = await Promise.all([
    count(orgApplies, () =>
      db
        .from("platform_email_log")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId!)
        .eq("status", "sent")
        .in("event_type", [...ORG_LIMITED_EVENTS])
        .gte("sent_at", dayAgo)
    ),
    count(orgApplies, () => inFlight().eq("organization_id", organizationId!)),
    count(ceilingApplies, () => db.from("platform_email_log").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", dayAgo)),
    count(ceilingApplies, () => inFlight()),
  ]);
  if (orgSent === null || orgInFlight === null) return not(unreadable(event, "organisation"));
  if (allSent === null || allInFlight === null) return not(unreadable(event, "ceiling"));

  // 7. In section F's order: the organisation's share, then the ceiling.
  if (orgApplies && orgSent + orgInFlight > limits.orgDailyLimit) return not(await writeRow(db, of, "refused", "org_limit"));
  if (ceilingApplies && allSent + allInFlight > limits.dailyCeiling) return not(await writeRow(db, of, "refused", "ceiling"));
  return { claimed: true, claim: { event, userId: to.userId, organizationId, at } };
}

/* ------------------------------------------------------------------ the send */

export type PlatformSendDeps = {
  db?: SupabaseClient;
  env?: Env;
  now?: () => number;
  /**
   * A caller's job with one deadline (rule T3), read just before the send
   * starts. The send waits the smaller of PLATFORM_SEND_TIMEOUT_MS and that;
   * with no time left nothing is dispatched and no row is written.
   */
  timeLeftMs?: () => number;
  /** A code's or a link's claim, taken by claimPlatformSend before the credential was made. */
  claim?: PlatformClaim;
};

/**
 * Send one platform email. Never throws for a send or a database outcome;
 * throws only on a programming error (an event that is not a platform
 * event, content that fails its template's check, a test to anyone but a
 * platform owner, a claim that names another event, account or
 * organisation), before anything is read or sent.
 *
 * A code or a link is sent only on its claim: the caller's, taken before
 * the credential was made, or one this call takes itself when none is
 * handed to it. A claim older than CLAIM_SEND_WITHIN_MS sends nothing and
 * writes no row (claim_stale). The welcome, the alert and the test read
 * their limits as before and write no claim. Then, for every event: "not
 * configured", the send within the time left, and the outcome's row.
 */
export async function sendPlatformEmail<E extends PlatformEvent>(req: PlatformSendRequest<E>, deps: PlatformSendDeps = {}): Promise<PlatformSendResult> {
  const { event, to, organizationId } = req;
  if (!isPlatformEvent(event)) throw new TypeError("sendPlatformEmail: not a platform event");
  if (event === "platform_test" && !to.platformOwner) {
    throw new TypeError("sendPlatformEmail: the test goes to a platform owner only");
  }
  if (deps.claim && (deps.claim.event !== event || deps.claim.userId !== to.userId || deps.claim.organizationId !== organizationId)) {
    throw new TypeError("sendPlatformEmail: the claim names another event, account or organisation");
  }
  const rendered = renderPlatformEmail(event, req.content);
  const env = deps.env ?? process.env;
  const clock = deps.now ?? Date.now;
  const db = deps.db ?? svc();
  const of: RowOf = { event, organizationId, userId: to.userId };

  if (isClaimedEvent(event)) {
    let claim = deps.claim;
    if (!claim) {
      const answer = await claimPlatformSend({ event, to, organizationId }, { db, env, now: clock });
      if (!answer.claimed) return answer.result;
      claim = answer.claim;
    }
    if (clock() - claim.at > CLAIM_SEND_WITHIN_MS) {
      console.warn(`[platform-email] ${event}: claim_stale; nothing sent`);
      return { status: "failed", errorCode: "claim_stale", logged: false };
    }
    return deliver(db, env, of, to, rendered, deps.timeLeftMs);
  }

  // The welcome, the alert and the test: their limits as read before the send.
  const now = clock();
  const dayAgo = new Date(now - DAY_MS).toISOString();
  const hourAgoMs = now - HOUR_MS;
  // 1. The account limit: the test's only (the welcome and the alert have none).
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
    if (error || !Array.isArray(data)) return unreadable(event, "account");
    const rows = data as LogRow[];
    // The test counts only the sends that reached the mail server: a test
    // that was suppressed or found the sender not configured used nothing of
    // the mailbox, so an owner fixing the setup is not locked out of testing.
    // The read is the newest 100 rows of 24 hours; the limits are read on them.
    const reachedServer = (r: LogRow) =>
      r.status === "sent" || (r.status === "failed" && DISPATCHED_FAILURE_CLASSES.has(r.error_code ?? ""));
    const attempts = rows.filter((r) => !isLimitRow(r) && reachedServer(r));
    const inHour = attempts.filter((r) => Date.parse(r.sent_at) >= hourAgoMs).length;
    if (inHour >= accountLimit.hour || attempts.length >= accountLimit.day) {
      const recorded = rows.some((r) => isLimitRow(r) && Date.parse(r.sent_at) >= hourAgoMs);
      if (recorded) return { status: "refused", errorCode: "account_limit", logged: false };
      return writeRow(db, of, "refused", "account_limit");
    }
  }
  // 2. Reserved test domains, then the allow-list.
  const held = suppression(to, env);
  if (held) return writeRow(db, of, "suppressed", held);
  // 3. The ceiling, from sent rows (a platform owner's own test is not refused by it).
  if (!(to.platformOwner && OWNER_CEILING_EXEMPT.has(event))) {
    const { count, error } = await db
      .from("platform_email_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .gte("sent_at", dayAgo);
    if (error || typeof count !== "number") return unreadable(event, "ceiling");
    if (count >= platformEmailLimits(env).dailyCeiling) return writeRow(db, of, "refused", "ceiling");
  }
  return deliver(db, env, of, to, rendered, deps.timeLeftMs);
}

/** "Not configured", then the send within the time the caller's job has left (rule T3), then the outcome's row. */
async function deliver(
  db: SupabaseClient,
  env: Env,
  of: RowOf,
  to: PlatformRecipient,
  rendered: { subject: string; text: string; html: string },
  timeLeftMs: (() => number) | undefined
): Promise<PlatformSendResult> {
  // 4. Configured.
  const smtp = readSmtpSettings(env);
  if (!smtp) return writeRow(db, of, "failed", "not_configured");

  // 5. The send.
  const waitMs = Math.floor(Math.min(PLATFORM_SEND_TIMEOUT_MS, timeLeftMs ? timeLeftMs() : Number.POSITIVE_INFINITY));
  if (!(waitMs > 0)) {
    console.warn(`[platform-email] ${of.event}: no_time; nothing sent`);
    return { status: "failed", errorCode: "no_time", logged: false };
  }
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
    { timeoutMs: waitMs }
  );
  if (result.ok) return writeRow(db, of, "sent", null);
  const cls = classifySmtpError(result.error);
  console.warn(`[platform-email] ${of.event}: not sent (${cls})`);
  const detail = scrubErrorDetail(result.error ?? "", [
    smtp.pass,
    smtp.user,
    to.email,
    smtp.from,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ]);
  return writeRow(db, of, "failed", cls, detail || null);
}
