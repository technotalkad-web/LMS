/**
 * ADR 0029 spec 79: the two mail systems kept apart, on staging.
 *
 * Tenant mail (an organisation's own SMTP) serves its learners; the platform
 * sender serves platform owners and administrators. Nothing falls back from
 * one to the other. Every case seeds its own organisation and accounts in the
 * lifecycle namespace (./data), reads the rows the app writes after its
 * answer (the mail jobs run after the response, so each read waits), and
 * deletes what it made when the file ends, also after a failure.
 *
 * Opening check (staging holds migrations 0114 and 0117): with the service
 * role, tenant_mail_status for one organisation, mail_job_mark for a start
 * and its finish, and a read of account_setup_links, each with no error;
 * then the build's health answer read with the cron secret, whose
 * tenant_smtp and mail_jobs read other than unknown, with no_0114 false. A
 * fallback taken on staging fails here. The file also counts staging's
 * accounts first: the public routes' account lookup reads one page of 1,000,
 * so the file stops with a message when the count leaves no room for its own.
 *
 * Rules the file keeps:
 *   - An alert is only marked as due by a request; a scheduled call sends the
 *     oldest due alert, one a call. A case that marks one counts the marks
 *     due and older than its own, posts journey-nudges that many times and
 *     once more, and stops as soon as its own mark is empty. More than twenty
 *     older marks fail the case with the count. No mark of this file's
 *     organisations is left due.
 *   - A broken SMTP is a host under a reserved top-level name (.invalid) with
 *     the other settings complete: no mail can leave it.
 *   - A case that needs a delivered mail is skipped, with its reason shown,
 *     when the bot inbox settings are absent; every other case runs.
 *   - The accounts are on a reserved domain, which the platform sender reads
 *     before its allow-list and before its own settings, so every platform
 *     row here is `suppressed` with `test_domain` on any build, with or
 *     without the platform sender's settings.
 *   - A limit under requests made at once is read as "at most", and the
 *     requests as claimed by at least one claim row of each kind.
 *   - A scheduled call (a POST to /api/cron/*) goes only to a local app or a
 *     staging app (isStagingAppUrl of scripts/staging-cron-post.mjs); any
 *     other address fails the case before the call.
 *   - A navigation to a setup link never prints its fragment: a failed one
 *     is reported with the fragment as #t=<redacted>.
 *   - A clean-up step that fails fails the run, with the count of failed
 *     steps and no address.
 *
 * Settings: the lifecycle suite's (NEXT_PUBLIC_SUPABASE_URL and the two
 * keys, E2E_BASE_URL), and the app's cron secret as spec 78 reads it
 * (LIFECYCLE_CRON_SECRET, which scripts/lifecycle-nightly.sh sets for the app
 * it starts, or KIVO_CLOUD_RUN_CRON_SECRET for a hand run on Cloud Run). The
 * mail cases read the bot inbox settings (./inbox.ts).
 *
 * Nothing printed holds an address, a link, a token or a code.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { addMember, createAuthUser, createOrg, markPlatformOwner, rand, svc, testEmail } from "./data";
import { authedContext } from "../lib/session";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { aliasFor, configureOrgSmtp } from "./inbox";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CRON_SECRET = process.env.LIFECYCLE_CRON_SECRET || process.env.KIVO_CLOUD_RUN_CRON_SECRET || "";
const MAIL_READY = !!(process.env.BOT_MAIL_ADDRESS && process.env.BOT_SMTP_USER && process.env.BOT_SMTP_PASS);
const MAIL_SKIP = "the bot inbox is not configured (BOT_MAIL_ADDRESS, BOT_SMTP_USER, BOT_SMTP_PASS)";

/** A host under the reserved top-level name .invalid: it never resolves, so no mail can leave it. */
const BROKEN_HOST = "smtp.lifecycle-79.invalid";
/** The job after the answer has 25 s for everything (CREDENTIAL_JOB_MS in lib/auth/credential-mail.ts). */
const JOB_MS = 25_000;
/** Accounts this file makes at most (35 by its cases), kept clear of the lookup's one page of 1,000. */
const ACCOUNTS_THIS_FILE_MAKES = 40;
const LOOKUP_PAGE = 1000;
/** The not-ready answers of an organisation's page start with this (PUBLIC_ANSWERS in lib/auth/credential-mail.ts). */
const NOT_READY_START = "Email could not be sent. Please contact your LMS Administrator.";
/** Rule N10's one answer for a link that cannot be used (lib/auth/setup-link.ts). */
const LINK_UNUSABLE = "This link can no longer be used. Ask your LMS Administrator for a new one, or use Forgot password.";
/** The Attention Center's item once routine mail stops at the daily limit (lib/attention/collect.ts). */
const ROUTINE_STOPPED_TITLE = "Routine email has stopped for today";

type Org = { id: string; slug: string; name: string };
type Account = { id: string; email: string; password: string };
type LogRow = { id: string; event_type: string; status: string; error: string | null; to_user_id: string | null };
type PlatformRow = { event_type: string; status: string; error_code: string | null; organization_id: string | null };
type StateRow = { state: string | null; alert_due_at: string | null; last_alert_at: string | null; daily_limit: number | null };
type Answer = { status: number; text: string; json: { ok?: unknown; ready?: unknown; message?: unknown } };

/** What this file made, for the clean-up at its end. */
const made = { orgs: [] as string[], users: [] as string[], owners: [] as string[], emails: new Set<string>() };

const db = (): SupabaseClient => svc();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let BASE = "";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function newOrg(purpose: string): Promise<Org> {
  const org = await createOrg({ name: `Lifecycle 79 ${purpose}` });
  made.orgs.push(org.id);
  return org;
}

async function newAccount(purpose: string, opts: { alias?: boolean } = {}): Promise<Account> {
  const email = opts.alias ? aliasFor(`s79${purpose}${rand(4)}`) : testEmail(`s79-${purpose}`);
  made.emails.add(email.toLowerCase());
  const u = await createAuthUser({ email, profile: { first_name: "S79", last_name: purpose, must_change_password: false } });
  made.users.push(u.id);
  return u;
}

async function member(org: Org, purpose: string, role: "user" | "admin" = "user", opts: { alias?: boolean } = {}): Promise<Account> {
  const a = await newAccount(purpose, opts);
  await addMember({ organizationId: org.id, userId: a.id, role });
  return a;
}

/** An address with no account behind it. */
function nobody(): string {
  const email = testEmail("s79-nobody");
  made.emails.add(email.toLowerCase());
  return email;
}

