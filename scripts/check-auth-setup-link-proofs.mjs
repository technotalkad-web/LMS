#!/usr/bin/env node
// =============================================================================
// scripts/check-auth-setup-link-proofs.mjs: staging proofs for ADR 0029's
// open questions 15 (an account made with an address only) and 19 (the
// sign-in time, an ended session, and the setup link's fragment through mail).
// =============================================================================
//
// RUN BY HAND, STAGING ONLY. It refuses any Supabase project but staging
// (the rule of tests/bot/lifecycle/cleanup.ts, isStagingSupabaseUrl). Points
// 1 to 6's first leg touch no app code and no app table: they call the auth
// server the way the set-password code does (auth.admin.createUser,
// auth.admin.updateUserById, auth.admin.generateLink with verifyOtp as
// app/auth/callback/route.ts uses it, auth.admin.getUserById, and
// signInWithPassword on a fresh client that keeps no session), and, for point
// 6, staging's send-smtp Edge Function with the request
// lib/email/smtp-function.ts (dispatchSmtp) makes.
//
// The platform leg of point 6 (--platform-leg) is the one part that widens
// this: it calls the app, a build of this branch that holds staging's
// platform sender settings, at STAGING_BASE_URL; it makes one organisation in
// the lifecycle namespace and one platform owner at the lifecycle domain; and
// it reads one app table, platform_email_log, by user id, for a row's event,
// status and code only. The platform settings stay in that deployment: none
// is given to this script. See "The platform leg" below.
//
// Accounts of points 1 and 3 to 5: new per run, in the lifecycle namespace
// (`lifecycle+p0029-<role>-<run>@lifecycle.test`, tests/e2e/helpers/
// namespace.ts). The domain is reserved and has no inbox; the e2e purge never
// matches it, and the lifecycle cleanup sweeps it after 48 h if a delete here
// fails. No organisation, membership or learner record is created (the
// profiles trigger adds one profile row per account; it goes with the
// account). Every account is deleted at the end, also after a failure.
//
// Accounts of point 2 (the mailbox form): three per run, at new aliases of
// the test mailbox (`<its local part>+p0029h-<role>-<run>@<its domain>`,
// roles a1, a2 and i). The lifecycle cleanup never sweeps the mailbox's
// domain, so the run first deletes any account left at an alias with this
// prefix, and deletes its own at the end, also after a failure.
//
// Mail sent per run: ONE invite from the auth server (point 2's control) and
// ONE fixed message through send-smtp (point 6). Each goes to a new alias of
// the test mailbox and nowhere else: every mailbox-domain address passes one
// guard that refuses anything but the mailbox or a "+tag" alias of it. The
// mailbox's address comes from the environment and is never printed,
// logged or written.
//
// Point 2, mailbox form. A1 is created with the address only. A2 is created
// the same way, then given a password and a confirmed address by the
// administrator call, then signs in once. I is then invited (the control).
// The mailbox is read in its inbox and in the all-mail and spam folders
// (found by their special-use marks), one search per alias by recipient,
// on a fresh connection per read. Pass: I's mail is found within 5 minutes,
// and a last read, no sooner than 5 minutes after A2's sign-in, finds I's
// mail again and no message to A1 or A2 in any of the three folders. Void:
// the invite is refused, its mail is not found in time, or a folder cannot
// be found. Fail: any message to A1 or A2. The four sent times are recorded
// only. A run with the mailbox takes about 6 to 11 minutes.
//
// Point 6, transport leg. One fixed message through send-smtp with the test
// organisation's SMTP settings (the BOT_SMTP_* names), to a new alias. Its
// text part and its HTML part each carry two links on staging's own host: a
// setup-style link whose 43-character value follows "#t=", and a control of
// the same shape whose value is in the query. The two parts are read back
// from the mailbox and decoded one by one. Pass: the setup-style link is
// there character for character in the text part, as the HTML link's
// address and as its shown text. A control that is not there whole makes
// the leg void. The tenant leg is pull request C's; it prints "not run".
// In a run, point 6 goes before point 2, so a void of point 2 is the last
// thing tried.
//
// Point 6, platform leg (--platform-leg, run alone). The build's own
// console adds an administrator at one fixed, listed alias of the test
// mailbox (`<its local part>+p0029h-welcome@<its domain>`), and the welcome
// the platform sender mails is read back from the mailbox:
//   1. the build: 43 random characters posted to /api/auth/set-password with
//      no password get rule N10's answer, so the address serves this branch
//      (any other answer: the leg is "not run"); it is step 9's control;
//   2. the sweep: any account left at an alias with this harness's prefix is
//      deleted; the time is noted;
//   3. the fixtures, with the service role: one organisation in the
//      lifecycle namespace and one platform owner at the lifecycle domain
//      (a password, a confirmed address, no forced change, mfa_required
//      false, as markPlatformOwner writes it);
//   4. the session: that owner signs in through the build's own /login form,
//      in a browser this script drives (no cookie is made by hand);
//   5. the add: POST /api/super/tenants/<organisation>/admins with the alias
//      (through the recipient guard) and the role admin: 200, invited true,
//      email_outcome.status "sent", and no setup_link in the answer;
//   6. the row: one platform_email_log row for the new account,
//      platform_admin_welcome, sent;
//   7. the mail: found within five minutes in the inbox, all-mail or spam
//      folder; the folder and the seconds are recorded;
//   8. the control: the sign-in address (the build's address, the
//      organisation's slug, /login) whole in the text part, and in the HTML
//      part as a link's address and as its shown text;
//   9. the link: the text part holds one address on the build's own host,
//      path /auth/set-password, no query, a fragment of #t= and 43
//      characters; the HTML part holds the same address as a link's address
//      and as its shown text. The token posted with no password gets the
//      good answer naming step 3's organisation, and again the same; any
//      other 43 characters get step 1's answer;
//  10. the use: the token with a password sets it once; that password signs
//      in at the auth server; the same token then gets rule N10's answer;
//  11. twenty sign-in-link requests at once for the administrator at the
//      alias: at most five sent rows and at most five in-flight rows, so at
//      most five mails;
//  12. clean-up, also after a failure, in this order: the alias's account
//      (its link's row, membership and profile go with it), the platform
//      owner's row and account, the organisation; a last read finds no
//      account at the prefix. The platform_email_log rows and the console's
//      audit row stay, with the user id emptied (on delete set null).
// Pass: steps 5 to 11. Void, and not proven by that run: the welcome is not
// sent (its class is recorded: not_allowed is the list, not_configured the
// deployment's settings, timeout a mail that may still arrive), the mail is
// not found in five minutes, or the control is not whole in a part. Fail:
// invited false (the alias was still taken), a link that is cut, changed,
// percent-encoded or wrapped in another address, a token the build refuses,
// any part of step 10, or more than five of step 11. Each run mails the
// alias once for the welcome and at most five times in step 11, from
// staging's platform mailbox, inside staging's ceiling. The console's audit
// row of the add names the alias and outlives the account.
//
// Output: step names, pass / fail / recorded / void / not run, HTTP statuses,
// error codes, "set" / "empty" for a time, "set" / "unset" for a setting,
// "whole" / "changed" for a link, folder roles and seconds. Never an address,
// password, token, link, session, id or error message.
//
// SETTINGS (environment only; the script reads no file):
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//   SUPABASE_SERVICE_ROLE_KEY (the staging values the lifecycle suite uses).
//   Points 2 and 6 read the names tests/bot/lifecycle/inbox.ts reads:
//   BOT_MAIL_ADDRESS and BOT_IMAP_PASS (or BOT_SMTP_PASS, the reader's
//   fallback), with BOT_IMAP_HOST and BOT_IMAP_PORT optional. Point 6 also
//   needs BOT_SMTP_USER and BOT_SMTP_PASS, with BOT_SMTP_HOST, BOT_SMTP_PORT,
//   BOT_SMTP_SECURE and BOT_SMTP_FROM_NAME optional (configureOrgSmtp's
//   defaults). Without them those points print "not run" and the rest runs.
//   The platform leg also reads STAGING_BASE_URL, the address of the build
//   under test, under the name scripts/staging-cron-post.mjs reads, and it
//   must pass that script's own test (isStagingAppUrl, imported).
//   Loaded the way the Playwright configs load them, e.g.
//     node -r dotenv/config scripts/check-auth-setup-link-proofs.mjs \
//       dotenv_config_path=<checkout>/.env.test.local --report <file>.json
//
// FLAGS:
//   --dry-run        check the settings, the project guard and the recipient
//                    guard; call nothing
//   --mail-only      run only points 2 and 6 (the mailbox points)
//   --platform-leg   run only point 6's platform leg (it needs the mailbox
//                    settings and STAGING_BASE_URL); without this flag the
//                    leg prints "not run"
//   --report <file>  also write the results as JSON (no secrets, no ids)
//
// EXIT: 0 every proof passed; 1 a proof failed or its control was void;
// 2 refused (not staging, a setting missing; also --mail-only or
// --platform-leg when their settings are unset, after the "not run" lines);
// 3 harness error or a failed cleanup.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isStagingAppUrl } from "./staging-cron-post.mjs";

const STAGING_REF = "zeaclbapadosqqttexxh";
const PRODUCTION_REF = "alkfrcglmseksweqhwzq";
/** Staging's own app host (wrangler.toml [vars] NEXT_PUBLIC_SITE_URL; scripts/staging-cron-post.mjs). */
const STAGING_SITE = "https://my-lms.mentora.workers.dev";
/** Built from the staging ref, never from SEND_SMTP_FUNCTION_URL, so no override can move it. */
const SEND_SMTP_URL = `https://${STAGING_REF}.supabase.co/functions/v1/send-smtp`;
const NS_PREFIX = "lifecycle";
const NS_DOMAIN = "lifecycle.test";
/** The "+tag" prefix of this harness's mailbox aliases; no spec uses it. */
const MAIL_TAG_PREFIX = "p0029h-";
const SENT_FIELDS = ["confirmation_sent_at", "invited_at", "recovery_sent_at", "email_change_sent_at"];
const USER_PAGE_SIZE = 1000;
const USER_MAX_PAGES = 20;
/** How long a control's mail is waited for, and the least time between A2's sign-in and the last read. */
const MAIL_WAIT_MS = 5 * 60_000;
const MAIL_POLL_MS = 15_000;
/** Longer than send-smtp's own 25 s, so the harness sees its answer. */
const SEND_WAIT_MS = 30_000;
/** lib/email/smtp-function.ts SMTP_SEND_WAIT_MS: how long the app waits for one send. */
const APP_SEND_WAIT_MS = 15_000;
/** The platform leg's one alias role: `<local>+p0029h-welcome@<domain>`, the address on the staging allow-list. */
const LEG_ALIAS_ROLE = "welcome";
/** Rule N10's one answer for a link that cannot be used (LINK_UNUSABLE_MESSAGE in lib/auth/setup-link.ts). */
const LINK_UNUSABLE = "This link can no longer be used. Ask your LMS Administrator for a new one, or use Forgot password.";
/** The setup link's path and token shape (SETUP_LINK_PATH, SETUP_TOKEN_SHAPE in lib/auth/setup-link.ts). */
const SETUP_PATH = "/auth/set-password";
/** The job after a public request has 25 s (CREDENTIAL_JOB_MS in lib/auth/credential-mail.ts). */
const APP_JOB_MS = 25_000;
/** Step 11 of the platform leg: requests made at once, and the most that may be sent (5 in the hour for one account). */
const LEG_BURST = 20;
const LEG_BURST_MAX = 5;

