import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { recordCredentialNotAttempted, sendNotification } from "@/lib/notifications/send";
import { openRun, requestBudget, runReading, runReady, spendCalls, type MailRun } from "@/lib/notifications/smtp-state";
import { platformSenderReadiness, sendPlatformEmail } from "@/lib/email/platform-sender";
import { ADMIN_ROLES, grantsAdminRights, listCountingMemberships, type CountingOrganisation } from "@/lib/auth/org-membership";
import { isSchemaMissing } from "@/lib/scoring/attempt-kind";
import { MAX_REQUESTS_PER_HOUR, OTP_TTL_MINUTES, generateOtpCode, hashOtp } from "@/lib/auth/password-reset";
import { sendTenantSignInLink, signInLink } from "@/lib/auth/auth-email";

/**
 * Reset codes and sign-in links asked for on the public pages (ADR 0029
 * sections A, C, D, G and I; step 12; the note of 2026-11-21, part 1).
 *
 * Before the answer (prepareCredentialRequest), for every address that
 * passed the route's format check, the same calls in one fixed order:
 *   1. the account lookup, once (lookupAccount): one page of accounts from
 *      the auth server, searched whole;
 *   2. with an organisation named: the organisation by its slug, then its
 *      run's opening (its settings, its row, tenant_mail_status: the state
 *      and the 24-hour count);
 *   3. without one, or with a slug that names none: nothing more (the
 *      platform sender's readiness is read from the environment).
 * The answer depends on the organisation's reading only (section C), never
 * on the address: a lookup that failed answers 503 for every address, as do
 * settings or an organisation that could not be read; otherwise "ready" or
 * "not ready" with its fixed sentence, the same status, body and headers
 * for an address with an account, one without, and one found twice.
 *
 * After the answer, through runAfterResponse and only for a found account,
 * the job (credentialJob):
 *   - rule 2 of section A: a platform owner, an account whose membership
 *     that counts gives administrator rights (ADR 0030's grantsAdminRights),
 *     or an open administrator invitation a platform owner made, is served
 *     by the platform sender on every page; on an organisation's page any
 *     other account is served by that organisation's own SMTP when it holds
 *     a membership there that counts, or meets the invitation rule of
 *     section I (an open invitation there and no membership that counts
 *     anywhere); anyone else gets nothing. A read this choice needs that
 *     fails sends nothing;
 *   - a job with work to do marks `started` and, last, `finished` through
 *     mail_job_mark (rule FP3); without migration 0114 it marks nothing and
 *     still sends;
 *   - a tenant-served account on an organisation that is not ready (or at
 *     its daily limit) gets nothing: no code, no link, one record row in 24
 *     hours and an alert marked as due (recordCredentialNotAttempted);
 *   - the limits of section G, read before anything is made: 5 an hour and
 *     10 a day for one account (a platform owner's own: the hourly limit
 *     only). A limit that cannot be read makes nothing;
 *   - a sign-in link is minted only for the account the lookup found, and
 *     only once the limits and rule 2 allow it: generateLink is never the
 *     lookup, and an id it returns that differs sends nothing.
 *
 * No log line holds an address, a user id, a code, a link or a database
 * message: fixed words and error codes only.
 */

type Env = Record<string, string | undefined>;

export type CredentialKind = "reset_code" | "sign_in_link";

/** Section G: one account's codes or links in 24 hours, in both systems. A platform owner's own has the hourly limit only. */
export const MAX_CREDENTIALS_PER_DAY = 10;
/** Section G: one account's codes or links in an hour (today's MAX_REQUESTS_PER_HOUR). */
export const MAX_CREDENTIALS_PER_HOUR = MAX_REQUESTS_PER_HOUR;
/**
 * The life stated in the platform's sign-in mail: the auth server's own
 * expiry of an email link, which this repository does not set (the hosted
 * default is one hour).
 */
export const SIGN_IN_LINK_MINUTES = 60;

/** The line every visitor of a page with no organisation reads (section D). */
export const LEARNERS_LINE = "Learners: sign in at your organisation's own address.";