/** Complete settings whose host never resolves: the organisation reads ready until its sends fail. */
async function brokenSmtp(orgId: string): Promise<void> {
  const { error } = await db()
    .from("notification_settings")
    .upsert(
      {
        organization_id: orgId,
        smtp_host: BROKEN_HOST,
        smtp_port: 465,
        smtp_secure: true,
        smtp_user: "mailer@lifecycle.test",
        smtp_password: `S79-${rand(12)}`,
        from_email: "mailer@lifecycle.test",
        from_name: "Lifecycle 79",
        email_paused: false,
      },
      { onConflict: "organization_id" }
    );
  expect(error, "write the organisation's broken SMTP settings").toBeNull();
}

let owner: Account | null = null;
/** One platform owner for the file: a password, a confirmed address, no forced change, mfa_required false. */
async function platformOwner(): Promise<Account> {
  if (owner) return owner;
  const o = await newAccount("owner");
  await markPlatformOwner(o.id);
  made.owners.push(o.id);
  owner = o;
  return o;
}

async function invite(orgId: string, email: string, role: "member" | "admin", invitedBy: string): Promise<void> {
  const { error } = await db().from("invitations").insert({
    organization_id: orgId,
    email: email.toLowerCase(),
    role,
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  expect(error, "write the invitation").toBeNull();
}

// ---------------------------------------------------------------------------
// The two public routes
// ---------------------------------------------------------------------------

async function ask(kind: "code" | "link", email: string, orgSlug: string | null): Promise<Answer> {
  const path = kind === "code" ? "/api/auth/forgot-password/request" : "/api/auth/magic-link";
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(orgSlug ? { email, orgSlug } : { email }),
  });
  const text = await res.text();
  let json: Answer["json"] = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { status: res.status, text, json };
}

/** Every address on one page gets the same status and body. Returns the shared answer. */
function sameAnswer(answers: Answer[], what: string): Answer {
  for (const a of answers.slice(1)) {
    expect(a.status, `${what}: the same status for every address`).toBe(answers[0].status);
    expect(a.text, `${what}: the same body for every address`).toBe(answers[0].text);
  }
  expect(answers[0].status, `${what}: 200`).toBe(200);
  return answers[0];
}

// ---------------------------------------------------------------------------
// Reading the rows
// ---------------------------------------------------------------------------

async function tenantRows(orgId: string, userId?: string): Promise<LogRow[]> {
  let q = db().from("notification_log").select("id, event_type, status, error, to_user_id").eq("organization_id", orgId);
  if (userId) q = q.eq("to_user_id", userId);
  const { data, error } = await q;
  expect(error, "read notification_log").toBeNull();
  return (data ?? []) as LogRow[];
}

async function platformRows(userId: string): Promise<PlatformRow[]> {
  const { data, error } = await db().from("platform_email_log").select("event_type, status, error_code, organization_id").eq("to_user_id", userId);
  expect(error, "read platform_email_log").toBeNull();
  return (data ?? []) as PlatformRow[];
}

async function stateRow(orgId: string): Promise<StateRow | null> {
  const { data, error } = await db().from("tenant_smtp_state").select("state, alert_due_at, last_alert_at, daily_limit").eq("organization_id", orgId).maybeSingle();
  expect(error, "read tenant_smtp_state").toBeNull();
  return (data as StateRow | null) ?? null;
}

/** A send that reached the mail server: a sent row, or a failed row the send itself wrote. */
const attempted = (r: LogRow) => r.status === "sent" || (r.status === "failed" && String(r.error ?? "").startsWith("tenant SMTP failed:"));
const inFlight = (r: LogRow) => r.status === "queued" && r.error === "in_flight";
/** A sign-in link's claim on the organisation's SMTP (CREDENTIAL_CLAIM_ERROR in lib/notifications/send.ts). */
const linkClaim = (r: LogRow) => r.status === "queued" && r.error === "claim";
const ofEvent = (rows: LogRow[], event: string) => rows.filter((r) => r.event_type === event);
const suppressedOnTestDomain = (r: PlatformRow) => r.status === "suppressed" && r.error_code === "test_domain";

/** Poll a read until it passes. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = JOB_MS + 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await read();
  while (!ok(v)) {
    if (Date.now() > end) {
      expect(ok(v), `${what} (waited ${Math.round(timeoutMs / 1000)} s)`).toBe(true);
      return v;
    }
    await sleep(1_500);
    v = await read();
  }
  return v;
}

/** After requests whose jobs run after the answer: past every job's deadline, then until the rows stop moving. */
async function settled(read: () => Promise<unknown[]>): Promise<void> {
  await sleep(JOB_MS + 3_000);
  let last = (await read()).length;
  for (let i = 0; i < 10; i++) {
    await sleep(3_000);
    const n = (await read()).length;
    if (n === last) return;
    last = n;
  }
}

async function health(withSecret: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/ops/health`, { headers: withSecret ? { "x-cron-secret": CRON_SECRET } : {} });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * isStagingAppUrl of scripts/staging-cron-post.mjs. It is loaded by a
 * dynamic import, as the ES module it is: a static import here is compiled
 * to require, which cannot load that file.
 */
async function stagingAppTest(): Promise<(raw: string) => boolean> {
  const href = pathToFileURL(path.resolve(__dirname, "../../../scripts/staging-cron-post.mjs")).href;
  const mod = (await import(href)) as { isStagingAppUrl?: unknown };
  if (typeof mod.isStagingAppUrl !== "function") throw new Error("scripts/staging-cron-post.mjs exports no isStagingAppUrl");
  return mod.isStagingAppUrl as (raw: string) => boolean;
}

/**
 * Whether a scheduled call may go to this app: a local app (localhost,
 * 127.0.0.1 or [::1], over http or https, with nothing after the port), or a
 * staging app as scripts/staging-cron-post.mjs reads one.
 */
async function cronTargetAllowed(base: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return false;
  const local = (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return local || (await stagingAppTest())(`${base.replace(/\/+$/, "")}/`);
}

/** Every POST to /api/cron/* of this file: refused before the call unless the app is local or staging's. */
async function cronPost(route: string): Promise<Response> {
  expect(await cronTargetAllowed(`${BASE}/`), "a scheduled call goes only to a local app or a staging app (E2E_BASE_URL)").toBe(true);
  return fetch(`${BASE}/api/cron/${route}`, { method: "POST", headers: { "x-cron-secret": CRON_SECRET } });
}

/**
 * Open an address that holds a setup link. A failed navigation is reported
 * with the fragment as #t=<redacted>: a new error, so neither its message
 * nor its stack carries the token.
 */
async function gotoSetupLink(page: Page, address: string): Promise<void> {
  try {
    await page.goto(address);
  } catch (e) {
    const redact = (s: string) => s.replace(/#t=[^\s"'`<>)\]]*/g, "#t=<redacted>");
    throw new Error(redact(e instanceof Error ? e.message : String(e)));
  }
}