// ---------------------------------------------------------------------------
// Flags and settings
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2).filter((a) => !a.startsWith("dotenv_config_"));
let dryRun = false;
let mailOnly = false;
let platformLeg = false;
let reportPath = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--mail-only") mailOnly = true;
  else if (a === "--platform-leg") platformLeg = true;
  else if (a === "--report" && argv[i + 1]) reportPath = argv[++i];
  else {
    console.error(`✖ unknown flag (${a.slice(0, 20)})`);
    process.exit(3);
  }
}

const env = process.env;
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function refuse(msg) {
  console.error(`✖ refused: ${msg}`);
  process.exit(2);
}
if (URL_.includes(PRODUCTION_REF)) refuse("the Supabase URL is the production project.");
function isStagingSupabaseUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === `${STAGING_REF}.supabase.co` && u.port === "";
  } catch {
    return false;
  }
}
if (!isStagingSupabaseUrl(URL_)) refuse("the Supabase URL is not the staging project.");
const missing = [
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) refuse(`missing setting(s): ${missing.join(", ")}.`);

console.log("guard: staging project, settings set (url set, anon key set, service key set)");

// The mailbox settings: names only, "set" or "unset", never a value.
const isSet = (name) => typeof env[name] === "string" && env[name].trim() !== "";
const MAIL_SETTING_NAMES = [
  "BOT_MAIL_ADDRESS", "BOT_IMAP_PASS", "BOT_IMAP_HOST", "BOT_IMAP_PORT",
  "BOT_SMTP_USER", "BOT_SMTP_PASS", "BOT_SMTP_HOST", "BOT_SMTP_PORT", "BOT_SMTP_SECURE", "BOT_SMTP_FROM_NAME",
];
console.log(`mailbox settings: ${MAIL_SETTING_NAMES.map((n) => `${n} ${isSet(n) ? "set" : "unset"}`).join(", ")}`);

/** The mailbox as { raw, base, local, domain }, all lower case but raw; null when it is not one plain address. */
function parseMailbox(value) {
  const raw = String(value ?? "").trim();
  const m = /^([a-z0-9._%-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(raw.toLowerCase());
  return m ? { raw, base: `${m[1]}@${m[2]}`, local: m[1], domain: m[2] } : null;
}
const MAILBOX = parseMailbox(env.BOT_MAIL_ADDRESS);
/** As tests/bot/lifecycle/inbox.ts reads it. */
const READER_PASS = (env.BOT_IMAP_PASS || env.BOT_SMTP_PASS || "").replace(/\s+/g, "");
const mailReason = !isSet("BOT_MAIL_ADDRESS")
  ? "BOT_MAIL_ADDRESS unset"
  : !MAILBOX
    ? "BOT_MAIL_ADDRESS set but not one plain address without a +tag"
    : !READER_PASS
      ? "the reader's password (BOT_IMAP_PASS or BOT_SMTP_PASS) unset"
      : null;
const mailReady = mailReason === null;
const smtpReason = mailReason ?? (!isSet("BOT_SMTP_USER") || !isSet("BOT_SMTP_PASS") ? "BOT_SMTP_USER or BOT_SMTP_PASS unset" : null);
const smtpReady = smtpReason === null;

/** The build under test for the platform leg: STAGING_BASE_URL, through the cron poster's own test of a staging app address. */
const LEG_BASE = (env.STAGING_BASE_URL ?? "").trim().replace(/\/+$/, "");
const legBaseReason = !LEG_BASE
  ? "STAGING_BASE_URL unset"
  : !isStagingAppUrl(`${LEG_BASE}/`)
    ? "STAGING_BASE_URL set but not a staging app address"
    : null;
const legReason = mailReason ?? legBaseReason;
const legReady = legReason === null;
console.log(`platform leg settings: STAGING_BASE_URL ${LEG_BASE ? "set" : "unset"}${LEG_BASE ? `, a staging app address ${legBaseReason ? "no" : "yes"}` : ""}`);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
/** outcome: pass | fail | recorded | void | not run | setup | harness */
const results = [];
function rec(point, step, outcome, detail = "") {
  results.push({ point, step, outcome, detail });
  const tag = outcome.toUpperCase().padEnd(8);
  console.log(`[${point}] ${tag} ${step}${detail ? `  (${detail})` : ""}`);
  return outcome === "pass" || outcome === "recorded" || outcome === "setup";
}
const check = (point, step, ok, detail) => rec(point, step, ok ? "pass" : "fail", detail);

/** Status and code only: an auth error's message can echo the address. */
function errInfo(error) {
  if (!error) return "no error";
  const status = error.status ?? "-";
  const code = error.code ?? (error.name && error.name !== "Error" ? error.name : "-");
  return `status=${status} code=${code}`;
}
/** A code from a server or a library, kept only when it looks like one. */
const safeCode = (c) => (c === undefined || c === null ? "-" : /^[A-Za-z0-9_.-]{1,64}$/.test(String(c)) ? String(c) : "other");
/** An IMAP failure as codes only: never the message, which can carry the address. */
function imapErr(e) {
  return `code=${safeCode(e?.code)}${e?.serverResponseCode ? ` server=${safeCode(e.serverResponseCode)}` : ""}${e?.authenticationFailed ? " auth_failed" : ""}`;
}

/** Every setting value that must never be printed, matched without regard to case. */
const REDACT = [
  MAILBOX?.raw, MAILBOX?.base, MAILBOX && MAILBOX.local.length >= 4 ? MAILBOX.local : null,
  env.BOT_SMTP_USER?.trim(), READER_PASS, (env.BOT_SMTP_PASS || "").replace(/\s+/g, ""), SERVICE, ANON,
].filter((v) => typeof v === "string" && v.length >= 4);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scrub(text) {
  let s = String(text ?? "");
  for (const v of REDACT) s = s.replace(new RegExp(escRe(v), "gi"), "<redacted>");
  return s
    .replace(/\S+@\S+/g, "<address>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/eyJ[\w.-]+/g, "<token>");
}
/** A thrown harness error, with anything that could be an address, a URL or a token removed. */
function harnessText(e) {
  const msg = scrub(e?.message ?? "").slice(0, 160);
  return `${safeCode(e?.name ?? "Error")}: ${msg}`;
}
const sec = (ms) => (ms / 1000).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** "set" or "empty (...)": how the auth server returned a time. */
function timeState(user, key) {
  if (!user) return "unread";
  if (!(key in user)) return "empty (left out)";
  const v = user[key];
  if (v === null) return "empty (null)";
  if (v === "") return 'empty ("")';
  return "set";
}
const isEmpty = (user, key) => !!user && timeState(user, key).startsWith("empty");
function sentStates(user) {
  return SENT_FIELDS.map((k) => `${k}=${timeState(user, k)}`).join(", ");
}

// ---------------------------------------------------------------------------
// Clients and accounts
// ---------------------------------------------------------------------------
const AUTH_OPTS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const svc = createClient(URL_, SERVICE, { auth: AUTH_OPTS });
/** A fresh anon client: no storage, no refresh timer, nothing shared with another. */
const fresh = (fetchImpl) =>
  createClient(URL_, ANON, { auth: AUTH_OPTS, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}) });
/** An anon client whose Data API calls carry the given access token. */
const asToken = (token) =>
  createClient(URL_, ANON, { auth: AUTH_OPTS, global: { headers: { Authorization: `Bearer ${token}` } } });
/**
 * A fetch that records the HTTP status of calls to one auth path and, for an
 * answer that is not OK, the body's error code (never its message).
 */
function answerRecorder(pathPart) {
  const box = { status: null, code: null };
  const f = async (input, init) => {
    const res = await fetch(input, init);
    if (String(typeof input === "string" ? input : input?.url ?? "").includes(pathPart)) {
      box.status = res.status;
      if (!res.ok) {
        try {
          const b = await res.clone().json();
          box.code = safeCode(b?.error_code ?? b?.code);
        } catch {
          box.code = "unread";
        }
      }
    }
    return res;
  };
  return { box, f };
}
const logoutRecorder = () => answerRecorder("/auth/v1/logout");

const RUN = randomBytes(3).toString("hex");
const addr = (role) => `${NS_PREFIX}+p0029-${role}-${RUN}@${NS_DOMAIN}`;
/** A new alias of the mailbox for this run, lower case. */
const mailAlias = (role, box = MAILBOX) => `${box.local}+${MAIL_TAG_PREFIX}${role}-${RUN}@${box.domain}`;
/** Long, with upper, lower, digit and symbol, so no password rule refuses it. */
const newPassword = () => `${randomBytes(18).toString("base64url")}Aa1!`;
const claims = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
};

const created = new Map(); // role -> id
const runAddresses = new Set(); // lower case
function track(role, user) {
  if (user?.id) created.set(role, user.id);
}

async function readUser(id) {
  const { data, error } = await svc.auth.admin.getUserById(id);
  return { user: data?.user ?? null, error };
}
async function signIn(email, password, fetchImpl) {
  const c = fresh(fetchImpl);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  return { client: c, session: data?.session ?? null, user: data?.user ?? null, error };
}
const refusedText = (r) => (r.session ? "a session came back" : errInfo(r.error));