/** The answers of section C, for every address alike. */
export const PUBLIC_ANSWERS: Record<CredentialKind, { ready: string; notReady: string; platform: string; platformNotConfigured: string }> = {
  reset_code: {
    ready: `If this address has an account with this organisation, we sent a 6-digit code. It expires in ${OTP_TTL_MINUTES} minutes.`,
    notReady: "Email could not be sent. Please contact your LMS Administrator. If a code does reach your inbox, enter it below.",
    platform: `If this address belongs to a platform or organisation administrator, a code is on its way. If none arrives in a few minutes, try again later. ${LEARNERS_LINE}`,
    platformNotConfigured: "Email could not be sent. Please try again later.",
  },
  sign_in_link: {
    ready: "If this address has an account with this organisation, we sent a sign-in link. It works once.",
    notReady: "Email could not be sent. Please contact your LMS Administrator. If a sign-in link does reach your inbox, you can use it.",
    platform: `If this address belongs to a platform or organisation administrator, a sign-in link is on its way. If none arrives in a few minutes, try again later. ${LEARNERS_LINE}`,
    platformNotConfigured: "Email could not be sent. Please try again later.",
  },
};

/** 503 for every address: the account lookup failed (ADR 0027 point 13). */
export const LOOKUP_UNAVAILABLE = { error: "account_lookup_unavailable" } as const;
/** 503 for every address: the organisation or its email settings could not be read (section C). */
export const EMAIL_UNAVAILABLE = { error: "email_unavailable" } as const;

/* ------------------------------------------------------------- the lookup */

/** The words of ADR 0027 point 6: one account, none, the address twice, or a lookup that failed. */
export type AccountLookup = { kind: "found"; userId: string } | { kind: "none" } | { kind: "ambiguous" } | { kind: "error" };

/**
 * The account behind an address: the only listUsers call on either public
 * route's path, one page of up to 1,000 accounts, as before ADR 0027's
 * slice 2 (which changes this one body). The page is searched whole, with no
 * early exit, comparing lower-cased addresses. "error": the answer carries
 * an error, the call throws, the answer holds no list, or an account on the
 * page has no id. The page's shape is read before any address is compared,
 * so "error" is the same for every address (section C).
 */
