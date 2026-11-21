/**
 * Each limit on a public reset code or sign-in link is claimed before the
 * send (ADR 0029, the note of 2026-11-22): a job writes its claim, then
 * counts the rows with its own claim among them, and goes on only within
 * the limit. So the limits hold under concurrent requests:
 *   - the account limit (5 in the hour, 10 in the day), in both systems;
 *   - the organisation's platform share and the platform's ceiling;
 *   - the organisation's own daily limit for its codes and links.
 *
 * Jobs are run together after their answers (40 of them, 60 for the sender
 * alone), in tests/unit/public-mail-world.ts, whose tables honour every
 * filter, stamp each row when it is written and answer every read after a
 * turn of the event loop, so jobs interleave. A limit under jobs run
 * together is asserted as "at most the limit", never as an exact number:
 * a claim may refuse more than it must, never less.
 *
 * Also: the shared times and the count of claims in flight; a reset code's
 * row written closed and opened only after every limit; a claim older than
 * the send window sends nothing; a claim or a count that cannot be written
 * or read sends nothing; the fallbacks of a database without 0114, each on
 * its own; the welcome, the alert and the test write no claim; the calls
 * before the answer are the same for a known and an unknown address.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/mail-claims.test.ts   (or npm run test:unit)
 */
import { createClient } from "@supabase/supabase-js";
import {
  ORG, OTHER_ORG, PLATFORM_ENV, SLUG, SUPABASE, ask, captureLogs, eq, finish, freshWorld, handed, install, requests, uninstall, world,
  type Asked, type Req, type Row,
} from "./public-mail-world";
import { CLAIMS_IN_FLIGHT_PAGE, CLAIM_IN_FLIGHT_MS, CLAIM_SEND_WITHIN_MS, SMTP_SEND_WAIT_MS, claimsInFlight } from "../../lib/email/smtp-function";
import { claimPlatformSend, sendPlatformEmail, type PlatformSendRequest } from "../../lib/email/platform-sender";
import { hashOtp } from "../../lib/auth/password-reset";

const id = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = { id: id(1), email: "admin@tenant.stub" };
const LEARNER = { id: id(2), email: "learner@tenant.stub" };
const ADMIN_X = { id: id(3), email: "admin-x@tenant.stub" };
const ADMIN_Y = { id: id(4), email: "admin-y@tenant.stub" };
const LEARNER_X = { id: id(5), email: "learner-x@tenant.stub" };
const LEARNER_Y = { id: id(6), email: "learner-y@tenant.stub" };
const many = (n: number, from: number, role: "admin" | "user") =>
  Array.from({ length: n }, (_, i) => ({ id: id(from + i), email: `${role}-${from + i}@tenant.stub`, role }));
const ADMINS = many(40, 100, "admin");
const LEARNERS = many(40, 200, "user");
const UNKNOWN = "nobody@tenant.stub";

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const LINK = "https://lms.stub/auth/finish?token_hash=t&type=magiclink";

type Route = { POST: (r: Request) => Promise<Response> };
type Kind = { name: string; path: string; route: Route; tenantEvent: "password_reset" | "magic_link"; platformEvent: "platform_reset_code" | "platform_sign_in_link" };

/** Every account the tests use, as members of the organisation. */
function base(over: Parameters<typeof freshWorld>[0] = {}) {
  const people = [ADMIN, LEARNER, ADMIN_X, ADMIN_Y, LEARNER_X, LEARNER_Y, ...ADMINS, ...LEARNERS];
  const role = (p: { id: string }) => ([ADMIN, ADMIN_X, ADMIN_Y].some((a) => a.id === p.id) || ADMINS.some((a) => a.id === p.id) ? "admin" : "user");
  freshWorld({
    users: people.map((p) => ({ id: p.id, email: p.email })),
    members: people.map((p) => ({ organization_id: ORG, user_id: p.id, role: role(p), status: "active" })),
    ...over,
  });
}

/** Every request's answer first, then every job at once: the platform runs each job after its answer. */
async function together(kind: Kind, payloads: Row[]): Promise<{ answers: Asked[]; lines: string[] }> {
  const jobs: Array<() => unknown> = [];
  const answers: Asked[] = [];
  for (const p of payloads) {
    answers.push(await ask(kind.route, kind.path, p));
    jobs.push(...handed.splice(0));
  }
  requests.length = 0;
  const { lines } = await captureLogs(() => Promise.all(jobs.map((j) => j())));
  return { answers, lines };
}

/**
 * Every answer first, then the first job alone and the rest at once after
 * it: so at least one goes, and the rest run together on what it left.
 */
async function firstThenTogether(kind: Kind, payloads: Row[]): Promise<{ lines: string[] }> {
  const jobs: Array<() => unknown> = [];
  for (const p of payloads) {
    await ask(kind.route, kind.path, p);
    jobs.push(...handed.splice(0));
  }
  requests.length = 0;
  const { lines } = await captureLogs(async () => {
    await jobs[0]();
    await Promise.all(jobs.slice(1).map((j) => j()));
  });
  return { lines };
}

/** One request, then its job. */
async function one(kind: Kind, payload: Row): Promise<string[]> {
  return (await together(kind, [payload])).lines;
}

/** The job's own fixed lines: kind, system, outcome and code. */
const jobLines = (lines: string[]) =>
  lines.filter((l) => l.includes('"event":"credential_mail"')).map((l) => JSON.parse(l) as { kind: string; system: string; outcome: string; code?: string });