// ---------------------------------------------------------------------------
// The recipient guard: the test mailbox or a "+tag" alias of it, nothing else
// ---------------------------------------------------------------------------
class RecipientRefused extends Error {
  constructor() {
    super("recipient refused: not the test mailbox or an alias of it");
    this.name = "RecipientRefused";
  }
}
/** True only for the mailbox itself or `<its local part>+<tag>@<its domain>`, the tag of [a-z0-9-]. */
function isMailboxRecipient(address, box) {
  if (!box || typeof address !== "string") return false;
  const a = address.toLowerCase();
  if (a === box.base) return true;
  const m = /^([^@\s+]+)\+([a-z0-9-]{1,64})@([^@\s]+)$/.exec(a);
  return !!m && m[1] === box.local && m[3] === box.domain;
}
function mailboxRecipient(address, box) {
  if (!isMailboxRecipient(address, box)) throw new RecipientRefused();
  return address;
}
/** The only ways this harness creates an account at, or mails, the mailbox's domain. */
async function createAtMailbox(address, { client = svc, box = MAILBOX } = {}) {
  mailboxRecipient(address, box);
  return client.auth.admin.createUser({ email: address });
}
async function inviteAtMailbox(address, { client = svc, box = MAILBOX } = {}) {
  mailboxRecipient(address, box);
  return client.auth.admin.inviteUserByEmail(address);
}

// ---------------------------------------------------------------------------
// send-smtp, as lib/email/smtp-function.ts (dispatchSmtp) calls it, with the
// test organisation's settings read the way tests/bot/lifecycle/inbox.ts
// (configureOrgSmtp) stores them and lib/notifications/send.ts sends them.
// ---------------------------------------------------------------------------
function testOrgSmtp() {
  const user = (env.BOT_SMTP_USER || "").trim();
  const fromName = env.BOT_SMTP_FROM_NAME || "QA LMS Bot";
  return {
    host: env.BOT_SMTP_HOST || "smtp.gmail.com",
    port: Number(env.BOT_SMTP_PORT || 465),
    secure: String(env.BOT_SMTP_SECURE || "true") === "true",
    user: user || undefined,
    pass: (env.BOT_SMTP_PASS || "").replace(/\s+/g, "") || undefined,
    from: fromName ? `"${fromName}" <${user}>` : user,
  };
}
let classifier = null;
/** The app's own class of a send-smtp error text (lib/email/smtp-function.ts); the text is never printed. */
async function smtpClass(text) {
  try {
    classifier ??= (await import(new URL("../lib/email/smtp-function.ts", import.meta.url).href)).classifySmtpError;
    return safeCode(classifier(text));
  } catch {
    return "unclassified";
  }
}
async function sendThroughSmtpFunction(to, message, { fetchImpl = fetch, box = MAILBOX } = {}) {
  mailboxRecipient(to, box);
  const payload = { ...testOrgSmtp(), to, subject: message.subject, html: message.html, text: message.text };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_WAIT_MS);
  const started = Date.now();
  try {
    const res = await fetchImpl(SEND_SMTP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (res.status === 401) return { ok: false, status: 401, cls: "bearer_refused", ms };
    if (!res.ok && res.status !== 200) return { ok: false, status: res.status, cls: await smtpClass(`Edge Function returned HTTP ${res.status}.`), ms };
    const body = await res.json().catch(() => null);
    if (body?.ok === true) return { ok: true, status: res.status, ms };
    return { ok: false, status: res.status, cls: await smtpClass(body?.error ?? "Unknown SMTP error."), ms };
  } catch {
    return { ok: false, status: null, cls: controller.signal.aborted ? "harness_wait_ended" : "fetch_failed", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The mailbox reader (imapflow, as tests/bot/lifecycle/inbox.ts uses it)
// ---------------------------------------------------------------------------
const openReaders = new Set();
async function openReader() {
  const mod = await import("imapflow");
  const ImapFlow = mod.ImapFlow ?? mod.default?.ImapFlow;
  const client = new ImapFlow({
    host: env.BOT_IMAP_HOST || "imap.gmail.com",
    port: Number(env.BOT_IMAP_PORT || 993),
    secure: true,
    auth: { user: MAILBOX.raw, pass: READER_PASS },
    logger: false,
  });
  // A socket error is read where the call fails; the event itself is never printed.
  client.on("error", () => {});
  openReaders.add(client);
  try {
    await client.connect();
  } catch (e) {
    await closeReader(client);
    throw e;
  }
  return client;
}
async function closeReader(client) {
  openReaders.delete(client);
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
}
const closeAllReaders = () => Promise.all([...openReaders].map((c) => closeReader(c)));

/** The inbox, all-mail and spam folders, by their special-use marks. */
async function findFolders() {
  const client = await openReader();
  try {
    const list = await client.list();
    const pick = (mark) => list.find((m) => m.specialUse === mark)?.path ?? null;
    const inbox = pick("\\Inbox") ?? list.find((m) => String(m.path).toUpperCase() === "INBOX")?.path ?? null;
    return [
      { role: "inbox", path: inbox },
      { role: "all-mail", path: pick("\\All") },
      { role: "spam", path: pick("\\Junk") },
    ];
  } finally {
    await closeReader(client);
  }
}

/** Every address a message was delivered to, lower case: envelope recipients and delivery headers. */
function recipientsOf(msg) {
  const set = new Set();
  for (const k of ["to", "cc", "bcc"]) for (const a of msg.envelope?.[k] ?? []) if (a?.address) set.add(a.address.toLowerCase());
  const raw = msg.headers ? msg.headers.toString("utf8") : "";
  for (const m of raw.matchAll(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/g)) set.add(m[0].toLowerCase());
  return set;
}

/**
 * One read on a fresh connection: in each folder, one search per alias by
 * recipient, over mail since `since`. A server hit counts only when the alias
 * is an exact recipient of the message.
 * Returns { [alias]: { [role]: { hits, exact: [{ uid, at }] } } }.
 */
async function readRound(folders, aliases, since) {
  const client = await openReader();
  try {
    const out = Object.fromEntries(aliases.map((a) => [a, {}]));
    for (const f of folders) {
      const lock = await client.getMailboxLock(f.path, { readOnly: true });
      try {
        for (const alias of aliases) {
          const found = await client.search({ to: alias, since }, { uid: true });
          const uids = Array.isArray(found) ? found : [];
          const exact = [];
          if (uids.length) {
            for await (const msg of client.fetch(uids.join(","), { uid: true, envelope: true, internalDate: true, headers: ["delivered-to", "x-original-to"] }, { uid: true })) {
              if (recipientsOf(msg).has(alias)) exact.push({ uid: msg.uid, at: msg.internalDate ?? null });
            }
          }
          out[alias][f.role] = { hits: uids.length, exact };
        }
      } finally {
        lock.release();
      }
    }
    return out;
  } finally {
    await closeReader(client);
  }
}
const exactCount = (round, alias, folders) => folders.reduce((n, f) => n + (round[alias]?.[f.role]?.exact.length ?? 0), 0);
const perFolder = (round, alias, folders) => folders.map((f) => `${f.role}=${round[alias]?.[f.role]?.exact.length ?? 0}`).join(" ");

/** Poll until a message to `alias` is found or `deadline` passes. */
async function waitForAlias(folders, alias, since, deadline, point, label) {
  let readErrors = 0;
  for (;;) {
    try {
      const r = await readRound(folders, [alias], since);
      for (const f of folders) {
        const hit = r[alias][f.role].exact;
        if (hit.length) return { folder: f, uid: Math.max(...hit.map((h) => h.uid)), at: Date.now(), readErrors };
      }
    } catch (e) {
      readErrors++;
      if (readErrors <= 3) rec(point, `${label}: a read failed (polling goes on)`, "recorded", imapErr(e));
    }
    const left = deadline - Date.now();
    if (left <= 0) return { folder: null, readErrors };
    await sleep(Math.min(MAIL_POLL_MS, left));
  }
}

async function readStream(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
/**
 * The message's text/plain and text/html parts, each read from the stored
 * message and decoded on its own (transfer encoding, then charset), so a
 * text made from the HTML is never taken for the text part.
 */
async function readParts(folderPath, uid) {
  const client = await openReader();
  try {
    const lock = await client.getMailboxLock(folderPath, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
      const leaves = [];
      const walk = (n) => (n?.childNodes?.length ? n.childNodes.forEach(walk) : n && leaves.push(n));
      walk(msg?.bodyStructure);
      const read = async (leaf) => {
        const { content } = await client.download(String(uid), leaf.part || "1", { uid: true });
        return content ? (await readStream(content)).toString("utf8") : "";
      };
      const inline = (type) => leaves.filter((l) => l.type === type && l.disposition !== "attachment");
      const texts = [], htmls = [];
      for (const l of inline("text/plain")) texts.push(await read(l));
      for (const l of inline("text/html")) htmls.push(await read(l));
      return { structure: safeCode(msg?.bodyStructure?.type), texts, htmls };
    } finally {
      lock.release();
    }
  } finally {
    await closeReader(client);
  }
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] !== "#") return named[k];
    const cp = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  });
}
/** Each <a> of an HTML part: its address and its shown text, as a reader's mail program would take them. */
function anchorsOf(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const h = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[1]);
    out.push({
      href: h ? decodeEntities(h[1] ?? h[2] ?? h[3]) : null,
      shown: decodeEntities(m[2].replace(/<[^>]*>/g, "")).trim(),
    });
  }
  return out;
}
const lineOf = (text, link) => String(text).split(/\r?\n/).some((l) => l.trim() === link);
const whole = (ok) => (ok ? "whole" : "changed");

// ---------------------------------------------------------------------------
// The proofs
// ---------------------------------------------------------------------------
const P1 = "Q15.1", P2 = "Q15.2", P3 = "Q15.3", P4 = "Q19.4", P5 = "Q19.5", P6 = "Q19.6";
const state = {};

async function preamble() {
  const require = createRequire(import.meta.url);
  const sjs = JSON.parse(readFileSync(require.resolve("@supabase/supabase-js/package.json"), "utf8")).version;
  rec("run", "client library", "recorded", `@supabase/supabase-js ${sjs}`);
  try {
    const res = await fetch(`${URL_}/auth/v1/health`, { headers: { apikey: ANON } });
    const body = await res.json().catch(() => ({}));
    rec("run", "auth server health", "recorded", `status=${res.status} version=${safeCode(body?.version ?? "unknown")}`);
  } catch (e) {
    rec("run", "auth server health", "recorded", harnessText(e));
  }
}