/** Rule (a) of the file: send this organisation's due alert by the scheduled call, past any older mark. */
async function sendOwnAlert(orgId: string): Promise<void> {
  const own = await stateRow(orgId);
  expect(own?.alert_due_at, "this case's alert is due").toBeTruthy();
  const { count, error } = await db()
    .from("tenant_smtp_state")
    .select("organization_id", { count: "exact", head: true })
    .not("alert_due_at", "is", null)
    .lt("alert_due_at", own!.alert_due_at!);
  expect(error, "count the older marks").toBeNull();
  const older = count ?? 0;
  expect(older, `${older} older alert marks are due on staging; more than twenty is worth a look before this runs`).toBeLessThanOrEqual(20);
  for (let i = 0; i <= older; i++) {
    const res = await cronPost("journey-nudges");
    await res.text().catch(() => "");
    expect(res.status === 401 || res.status === 403, "the cron secret is accepted").toBe(false);
    if (!(await stateRow(orgId))?.alert_due_at) return;
  }
  expect((await stateRow(orgId))?.alert_due_at ?? null, `this case's alert is sent after ${older + 1} scheduled calls`).toBeNull();
}

/**
 * A delivered mail in the bot inbox, by its exact recipient. Each poll opens
 * a fresh connection and reads the inbox's newest messages itself, comparing
 * each envelope's recipients, so it does not wait on the mail server's own
 * search index. A timeout says so without naming the recipient.
 */
async function mailArrives(recipient: string, since: Date): Promise<{ text: string; html: string }> {
  const want = recipient.toLowerCase();
  const floor = since.getTime() - 60_000;
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const client = new ImapFlow({
      host: process.env.BOT_IMAP_HOST || "imap.gmail.com",
      port: Number(process.env.BOT_IMAP_PORT || 993),
      secure: true,
      auth: { user: process.env.BOT_MAIL_ADDRESS!, pass: (process.env.BOT_IMAP_PASS || process.env.BOT_SMTP_PASS || "").replace(/\s+/g, "") },
      logger: false,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const found = await client.search({ since: new Date(floor - 86_400_000) }, { uid: true });
        const recent = (Array.isArray(found) ? found : []).slice(-200);
        let best = 0;
        if (recent.length) {
          for await (const m of client.fetch(recent.join(","), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
            const to = (m.envelope?.to ?? []).map((a) => String(a.address ?? "").toLowerCase());
            const at = m.internalDate ? new Date(m.internalDate).getTime() : 0;
            if (to.includes(want) && at >= floor && m.uid > best) best = m.uid;
          }
        }
        if (best) {
          const msg = await client.fetchOne(String(best), { source: true }, { uid: true });
          const parsed = await simpleParser((msg as { source: Buffer }).source);
          return { text: parsed.text ?? "", html: typeof parsed.html === "string" ? parsed.html : "" };
        }
      } finally {
        lock.release();
      }
    } catch {
      // A failed read: the next poll tries again on a new connection.
    } finally {
      await client.logout().catch(() => {});
    }
    await sleep(5_000);
  }
  throw new Error("the mail did not arrive in the bot inbox within 180 s");
}