const dispatched = (host: "platform" | "tenant") => requests.filter((r) => r.path === "/functions/v1/send-smtp" && (r.body as Row).host === `smtp.${host}.stub`);
const platformRowsOf = (pred: (r: Row) => boolean) => world.platformLog.filter(pred);
const claimsOfPlatform = () => platformRowsOf((r) => r.status === "suppressed" && r.error_code === "pending");
const outcomesOfPlatform = (event: string) => platformRowsOf((r) => r.event_type === event && !(r.status === "suppressed" && r.error_code === "pending"));
const tenantClaims = (event: string) => world.log.filter((r) => r.event_type === event && r.status === "queued");
const tenantSent = (event: string) => world.log.filter((r) => r.event_type === event && r.status === "sent");
const openCodes = (email: string) => world.otps.filter((r) => r.email === email && r.used_at === null);

/** The codes the mails carried: the tenant's "# 123456" line or the platform's code line. */
const mailedCodes = () =>
  requests
    .filter((r) => r.path === "/functions/v1/send-smtp")
    .map((r) => /(?:^|\n)#? ?(\d{6})(?:\n|$)/.exec(String((r.body as Row).text ?? ""))?.[1])
    .filter((c): c is string => typeof c === "string");

/** A clock the test moves; restored by the caller. */
function fakeClock(start = Date.now()) {
  const real = Date.now;
  let t = start;
  Date.now = () => t;
  return { move: (ms: number) => { t += ms; }, now: () => t, restore: () => { Date.now = real; } };
}

/** Set environment values for one block. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const seedPlatform = (n: number, row: Row, msAgo: (i: number) => number) => {
  for (let i = 0; i < n; i++) world.platformLog.push({ id: `seed-p-${world.platformLog.length}`, error_code: null, error_detail: null, ...row, sent_at: ago(msAgo(i)) });
};
const seedTenant = (n: number, row: Row, msAgo: (i: number) => number) => {
  for (let i = 0; i < n; i++) world.log.push({ id: `seed-t-${world.log.length}`, organization_id: ORG, error: null, ...row, sent_at: ago(msAgo(i)) });
};

async function main() {
  install(PLATFORM_ENV);
  try {
    const request = await import("../../app/api/auth/forgot-password/request/route");
    const magic = await import("../../app/api/auth/magic-link/route");
    const CODE: Kind = { name: "reset code", path: "/api/auth/forgot-password/request", route: request, tenantEvent: "password_reset", platformEvent: "platform_reset_code" };
    const LINK_KIND: Kind = { name: "sign-in link", path: "/api/auth/magic-link", route: magic, tenantEvent: "magic_link", platformEvent: "platform_sign_in_link" };
    const KINDS = [CODE, LINK_KIND];
    const db = createClient(SUPABASE, "stub-service-key-0029", { auth: { persistSession: false } });

    console.log("\nthe times and the count of claims in flight");
    {
      eq("a send starts within 30 s of its claim; a claim counts in flight for two minutes", [CLAIM_SEND_WITHIN_MS, CLAIM_IN_FLIGHT_MS], [30_000, 120_000]);
      eq("…two minutes cover the start, the send's own wait and a minute for the outcome's row and two clocks", CLAIM_IN_FLIGHT_MS >= CLAIM_SEND_WITHIN_MS + SMTP_SEND_WAIT_MS + 60_000, true);
      eq("…a read of claims asks for a page of 1,000", CLAIMS_IN_FLIGHT_PAGE, 1000);
      const of = (user: string | null, event: string, n: number) => Array.from({ length: n }, () => ({ to_user_id: user, event_type: event }));
      eq("400 claims of one account and kind count as five", claimsInFlight(of("u1", "platform_sign_in_link", 400)), 5);
      eq("…another kind of that account counts apart, and so does another account", claimsInFlight([...of("u1", "magic_link", 7), ...of("u1", "password_reset", 2), ...of("u2", "magic_link", 3)]), 5 + 2 + 3);
      eq("…a claim with no account counts by itself", claimsInFlight([...of(null, "magic_link", 7), ...of("u1", "magic_link", 9)]), 7 + 5);
      eq("…no claims, none", claimsInFlight([]), 0);
    }

    console.log("\nthe world answers each read as the table was when it arrived");
    {
      base();
      const seen: number[] = [];
      const job = async () => {
        const { data } = await db.from("platform_email_log").select("id").eq("to_user_id", ADMIN.id).eq("event_type", "world_check");
        seen.push((data ?? []).length);
        await db.from("platform_email_log").insert({ event_type: "world_check", to_user_id: ADMIN.id, status: "sent" });
      };
      await Promise.all(Array.from({ length: 40 }, job));
      eq("jobs started together each read the table as it was on arrival, before any of their rows", [seen.length, seen.every((n) => n === 0), platformRowsOf((r) => r.event_type === "world_check").length], [40, true, 40]);
    }

    console.log("\neach path sends one request, and five one after another; the sixth is refused, counted once");
    for (const kind of KINDS) {
      base();
      await one(kind, { email: LEARNER.email, orgSlug: SLUG });
      eq(`tenant ${kind.name}: one request sends: its claim, then its row`, [dispatched("tenant").length, world.log.map((r) => [r.event_type, r.status])], [1, [[kind.tenantEvent, "queued"], [kind.tenantEvent, "sent"]]]);
      base();
      let sends = 0;
      for (let i = 0; i < 5; i++) { await one(kind, { email: LEARNER.email, orgSlug: SLUG }); sends += dispatched("tenant").length; }
      eq(`tenant ${kind.name}: five one after another all send, with five claims and five rows`, [sends, tenantClaims(kind.tenantEvent).length, tenantSent(kind.tenantEvent).length], [5, 5, 5]);
      const sixth = jobLines(await one(kind, { email: LEARNER.email, orgSlug: SLUG }));
      eq(`tenant ${kind.name}: the sixth is refused for the account, with no claim and no send`, [sixth.map((l) => l.outcome), dispatched("tenant").length, tenantClaims(kind.tenantEvent).length], [["account_limit"], 0, 5]);

      base();
      await one(kind, { email: ADMIN.email });
      eq(`platform ${kind.name}: one request sends: its claim, then its row`, [dispatched("platform").length, world.platformLog.map((r) => [r.event_type, r.status, r.error_code])], [1, [[kind.platformEvent, "suppressed", "pending"], [kind.platformEvent, "sent", null]]]);
      base();
      sends = 0;
      for (let i = 0; i < 5; i++) { await one(kind, { email: ADMIN.email }); sends += dispatched("platform").length; }
      eq(`platform ${kind.name}: five one after another all send, with five claims and five rows`, [sends, claimsOfPlatform().length, outcomesOfPlatform(kind.platformEvent).filter((r) => r.status === "sent").length], [5, 5, 5]);
      const sixthAdmin = jobLines(await one(kind, { email: ADMIN.email }));
      // A code's account limit is read on its code rows first; a link's in the sender, which writes one refused row.
      eq(`platform ${kind.name}: the sixth is refused for the account, with no claim and no send`,
        [dispatched("platform").length, claimsOfPlatform().length, outcomesOfPlatform(kind.platformEvent).filter((r) => r.status === "refused").map((r) => r.error_code), sixthAdmin.map((l) => l.code ?? l.outcome)],
        [0, 5, kind === CODE ? [] : ["account_limit"], ["account_limit"]]);
    }

    console.log("\nthe platform sender alone: one account, one kind (60 at once)");
    {
      base({ smtpDelayMs: 200 });
      const to = { userId: ADMIN.id, email: ADMIN.email, platformOwner: false };
      const req: PlatformSendRequest<"platform_sign_in_link"> = { event: "platform_sign_in_link", to, organizationId: ORG, content: { link: LINK, minutes: 60 } };
      requests.length = 0;
      const { value: results } = await captureLogs(() => Promise.all(Array.from({ length: 60 }, () => sendPlatformEmail(req, { db, env: PLATFORM_ENV }))));
      eq("60 at once: at most 5 sends", [dispatched("platform").length <= 5, results.filter((r) => r.status === "sent").length <= 5], [true, true]);
      eq("…the rest are refused for the account, never sent", results.every((r) => r.status === "sent" || (r.status === "refused" && r.errorCode === "account_limit")), true);
      base({ smtpDelayMs: 1500 });
      requests.length = 0;
      const spaced: Array<Promise<unknown>> = [];
      await captureLogs(async () => {
        for (let i = 0; i < 10; i++) {
          spaced.push(sendPlatformEmail(req, { db, env: PLATFORM_ENV }));
          await new Promise((r) => setTimeout(r, 200));
        }
        await Promise.all(spaced);
      });
      eq("one request every 200 ms while a send takes 1.5 s: at most 5 sends", dispatched("platform").length <= 5, true);
    }

    console.log("\nthe two public routes, one administrator's address (40 jobs at once)");
    for (const kind of KINDS) {
      base();
      // An older code, still open, from before.
      if (kind === CODE) world.otps.push({ id: "otp-older", email: ADMIN.email, code_hash: hashOtp("111111"), created_at: ago(30 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      const { answers } = await together(kind, Array.from({ length: 40 }, () => ({ email: ADMIN.email })));
      eq(`${kind.name}: every answer is the same 200`, answers.every((a) => a.status === 200 && a.body === answers[0].body), true);
      eq(`${kind.name}: at most 5 mails go`, [dispatched("platform").length <= 5, outcomesOfPlatform(kind.platformEvent).filter((r) => r.status === "sent").length <= 5], [true, true]);
      if (kind === CODE) {
        const sentHashes = new Set(mailedCodes().map((c) => hashOtp(c)));
        eq("…every new open code row belongs to a request whose mail went", openCodes(ADMIN.email).filter((r) => r.id !== "otp-older").every((r) => sentHashes.has(String(r.code_hash))), true);
      }
    }
    {
      // One request first, then 39 at once, so that some go: the code rows they leave.
      base();
      world.otps.push({ id: "otp-older", email: ADMIN.email, code_hash: hashOtp("111111"), created_at: ago(30 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await firstThenTogether(CODE, Array.from({ length: 40 }, () => ({ email: ADMIN.email })));
      const sentHashes = new Set(mailedCodes().map((c) => hashOtp(c)));
      const open = openCodes(ADMIN.email);
      const byTime = (a: Row, b: Row) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at));
      const passed = world.otps.filter((r) => sentHashes.has(String(r.code_hash))).sort(byTime);
      eq("one code request, then 39 at once: at most 5 go, and some do (non-vacuous)", [dispatched("platform").length <= 5, passed.length > 0], [true, true]);
      eq("…every open code row belongs to a request whose mail went, never to one that was refused", open.every((r) => sentHashes.has(String(r.code_hash))), true);
      eq("…the newest open row, which the verify step reads, is the newest request's that passed", [...open].sort(byTime)[0]?.id === passed[0]?.id, true);
      eq("…the older code was closed once a newer one opened", world.otps.find((r) => r.id === "otp-older")?.used_at !== null, true);
    }
    {
      // Every request made together is refused (the ceiling is used up): the older code stays open.
      base();
      seedPlatform(375, { event_type: "platform_admin_welcome", organization_id: OTHER_ORG, to_user_id: id(900), status: "sent" }, () => 30 * MIN);
      world.otps.push({ id: "otp-older", email: ADMIN.email, code_hash: hashOtp("222222"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await together(CODE, Array.from({ length: 40 }, () => ({ email: ADMIN.email })));
      eq("all refused by the ceiling: nothing sent, no new code open, and the older code still open",
        [dispatched("platform").length, openCodes(ADMIN.email).map((r) => r.id)], [0, ["otp-older"]]);
    }

    console.log("\none account's requests one after another on a moved clock: the eleventh in the day is refused");
    for (const kind of KINDS) {
      base();
      const clock = fakeClock();
      try {
        const outcomes: string[] = [];
        for (let i = 0; i < 11; i++) {
          const lines = jobLines(await one(kind, { email: LEARNER.email, orgSlug: SLUG }));
          outcomes.push(lines.map((l) => l.outcome).join(","));
          clock.move(13 * MIN); // never more than five in an hour
        }
        eq(`tenant ${kind.name}: ten go, one every 13 minutes; the eleventh is refused for the day`, outcomes, [...Array(10).fill("sent"), "account_limit"]);
      } finally {
        clock.restore();
      }
      base();
      const clock2 = fakeClock();
      try {
        const outcomes: string[] = [];
        for (let i = 0; i < 11; i++) {
          const lines = jobLines(await one(kind, { email: ADMIN.email }));
          outcomes.push(lines.map((l) => l.code ?? l.outcome).join(","));
          clock2.move(13 * MIN);
        }
        eq(`platform ${kind.name}: the same`, outcomes, [...Array(10).fill("sent"), "account_limit"]);
      } finally {
        clock2.restore();
      }
    }

    console.log("\nan organisation's share and the ceiling, many accounts at once");
    {
      base();
      seedPlatform(47, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: id(901), status: "sent" }, () => 60 * MIN);
      const { lines } = await together(LINK_KIND, ADMINS.map((a) => ({ email: a.email })));
      const orgSent = () => platformRowsOf((r) => r.organization_id === ORG && r.status === "sent" && (r.event_type === "platform_sign_in_link" || r.event_type === "platform_reset_code")).length;
      eq("40 administrators of one organisation, 3 short of its share of 50: no more than 3 go", [dispatched("platform").length <= 3, orgSent() <= 50], [true, true]);
      eq("…the others are refused by the share (non-vacuous: the claims were counted)", jobLines(lines).some((l) => l.code === "org_limit"), true);
      base();
      seedPlatform(372, { event_type: "platform_admin_welcome", organization_id: OTHER_ORG, to_user_id: id(902), status: "sent" }, () => 60 * MIN);
      const ceiling = await withEnv({ PLATFORM_EMAIL_ORG_DAILY_LIMIT: "1000" }, () => together(LINK_KIND, ADMINS.map((a) => ({ email: a.email }))));
      eq("40 administrators, the platform 3 short of its ceiling of 375: no more than 3 go", [dispatched("platform").length <= 3, platformRowsOf((r) => r.status === "sent").length <= 375], [true, true]);
      eq("…the others are refused by the ceiling", jobLines(ceiling.lines).some((l) => l.code === "ceiling"), true);
    }

    console.log("\none learner on an organisation's page (40 jobs at once)");
    for (const kind of KINDS) {
      base();
      if (kind === CODE) world.otps.push({ id: "otp-older", email: LEARNER.email, code_hash: hashOtp("333333"), created_at: ago(30 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await together(kind, Array.from({ length: 40 }, () => ({ email: LEARNER.email, orgSlug: SLUG })));
      eq(`${kind.name}: at most 5 go through the organisation's SMTP`, [dispatched("tenant").length <= 5, tenantSent(kind.tenantEvent).length <= 5], [true, true]);
      if (kind === CODE) {
        const sentHashes = new Set(mailedCodes().map((c) => hashOtp(c)));
        eq("…every new open code row is one that was mailed", openCodes(LEARNER.email).filter((r) => r.id !== "otp-older").every((r) => sentHashes.has(String(r.code_hash))), true);
      }
    }

    console.log("\nthe organisation's daily limit (one learner, and 40 different learners)");
    {
      base({ sent24h: 370 });
      await together(LINK_KIND, Array.from({ length: 40 }, () => ({ email: LEARNER.email, orgSlug: SLUG })));
      eq("one learner, 40 jobs, 370 of 375 sent: at most 5 go", dispatched("tenant").length <= 5, true);
      base({ sent24h: 370 });
      const { lines } = await together(LINK_KIND, LEARNERS.map((l) => ({ email: l.email, orgSlug: SLUG })));
      const sentCount = dispatched("tenant").length;
      eq("40 different learners, the organisation 5 short of its limit: at most 5 go", [sentCount <= 5, world.sent24h + tenantSent("magic_link").length <= 375], [true, true]);
      const notSent = jobLines(lines).filter((l) => l.outcome !== "sent");
      eq("…the rest read daily_limit", [notSent.length, notSent.every((l) => l.outcome === "daily_limit" || l.code === "daily_limit")], [40 - sentCount, true]);
      base({ sent24h: 370 });
      const codes = await together(CODE, LEARNERS.map((l) => ({ email: l.email, orgSlug: SLUG })));
      eq("…the same for codes: at most 5 go, the rest read daily_limit", [dispatched("tenant").length <= 5, jobLines(codes.lines).filter((l) => l.outcome !== "sent").every((l) => l.outcome === "daily_limit" || l.code === "daily_limit")], [true, true]);
    }

    console.log("\nthe claims of one account count as five: another account still goes");
    {
      base();
      seedPlatform(44, { event_type: "platform_reset_code", organization_id: ORG, to_user_id: id(903), status: "sent" }, () => 60 * MIN);
      seedPlatform(400, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_X.id, status: "suppressed", error_code: "pending" }, () => 30_000);
      await one(LINK_KIND, { email: ADMIN_Y.email });
      eq("platform: 400 claims of one administrator in flight, the share 6 short: another administrator's link goes", dispatched("platform").length, 1);
      base({ dailyLimit: 30, sent24h: 24 });
      seedTenant(400, { event_type: "magic_link", to_user_id: LEARNER_X.id, status: "queued", error: "claim" }, () => 30_000);
      await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG });
      eq("tenant: 400 claims of one learner in flight, the daily limit 6 short: another learner's link goes", dispatched("tenant").length, 1);
    }

    console.log("\na full page of claims in flight cannot be counted, and nothing is sent");
    {
      base();
      for (let a = 0; a < CLAIMS_IN_FLIGHT_PAGE / 5; a++) seedPlatform(5, { event_type: "platform_sign_in_link", organization_id: OTHER_ORG, to_user_id: id(10_000 + a), status: "suppressed", error_code: "pending" }, () => 30_000);
      const pl = jobLines(await one(LINK_KIND, { email: ADMIN.email }));
      eq("platform: a page of 1,000 claims back reads as a limit that cannot be read: nothing sent", [dispatched("platform").length, pl.map((l) => l.code)], [0, ["log_unreadable"]]);
      base();
      for (let a = 0; a < CLAIMS_IN_FLIGHT_PAGE / 5; a++) seedTenant(5, { event_type: "magic_link", to_user_id: id(20_000 + a), status: "queued", error: "claim" }, () => 30_000);
      const tl = jobLines(await one(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG }));
      eq("tenant: a page of 1,000 claims back reads as the daily limit reached: not attempted", [dispatched("tenant").length, tl.map((l) => l.outcome)], [0, ["daily_limit"]]);
    }

    console.log("\na claim older than two minutes with no outcome");
    {
      base();
      seedPlatform(49, { event_type: "platform_reset_code", organization_id: ORG, to_user_id: id(904), status: "sent" }, () => 60 * MIN);
      seedPlatform(1, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_X.id, status: "suppressed", error_code: "pending" }, () => 3 * MIN);
      await one(LINK_KIND, { email: ADMIN_Y.email });
      eq("platform: no longer in flight (the share's last place still goes)", dispatched("platform").length, 1);
      base();
      seedPlatform(5, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_Y.id, status: "suppressed", error_code: "pending" }, (i) => 3 * MIN + i * MIN);
      const lines = jobLines(await one(LINK_KIND, { email: ADMIN_Y.email }));
      eq("…and still a request for its hour (five such claims: refused)", [dispatched("platform").length, lines.map((l) => l.code)], [0, ["account_limit"]]);
      base({ dailyLimit: 30, sent24h: 29 });
      seedTenant(1, { event_type: "magic_link", to_user_id: LEARNER_X.id, status: "queued", error: "claim" }, () => 3 * MIN);
      await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG });
      eq("tenant: no longer in flight (the day's last place still goes)", dispatched("tenant").length, 1);
      base();
      seedTenant(5, { event_type: "magic_link", to_user_id: LEARNER_Y.id, status: "queued", error: "claim" }, (i) => 3 * MIN + i * MIN);
      const tl = jobLines(await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG }));
      eq("…and still a request for its hour", [dispatched("tenant").length, tl.map((l) => l.outcome)], [0, ["account_limit"]]);
    }

    console.log("\na job that reaches its send more than 30 s after its claim sends nothing");
    {
      const late = async (kind: Kind, payload: Row, when: (r: Req) => boolean) => {
        const clock = fakeClock();
        world.onRequest = (r) => { if (when(r)) clock.move(CLAIM_SEND_WITHIN_MS + 1_000); };
        try {
          return jobLines(await one(kind, payload));
        } finally {
          world.onRequest = null;
          clock.restore();
        }
      };
      const mint = (r: Req) => r.path === "/auth/v1/admin/generate_link";
      base();
      let lines = await late(LINK_KIND, { email: ADMIN.email }, mint);
      eq("platform link: nothing sent, no outcome row, one claim_stale line", [dispatched("platform").length, outcomesOfPlatform("platform_sign_in_link").length, lines.map((l) => l.outcome)], [0, 0, ["claim_stale"]]);
      base();
      lines = await late(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG }, mint);
      eq("tenant link: nothing sent, no outcome row, one claim_stale line", [dispatched("tenant").length, tenantSent("magic_link").length, lines.map((l) => l.outcome)], [0, 0, ["claim_stale"]]);
      const claimWrite = (table: string) => (r: Req) => r.table === table && r.method === "POST" && ((r.body as Row).status === "queued" || (r.body as Row).error_code === "pending");
      base();
      world.otps.push({ id: "otp-older", email: LEARNER.email, code_hash: hashOtp("444444"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      lines = await late(CODE, { email: LEARNER.email, orgSlug: SLUG }, claimWrite("notification_log"));
      eq("tenant code: nothing sent, the new row never opened, the older code still open", [dispatched("tenant").length, openCodes(LEARNER.email).map((r) => r.id), lines.map((l) => l.outcome)], [0, ["otp-older"], ["claim_stale"]]);
      base();
      world.otps.push({ id: "otp-older", email: ADMIN.email, code_hash: hashOtp("555555"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      lines = await late(CODE, { email: ADMIN.email }, claimWrite("platform_email_log"));
      eq("platform code: the same", [dispatched("platform").length, openCodes(ADMIN.email).map((r) => r.id), lines.map((l) => l.outcome)], [0, ["otp-older"], ["claim_stale"]]);
    }

    console.log("\na claim that cannot be written, or a count after it that cannot be read, sends nothing");
    for (const kind of KINDS) {
      base({ writeFailing: new Set(["platform_email_log"]) });
      let lines = jobLines(await one(kind, { email: ADMIN.email }));
      eq(`platform ${kind.name}: the claim cannot be written: nothing sent, no row`, [dispatched("platform").length, world.platformLog.length, lines.map((l) => l.code)], [0, 0, ["log_unreadable"]]);
      base({ failRead: (r) => r.table === "platform_email_log" && r.query.get("error_code") === "eq.pending" });
      lines = jobLines(await one(kind, { email: ADMIN.email }));
      eq(`platform ${kind.name}: the claims in flight cannot be read: nothing sent, the claim the only row`, [dispatched("platform").length, world.platformLog.map((r) => r.error_code), lines.map((l) => l.code)], [0, ["pending"], ["log_unreadable"]]);
      base({ writeFailing: new Set(["notification_log"]) });
      const all = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
      lines = jobLines(all);
      eq(`tenant ${kind.name}: the claim cannot be written: nothing sent, one fixed line with its code`,
        [dispatched("tenant").length, lines.map((l) => l.outcome), all.some((l) => l.includes('"step":"claim_failed"') && l.includes('"code":"XX000"'))], [0, ["claim_failed"], true]);
    }
    {
      let reads = 0;
      base({ failRead: (r) => r.table === "notification_log" && r.query.get("status") === "eq.queued" && r.query.has("to_user_id") && ++reads === 2 });
      const lines = jobLines(await one(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG }));
      eq("tenant link: the account's count after the claim cannot be read: nothing minted or sent", [dispatched("tenant").length, requests.filter((r) => r.path === "/auth/v1/admin/generate_link").length, lines.map((l) => l.outcome)], [0, 0, ["limit_read_failed"]]);
      for (const kind of KINDS) {
        let statusReads = 0;
        base({ dailyLimit: 30, sent24h: 29, failRead: (r) => r.table === "rpc/tenant_mail_status" && ++statusReads === 2 });
        seedTenant(5, { event_type: "magic_link", to_user_id: LEARNER_X.id, status: "queued", error: "claim" }, () => 20_000);
        const all = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
        eq(`tenant ${kind.name}: the status read again after the claim fails: sent without the daily limit, and its class logged`,
          [dispatched("tenant").length, all.some((l) => l.includes('"event":"credential_claim"') && l.includes('"step":"status_unread"'))], [1, true]);
        base({ dailyLimit: 30, sent24h: 29, failRead: (r) => r.table === "notification_log" && r.query.get("organization_id") === `eq.${ORG}` && r.query.get("status") === "eq.queued" });
        seedTenant(5, { event_type: "magic_link", to_user_id: LEARNER_X.id, status: "queued", error: "claim" }, () => 20_000);
        const all2 = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
        eq(`tenant ${kind.name}: the claims in flight cannot be read: the same, with their class`,
          [dispatched("tenant").length, all2.some((l) => l.includes('"event":"credential_claim"') && l.includes('"step":"claims_unread"'))], [1, true]);
        base({ dailyLimit: 30, sent24h: 29 });
        seedTenant(5, { event_type: "magic_link", to_user_id: LEARNER_X.id, status: "queued", error: "claim" }, () => 20_000);
        const lines3 = jobLines(await one(kind, { email: LEARNER.email, orgSlug: SLUG }));
        eq(`tenant ${kind.name}: …the control: with both read, the claims in flight fill the day, and it is not attempted`, [dispatched("tenant").length, lines3.map((l) => l.outcome)], [0, ["daily_limit"]]);
      }
    }

    console.log("\na reset code's row: written closed, opened only after every limit and claim");
    {
      base();
      world.otps.push({ id: "otp-older", email: LEARNER.email, code_hash: hashOtp("666666"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await one(CODE, { email: LEARNER.email, orgSlug: SLUG });
      const idx = (pred: (r: Req) => boolean) => requests.findIndex(pred);
      const written = idx((r) => r.table === "password_reset_otps" && r.method === "POST");
      const claim = idx((r) => r.table === "notification_log" && r.method === "POST" && (r.body as Row).status === "queued");
      const opened = idx((r) => r.table === "password_reset_otps" && r.method === "PATCH" && (r.body as Row).used_at === null);
      const closedOlder = idx((r) => r.table === "password_reset_otps" && r.method === "PATCH" && r.query.has("created_at"));
      const sent = idx((r) => r.path === "/functions/v1/send-smtp");
      eq("the row is written closed, then the claim, then it is opened, then the older codes are closed, then the send",
        [typeof (requests[written]?.body as Row | undefined)?.used_at, written < claim, claim < opened, opened < closedOlder, closedOlder < sent], ["string", true, true, true, true]);
      eq("…the new code is the one open; the older one is closed", openCodes(LEARNER.email).map((r) => r.id === "otp-older"), [false]);
      base({ dailyLimit: 30, sent24h: 29 });
      seedTenant(5, { event_type: "password_reset", to_user_id: LEARNER_X.id, status: "queued", error: "claim" }, () => 20_000);
      world.otps.push({ id: "otp-older", email: LEARNER.email, code_hash: hashOtp("777777"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await one(CODE, { email: LEARNER.email, orgSlug: SLUG });
      eq("a request its claim refuses: its row stays closed, and the older code stays open", [dispatched("tenant").length, openCodes(LEARNER.email).map((r) => r.id), world.otps.length], [0, ["otp-older"], 2]);
      base();
      world.otps.push({ id: "otp-older", email: ADMIN.email, code_hash: hashOtp("888888"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await withEnv({ PLATFORM_SMTP_HOST: undefined }, () => one(CODE, { email: ADMIN.email }));
      eq("the platform sender not configured: no code opened, none closed; the claim and the not_configured row",
        [openCodes(ADMIN.email).map((r) => r.id), world.platformLog.map((r) => [r.status, r.error_code])], [["otp-older"], [["suppressed", "pending"], ["failed", "not_configured"]]]);
    }

    console.log("\nthe sender's two halves");
    {
      base();
      const to = { userId: ADMIN.id, email: ADMIN.email, platformOwner: false };
      const req: PlatformSendRequest<"platform_sign_in_link"> = { event: "platform_sign_in_link", to, organizationId: ORG, content: { link: LINK, minutes: 60 } };
      const claimed = await claimPlatformSend(req, { db, env: PLATFORM_ENV });
      const r = claimed.claimed ? await sendPlatformEmail(req, { db, env: PLATFORM_ENV, claim: claimed.claim }) : null;
      eq("a claim handed to the sender: it does not claim again (one claim, one outcome)", [r?.status, claimsOfPlatform().length, outcomesOfPlatform("platform_sign_in_link").length], ["sent", 1, 1]);
      if (claimed.claimed) {
        for (const [label, claim] of [
          ["another event", { ...claimed.claim, event: "platform_reset_code" as const }],
          ["another account", { ...claimed.claim, userId: ADMIN_X.id }],
          ["another organisation", { ...claimed.claim, organizationId: OTHER_ORG }],
        ] as const) {
          requests.length = 0;
          let threw = "no throw";
          try { await sendPlatformEmail(req, { db, env: PLATFORM_ENV, claim }); } catch (e) { threw = e instanceof TypeError ? "TypeError" : String(e); }
          eq(`a claim naming ${label} throws before anything is read`, [threw, requests.length], ["TypeError", 0]);
        }
      }
      base();
      const clock = fakeClock();
      try {
        const c = await claimPlatformSend(req, { db, env: PLATFORM_ENV });
        clock.move(CLAIM_SEND_WITHIN_MS + 1);
        requests.length = 0;
        const { value } = await captureLogs(async () => (c.claimed ? sendPlatformEmail(req, { db, env: PLATFORM_ENV, claim: c.claim }) : null));
        eq("a claim older than 30 s: claim_stale, nothing sent, no row", [value, dispatched("platform").length, outcomesOfPlatform("platform_sign_in_link").length], [{ status: "failed", errorCode: "claim_stale", logged: false }, 0, 0]);
      } finally {
        clock.restore();
      }
      // Four claims in the hour; another request claims at the same moment as this one.
      base();
      seedPlatform(4, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN.id, status: "suppressed", error_code: "pending" }, () => 50 * MIN);
      const alongside = (table: string, row: Row) => (q: Req) => {
        if (q.table === table && q.method === "POST" && ((q.body as Row).error_code === "pending" || (q.body as Row).status === "queued") && !world.platformLog.concat(world.log).some((r) => r.id === "alongside")) {
          (table === "platform_email_log" ? world.platformLog : world.log).push({ id: "alongside", ...row, sent_at: new Date(Date.now()).toISOString() });
        }
      };
      world.onRequest = alongside("platform_email_log", { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN.id, status: "suppressed", error_code: "pending" });
      const counted = await captureLogs(() => claimPlatformSend(req, { db, env: PLATFORM_ENV }));
      world.onRequest = null;
      eq("platform: the count after the claim finds the account past its limit: refused, the claim its only row",
        [counted.value.claimed ? "claimed" : counted.value.result, platformRowsOf((r) => r.status === "refused").length], [{ status: "refused", errorCode: "account_limit", logged: false }, 0]);
      base();
      seedTenant(4, { event_type: "magic_link", to_user_id: LEARNER.id, status: "queued", error: "claim" }, () => 50 * MIN);
      world.onRequest = alongside("notification_log", { organization_id: ORG, event_type: "magic_link", to_user_id: LEARNER.id, status: "queued", error: "claim" });
      const tl = jobLines(await one(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG }));
      world.onRequest = null;
      eq("tenant: the same for a link: nothing minted or sent, no row past the claim",
        [tl.map((l) => l.outcome), requests.filter((r) => r.path === "/auth/v1/admin/generate_link").length, dispatched("tenant").length, world.log.filter((r) => r.status !== "queued").length], [["account_limit"], 0, 0, 0]);
    }

    console.log("\nthe welcome, the alert and the test write no claim");
    {
      base();
      const welcome = await sendPlatformEmail(
        { event: "platform_admin_welcome", to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: false }, organizationId: ORG, content: { organizationName: "Tenant A", signInUrl: "https://lms.stub/tenant-a/login", role: "admin", setupLink: `https://lms.stub/auth/set-password#t=${"S".repeat(43)}`, days: 7 } },
        { db, env: PLATFORM_ENV }
      );
      const test = await sendPlatformEmail({ event: "platform_test", to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: true }, organizationId: null, content: {} }, { db, env: PLATFORM_ENV });
      eq("a welcome and a test: sent, one row each, no claim", [welcome.status, test.status, world.platformLog.map((r) => r.status), claimsOfPlatform().length], ["sent", "sent", ["sent", "sent"], 0]);
      base();
      seedPlatform(374, { event_type: "platform_admin_welcome", organization_id: OTHER_ORG, to_user_id: id(905), status: "sent" }, () => 60 * MIN);
      for (const a of ADMINS.slice(0, 20)) seedPlatform(3, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: a.id, status: "suppressed", error_code: "pending" }, () => 10_000);
      const alert = await sendPlatformEmail(
        { event: "tenant_smtp_alert", to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: false }, organizationId: ORG, content: { organizationName: "Tenant A", settingsUrl: "https://lms.stub/tenant-a/settings?tab=smtp", reading: "failing", errorClass: "auth" } },
        { db, env: PLATFORM_ENV }
      );
      eq("an alert goes while other accounts' claims fill the ceiling's count, and writes no claim", [alert.status, claimsOfPlatform().length], ["sent", 60]);
    }

    console.log("\nthe calls before the answer are the same for a known and an unknown address");
    for (const kind of KINDS) {
      base();
      const known = await ask(kind.route, kind.path, { email: LEARNER.email, orgSlug: SLUG });
      const unknown = await ask(kind.route, kind.path, { email: UNKNOWN, orgSlug: SLUG });
      eq(`${kind.name}, an organisation's page: the lookup, the organisation, its settings, its row and tenant_mail_status, alike`,
        [known.calls.map((c) => c.split("?")[0]).sort(), JSON.stringify(known.calls) === JSON.stringify(unknown.calls), known.body === unknown.body],
        [["GET /auth/v1/admin/users", "GET /rest/v1/notification_settings", "GET /rest/v1/organizations", "GET /rest/v1/organizations", "POST /rest/v1/rpc/tenant_mail_status"].sort(), true, true]);
      const knownAdmin = await ask(kind.route, kind.path, { email: ADMIN.email });
      const unknownNoOrg = await ask(kind.route, kind.path, { email: UNKNOWN });
      eq(`${kind.name}, the page with no organisation: the lookup alone, alike`,
        [knownAdmin.calls.map((c) => c.split("?")[0]), JSON.stringify(knownAdmin.calls) === JSON.stringify(unknownNoOrg.calls), knownAdmin.body === unknownNoOrg.body], [["GET /auth/v1/admin/users"], true, true]);
      eq("…every claim is in the job after the answer: nothing is written before it", [...known.calls, ...knownAdmin.calls].some((c) => !c.startsWith("GET ") && !c.includes("rpc/tenant_mail_status")), false);
    }

    console.log("\na database without 0114, each fallback on its own");
    for (const kind of KINDS) {
      base({ status: "missing", sent24h: 100_000 });
      await together(kind, Array.from({ length: 40 }, () => ({ email: LEARNER.email, orgSlug: SLUG })));
      eq(`no tenant_mail_status: the account limit still holds for ${kind.name}s (at most 5 of 40 at once)`, dispatched("tenant").length <= 5, true);
      base({ status: "missing", sent24h: 100_000 });
      await firstThenTogether(kind, Array.from({ length: 40 }, () => ({ email: LEARNER.email, orgSlug: SLUG })));
      eq(`…and of one, then 39 at once: at most 5, and some go`, [dispatched("tenant").length <= 5, dispatched("tenant").length >= 1], [true, true]);
      base({ status: "missing", sent24h: 100_000 });
      await one(kind, { email: LEARNER.email, orgSlug: SLUG });
      eq(`…and no daily limit is applied: one ${kind.name} goes`, dispatched("tenant").length, 1);
      base({ jobMark: "missing" });
      await together(kind, Array.from({ length: 40 }, () => ({ email: LEARNER.email, orgSlug: SLUG })));
      eq(`no mail_job_mark: the claims hold all the same (at most 5 ${kind.name}s)`, dispatched("tenant").length <= 5, true);
      base({ logCheck: "no_queued" });
      const all = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
      eq(`a notification_log check without the word queued: no ${kind.name} made or sent, one fixed line with the error's code`,
        [dispatched("tenant").length, requests.filter((r) => r.path === "/auth/v1/admin/generate_link").length, openCodes(LEARNER.email).length, all.filter((l) => l.includes('"event":"credential_claim"') && l.includes('"code":"23514"')).length],
        [0, 0, 0, 1]);
    }

    console.log("\nno log line holds an address or a user id");
    {
      base({ sent24h: 370 });
      const a = await together(LINK_KIND, LEARNERS.slice(0, 10).map((l) => ({ email: l.email, orgSlug: SLUG })));
      base();
      const b = await together(CODE, Array.from({ length: 10 }, () => ({ email: ADMIN.email })));
      const lines = [...a.lines, ...b.lines];
      const ids = [ADMIN, LEARNER, ...LEARNERS].map((p) => p.id);
      eq(`non-vacuous: lines were written (${lines.length})`, lines.length > 10, true);
      eq("no line holds an address or a user id", lines.filter((l) => /[^\s"']+@[^\s"']+\.stub/.test(l) || ids.some((x) => l.includes(x))), []);
    }
  } finally {
    uninstall();
  }
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