async function point1() {
  const email = addr("a");
  runAddresses.add(email);
  state.A = { email };
  const { data, error } = await svc.auth.admin.createUser({ email });
  track("A", data?.user);
  if (!check(P1, "createUser({ email }) with no password: no error and an id", !error && !!data?.user?.id, errInfo(error))) return;
  state.A.id = data.user.id;

  const { user, error: rErr } = await readUser(state.A.id);
  state.A.first = user;
  check(P1, "getUserById returns account A", !rErr && user?.id === state.A.id, errInfo(rErr));
  check(P1, "A: confirmed time empty", isEmpty(user, "email_confirmed_at"), `email_confirmed_at=${timeState(user, "email_confirmed_at")}, confirmed_at=${timeState(user, "confirmed_at")}`);
  check(P1, "A: sign-in time empty", isEmpty(user, "last_sign_in_at"), `last_sign_in_at=${timeState(user, "last_sign_in_at")}`);
  rec(P1, "empty time shape (A, last_sign_in_at)", "recorded", timeState(user, "last_sign_in_at"));

  // Control: the account is real, a second create for the same address is refused.
  const dup = await svc.auth.admin.createUser({ email });
  if (dup.data?.user?.id && dup.data.user.id !== state.A.id) track("A-dup", dup.data.user);
  check(P1, "control: a second createUser for the same address is refused", !!dup.error && !dup.data?.user, errInfo(dup.error));
  // The other control (A opens after the admin call) is in point 3.
}

/** The sent times on lifecycle account A: recorded only (they show a link was made, not that mail went). */
async function point2Reading(label) {
  const { user, error } = await readUser(state.A.id);
  rec(P2, `A (lifecycle) ${label}: the four sent times`, "recorded", error ? errInfo(error) : sentStates(user));
}

async function point3() {
  const A = state.A;
  // D: no password, confirmed. B: password, confirmed. C: password, unconfirmed.
  const D = { email: addr("d") }, B = { email: addr("b"), pw: newPassword() }, C = { email: addr("c"), pw: newPassword() };
  [D, B, C].forEach((x) => runAddresses.add(x.email));
  state.B = B; state.C = C; state.D = D;

  const d = await svc.auth.admin.createUser({ email: D.email, email_confirm: true });
  track("D", d.data?.user);
  const b = await svc.auth.admin.createUser({ email: B.email, password: B.pw, email_confirm: true });
  track("B", b.data?.user);
  const c = await svc.auth.admin.createUser({ email: C.email, password: C.pw });
  track("C", c.data?.user);
  if (!rec(P3, "setup: create D, B and C", d.error || b.error || c.error ? "fail" : "setup", `D ${errInfo(d.error)}; B ${errInfo(b.error)}; C ${errInfo(c.error)}`)) return;
  D.id = d.data.user.id; B.id = b.data.user.id; C.id = c.data.user.id;

  const rd = await readUser(D.id), rc = await readUser(C.id), rb = await readUser(B.id);
  rec(P3, "setup: D confirmed, C unconfirmed", isEmpty(rd.user, "email_confirmed_at") || !isEmpty(rc.user, "email_confirmed_at") ? "fail" : "setup",
    `D email_confirmed_at=${timeState(rd.user, "email_confirmed_at")}; C email_confirmed_at=${timeState(rc.user, "email_confirmed_at")}`);
  state.B.lastBefore = timeState(rb.user, "last_sign_in_at");

  // A: no password, unconfirmed.
  if (A?.id) {
    const a1 = await signIn(A.email, newPassword());
    check(P3, "A (no password, unconfirmed): a random password is refused", !a1.session && !!a1.error, refusedText(a1));
    const a2 = await signIn(A.email, "");
    check(P3, "A (no password, unconfirmed): an empty password is refused", !a2.session && !!a2.error, refusedText(a2));
  } else {
    rec(P3, "A rows", "not run", "account A was not created");
  }
  // D: no password, confirmed.
  const d1 = await signIn(D.email, newPassword());
  check(P3, "D (no password, confirmed): a random password is refused", !d1.session && !!d1.error, refusedText(d1));
  const d2 = await signIn(D.email, "");
  rec(P3, "D (no password, confirmed): an empty password (extra row)", !d2.session && !!d2.error ? "recorded" : "fail", refusedText(d2));
  // B: password, confirmed (the control that sign-in works here).
  const b1 = await signIn(B.email, B.pw);
  check(P3, "B (password, confirmed): the right password gives a session", !!b1.session && b1.user?.id === B.id, b1.session ? "session" : errInfo(b1.error));
  const b2 = await signIn(B.email, newPassword());
  check(P3, "B (password, confirmed): a wrong password is refused", !b2.session && !!b2.error, refusedText(b2));
  const rb2 = await readUser(B.id);
  state.B.lastAfter = timeState(rb2.user, "last_sign_in_at");
  // C: password, unconfirmed (recorded either way).
  const c1 = await signIn(C.email, C.pw);
  rec(P3, "C (password, unconfirmed): the right password", "recorded", c1.session ? "a session came back" : errInfo(c1.error));
  state.C.rightCode = c1.session ? "session" : `${c1.error?.status ?? "-"}/${c1.error?.code ?? c1.error?.name ?? "-"}`;

  // The step the set-password route will make on A.
  if (!A?.id) return;
  A.pw = newPassword();
  const up = await svc.auth.admin.updateUserById(A.id, { password: A.pw, email_confirm: true });
  check(P3, "A: updateUserById({ password, email_confirm: true }) has no error", !up.error, errInfo(up.error));
  const ra = await readUser(A.id);
  check(P3, "A: confirmed time now set", !isEmpty(ra.user, "email_confirmed_at"), `email_confirmed_at=${timeState(ra.user, "email_confirmed_at")}`);
  rec(P3, "A: sign-in time after the admin call", "recorded", `last_sign_in_at=${timeState(ra.user, "last_sign_in_at")}`);
  const a3 = await signIn(A.email, A.pw);
  check(P3, "A: the new password signs in (also point 1's control)", !!a3.session && a3.user?.id === A.id, a3.session ? "session" : errInfo(a3.error));
  const a4 = await signIn(A.email, newPassword());
  check(P3, "A: a wrong password is still refused", !a4.session && !!a4.error, refusedText(a4));
  const ra2 = await readUser(A.id);
  check(P1, "control: A's sign-in time is set once A signs in", !isEmpty(ra2.user, "last_sign_in_at"), `last_sign_in_at=${timeState(ra2.user, "last_sign_in_at")}`);
}