export async function lookupAccount(db: SupabaseClient, email: string): Promise<AccountLookup> {
  const want = email.trim().toLowerCase();
  let answer: { data: unknown; error: unknown };
  try {
    answer = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  } catch {
    return { kind: "error" };
  }
  if (answer.error) return { kind: "error" };
  const users = (answer.data as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return { kind: "error" };
  const page: Array<{ id: string; email?: unknown }> = [];
  for (const u of users as Array<{ id?: unknown; email?: unknown } | null>) {
    if (!u || typeof u.id !== "string" || u.id.length === 0) return { kind: "error" };
    page.push({ id: u.id, email: u.email });
  }
  let matches = 0;
  let id: string | null = null;
  for (const u of page) {
    const address = typeof u.email === "string" ? u.email.trim().toLowerCase() : null;
    if (address !== want) continue;
    matches++;
    id ??= u.id;
  }
  if (matches === 0 || id === null) return { kind: "none" };
  if (matches > 1) return { kind: "ambiguous" };
  return { kind: "found", userId: id };
}

/* ------------------------------------------------- the request, before the answer */

export type CredentialRequest = {
  kind: CredentialKind;
  /** Trimmed, lower-cased, and through the route's format check. */
  email: string;
  /** The organisation the page names; null on the page with no organisation. */
  orgSlug: string | null;
  /** The request's origin, read before the answer (the job runs after it). */
  origin: string;
  /** A sign-in link's landing page, already through safeNextPath; null for the default. */
  next: string | null;
  /** A reset code's row: the request's network address and user agent, read before the answer. */
  ip: string | null;
  userAgent: string | null;
};

export type PreparedRequest = {
  status: number;
  body: Record<string, unknown>;
  /** The work after the response: only for a found account. */
  job: (() => Promise<void>) | null;
};

type Deps = { db?: SupabaseClient; env?: Env; now?: () => number };

function serviceClient(): SupabaseClient {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

/** The calls before a run opens on a public request: the lookup and the organisation by its slug. */
const CALLS_BEFORE_THE_RUN = 2;

/**
 * The reads before the answer, the answer, and the job to run after it.
 * Never throws for a database outcome.
 */
export async function prepareCredentialRequest(req: CredentialRequest, deps: Deps = {}): Promise<PreparedRequest> {
  const db = deps.db ?? serviceClient();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const texts = PUBLIC_ANSWERS[req.kind];

  const lookup = await lookupAccount(db, req.email);
  if (lookup.kind === "error") {
    console.warn(JSON.stringify({ event: "account_lookup_unavailable", kind: req.kind }));
    return { status: 503, body: { ...LOOKUP_UNAVAILABLE }, job: null };
  }

  let org: { id: string; slug: string } | null = null;
  let run: MailRun | null = null;
  if (req.orgSlug) {
    let read: { data: unknown; error: unknown };
    try {
      read = await db.from("organizations").select("id, slug").eq("slug", req.orgSlug).maybeSingle();
    } catch {
      read = { data: null, error: { code: "thrown" } };
    }
    if (read.error) {
      console.warn(JSON.stringify({ event: "credential_org_unreadable", kind: req.kind }));
      return { status: 503, body: { ...EMAIL_UNAVAILABLE }, job: null };
    }
    const row = read.data as { id?: unknown; slug?: unknown } | null;
    if (row && typeof row.id === "string" && typeof row.slug === "string") org = { id: row.id, slug: row.slug };
  }

  let body: Record<string, unknown>;
  if (org) {
    run = await openRun({ organizationId: org.id, budget: requestBudget({ spent: CALLS_BEFORE_THE_RUN, now }), db, env, now });
    if (run.settings === "unreadable" || run.orgUnreadable) {
      console.warn(JSON.stringify({ event: "credential_settings_unreadable", kind: req.kind, org_id: org.id }));
      return { status: 503, body: { ...EMAIL_UNAVAILABLE }, job: null };
    }
    const ready = runReady(run);
    body = { ok: true, ready, message: ready ? texts.ready : texts.notReady };
  } else {
    const configured = platformSenderReadiness(env).configured;
    body = { ok: true, ready: configured, message: configured ? texts.platform : texts.platformNotConfigured };
  }

  if (lookup.kind !== "found") return { status: 200, body, job: null };
  const ctx: JobContext = { ...req, userId: lookup.userId, org, run, db, env, now };
  return { status: 200, body, job: () => credentialJob(ctx) };
}

/* ---------------------------------------------------------- the job */

type JobContext = CredentialRequest & {
  userId: string;
  org: { id: string; slug: string } | null;
  run: MailRun | null;
  db: SupabaseClient;
  env: Env;
  now: () => number;
};

type Choice =
  | { system: "platform"; organizationId: string | null; owner: boolean }
  | { system: "tenant" }
  | { system: "none" }
  | { system: "unreadable"; step: string };

/** One fixed log line of the job: the kind, the system and a fixed word. */
function note(ctx: JobContext, system: string, outcome: string, code?: string): void {
  const line = JSON.stringify({ event: "credential_mail", kind: ctx.kind, system, outcome, ...(code ? { code } : {}) });
  if (outcome === "sent") console.log(line);
  else console.warn(line);
}

/** A short code for an error: its own code or status, else "unknown". Never its message. */
function codeOf(e: unknown): string {
  const o = (e ?? {}) as { code?: unknown; status?: unknown };
  if (typeof o.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(o.code)) return o.code;
  if (typeof o.status === "number") return String(o.status);
  return "unknown";
}

function spend(ctx: JobContext, n: number): void {
  if (ctx.run) spendCalls(ctx.run.budget, n);
}

/**
 * The work after the response for one found account. Every outcome is a
 * fixed log line; it never throws for a database or send outcome
 * (runAfterResponse catches anything else).
 */
async function credentialJob(ctx: JobContext): Promise<void> {
  const choice = await chooseSystem(ctx);
  if (choice.system === "none") return;
  if (choice.system === "unreadable") {
    note(ctx, "unknown", "rule_read_failed", choice.step);
    return;
  }
  const day = await markJob(ctx, choice.system, "started");
  try {
    if (choice.system === "tenant") await tenantMail(ctx);
    else await platformMail(ctx, choice);
  } finally {
    if (day) await markJob(ctx, choice.system, "finished", day);
  }
}

type Invitation = { organization_id: string; email: string; role: string | null; invited_by: string | null };

const isAdminRole = (role: string | null | undefined) => (ADMIN_ROLES as readonly string[]).includes(role ?? "");

/** The account's open invitations: its address, not accepted, not expired. "unreadable" when the read failed. */
async function openInvitations(ctx: JobContext): Promise<Invitation[] | "unreadable"> {
  try {
    const { data, error } = await ctx.db
      .from("invitations")
      .select("organization_id, email, role, invited_by, accepted_at, expires_at")
      .eq("email", ctx.email)
      .is("accepted_at", null)
      .gt("expires_at", new Date(ctx.now()).toISOString());
    if (error || !Array.isArray(data)) return "unreadable";
    const nowMs = ctx.now();
    return (data as Array<Invitation & { accepted_at?: unknown; expires_at?: unknown }>).filter(
      (i) =>
        typeof i.organization_id === "string" &&
        String(i.email ?? "").trim().toLowerCase() === ctx.email &&
        i.accepted_at == null &&
        typeof i.expires_at === "string" &&
        Date.parse(i.expires_at) > nowMs
    );
  } catch {
    return "unreadable";
  }
}

/** Which of these accounts are platform owners. "unreadable" when the read failed. */
async function platformOwners(ctx: JobContext, ids: string[]): Promise<Set<string> | "unreadable"> {
  try {
    const { data, error } = await ctx.db.from("platform_owners").select("user_id").in("user_id", [...new Set(ids)]);
    if (error || !Array.isArray(data)) return "unreadable";
    return new Set((data as Array<{ user_id?: unknown }>).map((r) => r.user_id).filter((x): x is string => typeof x === "string"));
  } catch {
    return "unreadable";
  }
}

/**
 * Rule 2 of section A (with section I's invitation rule and ADR 0030's
 * memberships that count). Q1 before Q3: an account the platform serves
 * gets platform mail on every page, whatever the page's organisation reads.
 */
async function chooseSystem(ctx: JobContext): Promise<Choice> {
  spend(ctx, 3);
  const [memberships, invitations] = await Promise.all([listCountingMemberships(ctx.db, ctx.userId), openInvitations(ctx)]);
  if (memberships === "unreadable") return { system: "unreadable", step: "memberships" };
  if (invitations === "unreadable") return { system: "unreadable", step: "invitations" };
  const adminInvites = invitations.filter((i) => isAdminRole(i.role) && typeof i.invited_by === "string");
  spend(ctx, 1);
  const owners = await platformOwners(ctx, [ctx.userId, ...adminInvites.map((i) => i.invited_by as string)]);
  if (owners === "unreadable") return { system: "unreadable", step: "platform_owners" };

  // 1. A platform owner.
  if (owners.has(ctx.userId)) return { system: "platform", organizationId: null, owner: true };
  // 2. Administrator rights, by ADR 0030's one test, on memberships that count.
  const administered = memberships.filter((m: CountingOrganisation) => grantsAdminRights({ role: m.role, status: "active" }, { deleted_at: null }));
  if (administered.length > 0) {
    const here = ctx.org ? administered.find((m) => m.id === ctx.org!.id) : undefined;
    return { system: "platform", organizationId: (here ?? administered[0]).id, owner: false };
  }
  // 3. An open administrator invitation a platform owner made.
  const byOwner = adminInvites.filter((i) => owners.has(i.invited_by as string));
  if (byOwner.length > 0) {
    const here = ctx.org ? byOwner.find((i) => i.organization_id === ctx.org!.id) : undefined;
    return { system: "platform", organizationId: (here ?? byOwner[0]).organization_id, owner: false };
  }
  // The page with no organisation serves no one else.
  if (!ctx.org) return { system: "none" };
  // Tenant-served: a membership that counts here, or the invitation rule.
  if (memberships.some((m) => m.id === ctx.org!.id)) return { system: "tenant" };
  if (memberships.length === 0 && invitations.some((i) => i.organization_id === ctx.org!.id)) return { system: "tenant" };
  return { system: "none" };
}

/** One mail_job_mark call. Answers the day of the start mark, or null: no 0114 (no mark, the job still sends) or a failed mark. */
async function markJob(ctx: JobContext, kind: "tenant" | "platform", mark: "started" | "finished", day?: string): Promise<string | null> {
  spend(ctx, 1);
  try {
    const { data, error } = await ctx.db.rpc("mail_job_mark", day ? { p_kind: kind, p_mark: mark, p_day: day } : { p_kind: kind, p_mark: mark });
    if (error) {
      console.warn(JSON.stringify({ event: isSchemaMissing(error) ? "mail_job_mark_missing" : "mail_job_mark_failed", mark, code: codeOf(error) }));
      return null;
    }
    return typeof data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : null;
  } catch (e) {
    console.warn(JSON.stringify({ event: "mail_job_mark_failed", mark, code: codeOf(e) }));
    return null;
  }
}

/**
 * Whether the account is under its limit (section G), from the newest rows
 * of the last 24 hours, newest first, that `read` answers. null when the
 * read failed: nothing is made.
 */
async function underLimit(
  ctx: JobContext,
  read: () => PromiseLike<{ data: unknown; error: unknown }>,
  timeOf: (row: Record<string, unknown>) => unknown,
  hourlyOnly: boolean,
  counts: (row: Record<string, unknown>) => boolean = () => true
): Promise<boolean | null> {
  spend(ctx, 1);
  let answer: { data: unknown; error: unknown };
  try {
    answer = await read();
  } catch {
    return null;
  }
  if (answer.error || !Array.isArray(answer.data)) return null;
  const hourAgo = ctx.now() - 3_600_000;
  const rows = (answer.data as Array<Record<string, unknown>>).filter(counts);
  const inHour = rows.filter((r) => {
    const t = timeOf(r);
    return typeof t === "string" && Date.parse(t) >= hourAgo;
  }).length;
  if (inHour >= MAX_CREDENTIALS_PER_HOUR) return false;
  return hourlyOnly || rows.length < MAX_CREDENTIALS_PER_DAY;
}

const dayAgoIso = (ctx: JobContext) => new Date(ctx.now() - 24 * 3_600_000).toISOString();

/** Reset codes: the account's code rows of the last 24 hours (password_reset_otps), in both systems. */
function resetCodesUnderLimit(ctx: JobContext, hourlyOnly: boolean): Promise<boolean | null> {
  return underLimit(
    ctx,
    () =>
      ctx.db
        .from("password_reset_otps")
        .select("created_at")
        .eq("email", ctx.email)
        .gte("created_at", dayAgoIso(ctx))
        .order("created_at", { ascending: false })
        .limit(MAX_CREDENTIALS_PER_DAY),
    (r) => r.created_at,
    hourlyOnly
  );
}

/** A new reset code: older open codes of the address are closed, then the new code's row is written. null when the row was not written. */
async function newResetCode(ctx: JobContext): Promise<string | null> {
  const code = generateOtpCode();
  const nowIso = new Date(ctx.now()).toISOString();
  spend(ctx, 2);
  try {
    const closed = await ctx.db.from("password_reset_otps").update({ used_at: nowIso }).eq("email", ctx.email).is("used_at", null);
    if (closed.error) console.warn(JSON.stringify({ event: "credential_mail", kind: ctx.kind, outcome: "close_codes_failed", code: codeOf(closed.error) }));
    const written = await ctx.db.from("password_reset_otps").insert({
      email: ctx.email,
      code_hash: hashOtp(code),
      expires_at: new Date(ctx.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
      ip: ctx.ip,
      user_agent: ctx.userAgent,
    });
    if (written.error) {
      console.warn(JSON.stringify({ event: "credential_mail", kind: ctx.kind, outcome: "code_row_failed", code: codeOf(written.error) }));
      return null;
    }
    return code;
  } catch (e) {
    console.warn(JSON.stringify({ event: "credential_mail", kind: ctx.kind, outcome: "code_row_failed", code: codeOf(e) }));
    return null;
  }
}

/**
 * A sign-in link for the account the lookup found, minted once the limits
 * and rule 2 allow it. The auth server must answer for that same account: an
 * id that differs sends nothing (ADR 0027 point 19). null: nothing is sent.
 */
async function mintSignInLink(ctx: JobContext, next: string, system: string): Promise<string | null> {
  spend(ctx, 1);
  let answer: { data: unknown; error: unknown };
  try {
    answer = await ctx.db.auth.admin.generateLink({ type: "magiclink", email: ctx.email });
  } catch (e) {
    note(ctx, system, "mint_failed", codeOf(e));
    return null;
  }
  if (answer.error || !answer.data) {
    note(ctx, system, "mint_failed", codeOf(answer.error));
    return null;
  }
  const data = answer.data as { user?: { id?: unknown } | null; properties?: { hashed_token?: unknown } | null };
  if (data.user?.id !== ctx.userId) {
    note(ctx, system, "account_mismatch");
    return null;
  }
  const tokenHash = data.properties?.hashed_token;
  if (typeof tokenHash !== "string" || tokenHash.length === 0) {
    note(ctx, system, "mint_failed", "no_token");
    return null;
  }
  return signInLink(ctx.origin, tokenHash, next);
}

/** Through the organisation's own SMTP (a tenant-served account on its page). */
async function tenantMail(ctx: JobContext): Promise<void> {
  const run = ctx.run!;
  const org = ctx.org!;
  const event = ctx.kind === "reset_code" ? "password_reset" : "magic_link";
  if (!runReady(run)) {
    // Not attempted: no code, no link, the record row once in 24 hours and the alert marked as due.
    const reading = runReading(run);
    const atLimit = reading !== "not_configured" && reading !== "failing" && run.limit !== null;
    const why = atLimit ? "daily_limit" : "smtp_not_ready";
    await recordCredentialNotAttempted(run, { event, to: { user_id: ctx.userId, email: ctx.email } }, why);
    note(ctx, "tenant", why);
    return;
  }
  if (ctx.kind === "reset_code") {
    const under = await resetCodesUnderLimit(ctx, false);
    if (under !== true) return note(ctx, "tenant", under === null ? "limit_read_failed" : "account_limit");
    const code = await newResetCode(ctx);
    if (!code) return;
    const r = await sendNotification(
      {
        organizationId: run.organizationId,
        event: "password_reset",
        to: { user_id: ctx.userId, email: ctx.email },
        context: {
          learner_name: ctx.email,
          learner_email: ctx.email,
          otp_code: code,
          otp_minutes: String(OTP_TTL_MINUTES),
          org_name: run.orgName,
        },
      },
      { run }
    );
    return note(ctx, "tenant", r.status === "sent" ? "sent" : "not_sent", r.errorClass);
  }
  const under = await underLimit(
    ctx,
    () =>
      ctx.db
        .from("notification_log")
        .select("sent_at")
        .eq("to_user_id", ctx.userId)
        .eq("event_type", "magic_link")
        .gte("sent_at", dayAgoIso(ctx))
        .order("sent_at", { ascending: false })
        .limit(MAX_CREDENTIALS_PER_DAY),
    (r) => r.sent_at,
    false
  );
  if (under !== true) return note(ctx, "tenant", under === null ? "limit_read_failed" : "account_limit");
  const link = await mintSignInLink(ctx, ctx.next ?? `/${org.slug}/dashboard`, "tenant");
  if (!link) return;
  const r = await sendTenantSignInLink(run, { userId: ctx.userId, email: ctx.email }, link);
  note(ctx, "tenant", r.status === "sent" ? "sent" : "not_sent", r.errorClass);
}

/** Through the platform sender (a platform-served account, on any page). */
async function platformMail(ctx: JobContext, choice: { organizationId: string | null; owner: boolean }): Promise<void> {
  const to = { userId: ctx.userId, email: ctx.email, platformOwner: choice.owner };
  const deps = { db: ctx.db, env: ctx.env, now: ctx.now };
  if (ctx.kind === "reset_code") {
    const under = await resetCodesUnderLimit(ctx, choice.owner);
    if (under !== true) return note(ctx, "platform", under === null ? "limit_read_failed" : "account_limit");
    const code = await newResetCode(ctx);
    if (!code) return;
    const r = await sendPlatformEmail(
      { event: "platform_reset_code", to, organizationId: choice.organizationId, content: { code, minutes: OTP_TTL_MINUTES } },
      deps
    );
    return note(ctx, "platform", r.status, r.errorCode ?? undefined);
  }
  // The platform sender reads this same limit before it sends; it is read
  // here first so that no link is minted for an account past it.
  const under = await underLimit(
    ctx,
    () =>
      ctx.db
        .from("platform_email_log")
        .select("sent_at, status, error_code")
        .eq("to_user_id", ctx.userId)
        .eq("event_type", "platform_sign_in_link")
        .gte("sent_at", dayAgoIso(ctx))
        .order("sent_at", { ascending: false })
        .limit(100),
    (r) => r.sent_at,
    choice.owner,
    // The sender's own refusal rows are not requests.
    (r) => !(r.status === "refused" && r.error_code === "account_limit")
  );
  if (under !== true) return note(ctx, "platform", under === null ? "limit_read_failed" : "account_limit");
  const link = await mintSignInLink(ctx, ctx.next ?? "/select-org", "platform");
  if (!link) return;
  const r = await sendPlatformEmail(
    { event: "platform_sign_in_link", to, organizationId: choice.organizationId, content: { link, minutes: SIGN_IN_LINK_MINUTES } },
    deps
  );
  note(ctx, "platform", r.status, r.errorCode ?? undefined);
}