/** The Settings test, run by an administrator of the organisation from the bot inbox, as the SMTP tab's "Send test" does. */
async function settingsTest(browser: Browser, org: Org, admin: Account): Promise<{ status?: string; reading?: string }> {
  const ctx = await authedContext(browser, BASE, admin.email, admin.password);
  try {
    const res = await ctx.request.post("/api/notifications/settings/test", { data: { orgSlug: org.slug } });
    expect(res.status(), "the Settings test answers 200").toBe(200);
    const body = (await res.json()) as { test?: { status?: string; reading?: string } };
    return body.test ?? {};
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

test.describe.serial("ADR 0029 spec 79: tenant mail and platform mail kept apart", () => {
  test.beforeAll(({}, testInfo) => {
    BASE = String(testInfo.project.use.baseURL ?? process.env.E2E_BASE_URL ?? "").replace(/\/+$/, "");
  });

  test.afterAll(async () => {
    const d = db();
    let failed = 0;
    /** One clean-up step: an error it answers, or one it throws, counts as failed; every step runs. */
    const step = async (run: () => PromiseLike<{ error: unknown }>, tolerate: (error: unknown) => boolean = () => false): Promise<void> => {
      try {
        const { error } = await run();
        if (error && !tolerate(error)) failed++;
      } catch {
        failed++;
      }
    };
    for (const id of made.owners) await step(() => d.from("platform_owners").delete().eq("user_id", id));
    for (const id of made.orgs) await step(() => d.from("organizations").delete().eq("id", id));
    // Accounts the app made for this file (the bulk file's rows, the console's
    // administrator) are found by their address.
    const byAddress: string[] = [];
    try {
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await d.auth.admin.listUsers({ page, perPage: LOOKUP_PAGE });
        if (error) {
          failed++;
          break;
        }
        const users = data?.users ?? [];
        for (const u of users) if (u.email && made.emails.has(u.email.toLowerCase())) byAddress.push(u.id);
        if (users.length < LOOKUP_PAGE) break;
      }
    } catch {
      failed++;
    }
    const accounts = new Set([...made.users, ...byAddress]);
    for (const id of accounts) await step(() => d.auth.admin.deleteUser(id), (error) => (error as { status?: number }).status === 404);
    if (made.emails.size) await step(() => d.from("password_reset_otps").delete().in("email", [...made.emails]));
    console.log(`[spec 79 cleanup] organisations=${made.orgs.length} accounts=${accounts.size} failed=${failed}`);
    // A step that failed fails the run: the count only, never an address.
    if (failed > 0) throw new Error(`spec 79 clean-up: ${failed} step(s) failed; see the [spec 79 cleanup] line`);
  });

  test("staging holds 0114 and 0117, takes no fallback, and leaves the account lookup room", async () => {
    expect(CRON_SECRET, "set LIFECYCLE_CRON_SECRET (scripts/lifecycle-nightly.sh sets it for the app it starts) or KIVO_CLOUD_RUN_CRON_SECRET (Cloud Run)").not.toBe("");

    // The public routes' lookup reads one page of accounts (ADR 0027 slice 2 changes that).
    const { data: page1, error: listError } = await db().auth.admin.listUsers({ page: 1, perPage: LOOKUP_PAGE });
    expect(listError, "count staging's accounts").toBeNull();
    const accounts = page1?.users?.length ?? 0;
    if (accounts + ACCOUNTS_THIS_FILE_MAKES >= LOOKUP_PAGE) {
      throw new Error(
        `staging holds ${accounts >= LOOKUP_PAGE ? "1,000 or more" : accounts} accounts: with this file's own the public routes' one-page lookup could miss one, and that would read as a lost job. Stopped before any case.`
      );
    }

    const org = await newOrg("opening");
    const status = await db().rpc("tenant_mail_status", { p_org: org.id });
    expect(status.error, "tenant_mail_status answers").toBeNull();
    expect(Array.isArray(status.data) && status.data.length === 1, "tenant_mail_status answers one row for the organisation").toBe(true);
    const start = await db().rpc("mail_job_mark", { p_kind: "tenant", p_mark: "started" });
    expect(start.error, "mail_job_mark started answers").toBeNull();
    expect(typeof start.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start.data), "mail_job_mark hands back its day").toBe(true);
    const finish = await db().rpc("mail_job_mark", { p_kind: "tenant", p_mark: "finished", p_day: start.data });
    expect(finish.error, "mail_job_mark finished answers").toBeNull();
    const links = await db().from("account_setup_links").select("id", { count: "exact", head: true }).limit(1);
    expect(links.error, "account_setup_links can be read").toBeNull();

    const h = await health(true);
    expect([200, 503], "the health answer").toContain(h.status);
    const checks = (h.body.email_checks ?? {}) as Record<string, { status?: string; detail?: { no_0114?: unknown } }>;
    for (const name of ["tenant_smtp", "mail_jobs"]) {
      expect(checks[name]?.status, `${name} reads other than unknown`).toBeTruthy();
      expect(checks[name]?.status, `${name} reads other than unknown`).not.toBe("unknown");
      expect(checks[name]?.detail?.no_0114, `${name}: no_0114 is false`).toBe(false);
    }
  });

  test("the health check with the secret: the new checks sit under email_checks, none under checks", async () => {
    const h = await health(true);
    const checks = Object.keys((h.body.checks ?? {}) as object).sort();
    const email = Object.keys((h.body.email_checks ?? {}) as object);
    expect(checks, "checks hold the five checks they held").toEqual(["crons", "db", "email", "lrs_outbox", "storage"]);
    for (const name of ["platform_email", "tenant_smtp", "mail_jobs"]) {
      expect(email, `${name} is under email_checks`).toContain(name);
      expect(checks, `${name} is not under checks`).not.toContain(name);
    }
    const open = await health(false);
    expect(Object.keys(open.body).sort(), "without the secret: the status and the time only").toEqual(["status", "ts"]);
  });

  test("a ready organisation: a member's reset writes one sent row, and the answer is the ready one (mail)", async () => {
    test.skip(!MAIL_READY, MAIL_SKIP);
    const org = await newOrg("ready");
    await configureOrgSmtp(org.id);
    const learner = await member(org, "ready", "user", { alias: true });
    const since = new Date(Date.now() - 60_000);
    const answer = sameAnswer([await ask("code", learner.email, org.slug), await ask("code", nobody(), org.slug)], "ready organisation");
    expect(answer.json.ready, "the ready answer").toBe(true);
    const rows = await until(() => tenantRows(org.id, learner.id), (r) => ofEvent(r, "password_reset").some(attempted), "the member's reset is attempted");
    const resets = ofEvent(rows, "password_reset").filter(attempted);
    expect(resets.length, "one attempted reset row").toBe(1);
    expect(resets[0].status, "the reset row is sent").toBe("sent");
    const mail = await mailArrives(learner.email, since);
    expect(/\b\d{6}\b/.test(mail.text), "the mail holds a six-digit code").toBe(true);
  });

  test("no SMTP: a member and an unknown address get the same not-ready answer; one record row; one alert, and none for a second request", async () => {
    const org = await newOrg("nosmtp");
    const admin = await member(org, "nosmtp-admin", "admin");
    const learner = await member(org, "nosmtp");
    const answer = sameAnswer([await ask("code", learner.email, org.slug), await ask("code", nobody(), org.slug)], "no SMTP");
    expect(answer.json.ready, "the not-ready answer").toBe(false);
    expect(String(answer.json.message).startsWith(NOT_READY_START), "the not-ready sentence").toBe(true);

    const rows = await until(() => tenantRows(org.id, learner.id), (r) => r.length > 0, "the member's record row is written");
    expect(rows.length, "one row for the member").toBe(1);
    expect(rows[0].status === "failed" && rows[0].error === "smtp_not_ready", "it is the record of a send not attempted").toBe(true);
    const first = await until(() => stateRow(org.id), (s) => !!s?.alert_due_at, "one alert is marked as due");

    // A second request: no second record row in 24 hours, and no second mark.
    await ask("code", learner.email, org.slug);
    await sleep(JOB_MS);
    expect((await tenantRows(org.id, learner.id)).length, "still one row for the member").toBe(1);
    expect((await stateRow(org.id))?.alert_due_at, "the mark is the first one").toBe(first!.alert_due_at);

    await sendOwnAlert(org.id);
    const alert = await until(() => platformRows(admin.id), (r) => r.some((x) => x.event_type === "tenant_smtp_alert"), "the alert's platform row");
    const alerts = alert.filter((x) => x.event_type === "tenant_smtp_alert");
    expect(alerts.length, "one alert row for the administrator").toBe(1);
    expect(alerts.every(suppressedOnTestDomain), "the alert to a reserved domain is suppressed").toBe(true);

    // A request after the alert was sent marks nothing inside the bound.
    await ask("code", learner.email, org.slug);
    await sleep(JOB_MS);
    expect((await stateRow(org.id))?.alert_due_at ?? null, "no new mark inside the bound").toBeNull();
    expect((await platformRows(admin.id)).filter((x) => x.event_type === "tenant_smtp_alert").length, "still one alert").toBe(1);
  });

  const broken: { org?: Org; members: Account[] } = { members: [] };

  test("a broken SMTP: failures to three members turn it failing, then every address gets the not-ready answer", async () => {
    const org = await newOrg("broken");
    broken.org = org;
    const admin = await member(org, "broken-admin", "admin");
    await brokenSmtp(org.id);
    for (let i = 1; i <= 4; i++) broken.members.push(await member(org, `broken${i}`));

    const before = sameAnswer([await ask("code", broken.members[0].email, org.slug), await ask("code", nobody(), org.slug)], "broken SMTP before it fails");
    expect(before.json.ready, "complete settings read ready before any failure").toBe(true);
    await until(() => tenantRows(org.id, broken.members[0].id), (r) => r.some(attempted), "the first member's send is attempted");
    for (const m of broken.members.slice(1, 3)) {
      await ask("code", m.email, org.slug);
      await until(() => tenantRows(org.id, m.id), (r) => r.some(attempted), "the member's send is attempted");
    }
    await until(() => stateRow(org.id), (s) => s?.state === "failing", "three members' failures turn the state failing");

    const after = sameAnswer(
      [await ask("code", broken.members[0].email, org.slug), await ask("code", broken.members[3].email, org.slug), await ask("code", nobody(), org.slug)],
      "broken SMTP once failing"
    );
    expect(after.json.ready, "the not-ready answer once failing").toBe(false);
    await sleep(JOB_MS);
    expect((await tenantRows(org.id, broken.members[3].id)).some(attempted), "nothing is attempted once failing").toBe(false);
    expect((await tenantRows(org.id)).filter((r) => r.status === "sent").length, "no sent row").toBe(0);

    await sendOwnAlert(org.id);
    const alerts = (await platformRows(admin.id)).filter((x) => x.event_type === "tenant_smtp_alert");
    expect(alerts.length, "one alert row for the administrator").toBe(1);
    expect(alerts.every(suppressedOnTestDomain), "the alert to a reserved domain is suppressed").toBe(true);
  });

  test("a broken SMTP: a delivered test from Settings clears it (mail)", async ({ browser }) => {
    test.skip(!MAIL_READY, MAIL_SKIP);
    const org = broken.org!;
    expect(org, "the broken organisation of the case before").toBeTruthy();
    await configureOrgSmtp(org.id);
    const tester = await member(org, "broken-tester", "admin", { alias: true });
    const since = new Date(Date.now() - 60_000);
    const t = await settingsTest(browser, org, tester);
    expect(t.status, "the Settings test was delivered to the mail server").toBe("sent");
    await until(() => stateRow(org.id), (s) => s?.state === "healthy", "a delivered test clears the state");
    const answer = await ask("code", nobody(), org.slug);
    expect(answer.json.ready, "the ready answer again").toBe(true);
    await mailArrives(tester.email, since);
  });

  test("an administrator on a not-ready page: one platform row, no tenant attempt, no alert", async () => {
    const org = await newOrg("admin-page");
    const admin = await member(org, "admin-page", "admin");
    const answer = sameAnswer([await ask("code", admin.email, org.slug), await ask("code", nobody(), org.slug)], "not-ready page");
    expect(answer.json.ready, "the not-ready answer").toBe(false);
    const rows = await until(() => platformRows(admin.id), (r) => r.length > 0, "the administrator's platform row");
    expect(rows.length, "one platform row").toBe(1);
    expect(rows[0].event_type === "platform_reset_code" && rows[0].organization_id === org.id, "a platform reset code for this organisation").toBe(true);
    expect(suppressedOnTestDomain(rows[0]), "suppressed on the reserved domain").toBe(true);
    await sleep(3_000);
    expect((await tenantRows(org.id)).length, "no tenant row").toBe(0);
    expect((await stateRow(org.id))?.alert_due_at ?? null, "no alert is marked").toBeNull();
  });

  test("the page with no organisation: a platform row for a platform-served account, nothing for a learner, the same answer", async () => {
    const org = await newOrg("no-org");
    const admin = await member(org, "no-org-admin", "admin");
    const learner = await member(org, "no-org");
    const po = await platformOwner();
    sameAnswer(
      [await ask("code", admin.email, null), await ask("code", learner.email, null), await ask("code", po.email, null), await ask("code", nobody(), null)],
      "the page with no organisation"
    );
    const adminRows = await until(() => platformRows(admin.id), (r) => r.length > 0, "the administrator's platform row");
    expect(adminRows.length === 1 && adminRows[0].event_type === "platform_reset_code" && adminRows[0].organization_id === org.id, "one platform row for the administrator, for their organisation").toBe(true);
    expect(suppressedOnTestDomain(adminRows[0]), "suppressed on the reserved domain").toBe(true);
    const ownerRows = await until(() => platformRows(po.id), (r) => r.some((x) => x.event_type === "platform_reset_code"), "the platform owner's platform row");
    const ownerCodes = ownerRows.filter((x) => x.event_type === "platform_reset_code");
    expect(ownerCodes.length === 1 && ownerCodes[0].organization_id === null, "one platform row for the platform owner's own code").toBe(true);
    expect(suppressedOnTestDomain(ownerCodes[0]), "suppressed on the reserved domain").toBe(true);
    await sleep(3_000);
    expect((await platformRows(learner.id)).length, "no platform row for the learner").toBe(0);
    expect((await tenantRows(org.id)).length, "no tenant row").toBe(0);
  });

  test("the invitation rule: no membership gets tenant mail; a membership in another live organisation gets none; one only in a deleted organisation gets tenant mail", async () => {
    const org = await newOrg("invite");
    const admin = await member(org, "invite-admin", "admin");
    await brokenSmtp(org.id);
    const other = await newOrg("invite-other");
    const gone = await newOrg("invite-gone");

    const fresh = await newAccount("invite-fresh");
    const elsewhere = await newAccount("invite-elsewhere");
    await addMember({ organizationId: other.id, userId: elsewhere.id, role: "user" });
    const deletedOnly = await newAccount("invite-deleted");
    await addMember({ organizationId: gone.id, userId: deletedOnly.id, role: "user" });
    const { error } = await db().from("organizations").update({ deleted_at: new Date().toISOString() }).eq("id", gone.id);
    expect(error, "mark the third organisation deleted").toBeNull();
    for (const a of [fresh, elsewhere, deletedOnly]) await invite(org.id, a.email, "member", admin.id);

    for (const a of [fresh, elsewhere, deletedOnly]) await ask("code", a.email, org.slug);
    await until(() => tenantRows(org.id, fresh.id), (r) => r.some(attempted), "an invited account with no membership gets tenant mail");
    await until(() => tenantRows(org.id, deletedOnly.id), (r) => r.some(attempted), "an invited account whose only membership is in a deleted organisation gets tenant mail");
    await sleep(JOB_MS);
    expect((await tenantRows(org.id, elsewhere.id)).length, "an invited account with a membership in another live organisation gets no tenant mail").toBe(0);
    expect((await platformRows(elsewhere.id)).length, "and no platform mail").toBe(0);
    expect((await stateRow(org.id))?.state ?? null, "two people's failures leave the organisation ready").not.toBe("failing");
  });

  test("a new organisation with no SMTP whose first administrator, an existing account, was invited by a platform owner: one platform row, no tenant attempt", async () => {
    const org = await newOrg("first-admin");
    const po = await platformOwner();
    const first = await newAccount("first-admin");
    await invite(org.id, first.email, "admin", po.id);
    const answer = sameAnswer([await ask("code", first.email, org.slug), await ask("code", nobody(), org.slug)], "new organisation");
    expect(answer.json.ready, "the not-ready answer").toBe(false);
    const rows = await until(() => platformRows(first.id), (r) => r.length > 0, "the invited administrator's platform row");
    expect(rows.length === 1 && rows[0].event_type === "platform_reset_code" && rows[0].organization_id === org.id, "one platform reset code for the new organisation").toBe(true);
    expect(suppressedOnTestDomain(rows[0]), "suppressed on the reserved domain").toBe(true);
    await sleep(3_000);
    expect((await tenantRows(org.id)).length, "no tenant row").toBe(0);
    expect((await stateRow(org.id))?.alert_due_at ?? null, "no alert is marked").toBeNull();
  });

  test("an organisation scheduled for deletion still sends; a deleted one reads not ready and raises no alert", async () => {
    const leaving = await newOrg("leaving");
    await brokenSmtp(leaving.id);
    const a = await member(leaving, "leaving");
    const { error: e1 } = await db().from("organizations").update({ scheduled_deletion_at: new Date(Date.now() + 7 * 86_400_000).toISOString() }).eq("id", leaving.id);
    expect(e1, "schedule the organisation for deletion").toBeNull();
    const ans = sameAnswer([await ask("code", a.email, leaving.slug), await ask("code", nobody(), leaving.slug)], "scheduled for deletion");
    expect(ans.json.ready, "an organisation scheduled for deletion reads ready").toBe(true);
    await until(() => tenantRows(leaving.id, a.id), (r) => r.some(attempted), "its member's send is attempted");

    const gone = await newOrg("gone");
    await brokenSmtp(gone.id);
    const b = await member(gone, "gone");
    const { error: e2 } = await db().from("organizations").update({ deleted_at: new Date().toISOString() }).eq("id", gone.id);
    expect(e2, "delete the organisation").toBeNull();
    const ans2 = sameAnswer([await ask("code", b.email, gone.slug), await ask("code", nobody(), gone.slug)], "deleted organisation");
    expect(ans2.json.ready, "a deleted organisation reads not ready").toBe(false);
    await sleep(JOB_MS);
    expect((await tenantRows(gone.id)).length, "nothing is attempted or recorded").toBe(0);
    expect((await stateRow(gone.id))?.alert_due_at ?? null, "no alert is marked").toBeNull();
  });

  const bulk: { org?: Org; person?: string; personStatus?: string } = {};

  test("a bulk file with a broken SMTP: three attempts, the state failing, one alert, every row not sent", async ({ browser }) => {
    const org = await newOrg("bulk");
    bulk.org = org;
    const admin = await member(org, "bulk-admin", "admin");
    await brokenSmtp(org.id);
    const people = [1, 2, 3, 4, 5].map((i) => testEmail(`s79-bulk${i}`));
    // With the inbox, one of the five is the person of the next case, welcomed in invite mode.
    if (MAIL_READY) people[4] = aliasFor(`s79bulk${rand(4)}`);
    bulk.person = MAIL_READY ? people[4] : undefined;
    for (const p of people) made.emails.add(p.toLowerCase());
    const csv = ["first_name,last_name,unique_id,email,lms_role,node_id,status", ...people.map((p, i) => `Bulk,P${i + 1},S79-${rand(6)},${p},user,root,active`)].join("\n");

    const ctx = await authedContext(browser, BASE, admin.email, admin.password);
    let results: Array<{ email?: string; status?: string; email_outcome?: { status?: string } }> = [];
    try {
      const res = await ctx.request.post("/api/users/bulk", { data: { orgSlug: org.slug, csv } });
      expect(res.status(), "the bulk file answers 200").toBe(200);
      results = ((await res.json()) as { results?: typeof results }).results ?? [];
    } finally {
      await ctx.close();
    }
    expect(results.length, "a result for each row").toBe(people.length);
    expect(results.every((r) => r.status === "invited" || r.status === "created"), "every row's account is made").toBe(true);
    // The next case's premise: how the person's account was made, read there.
    if (bulk.person) bulk.personStatus = results.find((r) => String(r.email ?? "").toLowerCase() === bulk.person!.toLowerCase())?.status;
    expect(results.every((r) => r.email_outcome?.status === "not_sent"), "every row's welcome is not sent").toBe(true);
    const invites = ofEvent(await tenantRows(org.id), "account_invite");
    expect(invites.filter(attempted).length, "three attempts, then the run stops").toBe(3);
    expect((await stateRow(org.id))?.state, "the state is failing").toBe("failing");
    await until(() => stateRow(org.id), (s) => !!s?.alert_due_at, "one alert is marked as due");
    await sendOwnAlert(org.id);
    const alerts = (await platformRows(admin.id)).filter((x) => x.event_type === "tenant_smtp_alert");
    expect(alerts.length, "one alert").toBe(1);
  });

  test("after the fix, a person welcomed in invite mode, still unconfirmed, resets and signs in (mail)", async ({ browser }) => {
    test.skip(!MAIL_READY, MAIL_SKIP);
    const org = bulk.org!;
    const person = bulk.person!;
    expect(org && person, "the bulk case before").toBeTruthy();
    // The premise: a new account the bulk file made in invite mode, whose address is not confirmed before the reset.
    expect(bulk.personStatus, "the bulk file made the person's account in invite mode").toBe("invited");
    const { data: profiles, error: profileError } = await db().from("profiles").select("id").eq("email", person.toLowerCase());
    expect(profileError, "read the person's profile").toBeNull();
    expect((profiles ?? []).length, "one profile at the person's address").toBe(1);
    const personId = String((profiles ?? [])[0]?.id);
    const confirmedAt = async (): Promise<string | null> => {
      const { data, error } = await db().auth.admin.getUserById(personId);
      expect(error, "read the person's account").toBeNull();
      return data?.user?.email_confirmed_at ?? null;
    };
    await configureOrgSmtp(org.id);
    const tester = await member(org, "bulk-tester", "admin", { alias: true });
    const t = await settingsTest(browser, org, tester);
    expect(t.status, "the Settings test was delivered to the mail server").toBe("sent");
    await until(() => stateRow(org.id), (s) => s?.state === "healthy", "the fix clears the state");

    const since = new Date(Date.now() - 60_000);
    const answer = await ask("code", person, org.slug);
    expect(answer.json.ready, "the ready answer").toBe(true);
    const mail = await mailArrives(person, since);
    const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
    expect(code, "the mail holds a six-digit code").toBeTruthy();
    const verify = await fetch(`${BASE}/api/auth/forgot-password/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: person, code }) });
    expect(verify.status, "the code is accepted").toBe(200);
    const { reset_token } = (await verify.json()) as { reset_token?: string };
    const password = `S79-${rand(10)}Aa1!`;
    expect(await confirmedAt(), "the person's address is still unconfirmed before the reset").toBeNull();
    const reset = await fetch(`${BASE}/api/auth/forgot-password/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: person, reset_token, new_password: password }) });
    expect(reset.status, "the password is set").toBe(200);
    expect(await confirmedAt(), "the reset confirms the address").toBeTruthy();
    const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await c.auth.signInWithPassword({ email: person, password });
    expect(error, "the person signs in").toBeNull();
    expect(!!data.session, "a session").toBe(true);
  });

  test("a sixth sign-in-link request in an hour sends nothing", async () => {
    const org = await newOrg("sixth");
    await brokenSmtp(org.id);
    const learner = await member(org, "sixth");
    for (let i = 1; i <= 5; i++) {
      await ask("link", learner.email, org.slug);
      await until(() => tenantRows(org.id, learner.id), (r) => ofEvent(r, "magic_link").filter(attempted).length >= i, `request ${i} is attempted`);
    }
    await ask("link", learner.email, org.slug);
    await settled(() => tenantRows(org.id, learner.id));
    const links = ofEvent(await tenantRows(org.id, learner.id), "magic_link");
    expect(links.filter(attempted).length, "five attempts in the hour").toBe(5);
    expect(links.filter(inFlight).length, "five in-flight rows").toBe(5);
  });

  test("ten requests for a member's code on a not-ready organisation write one record row; the unauthenticated health status reads the same", async () => {
    const org = await newOrg("ten");
    await member(org, "ten-admin", "admin");
    const learner = await member(org, "ten");
    const before = await health(false);
    for (let i = 0; i < 10; i++) {
      await ask("code", learner.email, org.slug);
      if (i === 0) await until(() => tenantRows(org.id, learner.id), (r) => r.length > 0, "the record row is written");
      else await sleep(1_500);
    }
    await settled(() => tenantRows(org.id, learner.id));
    const rows = await tenantRows(org.id, learner.id);
    expect(rows.length, "one record row").toBe(1);
    expect(rows[0].error, "the record of a send not attempted").toBe("smtp_not_ready");
    const after = await health(false);
    expect(after.status, "the same unauthenticated status code").toBe(before.status);
    expect(after.body.status, "the same unauthenticated status").toBe(before.body.status);
    await sendOwnAlert(org.id);
  });

  test("the daily limit: routine mail stops at the line, a reset code still goes at 29, the page reads not ready at 30, and it opens when the rows age", async ({ browser }) => {
    const org = await newOrg("limit");
    const admin = await member(org, "limit-admin", "admin");
    const learner = await member(org, "limit");
    await brokenSmtp(org.id);
    const { error: limitError } = await db().from("tenant_smtp_state").upsert({ organization_id: org.id, daily_limit: 30 }, { onConflict: "organization_id" });
    expect(limitError, "set the organisation's daily limit to 30").toBeNull();
    const filler: string[] = [];
    async function sentRows(n: number) {
      const rows = Array.from({ length: n }, () => ({
        organization_id: org.id,
        event_type: "custom_broadcast",
        channel: "email",
        to_address: testEmail("s79-filler"),
        subject: "Spec 79 count",
        status: "sent",
        context: {},
      }));
      const { data, error } = await db().from("notification_log").insert(rows).select("id");
      expect(error, "write sent rows to the count").toBeNull();
      filler.push(...((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    }

    // At 5 of 30 routine mail stops: the reserve of 25 is kept.
    await sentRows(5);
    const ctx = await authedContext(browser, BASE, admin.email, admin.password);
    try {
      const res = await ctx.request.post("/api/notifications/broadcast", {
        data: { orgSlug: org.slug, subject: "Spec 79", body_md: "Spec 79 routine mail.", audience: "users", user_ids: [learner.id] },
      });
      // Accepted: a refusal (a 4xx) is not a broadcast that routine mail stopped.
      expect(res.status(), "the broadcast is accepted (200)").toBe(200);
      await until(() => stateRow(org.id), (s) => !!s?.alert_due_at, "one alert is due once routine mail stops");
      expect(ofEvent(await tenantRows(org.id, learner.id), "custom_broadcast").filter(attempted).length, "the routine mail is not attempted").toBe(0);
      const page = await ctx.newPage();
      await page.goto(`/${org.slug}/attention`);
      // The item in the Attention Center's list, not the admin banner that
      // carries the same words; section K: it is critical.
      const item = page.locator("article").filter({ hasText: ROUTINE_STOPPED_TITLE });
      await expect(item, "the Attention Center item").toBeVisible({ timeout: 30_000 });
      const group = page.locator("section").filter({ has: item });
      await expect(group, "one group holds the item").toHaveCount(1);
      await expect(group.getByRole("heading", { level: 2 }), "the item is in the Critical group").toContainText("Critical");
      await page.close();
    } finally {
      await ctx.close();
    }
    await sendOwnAlert(org.id);

    // At 29 a reset code still goes.
    await sentRows(24);
    const at29 = await ask("code", learner.email, org.slug);
    expect(at29.json.ready, "ready at 29 of 30").toBe(true);
    await until(() => tenantRows(org.id, learner.id), (r) => ofEvent(r, "password_reset").some(attempted), "the reset code is attempted at 29");
    expect((await stateRow(org.id))?.state ?? null, "one person's failure leaves it ready").not.toBe("failing");

    // At 30 the page reads not ready, with no second alert that day.
    await sentRows(1);
    const at30 = sameAnswer([await ask("code", learner.email, org.slug), await ask("code", nobody(), org.slug)], "at the limit");
    expect(at30.json.ready, "not ready at 30 of 30").toBe(false);
    await until(() => tenantRows(org.id, learner.id), (r) => r.some((x) => x.error === "daily_limit"), "the record row of the daily limit");
    expect((await stateRow(org.id))?.alert_due_at ?? null, "no second alert at the limit on the same day").toBeNull();

    // The rows age past 24 hours: it opens again.
    const { error: ageError } = await db().from("notification_log").update({ sent_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }).in("id", filler);
    expect(ageError, "age the count's rows").toBeNull();
    const opened = await ask("code", nobody(), org.slug);
    expect(opened.json.ready, "ready again once the rows are a day old").toBe(true);
  });

  test("the console adds an administrator: one platform row, the setup link returned and no password; the link works once", async ({ browser }) => {
    const org = await newOrg("console");
    const po = await platformOwner();
    const email = testEmail("s79-console");
    made.emails.add(email.toLowerCase());
    const ctx = await authedContext(browser, BASE, po.email, po.password);
    let answer: { invited?: unknown; user_id?: unknown; email_outcome?: { status?: unknown; class?: unknown } | null; setup_link?: unknown } = {};
    let raw = "";
    try {
      const res = await ctx.request.post(`/api/super/tenants/${org.id}/admins`, { data: { email, role: "admin" } });
      expect(res.status(), "the console's add answers 200").toBe(200);
      raw = await res.text();
      answer = JSON.parse(raw);
    } finally {
      await ctx.close();
    }
    expect(answer.invited, "a new account").toBe(true);
    expect(answer.email_outcome?.status === "not_sent" && answer.email_outcome?.class === "test_domain", "the welcome to a reserved domain is not sent").toBe(true);
    // The answer's keys: no password, and only the server's own values.
    expect(Object.keys(answer).some((k) => /pass/i.test(k)), "no password in the answer").toBe(false);
    expect(raw.includes(po.password), "the owner's password is in no answer").toBe(false);
    expect(typeof answer.setup_link === "string", "the setup link is returned because the welcome was not sent").toBe(true);
    const userId = String(answer.user_id);
    made.users.push(userId);
    const rows = await platformRows(userId);
    expect(rows.length === 1 && rows[0].event_type === "platform_admin_welcome" && suppressedOnTestDomain(rows[0]), "one platform welcome row, suppressed").toBe(true);

    const link = new URL(String(answer.setup_link));
    expect(link.pathname === "/auth/set-password" && link.search === "" && /^#t=[A-Za-z0-9_-]{43}$/.test(link.hash), "the link's form: the page, no query, the token in the fragment").toBe(true);
    const open = `${BASE}${link.pathname}${link.hash}`;
    const visitor = await browser.newContext();
    try {
      // Opened twice, each time in a page of its own (the form takes the
      // token out of the address bar), it spends nothing.
      for (let i = 0; i < 2; i++) {
        const p = await visitor.newPage();
        await gotoSetupLink(p, open);
        await expect(p.getByRole("heading", { name: "Set your password" }), `the form, opening ${i + 1}`).toBeVisible({ timeout: 30_000 });
        await expect(p.getByText(org.name).first()).toBeVisible();
        await p.close();
      }
      const page = await visitor.newPage();
      await gotoSetupLink(page, open);
      await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible({ timeout: 30_000 });
      const { data: linkRows, error: linkError } = await db().from("account_setup_links").select("used_at, ended_at").eq("user_id", userId);
      expect(linkError, "read the link's row").toBeNull();
      expect((linkRows ?? []).length === 1 && (linkRows ?? []).every((r: { used_at: unknown; ended_at: unknown }) => r.used_at === null && r.ended_at === null), "the link is still open").toBe(true);

      const password = `S79-${rand(10)}Aa1!`;
      await page.getByLabel(/new password/i).fill(password);
      await page.getByLabel(/confirm password/i).fill(password);
      await page.getByRole("button", { name: /set password/i }).click();
      await expect(page.getByText("Your password is set")).toBeVisible({ timeout: 30_000 });

      const signedIn = await authedContext(browser, BASE, email, password);
      await signedIn.close();

      const again = await visitor.newPage();
      await gotoSetupLink(again, open);
      await expect(again.getByText(LINK_UNUSABLE), "the same link then gets rule N10's answer").toBeVisible({ timeout: 30_000 });
    } finally {
      await visitor.close();
    }
  });

  test("requests at once on a broken SMTP: at most five attempts of each kind, no more open codes than attempts, still ready, and another learner still goes", async () => {
    const org = await newOrg("burst");
    await brokenSmtp(org.id);
    const a = await member(org, "burst-a");
    const b = await member(org, "burst-b");

    const links = await Promise.all(Array.from({ length: 20 }, () => ask("link", a.email, org.slug)));
    expect(links.every((x) => x.status === 200), "every link request answers 200").toBe(true);
    await settled(() => tenantRows(org.id, a.id));
    const codes = await Promise.all(Array.from({ length: 20 }, () => ask("code", a.email, org.slug)));
    expect(codes.every((x) => x.status === 200), "every code request answers 200").toBe(true);
    await settled(() => tenantRows(org.id, a.id));

    const rows = await tenantRows(org.id, a.id);
    const linkTries = ofEvent(rows, "magic_link").filter(attempted).length;
    const codeTries = ofEvent(rows, "password_reset").filter(attempted).length;
    const linkClaims = ofEvent(rows, "magic_link").filter(linkClaim).length;
    const { count: codeRows, error: codeRowsError } = await db()
      .from("password_reset_otps")
      .select("id", { count: "exact", head: true })
      .eq("email", a.email.toLowerCase());
    expect(codeRowsError, "read the code rows").toBeNull();
    // Requests that meet at a limit may all be refused: each is claimed and
    // counted before its send, so the bound is "at most", never an exact number.
    // The counts are recorded on the run; the second learner below shows that
    // the organisation still sends.
    test.info().annotations.push({ type: "attempts", description: `links ${linkTries}, codes ${codeTries}, link claims ${linkClaims}, code rows ${codeRows ?? 0}` });
    // The floor, which holds even when every send is refused: a new learner's
    // first request of each kind reads no earlier one, so it writes its claim
    // (a link's claim row, a code's own closed row) before any limit refuses it.
    expect(linkClaims, "the link requests were claimed: at least one claim row").toBeGreaterThanOrEqual(1);
    expect(codeRows ?? 0, "the code requests were claimed: at least one code row").toBeGreaterThanOrEqual(1);
    expect(linkTries, "at most five links are attempted").toBeLessThanOrEqual(5);
    expect(codeTries, "at most five codes are attempted").toBeLessThanOrEqual(5);
    expect(ofEvent(rows, "magic_link").filter(inFlight).length, "at most five link rows in flight").toBeLessThanOrEqual(5);
    expect(ofEvent(rows, "password_reset").filter(inFlight).length, "at most five code rows in flight").toBeLessThanOrEqual(5);
    expect(rows.filter((r) => r.status === "sent").length, "no sent row").toBe(0);
    const { count: openCodes, error: otpError } = await db()
      .from("password_reset_otps")
      .select("id", { count: "exact", head: true })
      .eq("email", a.email.toLowerCase())
      .is("used_at", null);
    expect(otpError, "read the open code rows").toBeNull();
    expect(openCodes ?? 0, "no more open code rows than code attempts").toBeLessThanOrEqual(codeTries);
    const st = await stateRow(org.id);
    expect(st?.state ?? null, "one person's failures do not turn it failing").not.toBe("failing");

    // Another learner of the same organisation still goes.
    await ask("link", b.email, org.slug);
    await until(() => tenantRows(org.id, b.id), (r) => ofEvent(r, "magic_link").some(attempted), "the second learner's link is attempted");
    expect((await tenantRows(org.id)).some((r) => r.error === "daily_limit"), "no daily-limit row").toBe(false);
    expect((await stateRow(org.id))?.alert_due_at ?? null, "no alert is due").toBeNull();
  });
});