async function point4() {
  const E = { email: addr("e"), pw: newPassword() };
  runAddresses.add(E.email);
  const e = await svc.auth.admin.createUser({ email: E.email });
  track("E", e.data?.user);
  if (!check(P4, "E = createUser({ email }) has no error", !e.error && !!e.data?.user?.id, errInfo(e.error))) return;
  E.id = e.data.user.id;

  let r = await readUser(E.id);
  check(P4, "E after create: sign-in time empty", isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);
  rec(P4, "empty time shape (E after create)", "recorded", `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}; email_confirmed_at=${timeState(r.user, "email_confirmed_at")}`);

  const up = await svc.auth.admin.updateUserById(E.id, { password: E.pw, email_confirm: true });
  check(P4, "E: updateUserById({ password, email_confirm: true }) has no error", !up.error, errInfo(up.error));
  r = await readUser(E.id);
  check(P4, "E after updateUserById: sign-in time still empty", isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);

  const gl = await svc.auth.admin.generateLink({ type: "magiclink", email: E.email });
  const hash = gl.data?.properties?.hashed_token;
  check(P4, "E: generateLink({ type: \"magiclink\" }) has no error and a token hash", !gl.error && !!hash, `${errInfo(gl.error)}; hashed_token=${hash ? "set" : "empty"}; verification_type=${gl.data?.properties?.verification_type ?? "-"}`);
  r = await readUser(E.id);
  check(P4, "E after generateLink, link not opened: sign-in time still empty", isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);
  rec(P4, "E after generateLink: the four sent times (read)", "recorded", sentStates(r.user));
  if (!hash) return;

  // Control on the same account: the link is used.
  const v = await fresh().auth.verifyOtp({ type: "magiclink", token_hash: hash });
  check(P4, "control: verifyOtp({ type: \"magiclink\", token_hash }) on a fresh client gives a session", !!v.data?.session && v.data?.user?.id === E.id, v.data?.session ? "session" : errInfo(v.error));
  r = await readUser(E.id);
  check(P4, "control: E's sign-in time now set", !isEmpty(r.user, "last_sign_in_at"), `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);

  // Second control: B before and after its password sign-in (point 3).
  if (state.B?.lastBefore) {
    check(P4, "second control: B's sign-in time empty before its password sign-in", state.B.lastBefore.startsWith("empty"), `last_sign_in_at=${state.B.lastBefore}`);
    check(P4, "second control: B's sign-in time set after it", state.B.lastAfter === "set", `last_sign_in_at=${state.B.lastAfter}`);
  } else {
    rec(P4, "second control (B)", "not run", "B was not created");
  }

  // Recorded beside it: an invite-type link (it creates its own account).
  const F = { email: addr("f") };
  runAddresses.add(F.email);
  const gi = await svc.auth.admin.generateLink({ type: "invite", email: F.email });
  track("F", gi.data?.user);
  const fh = gi.data?.properties?.hashed_token;
  rec(P4, "invite link: generateLink({ type: \"invite\" }) on a new address", !gi.error && fh ? "recorded" : "fail", `${errInfo(gi.error)}; hashed_token=${fh ? "set" : "empty"}`);
  if (!gi.data?.user?.id || !fh) return;
  r = await readUser(gi.data.user.id);
  rec(P4, "invite link: sign-in time before the link is used", "recorded", `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}; ${sentStates(r.user)}`);
  const vi = await fresh().auth.verifyOtp({ type: "invite", token_hash: fh });
  rec(P4, "invite link: verifyOtp({ type: \"invite\" }) on a fresh client", "recorded", vi.data?.session ? "session" : errInfo(vi.error));
  r = await readUser(gi.data.user.id);
  rec(P4, "invite link: sign-in time after the link is used", "recorded", `last_sign_in_at=${timeState(r.user, "last_sign_in_at")}`);
}

/** One round of point 5: X is ended, Y is the control in every row. */
async function point5Round(H, way) {
  const lr = logoutRecorder();
  const sx = await signIn(H.email, H.pw, way === "own" ? lr.f : undefined);
  const sy = await signIn(H.email, H.pw);
  if (!rec(P5, `${way}: two sessions on separate clients`, sx.session && sy.session ? "setup" : "fail", `X ${sx.session ? "session" : errInfo(sx.error)}; Y ${sy.session ? "session" : errInfo(sy.error)}`)) return;
  const X = { access: sx.session.access_token, refresh: sx.session.refresh_token };
  const Y = { access: sy.session.access_token, refresh: sy.session.refresh_token };
  const cx = claims(X.access), cy = claims(Y.access);
  rec(P5, `${way}: the two are different sessions`, cx.session_id && cy.session_id && cx.session_id !== cy.session_id ? "setup" : "fail", `session_id X ${cx.session_id ? "set" : "empty"}, Y ${cy.session_id ? "set" : "empty"}, differ=${cx.session_id !== cy.session_id}`);

  // End X with the scope of that one session.
  if (way === "own") {
    const { error } = await sx.client.auth.signOut({ scope: "local" });
    rec(P5, "own: X's own signOut({ scope: \"local\" })", error ? "fail" : "recorded", `${errInfo(error)}; logout HTTP status=${lr.box.status ?? "no call"}`);
  } else {
    const adm = logoutRecorder();
    const admin = createClient(URL_, SERVICE, { auth: AUTH_OPTS, global: { fetch: adm.f } });
    const { error } = await admin.auth.admin.signOut(X.access, "local");
    rec(P5, "admin: auth.admin.signOut(X's token, \"local\")", error ? "fail" : "recorded", `${errInfo(error)}; logout HTTP status=${adm.box.status ?? "no call"}`);
  }
  const lifeLeft = Number.isFinite(cx.exp) ? Math.round(cx.exp - Date.now() / 1000) : null;
  rec(P5, `${way}: X's access token life left when tested`, "recorded", lifeLeft === null ? "unknown" : `${lifeLeft} s`);

  // (a) The auth server asked who this is; the server's own status and code are recorded beside the library's.
  const ur = answerRecorder("/auth/v1/user");
  const ax = await fresh(ur.f).auth.getUser(X.access);
  check(P5, `${way} (a): getUser with X's old token is refused`, !ax.data?.user && !!ax.error, ax.data?.user ? "the account came back" : errInfo(ax.error));
  rec(P5, `${way} (a): the auth server's own answer to X's old token`, "recorded", `status=${ur.box.status ?? "no call"} code=${ur.box.code ?? "-"}`);
  const ay = await fresh().auth.getUser(Y.access);
  check(P5, `${way} (a) control: getUser with Y's token returns the account`, ay.data?.user?.id === H.id, ay.data?.user ? "the account" : errInfo(ay.error));

  // (c) A read through the Data API (before (b), so Y's refresh changes nothing here).
  const read = async (tok) => {
    const res = await asToken(tok).from("profiles").select("id").eq("id", H.id);
    const rows = Array.isArray(res.data) ? res.data.length : 0;
    const own = rows === 1 && res.data[0].id === H.id;
    return { status: res.status, rows, own, error: res.error };
  };
  const qx = await read(X.access);
  rec(P5, `${way} (c): Data API read of H's own profile row with X's old token`, "recorded", `status=${qx.status} rows=${qx.rows} own_row=${qx.own}${qx.error ? ` code=${qx.error.code ?? "-"}` : ""}`);
  const qy = await read(Y.access);
  check(P5, `${way} (c) control: the same read with Y's token returns the row`, qy.status === 200 && qy.own, `status=${qy.status} rows=${qy.rows} own_row=${qy.own}${qy.error ? ` code=${qy.error.code ?? "-"}` : ""}`);

  // (b) A refresh.
  const bx = await fresh().auth.refreshSession({ refresh_token: X.refresh });
  check(P5, `${way} (b): refresh with X's old refresh token is refused`, !bx.data?.session && !!bx.error, bx.data?.session ? "new tokens came back" : errInfo(bx.error));
  const by = await fresh().auth.refreshSession({ refresh_token: Y.refresh });
  const yNew = by.data?.session;
  check(P5, `${way} (b) control: refresh with Y's refresh token gives new tokens`, !!yNew && yNew.access_token !== Y.access && yNew.user?.id === H.id, yNew ? "new tokens" : errInfo(by.error));
}

async function point5() {
  const H = { email: addr("h"), pw: newPassword() };
  runAddresses.add(H.email);
  const h = await svc.auth.admin.createUser({ email: H.email, password: H.pw, email_confirm: true });
  track("H", h.data?.user);
  if (!rec(P5, "setup: create H (password, confirmed)", h.error ? "fail" : "setup", errInfo(h.error))) return;
  H.id = h.data.user.id;

  for (const way of ["own", "admin"]) {
    try {
      await point5Round(H, way);
    } catch (e) {
      rec(P5, `${way}: round`, "harness", harnessText(e));
    }
  }

  // N13's second open point: three refusal codes side by side.
  const hw = await signIn(H.email, newPassword());
  const unknown = addr("u"); // never created
  const uk = await signIn(unknown, newPassword());
  rec(P5, "codes: wrong password on H (confirmed)", "recorded", refusedText(hw));
  rec(P5, "codes: right password on C (unconfirmed)", "recorded", state.C?.rightCode ?? "not run");
  rec(P5, "codes: an unknown address", "recorded", refusedText(uk));
}

/** Step 1 of point 2: delete any account left at an alias with this harness's prefix. */
async function sweepMailboxAliases() {
  const re = new RegExp(`^${escRe(MAILBOX.local)}\\+${escRe(MAIL_TAG_PREFIX)}[a-z0-9-]+@${escRe(MAILBOX.domain)}$`);
  const ids = [];
  let scanned = 0, error = null;
  for (let page = 1; page <= USER_MAX_PAGES; page++) {
    const { data, error: e } = await svc.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
    if (e) { error = e; break; }
    const users = data?.users ?? [];
    scanned += users.length;
    for (const u of users) if (u.email && re.test(u.email.toLowerCase())) ids.push(u.id);
    if (users.length < USER_PAGE_SIZE) break;
  }
  let deleted = 0;
  for (const id of ids) {
    const { error: d } = await svc.auth.admin.deleteUser(id);
    if (!d) deleted++;
  }
  return { ok: !error && deleted === ids.length, found: ids.length, deleted, scanned, error };
}

/** Point 2 with the mailbox: A1 and A2 must get no mail, beside the invited control I whose mail arrives. */
async function point2Mail() {
  // The reader signs in and finds its three folders before any account or mail is made.
  let folders;
  try {
    folders = await findFolders();
  } catch (e) {
    rec(P2, "mailbox: the reader signs in and lists its folders", "void", `${imapErr(e)}; point 2 is not proven by this run`);
    return;
  }
  const missingFolders = folders.filter((f) => !f.path);
  if (!rec(P2, "mailbox: inbox, all-mail and spam folders found by their special-use marks", missingFolders.length ? "void" : "setup",
    folders.map((f) => `${f.role}=${f.path ? "found" : "missing"}`).join(" "))) return;
  state.folders = folders;

  // 1. Leftovers of an earlier run; then the time this run's mail is read from.
  const sw = await sweepMailboxAliases();
  rec(P2, "mailbox step 1: accounts left at this harness's aliases deleted", sw.ok ? "setup" : "fail",
    `found=${sw.found} deleted=${sw.deleted} users scanned=${sw.scanned}${sw.error ? ` scan ${errInfo(sw.error)}` : ""}`);
  const step1At = Date.now();
  // IMAP's "since" is a day; a day earlier covers any time zone. The aliases are new, so nothing older can match.
  const since = new Date(step1At - 24 * 3600_000);

  // 2. A1: the address only, and nothing more.
  const A1 = { email: mailAlias("a1") };
  runAddresses.add(A1.email);
  const c1 = await createAtMailbox(A1.email);
  track("M-A1", c1.data?.user);
  if (!check(P2, "mailbox step 2: A1 = createUser({ email }) has no error", !c1.error && !!c1.data?.user?.id, errInfo(c1.error))) return;
  A1.id = c1.data.user.id;

  // 3. A2: the same create, the administrator's password call, one password sign-in.
  const A2 = { email: mailAlias("a2"), pw: newPassword() };
  runAddresses.add(A2.email);
  const c2 = await createAtMailbox(A2.email);
  track("M-A2", c2.data?.user);
  if (!check(P2, "mailbox step 3: A2 = createUser({ email }) has no error", !c2.error && !!c2.data?.user?.id, errInfo(c2.error))) return;
  A2.id = c2.data.user.id;
  const up = await svc.auth.admin.updateUserById(A2.id, { password: A2.pw, email_confirm: true });
  const upOk = check(P2, "mailbox step 3: A2 updateUserById({ password, email_confirm: true }) has no error", !up.error, errInfo(up.error));
  const s2 = await signIn(A2.email, A2.pw);
  const s2Ok = check(P2, "mailbox step 3: A2's password sign-in gives a session", !!s2.session && s2.user?.id === A2.id, s2.session ? "session" : errInfo(s2.error));
  const step3At = Date.now();

  // 4. The control, after A2's last step: one invite, the call spec 36 makes.
  const I = { email: mailAlias("i") };
  runAddresses.add(I.email);
  const inviteAt = Date.now();
  const inv = await inviteAtMailbox(I.email);
  track("M-I", inv.data?.user);
  if (inv.error) {
    rec(P2, "mailbox step 4: control inviteUserByEmail to I", "void", `${errInfo(inv.error)}; the mailer refused, point 2 is not proven by this run`);
    return;
  }
  rec(P2, "mailbox step 4: control inviteUserByEmail to I", "recorded", "no error");

  // 5. Read until the control's mail is found, for at most five minutes.
  const got = await waitForAlias(folders, I.email, since, inviteAt + MAIL_WAIT_MS, P2, "mailbox step 5");
  if (!got.folder) {
    rec(P2, "mailbox step 5: the control's mail is found within 5 minutes", "void", `not found after ${sec(Date.now() - inviteAt)} s; point 2 is not proven by this run`);
    return;
  }
  rec(P2, "mailbox step 5: the control's mail is found within 5 minutes", "pass", `folder=${got.folder.role} after ${sec(got.at - inviteAt)} s`);

  // 6. The last read: no sooner than five minutes after step 3, one search per alias in every folder.
  const wait = step3At + MAIL_WAIT_MS - Date.now();
  if (wait > 0) {
    console.log(`  waiting ${Math.ceil(wait / 1000)} s before the last read`);
    await sleep(wait);
  }
  let last;
  try {
    last = await readRound(folders, [A1.email, A2.email, I.email], since);
  } catch (e) {
    rec(P2, "mailbox step 6: the last read", "void", `${imapErr(e)}; point 2 is not proven by this run`);
    return;
  }
  const after = sec(Date.now() - step3At);
  const nI = exactCount(last, I.email, folders), nA1 = exactCount(last, A1.email, folders), nA2 = exactCount(last, A2.email, folders);
  rec(P2, "mailbox step 6: the last read finds the control's mail again", nI > 0 ? "pass" : "void", `I ${perFolder(last, I.email, folders)}; ${after} s after step 3`);
  check(P2, "mailbox step 6: no message to A1 in any folder", nA1 === 0, `A1 ${perFolder(last, A1.email, folders)}`);
  check(P2, "mailbox step 6: no message to A2 in any folder", nA2 === 0, `A2 ${perFolder(last, A2.email, folders)}`);
  const loose = [["A1", A1.email], ["A2", A2.email], ["I", I.email]]
    .map(([k, a]) => [k, folders.reduce((n, f) => n + last[a][f.role].hits, 0) - exactCount(last, a, folders)])
    .filter(([, n]) => n > 0);
  if (loose.length) rec(P2, "mailbox step 6: search hits whose recipients are not the alias (not counted)", "recorded", loose.map(([k, n]) => `${k}=${n}`).join(" "));

  // The four sent times, recorded only.
  for (const [k, x] of [["A1", A1], ["A2", A2], ["I", { id: inv.data?.user?.id }]]) {
    if (!x.id) continue;
    const r = await readUser(x.id);
    rec(P2, `mailbox: ${k}'s four sent times`, "recorded", r.error ? errInfo(r.error) : sentStates(r.user));
  }

  // The verdict.
  if (nA1 || nA2) {
    rec(P2, "mailbox verdict: no mail at create, at the password step or at the first sign-in", "fail",
      nA1 ? "A1 received mail, so createUser alone mailed it" : "only A2 received mail, so the password call or the first sign-in mailed it");
  } else if (nI === 0) {
    rec(P2, "mailbox verdict", "void", "the last read did not find the control's mail; point 2 is not proven by this run");
  } else {
    check(P2, "mailbox verdict: no mail at create, at the password step or at the first sign-in", upOk && s2Ok,
      upOk && s2Ok ? "the control's mail found in the same read" : "A2's steps did not complete");
  }
}

/** The one fixed message of point 6, with this run's two links. */
function transportMessage(link, control) {
  const intro = "This is an automatic test message from the LMS test harness. It needs no action, and its links lead to no account.";
  return {
    subject: "LMS test: link transport check",
    text: `${intro}\n\nLink 1:\n${link}\n\nLink 2:\n${control}\n`,
    html: `<!doctype html><html><body><p>${intro}</p><p>Link 1: <a href="${link}">${link}</a></p><p>Link 2: <a href="${control}">${control}</a></p></body></html>`,
  };
}
/** 43 random characters (32 bytes as base64url), the setup token's shape; it belongs to no row. */
function token43() {
  const t = randomBytes(32).toString("base64url");
  if (t.length !== 43) throw new Error("token length");
  return t;
}

/** Point 6, the transport leg: the fragment link through send-smtp and back out of the mailbox, whole. */
async function point6Transport() {
  const T = mailAlias("t"); // no account: only a recipient
  const link = `${STAGING_SITE}/auth/set-password#t=${token43()}`;
  const control = `${STAGING_SITE}/auth/set-password?t=${token43()}`;
  const message = transportMessage(link, control);

  let folders = state.folders;
  if (!folders) {
    try {
      folders = await findFolders();
    } catch (e) {
      rec(P6, "transport: the reader signs in and lists its folders", "void", `${imapErr(e)}; nothing was sent`);
      return;
    }
  }
  folders = folders.filter((f) => f.path);
  const since = new Date(Date.now() - 24 * 3600_000);

  const sentAt = Date.now();
  const ans = await sendThroughSmtpFunction(T, message);
  if (!ans.ok) {
    rec(P6, "transport: one message through staging's send-smtp (test organisation's SMTP)", "void", `status=${ans.status ?? "none"} class=${ans.cls} after ${sec(ans.ms)} s; the leg is not proven by this run`);
    return;
  }
  rec(P6, "transport: one message through staging's send-smtp (test organisation's SMTP)", "recorded",
    `status=${ans.status} ok=true after ${sec(ans.ms)} s (the app waits ${sec(APP_SEND_WAIT_MS)} s)`);

  const got = await waitForAlias(folders, T, since, sentAt + MAIL_WAIT_MS, P6, "transport");
  if (!got.folder) {
    rec(P6, "transport: the message is found in the mailbox", "void", `not found after ${sec(Date.now() - sentAt)} s; the leg is not proven by this run`);
    return;
  }
  rec(P6, "transport: the message is found in the mailbox", "recorded", `folder=${got.folder.role} after ${sec(got.at - sentAt)} s`);

  let parts;
  try {
    parts = await readParts(got.folder.path, got.uid);
  } catch (e) {
    rec(P6, "transport: the message's parts read", "void", `${imapErr(e)}; the leg is not proven by this run`);
    return;
  }
  rec(P6, "transport: the message's parts", "recorded", `structure=${parts.structure} text parts=${parts.texts.length} html parts=${parts.htmls.length}`);

  const anchors = parts.htmls.flatMap(anchorsOf);
  const rows = [
    ["text part", parts.texts.some((t) => lineOf(t, link)), parts.texts.some((t) => lineOf(t, control))],
    ["html part, the link's address", anchors.some((a) => a.href === link), anchors.some((a) => a.href === control)],
    ["html part, the link's shown text", anchors.some((a) => a.shown === link), anchors.some((a) => a.shown === control)],
  ];
  for (const [part, f, c] of rows) rec(P6, `transport: ${part}`, "recorded", `fragment link ${whole(f)}, control ${whole(c)}`);
  const controlsWhole = rows.every(([, , c]) => c);
  const fragmentsWhole = rows.every(([, f]) => f);
  if (!controlsWhole) rec(P6, "transport verdict", "void", "a control did not arrive whole, so the reader's view is not shown; the leg is not proven by this run");
  else check(P6, "transport verdict: the fragment link arrives whole in every part", fragmentsWhole, fragmentsWhole ? "every part whole" : "a part changed it");
}

// ---------------------------------------------------------------------------
// Point 6, the platform leg: the console's welcome, read back from the mailbox
// ---------------------------------------------------------------------------
const P6P = "Q19.6p";
/** The leg's fixed alias of the mailbox; the staging allow-list names it. */
const legAlias = (box = MAILBOX) => `${box.local}+${MAIL_TAG_PREFIX}${LEG_ALIAS_ROLE}@${box.domain}`;
/** The only way the leg names the alias to the app: through the recipient guard. */
function legRecipient(address, box = MAILBOX) {
  return mailboxRecipient(address, box);
}
/** What the leg made, for its own clean-up in its own order. */
const leg = { orgId: null, ownerId: null, adminId: null, browser: null };

/** POST a JSON body to the build; the answer's status and parsed body (never printed). */
async function postBuild(path, body, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${LEG_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const isUnusable = (a) => a.status === 400 && a.json?.error === LINK_UNUSABLE && a.json?.code === "unusable";

/** The leg's platform_email_log rows for one account: event, status and code only. */
async function legRows(userId) {
  const { data, error } = await svc.from("platform_email_log").select("event_type, status, error_code").eq("to_user_id", userId);
  return { rows: Array.isArray(data) ? data : [], error };
}

/** Lines of a text part that name the set-password page on the build's host, in any form. */
function setupLines(text, host) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes(SETUP_PATH) || l.includes(encodeURIComponent(SETUP_PATH)) || (l.includes(host) && /set-password/i.test(l)));
}

async function platformLegRun() {
  const host = new URL(LEG_BASE).host;
  const setupRe = new RegExp(`^${escRe(`${new URL(LEG_BASE).origin}${SETUP_PATH}`)}#t=([A-Za-z0-9_-]{43})$`);

  // 1. The build.
  let first;
  try {
    first = await postBuild("/api/auth/set-password", { token: token43() });
  } catch (e) {
    rec(P6P, "step 1: the build answers", "not run", `the request failed (${safeCode(e?.name)}); the address does not serve this branch`);
    return;
  }
  if (!isUnusable(first)) {
    rec(P6P, "step 1: 43 random characters get rule N10's answer", "not run", `status=${first.status}; the address does not serve this branch`);
    return;
  }
  rec(P6P, "step 1: 43 random characters get rule N10's answer (the build is this branch)", "setup", `status=${first.status}`);

  // 2. The sweep.
  const sw = await sweepMailboxAliases();
  if (!rec(P6P, "step 2: accounts left at this harness's aliases deleted", sw.ok ? "setup" : "fail",
    `found=${sw.found} deleted=${sw.deleted} users scanned=${sw.scanned}${sw.error ? ` scan ${errInfo(sw.error)}` : ""}`)) return;
  const sweptAt = Date.now();
  const since = new Date(sweptAt - 24 * 3600_000);

  // 3. The fixtures.
  const slug = `${NS_PREFIX}-p0029h-${randomBytes(3).toString("hex")}`;
  const orgName = `Lifecycle platform leg ${RUN}`;
  const { data: org, error: orgError } = await svc.from("organizations").insert({ name: orgName, slug }).select("id").single();
  if (!rec(P6P, "step 3: the organisation (lifecycle namespace)", orgError || !org?.id ? "fail" : "setup", orgError ? `code=${safeCode(orgError.code)}` : "made")) return;
  leg.orgId = org.id;
  const O = { email: addr("owner"), pw: newPassword() };
  runAddresses.add(O.email);
  const o = await svc.auth.admin.createUser({ email: O.email, password: O.pw, email_confirm: true });
  track("leg-owner", o.data?.user);
  if (!rec(P6P, "step 3: the platform owner's account (password, confirmed)", o.error || !o.data?.user?.id ? "fail" : "setup", errInfo(o.error))) return;
  leg.ownerId = o.data.user.id;
  const prof = await svc.from("profiles").upsert({ id: leg.ownerId, email: O.email, first_name: "Platform", last_name: "Leg", must_change_password: false }, { onConflict: "id" });
  const po = await svc.from("platform_owners").upsert({ user_id: leg.ownerId, mfa_required: false }, { onConflict: "user_id" });
  if (!rec(P6P, "step 3: the owner's profile (no forced change) and platform owner row (mfa_required false)", prof.error || po.error ? "fail" : "setup",
    `profile ${prof.error ? `code=${safeCode(prof.error.code)}` : "ok"}; platform_owners ${po.error ? `code=${safeCode(po.error.code)}` : "ok"}`)) return;

  // 4. The session, through the build's own /login form.
  const { chromium } = await import("playwright");
  leg.browser = await chromium.launch();
  const ctx = await leg.browser.newContext({ baseURL: LEG_BASE });
  const page = await ctx.newPage();
  let signedIn = false;
  try {
    await page.goto("/login");
    await page.getByLabel(/work email/i).waitFor({ timeout: 30_000 });
    await page.getByLabel(/work email/i).fill(O.email);
    await page.getByLabel(/^password$/i).fill(O.pw);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/super(\/|$)/, { timeout: 30_000 });
    signedIn = true;
  } catch (e) {
    rec(P6P, "step 4: the owner signs in through /login", "fail", `${safeCode(e?.name)}`);
  }
  await page.close().catch(() => {});
  if (!signedIn) return;
  rec(P6P, "step 4: the owner signs in through /login", "setup", "a session in the driven browser");

  // 5. The add, through the recipient guard.
  const alias = legRecipient(legAlias());
  const added = await ctx.request.post(`/api/super/tenants/${leg.orgId}/admins`, { data: { email: alias, role: "admin" } });
  const ans = await added.json().catch(() => null);
  if (typeof ans?.user_id === "string") leg.adminId = ans.user_id;
  if (added.status() !== 200) {
    rec(P6P, "step 5: the console's add answers 200", "fail", `status=${added.status()}`);
    return;
  }
  if (ans?.invited !== true) {
    rec(P6P, "step 5: invited true (a new account at the alias)", "fail", "invited false: the alias was still taken");
    return;
  }
  if (ans?.email_outcome?.status !== "sent") {
    rec(P6P, "step 5: the welcome is sent", "void", `email_outcome=${safeCode(ans?.email_outcome?.status)} class=${safeCode(ans?.email_outcome?.class)}; the leg is not proven by this run`);
    return;
  }
  check(P6P, "step 5: 200, invited true, email_outcome sent, no setup_link in the answer (rule N8)", !("setup_link" in ans), "setup_link absent");
  await ctx.close().catch(() => {});

  // 6. The row.
  const r6 = await legRows(leg.adminId);
  const welcomes = r6.rows.filter((r) => r.event_type === "platform_admin_welcome");
  check(P6P, "step 6: one platform_email_log row, platform_admin_welcome, sent", !r6.error && welcomes.length === 1 && welcomes[0].status === "sent",
    r6.error ? `read code=${safeCode(r6.error.code)}` : `rows=${welcomes.length} status=${welcomes.map((r) => safeCode(r.status)).join(",") || "-"}`);

  // 7. The mail.
  let folders;
  try {
    folders = (await findFolders()).filter((f) => f.path);
  } catch (e) {
    rec(P6P, "step 7: the reader signs in and lists its folders", "void", `${imapErr(e)}; the leg is not proven by this run`);
    return;
  }
  const got = await waitForAlias(folders, alias, since, sweptAt + MAIL_WAIT_MS, P6P, "step 7");
  if (!got.folder) {
    rec(P6P, "step 7: the welcome is found within 5 minutes", "void", `not found after ${sec(Date.now() - sweptAt)} s; the leg is not proven by this run`);
    return;
  }
  rec(P6P, "step 7: the welcome is found within 5 minutes", "recorded", `folder=${got.folder.role} after ${sec(got.at - sweptAt)} s`);
  let parts;
  try {
    parts = await readParts(got.folder.path, got.uid);
  } catch (e) {
    rec(P6P, "step 7: the welcome's parts read", "void", `${imapErr(e)}; the leg is not proven by this run`);
    return;
  }
  rec(P6P, "step 7: the welcome's parts", "recorded", `structure=${parts.structure} text parts=${parts.texts.length} html parts=${parts.htmls.length}`);
  const anchors = parts.htmls.flatMap(anchorsOf);

  // 8. The control: the sign-in address, which this script knows exactly.
  const signIn = `${new URL(LEG_BASE).origin}/${slug}/login`;
  const control = [
    ["text part", parts.texts.some((t) => lineOf(t, signIn))],
    ["html part, the link's address", anchors.some((a) => a.href === signIn)],
    ["html part, the link's shown text", anchors.some((a) => a.shown === signIn)],
  ];
  for (const [part, ok] of control) rec(P6P, `step 8: the sign-in address, ${part}`, "recorded", whole(ok));
  if (!control.every(([, ok]) => ok)) {
    rec(P6P, "step 8: the control is whole in every part", "void", "the reader's view is not shown; the leg is not proven by this run");
    return;
  }

  // 9. The link.
  const lines = parts.texts.flatMap((t) => setupLines(t, host));
  const exact = lines.filter((l) => setupRe.test(l));
  const link = exact.length === 1 && lines.length === 1 ? exact[0] : null;
  if (!check(P6P, "step 9: the text part holds one setup address on the build's host, no query, #t= and 43 characters", !!link,
    `lines naming the page=${lines.length}, of the exact form=${exact.length}`)) return;
  const htmlWhole = anchors.some((a) => a.href === link) && anchors.some((a) => a.shown === link);
  check(P6P, "step 9: the HTML part holds the same address as a link's address and as its shown text", htmlWhole, whole(htmlWhole));
  const token = setupRe.exec(link)[1];
  const read1 = await postBuild("/api/auth/set-password", { token });
  check(P6P, "step 9: the token with no password gets the good answer naming the organisation", read1.status === 200 && read1.json?.organization === orgName, `status=${read1.status} organisation ${read1.json?.organization === orgName ? "named" : "not named"}`);
  const read2 = await postBuild("/api/auth/set-password", { token });
  check(P6P, "step 9: posted again, it is still good (a read spends nothing)", read2.status === 200 && read2.json?.organization === orgName, `status=${read2.status}`);
  const other = await postBuild("/api/auth/set-password", { token: token43() });
  check(P6P, "step 9: any other 43 characters get step 1's answer", isUnusable(other), `status=${other.status}`);

  // 10. The use.
  const pw = newPassword();
  const set = await postBuild("/api/auth/set-password", { token, password: pw });
  check(P6P, "step 10: the token with a password sets it", set.status === 200 && set.json?.ok === true, `status=${set.status} code=${safeCode(set.json?.code)}`);
  const s10 = await signIn_(alias, pw);
  check(P6P, "step 10: that password signs in at the auth server", !!s10.session, s10.session ? "session" : errInfo(s10.error));
  const after = await postBuild("/api/auth/set-password", { token });
  check(P6P, "step 10: the same token then gets rule N10's answer", isUnusable(after), `status=${after.status}`);

  // 11. Twenty sign-in-link requests at once for the administrator at the alias.
  const burst = await Promise.all(Array.from({ length: LEG_BURST }, () => postBuild("/api/auth/magic-link", { email: alias }).catch(() => ({ status: null }))));
  rec(P6P, `step 11: ${LEG_BURST} sign-in-link requests at once`, "recorded", `answered 200: ${burst.filter((b) => b.status === 200).length}`);
  await sleep(APP_JOB_MS + 5_000);
  let r11 = await legRows(leg.adminId);
  for (let i = 0; i < 10; i++) {
    await sleep(3_000);
    const next = await legRows(leg.adminId);
    if (next.rows.length === r11.rows.length) break;
    r11 = next;
  }
  const links = r11.rows.filter((r) => r.event_type === "platform_sign_in_link");
  const sentLinks = links.filter((r) => r.status === "sent").length;
  const flight = links.filter((r) => r.status === "suppressed" && r.error_code === "in_flight").length;
  check(P6P, `step 11: at most ${LEG_BURST_MAX} sent rows`, !r11.error && sentLinks <= LEG_BURST_MAX, `sent=${sentLinks}`);
  check(P6P, `step 11: at most ${LEG_BURST_MAX} in-flight rows`, !r11.error && flight <= LEG_BURST_MAX, `in_flight=${flight}`);
  rec(P6P, "step 11: the burst's other rows", "recorded", `refused=${links.filter((r) => r.status === "refused").length} failed=${links.filter((r) => r.status === "failed").length} claims=${links.filter((r) => r.status === "suppressed" && r.error_code === "pending").length}`);
}
/** A password sign-in at the auth server on a fresh client (the name signIn is the run's own helper above). */
const signIn_ = (email, password) => signIn(email, password);

/** Step 12: the leg's clean-up, in its order, also after a failure. */
async function platformLegCleanup() {
  let ok = true;
  const notes = [];
  if (leg.browser) await leg.browser.close().catch(() => {});
  if (leg.adminId) {
    const { error } = await svc.auth.admin.deleteUser(leg.adminId);
    if (error) { ok = false; notes.push(`alias account ${errInfo(error)}`); }
  }
  if (leg.ownerId) {
    const row = await svc.from("platform_owners").delete().eq("user_id", leg.ownerId);
    if (row.error) { ok = false; notes.push(`owner row code=${safeCode(row.error.code)}`); }
    const { error } = await svc.auth.admin.deleteUser(leg.ownerId);
    if (error) { ok = false; notes.push(`owner account ${errInfo(error)}`); }
    created.delete("leg-owner");
  }
  if (leg.orgId) {
    const { error } = await svc.from("organizations").delete().eq("id", leg.orgId);
    if (error) { ok = false; notes.push(`organisation code=${safeCode(error.code)}`); }
  }
  // A last read: no account left at the harness's prefix.
  const last = await sweepMailboxAliases();
  if (!last.ok || last.found > 0) ok = false;
  rec(P6P, "step 12: clean-up (alias account, owner row and account, organisation; none left at the prefix)", ok ? "pass" : "fail",
    `${notes.join("; ") || "all deleted"}; left at the prefix=${last.found}${last.found ? `, deleted now=${last.deleted}` : ""}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Cleanup: every account of this run, also after a failure
// ---------------------------------------------------------------------------
let cleanupPromise = null;
/** One cleanup per process: a second caller waits for the first. */
const cleanup = () => (cleanupPromise ??= doCleanup());
async function doCleanup() {
  let ok = true;
  const ids = [...new Set(created.values())];
  let deleted = 0;
  for (const id of ids) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) {
      ok = false;
      rec("cleanup", "deleteUser", "fail", errInfo(error));
    } else deleted++;
  }
  // Any account of this run's addresses still there (one an error left behind).
  let left = 0, extra = 0, scanned = 0, scanError = null;
  if (runAddresses.size) {
    for (let page = 1; page <= USER_MAX_PAGES; page++) {
      const { data, error } = await svc.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
      if (error) { scanError = error; break; }
      const users = data?.users ?? [];
      scanned += users.length;
      for (const u of users) {
        if (u.email && runAddresses.has(u.email.toLowerCase())) {
          const { error: dErr } = await svc.auth.admin.deleteUser(u.id);
          if (dErr) { left++; ok = false; } else extra++;
        }
      }
      if (users.length < USER_PAGE_SIZE) break;
    }
  }
  const { count, error: pErr } = ids.length
    ? await svc.from("profiles").select("id", { count: "exact", head: true }).in("id", ids)
    : { count: 0, error: null };
  if (pErr || (count ?? 0) > 0) ok = false;
  if (scanError) ok = false;
  rec("cleanup", "accounts of this run deleted", ok ? "pass" : "fail",
    `created=${ids.length} deleted=${deleted} found_by_address_and_deleted=${extra} left=${left}; users scanned=${scanned}${scanError ? ` scan ${errInfo(scanError)}` : ""}; profile rows left=${pErr ? `unread ${pErr.code ?? "-"}` : count ?? 0}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Dry run: the plan and the recipient guard, through the same wrappers as
// the run, with stub transports that count calls. Nothing leaves the process.
// ---------------------------------------------------------------------------
function notMailboxFor(box) {
  const { local, domain, base } = box;
  const tag = `${MAIL_TAG_PREFIX}x-${RUN}`;
  return [
    "", `someone.else@${domain}`, `${local}@other.invalid`, `${local}@${domain}.invalid`,
    `${local}+${tag}@other.invalid`, `${local}+${tag}@${domain}.invalid`, `${local}+${tag}@sub.${domain}`,
    `x${local}+${tag}@${domain}`, `${local}x+${tag}@${domain}`, `${local}+${tag}@${domain}@other.invalid`,
    `"${local}+${tag}@${domain}" <someone@other.invalid>`, `${local}+${tag}@${domain}, someone@other.invalid`,
    ` ${local}+${tag}@${domain}`, `${local}+${tag}@${domain}\r\nBcc: someone@other.invalid`,
    `${base}.invalid`, `${local}+${tag}@${domain} `,
  ];
}
async function recipientSelfCheck() {
  const boxes = [parseMailbox("mailbox@example.invalid"), MAILBOX].filter(Boolean);
  // The platform leg's one way to name an address to the app.
  let legRefused = 0, legTried = 0, legAccepted = 0;
  let calls = 0, refused = 0, tried = 0, accepted = 0, good = 0;
  const stubFetch = async () => { calls++; throw new Error("stub transport"); };
  const stubClient = { auth: { admin: { createUser: async () => { calls++; return {}; }, inviteUserByEmail: async () => { calls++; return {}; } } } };
  const stubMessage = transportMessage(`${STAGING_SITE}/`, `${STAGING_SITE}/`);
  for (const box of boxes) {
    for (const bad of notMailboxFor(box)) {
      for (const send of [
        () => createAtMailbox(bad, { client: stubClient, box }),
        () => inviteAtMailbox(bad, { client: stubClient, box }),
        () => sendThroughSmtpFunction(bad, stubMessage, { fetchImpl: stubFetch, box }),
        async () => legRecipient(bad, box),
      ]) {
        tried++;
        try {
          await send();
        } catch (e) {
          if (e instanceof RecipientRefused) refused++;
        }
      }
    }
    for (const ok of [box.base, ...["a1", "a2", "i", "t"].map((r) => mailAlias(r, box))]) {
      good++;
      if (isMailboxRecipient(ok, box)) accepted++;
    }
    for (const bad of notMailboxFor(box)) {
      legTried++;
      try {
        legRecipient(bad, box);
      } catch (e) {
        if (e instanceof RecipientRefused) legRefused++;
      }
    }
    try {
      if (legRecipient(legAlias(box), box) === legAlias(box)) legAccepted++;
    } catch {
      // refused: counted below as not accepted
    }
  }
  const pass = refused === tried && calls === 0 && accepted === good;
  console.log(`recipient guard: ${refused} of ${tried} calls to addresses that are not the mailbox refused, transport calls made ${calls}; ${accepted} of ${good} mailbox addresses accepted (${boxes.length === 2 ? "a sample mailbox and the set one" : "a sample mailbox only"}) => ${pass ? "pass" : "FAIL"}`);
  const legPass = legRefused === legTried && legAccepted === boxes.length;
  console.log(`platform leg guard: the fixed alias accepted for ${legAccepted} of ${boxes.length} mailbox(es); ${legRefused} of ${legTried} other addresses refused => ${legPass ? "pass" : "FAIL"}`);
  const baseChecks = [
    ["https://my-lms.mentora.workers.dev", true],
    ["https://my-lms-staging-123456789.asia-south1.run.app", true],
    ["https://my-lms-prod.mentora.workers.dev", false],
    ["http://localhost:3100", false],
    ["https://my-lms.mentora.workers.dev:8443", false],
    ["https://example.invalid", false],
  ];
  const baseOk = baseChecks.every(([u, want]) => isStagingAppUrl(`${u}/`) === want);
  console.log(`platform leg address test: the cron poster's isStagingAppUrl admits the two staging apps and refuses ${baseChecks.length - 2} other addresses => ${baseOk ? "pass" : "FAIL"}`);
  return pass && legPass && baseOk;
}

if (dryRun) {
  if (platformLeg) {
    console.log(`plan: point 6 platform leg alone (--platform-leg): ${legReady ? "runs" : `not run (${legReason})`}: the build's console adds an administrator at the fixed alias, the welcome is read from the mailbox, its link is used once, then ${LEG_BURST} sign-in-link requests at once; points 1 to 5 and the transport leg left out; the tenant leg not run (pull request C)`);
  } else {
    console.log(`plan: ${mailOnly ? "points 1, 3, 4 and 5 left out (--mail-only)" : "points 1, 3, 4 and 5 run"}; point 2 with the mailbox ${mailReady ? "runs" : `not run (${mailReason})`}; point 6 transport leg ${smtpReady ? "runs" : `not run (${smtpReason})`}; point 6 platform leg not run (it runs alone, with --platform-leg); point 6 tenant leg not run (pull request C)`);
  }
  const guardOk = await recipientSelfCheck();
  console.log("dry run: no call made.");
  process.exit(guardOk ? 0 : 3);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const startedAt = new Date().toISOString();
const count = (o) => results.filter((r) => r.outcome === o).length;
function finish() {
  const summary = `pass=${count("pass")} fail=${count("fail")} void=${count("void")} recorded=${count("recorded")} not_run=${count("not run")} harness=${count("harness")}`;
  console.log(`\nsummary: ${summary}`);
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), project: "staging", mode: mailOnly ? "mail-only" : "all", summary, results }, null, 2) + "\n");
    console.log("report written");
  }
}
const notRunMail = () => rec(P2, "point 2 with the mailbox", "not run", mailReason);
const notRunTransport = () => rec(P6, "point 6, transport leg", "not run", smtpReason);
const notRunLaterLegs = () => {
  rec(P6, "point 6, platform leg", "not run", "it runs alone, with --platform-leg, against a build that holds staging's platform sender settings");
  rec(P6, "point 6, tenant leg in the app's own mail", "not run", "pull request C");
};

// --platform-leg with its settings unset: decided before any call, and no call is made.
if (platformLeg && !legReady) {
  rec(P6P, "point 6, platform leg", "not run", legReason);
  finish();
  process.exit(2);
}

// --mail-only with nothing to run: decided before any call, and no call is made.
if (mailOnly && !mailReady) {
  notRunMail();
  notRunTransport();
  notRunLaterLegs();
  finish();
  process.exit(2);
}

let exiting = false;
async function emergencyExit(why, e) {
  if (exiting) return;
  exiting = true;
  console.error(`✖ ${why}${e ? `: ${harnessText(e)}` : ""}; cleaning up`);
  await closeAllReaders().catch(() => {});
  await cleanup().catch(() => {});
  finish();
  process.exit(3);
}
process.on("SIGINT", () => emergencyExit("interrupted"));
process.on("uncaughtException", (e) => emergencyExit("uncaught error", e));
process.on("unhandledRejection", (e) => emergencyExit("unhandled rejection", e));

let harnessFailed = false;
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    harnessFailed = true;
    rec(name, "step threw", "harness", e instanceof RecipientRefused ? "a recipient that is not the mailbox was refused" : harnessText(e));
  }
}

let cleanOk = false;
if (platformLeg) {
  let legClean = false;
  try {
    await step("run", preamble);
    await step(P6P, platformLegRun);
  } finally {
    legClean = await platformLegCleanup().catch((e) => {
      rec(P6P, "step 12: clean-up threw", "harness", harnessText(e));
      return false;
    });
    await closeAllReaders().catch(() => {});
    cleanOk = (await cleanup().catch(() => false)) && legClean;
  }
  finish();
  process.exit(harnessFailed || count("harness") || !cleanOk ? 3 : count("fail") || count("void") ? 1 : 0);
}
try {
  await step("run", preamble);
  if (!mailOnly) {
    await step(P1, point1);
    if (state.A?.id) await step(P2, () => point2Reading("after create"));
    else rec(P2, "A (lifecycle): the four sent times", "not run", "account A was not created");
    await step(P3, point3);
    if (state.A?.id) await step(P2, () => point2Reading("after point 3's last step"));
    await step(P4, point4);
    await step(P5, point5);
  }
  // The transport leg first: point 2 comes last, so that nothing is tried after a void of point 2.
  if (smtpReady) await step(P6, point6Transport);
  else notRunTransport();
  notRunLaterLegs();
  if (mailReady) await step(P2, point2Mail);
  else notRunMail();
} finally {
  await closeAllReaders().catch(() => {});
  cleanOk = await cleanup().catch((e) => {
    rec("cleanup", "cleanup threw", "harness", harnessText(e));
    return false;
  });
}

finish();
process.exit(harnessFailed || count("harness") || !cleanOk ? 3 : count("fail") || count("void") ? 1 : 0);
