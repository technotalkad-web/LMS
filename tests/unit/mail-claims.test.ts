/**
 * Each limit on a public reset code or sign-in link is claimed before the
 * send (ADR 0029, the notes of 2026-11-22): a job writes its claim, then
 * counts its account's requests with its own claim among them, and goes on
 * only within the account's limit. Only a request that passed its
 * account's count writes its in-flight row, and the shares count the rows
 * sent and the in-flight rows, never a claim. So the limits hold under
 * concurrent requests:
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
 * Each account count is exact (a count of the claims its limit names, with
 * no page), and the account limits hold hour after hour on a moved clock: at
 * the limit, a burst of requests at once, then requests one by one. The
 * in-flight rows of one account and kind are at most five, however many of
 * its requests run at once, and requests for one account never hold back
 * another account's code or link: its claims count against nobody else.
 *
 * Also: the shared times and the word; each path's rows in order; a reset
 * code's row written closed and opened only after every limit, and only a
 * send that was attempted closes the address's older codes; a claim older
 * than the send window sends nothing; a claim, an in-flight row or a count
 * that cannot be written or read sends nothing on the platform, and on a
 * tenant in-flight rows that cannot be counted are no reading of the daily
 * limit; the fallbacks of a database without 0114, each on its own; the
 * welcome, the alert and the test write no claim; the calls before the
 * answer are the same for a known and an unknown address.
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
import { CLAIM_IN_FLIGHT_MS, CLAIM_SEND_WITHIN_MS, IN_FLIGHT_WORD, SMTP_SEND_WAIT_MS, accountRequests } from "../../lib/email/smtp-function";
import { claimPlatformSend, sendPlatformEmail, type PlatformSendRequest } from "../../lib/email/platform-sender";
import { hashOtp } from "../../lib/auth/password-reset";

const id = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = { id: id(1), email: "admin@tenant.stub" };
const LEARNER = { id: id(2), email: "learner@tenant.stub" };
const ADMIN_X = { id: id(3), email: "admin-x@tenant.stub" };
const ADMIN_Y = { id: id(4), email: "admin-y@tenant.stub" };
const LEARNER_X = { id: id(5), email: "learner-x@tenant.stub" };
const LEARNER_Y = { id: id(6), email: "learner-y@tenant.stub" };
/** An administrator of the other organisation. */
const ADMIN_B = { id: id(7), email: "admin-b@tenant-b.stub" };
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

/** Every account the tests use, as members of the organisation, and one administrator of the other. */
function base(over: Parameters<typeof freshWorld>[0] = {}) {
  const people = [ADMIN, LEARNER, ADMIN_X, ADMIN_Y, LEARNER_X, LEARNER_Y, ...ADMINS, ...LEARNERS];
  const role = (p: { id: string }) => ([ADMIN, ADMIN_X, ADMIN_Y].some((a) => a.id === p.id) || ADMINS.some((a) => a.id === p.id) ? "admin" : "user");
  freshWorld({
    users: [...people, ADMIN_B].map((p) => ({ id: p.id, email: p.email })),
    members: [
      ...people.map((p) => ({ organization_id: ORG, user_id: p.id, role: role(p), status: "active" })),
      { organization_id: OTHER_ORG, user_id: ADMIN_B.id, role: "admin", status: "active" },
    ],
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
const isPlatformClaim = (r: Row) => r.status === "suppressed" && r.error_code === "pending";
const isPlatformInFlight = (r: Row) => r.status === "suppressed" && r.error_code === IN_FLIGHT_WORD;
const claimsOfPlatform = () => platformRowsOf(isPlatformClaim);
const inFlightOfPlatform = (userId?: string, event?: string) => platformRowsOf((r) => isPlatformInFlight(r) && (!userId || r.to_user_id === userId) && (!event || r.event_type === event));
const outcomesOfPlatform = (event: string) => platformRowsOf((r) => r.event_type === event && !isPlatformClaim(r) && !isPlatformInFlight(r));
const tenantClaims = (event: string) => world.log.filter((r) => r.event_type === event && r.status === "queued" && r.error === "claim");
const tenantInFlight = (event?: string, userId?: string) => world.log.filter((r) => r.status === "queued" && r.error === IN_FLIGHT_WORD && (!event || r.event_type === event) && (!userId || r.to_user_id === userId));
const tenantSent = (event: string) => world.log.filter((r) => r.event_type === event && r.status === "sent");
const dailyLimitRows = () => world.log.filter((r) => r.error === "daily_limit");
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

/** One request: its answer, then the jobs it hands over (run by the caller). */
type Ask = () => Promise<Array<() => unknown>>;
/** A burst at the limit: this many requests at once for one account. */
const BURST = 150;
const HOURS = 3;
/** The requests at once for one account in the cases where another account's mail must still go. */
const AT_ONCE = 1200;

/**
 * Hour after hour on a moved clock (61 minutes apart, so all of them lie
 * inside one day): five requests one after another (the hour's limit), then
 * BURST requests at once, then ten more one after another. Answers what was
 * sent in each hour, what the first five sent, and, for the first burst,
 * how many jobs ran and what they sent.
 */
async function hourAfterHour(asked: Ask, sent: () => number): Promise<{ perHour: number[]; firstFive: number; burstJobs: number; burstSent: number }> {
  const clock = fakeClock();
  const perHour: number[] = [];
  let firstFive = 0;
  let burstJobs = 0;
  let burstSent = 0;
  const oneByOne = async (n: number) => {
    for (let i = 0; i < n; i++) for (const job of await asked()) await job();
  };
  try {
    await captureLogs(async () => {
      for (let h = 0; h < HOURS; h++) {
        if (h > 0) clock.move(61 * 60_000);
        const before = sent();
        await oneByOne(5);
        if (h === 0) firstFive = sent() - before;
        const jobs: Array<() => unknown> = [];
        for (let i = 0; i < BURST; i++) jobs.push(...(await asked()));
        const beforeBurst = sent();
        await Promise.all(jobs.map((j) => j()));
        if (h === 0) {
          burstJobs = jobs.length;
          burstSent = sent() - beforeBurst;
        }
        await oneByOne(10);
        perHour.push(sent() - before);
      }
    });
  } finally {
    clock.restore();
  }
  return { perHour, firstFive, burstJobs, burstSent };
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
/** A platform request that passed its account's count: its claim and its in-flight row. */
const seedPlatformPassed = (n: number, row: Row, msAgo: (i: number) => number) => {
  seedPlatform(n, { ...row, status: "suppressed", error_code: "pending" }, msAgo);
  seedPlatform(n, { ...row, status: "suppressed", error_code: IN_FLIGHT_WORD }, msAgo);
};
/** A tenant link that passed its account's count: its claim and its in-flight row. */
const seedTenantPassed = (n: number, row: Row, msAgo: (i: number) => number) => {
  seedTenant(n, { ...row, status: "queued", error: "claim" }, msAgo);
  seedTenant(n, { ...row, status: "queued", error: IN_FLIGHT_WORD }, msAgo);
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

    console.log("\nthe times and the word");
    {
      eq("a send starts within 30 s of its claim; an in-flight row counts for two minutes", [CLAIM_SEND_WITHIN_MS, CLAIM_IN_FLIGHT_MS], [30_000, 120_000]);
      eq("…two minutes cover the start, the send's own wait and a minute for the outcome's row and two clocks", CLAIM_IN_FLIGHT_MS >= CLAIM_SEND_WITHIN_MS + SMTP_SEND_WAIT_MS + 60_000, true);
      eq("one word for an in-flight row, in both systems", IN_FLIGHT_WORD, "in_flight");
      const at = Date.now();
      const byWindow = (sinceIso: string) => Promise.resolve({ count: at - Date.parse(sinceIso) > 2 * 3_600_000 ? 9 : 4, error: null });
      eq("an account's requests: two exact counts, the hour's and the day's", await accountRequests(byWindow, at, true), { hour: 4, day: 9 });
      eq("…with the hourly limit alone, the day is not read", await accountRequests(byWindow, at, false), { hour: 4, day: null });
      const unread = [
        await accountRequests(() => Promise.resolve({ count: null, error: { code: "XX000" } }), at, true),
        await accountRequests(() => { throw new Error("stub"); }, at, true),
        await accountRequests(() => Promise.reject(new Error("stub")), at, true),
        await accountRequests((s) => Promise.resolve({ count: at - Date.parse(s) > 2 * 3_600_000 ? null : 4, error: null }), at, true),
      ];
      eq("…a count that fails, throws or answers no number cannot be read: null", unread, [null, null, null, null]);
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

    console.log("\neach path sends one request with its rows in order, and five one after another; the sixth is refused, counted once");
    for (const kind of KINDS) {
      const tenantRows = () => world.log.map((r) => [r.event_type, r.status, r.error]);
      const tenantOrder = kind === CODE
        ? [[kind.tenantEvent, "queued", IN_FLIGHT_WORD], [kind.tenantEvent, "sent", null]]
        : [[kind.tenantEvent, "queued", "claim"], [kind.tenantEvent, "queued", IN_FLIGHT_WORD], [kind.tenantEvent, "sent", null]];
      base();
      await one(kind, { email: LEARNER.email, orgSlug: SLUG });
      eq(`tenant ${kind.name}: one request sends: ${kind === CODE ? "its in-flight row (its claim is its closed code row)" : "its claim, its in-flight row"}, then its row`, [dispatched("tenant").length, tenantRows()], [1, tenantOrder]);
      base();
      let sends = 0;
      for (let i = 0; i < 5; i++) { await one(kind, { email: LEARNER.email, orgSlug: SLUG }); sends += dispatched("tenant").length; }
      const claimsOf = () => (kind === CODE ? world.otps.filter((r) => r.email === LEARNER.email).length : tenantClaims(kind.tenantEvent).length);
      eq(`tenant ${kind.name}: five one after another all send, with five claims, five in-flight rows and five rows`, [sends, claimsOf(), tenantInFlight(kind.tenantEvent).length, tenantSent(kind.tenantEvent).length], [5, 5, 5, 5]);
      const sixth = jobLines(await one(kind, { email: LEARNER.email, orgSlug: SLUG }));
      eq(`tenant ${kind.name}: the sixth is refused for the account, with no claim, no in-flight row and no send`, [sixth.map((l) => l.outcome), dispatched("tenant").length, claimsOf(), tenantInFlight(kind.tenantEvent).length], [["account_limit"], 0, 5, 5]);

      base();
      await one(kind, { email: ADMIN.email });
      eq(`platform ${kind.name}: one request sends: its claim, its in-flight row, then its row`, [dispatched("platform").length, world.platformLog.map((r) => [r.event_type, r.status, r.error_code])],
        [1, [[kind.platformEvent, "suppressed", "pending"], [kind.platformEvent, "suppressed", IN_FLIGHT_WORD], [kind.platformEvent, "sent", null]]]);
      base();
      sends = 0;
      for (let i = 0; i < 5; i++) { await one(kind, { email: ADMIN.email }); sends += dispatched("platform").length; }
      eq(`platform ${kind.name}: five one after another all send, with five claims, five in-flight rows and five rows`,
        [sends, claimsOfPlatform().length, inFlightOfPlatform().length, outcomesOfPlatform(kind.platformEvent).filter((r) => r.status === "sent").length], [5, 5, 5, 5]);
      const sixthAdmin = jobLines(await one(kind, { email: ADMIN.email }));
      // A code's account limit is read on its code rows first; a link's in the sender, which writes one refused row.
      eq(`platform ${kind.name}: the sixth is refused for the account, with no claim, no in-flight row and no send`,
        [dispatched("platform").length, claimsOfPlatform().length, inFlightOfPlatform().length, outcomesOfPlatform(kind.platformEvent).filter((r) => r.status === "refused").map((r) => r.error_code), sixthAdmin.map((l) => l.code ?? l.outcome)],
        [0, 5, 5, kind === CODE ? [] : ["account_limit"], ["account_limit"]]);
    }

    console.log("\nthe platform sender alone: one account, one kind (60 at once)");
    {
      base({ smtpDelayMs: 200 });
      const to = { userId: ADMIN.id, email: ADMIN.email, platformOwner: false };
      const req: PlatformSendRequest<"platform_sign_in_link"> = { event: "platform_sign_in_link", to, organizationId: ORG, content: { link: LINK, minutes: 60 } };
      requests.length = 0;
      const { value: results } = await captureLogs(() => Promise.all(Array.from({ length: 60 }, () => sendPlatformEmail(req, { db, env: PLATFORM_ENV }))));
      eq("60 at once: at most 5 sends, and at most 5 in-flight rows", [dispatched("platform").length <= 5, results.filter((r) => r.status === "sent").length <= 5, inFlightOfPlatform(ADMIN.id).length <= 5], [true, true, true]);
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
      eq(`${kind.name}: at most 5 in-flight rows for that account and kind`, inFlightOfPlatform(ADMIN.id, kind.platformEvent).length <= 5, true);
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

    console.log(`\nthe account limits hold hour after hour: at the limit, ${BURST} requests at once, then requests one by one`);
    {
      const asks = (kind: Kind, payload: Row): Ask => async () => {
        await ask(kind.route, kind.path, payload);
        return handed.splice(0);
      };
      const platformSentOf = (event: string, userId: string) => () => platformRowsOf((r) => r.event_type === event && r.to_user_id === userId && r.status === "sent").length;
      const tenantSentOf = (event: string, userId: string) => () => world.log.filter((r) => r.event_type === event && r.to_user_id === userId && r.status === "sent").length;
      const cases: Array<{ label: string; asked: Ask; sent: () => number }> = [
        { label: "platform sign-in link, one administrator, through the route", asked: asks(LINK_KIND, { email: ADMIN.email }), sent: platformSentOf("platform_sign_in_link", ADMIN.id) },
        { label: "platform reset code, one administrator, through the route", asked: asks(CODE, { email: ADMIN.email }), sent: platformSentOf("platform_reset_code", ADMIN.id) },
        { label: "tenant sign-in link, one learner", asked: asks(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG }), sent: tenantSentOf("magic_link", LEARNER.id) },
        { label: "tenant reset code, one learner", asked: asks(CODE, { email: LEARNER.email, orgSlug: SLUG }), sent: tenantSentOf("password_reset", LEARNER.id) },
      ];
      for (const kind of ["platform_sign_in_link", "platform_reset_code"] as const) {
        const req = kind === "platform_sign_in_link"
          ? ({ event: kind, to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: false }, organizationId: ORG, content: { link: LINK, minutes: 60 } } as PlatformSendRequest<typeof kind>)
          : ({ event: kind, to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: false }, organizationId: ORG, content: { code: "123456", minutes: 10 } } as PlatformSendRequest<typeof kind>);
        cases.push({
          label: `the platform sender alone, ${kind === "platform_sign_in_link" ? "a link" : "a code"}, one administrator`,
          asked: async () => [() => sendPlatformEmail(req, { db, env: PLATFORM_ENV })],
          sent: platformSentOf(kind, ADMIN.id),
        });
      }
      for (const c of cases) {
        base();
        const run = await hourAfterHour(c.asked, c.sent);
        const total = run.perHour.reduce((a, b) => a + b, 0);
        eq(`${c.label}: no hour sends more than 5, and the ${HOURS} hours together no more than 10 (${run.perHour.join(", ")})`, [run.perHour.every((n) => n <= 5), total <= 10], [true, true]);
        eq("…non-vacuous: the first hour's five went one after another, and the second hour's sent within the day's room", [run.firstFive, run.perHour[1]], [5, 5]);
        eq(`…the first hour's burst at the limit ran (${BURST} jobs) and sent nothing`, [run.burstJobs, run.burstSent], [BURST, 0]);
      }
    }

    console.log("\neach account count is an exact count of the account's claims: a count of the rows, with no page");
    {
      /** The reads of one account's rows: by its user id, or by its address for code rows. */
      const accountReads = (table: string) => requests.filter((r) => r.table === table && (r.method === "GET" || r.method === "HEAD") && (r.query.has("to_user_id") || r.query.has("email")));
      const shape = (r: Req) => ({
        exact: r.method === "HEAD" && /(^|,)\s*count=exact/.test(r.prefer),
        keys: [...new Set(r.query.keys())].sort(),
        filters: Object.fromEntries([...r.query.entries()].filter(([k]) => k !== "select" && k !== "to_user_id" && k !== "email" && k !== "sent_at" && k !== "created_at")),
        since: r.query.get("sent_at") ?? r.query.get("created_at") ?? "",
      });
      const check = (label: string, reads: Req[], keys: string[], filters: Record<string, string>) => {
        const shapes = reads.map(shape);
        eq(`${label}: four counts (the hour and the day, before the claim and after it), each exact, with no page or order`,
          [shapes.length, shapes.every((s) => s.exact && JSON.stringify(s.keys) === JSON.stringify(keys) && JSON.stringify(s.filters) === JSON.stringify(filters)), shapes.every((s) => s.since.startsWith("gte."))],
          [4, true, true]);
        const spans = reads.map((r) => Date.parse((r.query.get("sent_at") ?? r.query.get("created_at") ?? "").slice(4)));
        eq(`${label}: …two of them read the hour and two the day`, [spans.filter((t) => Date.now() - t <= 3_600_000 + 60_000).length, spans.filter((t) => Date.now() - t >= 24 * 3_600_000 - 60_000).length], [2, 2]);
      };
      const platformKeys = ["error_code", "event_type", "select", "sent_at", "status", "to_user_id"];
      const platformRequests = "in.(pending,test_domain,not_allowed)";
      base();
      await one(LINK_KIND, { email: ADMIN.email });
      check("platform link", accountReads("platform_email_log"), platformKeys, { event_type: "eq.platform_sign_in_link", status: "eq.suppressed", error_code: platformRequests });
      base();
      await one(CODE, { email: ADMIN.email });
      check("platform code, the sender's account", accountReads("platform_email_log"), platformKeys, { event_type: "eq.platform_reset_code", status: "eq.suppressed", error_code: platformRequests });
      check("platform code, the address's code rows", accountReads("password_reset_otps"), ["created_at", "email", "select"], {});
      base();
      await one(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG });
      check("tenant link", accountReads("notification_log"), ["error", "event_type", "select", "sent_at", "status", "to_user_id"], { event_type: "eq.magic_link", status: "eq.queued", error: "eq.claim" });
      base();
      await one(CODE, { email: LEARNER.email, orgSlug: SLUG });
      check("tenant code, the address's code rows", accountReads("password_reset_otps"), ["created_at", "email", "select"], {});
      eq("…a tenant code reads no account count of links", accountReads("notification_log").length, 0);
      // The shares' counts read no rows either: exact counts of the in-flight rows.
      base();
      await one(LINK_KIND, { email: ADMIN.email });
      const flightReads = requests.filter((r) => r.table === "platform_email_log" && r.query.get("error_code") === `eq.${IN_FLIGHT_WORD}`);
      eq("platform: the organisation's in-flight rows and every in-flight row, two exact counts from two minutes ago, with no page or order",
        [flightReads.length, flightReads.every((r) => shape(r).exact && !r.query.has("limit") && !r.query.has("order")), flightReads.map((r) => r.query.has("organization_id")).sort()], [2, true, [false, true]]);
      base();
      await one(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG });
      const tenantFlight = requests.filter((r) => r.table === "notification_log" && r.query.get("error") === `eq.${IN_FLIGHT_WORD}`);
      eq("tenant: the organisation's in-flight rows, one exact count, with no page or order",
        [tenantFlight.length, tenantFlight.every((r) => shape(r).exact && !r.query.has("limit") && !r.query.has("order") && r.query.get("organization_id") === `eq.${ORG}`)], [1, true]);
    }

    console.log("\nan organisation's share and the ceiling, many accounts at once");
    {
      base();
      seedPlatform(47, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: id(901), status: "sent" }, () => 60 * MIN);
      const { lines } = await together(LINK_KIND, ADMINS.map((a) => ({ email: a.email })));
      const orgSent = () => platformRowsOf((r) => r.organization_id === ORG && r.status === "sent" && (r.event_type === "platform_sign_in_link" || r.event_type === "platform_reset_code")).length;
      eq("40 administrators of one organisation, 3 short of its share of 50: no more than 3 go", [dispatched("platform").length <= 3, orgSent() <= 50], [true, true]);
      eq("…the others are refused by the share (non-vacuous: the in-flight rows were counted)", jobLines(lines).some((l) => l.code === "org_limit"), true);
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
      eq(`${kind.name}: at most 5 in-flight rows for that account and kind`, tenantInFlight(kind.tenantEvent, LEARNER.id).length <= 5, true);
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

    console.log("\nthe shares count the in-flight rows of requests that passed their account's count");
    {
      base();
      seedPlatform(44, { event_type: "platform_reset_code", organization_id: ORG, to_user_id: id(903), status: "sent" }, () => 60 * MIN);
      seedPlatformPassed(5, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_X.id }, () => 30_000);
      await one(LINK_KIND, { email: ADMIN_Y.email });
      eq("platform: five in-flight rows of another administrator, the share six short: the next link goes", dispatched("platform").length, 1);
      base();
      seedPlatform(45, { event_type: "platform_reset_code", organization_id: ORG, to_user_id: id(903), status: "sent" }, () => 60 * MIN);
      seedPlatformPassed(5, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_X.id }, () => 30_000);
      const refused = jobLines(await one(LINK_KIND, { email: ADMIN_Y.email }));
      eq("…five short: refused by the share", [dispatched("platform").length, refused.map((l) => l.code)], [0, ["org_limit"]]);
      base({ dailyLimit: 30, sent24h: 24 });
      seedTenantPassed(5, { event_type: "magic_link", to_user_id: LEARNER_X.id }, () => 30_000);
      await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG });
      eq("tenant: five in-flight rows of another learner, the daily limit six short: the next link goes", dispatched("tenant").length, 1);
      base({ dailyLimit: 30, sent24h: 25 });
      seedTenantPassed(5, { event_type: "magic_link", to_user_id: LEARNER_X.id }, () => 30_000);
      const tl = jobLines(await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG }));
      eq("…five short: not attempted, daily_limit", [dispatched("tenant").length, tl.map((l) => l.outcome)], [0, ["daily_limit"]]);
    }

    console.log("\na claim with no in-flight row counts against nobody else");
    {
      base();
      seedPlatform(49, { event_type: "platform_reset_code", organization_id: ORG, to_user_id: id(903), status: "sent" }, () => 60 * MIN);
      seedPlatform(400, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_X.id, status: "suppressed", error_code: "pending" }, () => 30_000);
      await one(LINK_KIND, { email: ADMIN_Y.email });
      eq("platform: 400 claims of one administrator with no in-flight row, the share one short: another administrator's link goes", dispatched("platform").length, 1);
      base({ dailyLimit: 30, sent24h: 29 });
      seedTenant(400, { event_type: "magic_link", to_user_id: LEARNER_X.id, status: "queued", error: "claim" }, () => 30_000);
      await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG });
      eq("tenant: 400 claims of one learner with no in-flight row, the daily limit one short: another learner's link goes", dispatched("tenant").length, 1);
    }

    console.log(`\nrequests at once for one account hold back no other account's mail (${AT_ONCE} at once)`);
    {
      base();
      const burst = await together(LINK_KIND, Array.from({ length: AT_ONCE }, () => ({ email: ADMIN.email })));
      eq(`platform: ${AT_ONCE} link requests at once for one administrator ran, at most 5 went, with at most 5 in-flight rows`,
        [burst.answers.length, dispatched("platform").length <= 5, inFlightOfPlatform(ADMIN.id, "platform_sign_in_link").length <= 5], [AT_ONCE, true, true]);
      const other = jobLines(await one(LINK_KIND, { email: ADMIN_B.email }));
      eq("…then one link for an administrator of another organisation is sent, and its line reads sent",
        [dispatched("platform").length, platformRowsOf((r) => r.to_user_id === ADMIN_B.id && r.status === "sent").length, other.map((l) => l.outcome)], [1, 1, ["sent"]]);
      base();
      const tenantBurst = await together(LINK_KIND, Array.from({ length: AT_ONCE }, () => ({ email: LEARNER.email, orgSlug: SLUG })));
      eq(`tenant: on a day with nothing sent, ${AT_ONCE} link requests at once for one learner ran, at most 5 went, with at most 5 in-flight rows`,
        [tenantBurst.answers.length, tenantSent("magic_link").length <= 5, tenantInFlight("magic_link", LEARNER.id).length <= 5], [AT_ONCE, true, true]);
      const next = jobLines(await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG }));
      eq("…then one link for another learner of the organisation is sent, with no daily_limit row and no alert due",
        [dispatched("tenant").length, next.map((l) => l.outcome), dailyLimitRows().length, world.state?.alert_due_at ?? null], [1, ["sent"], 0, null]);
    }

    console.log("\nan in-flight row older than two minutes");
    {
      base();
      seedPlatform(49, { event_type: "platform_reset_code", organization_id: ORG, to_user_id: id(904), status: "sent" }, () => 60 * MIN);
      seedPlatformPassed(1, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_X.id }, () => 3 * MIN);
      await one(LINK_KIND, { email: ADMIN_Y.email });
      eq("platform: no longer in flight (the share's last place still goes)", dispatched("platform").length, 1);
      base();
      seedPlatformPassed(5, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN_Y.id }, (i) => 3 * MIN + i * MIN);
      const lines = jobLines(await one(LINK_KIND, { email: ADMIN_Y.email }));
      eq("…its claim still counts as a request for its hour (five such claims: refused)", [dispatched("platform").length, lines.map((l) => l.code)], [0, ["account_limit"]]);
      base({ dailyLimit: 30, sent24h: 29 });
      seedTenantPassed(1, { event_type: "magic_link", to_user_id: LEARNER_X.id }, () => 3 * MIN);
      await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG });
      eq("tenant: no longer in flight (the day's last place still goes)", dispatched("tenant").length, 1);
      base();
      seedTenantPassed(5, { event_type: "magic_link", to_user_id: LEARNER_Y.id }, (i) => 3 * MIN + i * MIN);
      const tl = jobLines(await one(LINK_KIND, { email: LEARNER_Y.email, orgSlug: SLUG }));
      eq("…its claim still counts as a request for its hour", [dispatched("tenant").length, tl.map((l) => l.outcome)], [0, ["account_limit"]]);
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
      // The first row a code's job writes after its code row: the tenant's in-flight row, the platform's claim.
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

    console.log("\na claim, an in-flight row or a count after them that cannot be written or read sends nothing");
    for (const kind of KINDS) {
      base({ writeFailing: new Set(["platform_email_log"]) });
      let lines = jobLines(await one(kind, { email: ADMIN.email }));
      eq(`platform ${kind.name}: the claim cannot be written: nothing sent, no row`, [dispatched("platform").length, world.platformLog.length, lines.map((l) => l.code)], [0, 0, ["log_unreadable"]]);
      base({ failWrite: (r) => r.table === "platform_email_log" && r.method === "POST" && (r.body as Row).error_code === IN_FLIGHT_WORD });
      lines = jobLines(await one(kind, { email: ADMIN.email }));
      eq(`platform ${kind.name}: the in-flight row cannot be written: nothing sent, the claim the only row`, [dispatched("platform").length, world.platformLog.map((r) => r.error_code), lines.map((l) => l.code)], [0, ["pending"], ["log_unreadable"]]);
      base({ failRead: (r) => r.table === "platform_email_log" && r.query.get("error_code") === `eq.${IN_FLIGHT_WORD}` });
      lines = jobLines(await one(kind, { email: ADMIN.email }));
      eq(`platform ${kind.name}: the in-flight rows cannot be counted: nothing sent, the claim and the in-flight row the only rows`,
        [dispatched("platform").length, world.platformLog.map((r) => r.error_code), lines.map((l) => l.code)], [0, ["pending", IN_FLIGHT_WORD], ["log_unreadable"]]);
      // The account's count read once its claim is written.
      base({ failRead: (r) => r.table === "platform_email_log" && r.method === "HEAD" && r.query.has("to_user_id") && world.platformLog.some((row) => row.error_code === "pending") });
      lines = jobLines(await one(kind, { email: ADMIN.email }));
      eq(`platform ${kind.name}: the account's count after the claim cannot be read: nothing sent, the claim the only row`, [dispatched("platform").length, world.platformLog.map((r) => r.error_code), lines.map((l) => l.code)], [0, ["pending"], ["log_unreadable"]]);
      base({ writeFailing: new Set(["notification_log"]) });
      const all = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
      lines = jobLines(all);
      eq(`tenant ${kind.name}: ${kind === CODE ? "its in-flight row" : "the claim"} cannot be written: nothing sent, one fixed line with its code`,
        [dispatched("tenant").length, lines.map((l) => l.outcome), all.some((l) => l.includes('"step":"claim_failed"') && l.includes('"code":"XX000"'))], [0, ["claim_failed"], true]);
      base({ failWrite: (r) => r.table === "notification_log" && r.method === "POST" && (r.body as Row).error === IN_FLIGHT_WORD });
      const flightFailed = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
      eq(`tenant ${kind.name}: the in-flight row cannot be written: nothing ${kind === CODE ? "" : "minted or "}sent, ${kind === CODE ? "no row" : "the claim the only row"}, one fixed line`,
        [dispatched("tenant").length, requests.filter((r) => r.path === "/auth/v1/admin/generate_link").length, world.log.map((r) => r.error), jobLines(flightFailed).map((l) => l.outcome)],
        [0, 0, kind === CODE ? [] : ["claim"], ["claim_failed"]]);
    }
    {
      // The account's count read once its claim is written.
      base({ failRead: (r) => r.table === "notification_log" && r.query.get("status") === "eq.queued" && r.query.has("to_user_id") && world.log.some((row) => row.status === "queued") });
      const lines = jobLines(await one(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG }));
      eq("tenant link: the account's count after the claim cannot be read: nothing minted or sent, the claim the only row",
        [dispatched("tenant").length, requests.filter((r) => r.path === "/auth/v1/admin/generate_link").length, lines.map((l) => l.outcome), world.log.map((r) => r.error)], [0, 0, ["limit_read_failed"], ["claim"]]);
      const credentialLine = (all: string[], step: string) => all.some((l) => l.includes('"event":"credential_claim"') && l.includes(`"step":"${step}"`));
      for (const kind of KINDS) {
        // A limit of 30, 29 sent before the answer, and five in-flight rows of another learner.
        const arrange = (over: Parameters<typeof freshWorld>[0] = {}) => {
          base({ dailyLimit: 30, sent24h: 29, ...over });
          seedTenantPassed(5, { event_type: "magic_link", to_user_id: LEARNER_X.id }, () => 20_000);
        };
        let statusReads = 0;
        arrange({ failRead: (r) => r.table === "rpc/tenant_mail_status" && ++statusReads === 2 });
        const all = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
        eq(`tenant ${kind.name}: the status read again fails: the run's first count and the in-flight rows apply: not attempted, daily_limit, with its record row and the status_unread line`,
          [dispatched("tenant").length, jobLines(all).map((l) => l.outcome), dailyLimitRows().length, credentialLine(all, "status_unread")], [0, ["daily_limit"], 1, true]);
        arrange({ failRead: (r) => r.table === "notification_log" && r.query.get("error") === `eq.${IN_FLIGHT_WORD}` });
        const all2 = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
        eq(`tenant ${kind.name}: the in-flight rows cannot be counted: one goes on the run's own count, with the claims_unread line, no daily_limit row and no alert due`,
          [dispatched("tenant").length, credentialLine(all2, "claims_unread"), dailyLimitRows().length, world.state?.alert_due_at ?? null], [1, true, 0, null]);
        arrange({ status: "missing" });
        const all3 = await one(kind, { email: LEARNER.email, orgSlug: SLUG });
        eq(`tenant ${kind.name}: without 0114 one goes, and no daily limit is applied`, [dispatched("tenant").length, jobLines(all3).map((l) => l.outcome), dailyLimitRows().length], [1, ["sent"], 0]);
        arrange();
        const lines3 = jobLines(await one(kind, { email: LEARNER.email, orgSlug: SLUG }));
        eq(`tenant ${kind.name}: …the control: with both read, the in-flight rows fill the day, and it is not attempted`, [dispatched("tenant").length, lines3.map((l) => l.outcome)], [0, ["daily_limit"]]);
      }
    }

    console.log("\na reset code's row: written closed, opened only after every limit and claim");
    {
      base();
      world.otps.push({ id: "otp-older", email: LEARNER.email, code_hash: hashOtp("666666"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await one(CODE, { email: LEARNER.email, orgSlug: SLUG });
      const idx = (pred: (r: Req) => boolean) => requests.findIndex(pred);
      const written = idx((r) => r.table === "password_reset_otps" && r.method === "POST");
      const flight = idx((r) => r.table === "notification_log" && r.method === "POST" && (r.body as Row).error === IN_FLIGHT_WORD);
      const opened = idx((r) => r.table === "password_reset_otps" && r.method === "PATCH" && (r.body as Row).used_at === null);
      const closedOlder = idx((r) => r.table === "password_reset_otps" && r.method === "PATCH" && r.query.has("created_at"));
      const sent = idx((r) => r.path === "/functions/v1/send-smtp");
      eq("the row is written closed, then the in-flight row, then it is opened, then the send, and only then are the older codes closed",
        [typeof (requests[written]?.body as Row | undefined)?.used_at, written < flight, flight < opened, opened < sent, sent < closedOlder], ["string", true, true, true, true]);
      eq("…the new code is the one open; the older one is closed", openCodes(LEARNER.email).map((r) => r.id === "otp-older"), [false]);
      base({ dailyLimit: 30, sent24h: 29 });
      seedTenant(5, { event_type: "password_reset", to_user_id: LEARNER_X.id, status: "queued", error: IN_FLIGHT_WORD }, () => 20_000);
      world.otps.push({ id: "otp-older", email: LEARNER.email, code_hash: hashOtp("777777"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await one(CODE, { email: LEARNER.email, orgSlug: SLUG });
      eq("a request the daily limit refuses after its in-flight row: its row stays closed, and the older code stays open", [dispatched("tenant").length, openCodes(LEARNER.email).map((r) => r.id), world.otps.length], [0, ["otp-older"], 2]);
      base();
      world.otps.push({ id: "otp-older", email: ADMIN.email, code_hash: hashOtp("888888"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      await withEnv({ PLATFORM_SMTP_HOST: undefined }, () => one(CODE, { email: ADMIN.email }));
      eq("the platform sender not configured: no code opened, none closed; the claim, the in-flight row and the not_configured row",
        [openCodes(ADMIN.email).map((r) => r.id), world.platformLog.map((r) => [r.status, r.error_code])], [["otp-older"], [["suppressed", "pending"], ["suppressed", IN_FLIGHT_WORD], ["failed", "not_configured"]]]);
    }

    console.log("\nonly a send that was attempted closes an older code (the later note of 2026-11-22, part 4)");
    {
      const opening = (r: Req) => r.table === "password_reset_otps" && r.method === "PATCH" && (r.body as Row).used_at === null;
      /** A code's job whose clock moves on by `ms` while its own row is opened. */
      const movedAtOpen = async (payload: Row, ms: number) => {
        const clock = fakeClock();
        world.onRequest = (r) => { if (opening(r)) clock.move(ms); };
        try {
          return jobLines(await one(CODE, payload));
        } finally {
          world.onRequest = null;
          clock.restore();
        }
      };
      const older = (email: string) => ({ id: "otp-older", email, code_hash: hashOtp("121212"), created_at: ago(5 * MIN), used_at: null, attempts: 0, expires_at: new Date(Date.now() + 5 * MIN).toISOString() });
      const own = (email: string) => world.otps.find((r) => r.email === email && r.id !== "otp-older");
      const newestOpen = (email: string) => [...openCodes(email)].sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))[0]?.id ?? null;
      for (const [system, payload, email] of [["tenant", { email: LEARNER.email, orgSlug: SLUG }, LEARNER.email], ["platform", { email: ADMIN.email }, ADMIN.email]] as const) {
        const host = system === "tenant" ? "tenant" : "platform";
        base();
        world.otps.push(older(email));
        let lines = await movedAtOpen(payload, CLAIM_SEND_WITHIN_MS + 1_000);
        eq(`${system} code: the clock passes the claim's 30 s while the code is opened: nothing sent, its own row closed again, the older code still open and the newest open row`,
          [dispatched(host).length, typeof own(email)?.used_at, openCodes(email).map((r) => r.id), newestOpen(email), lines.map((l) => l.outcome)], [0, "string", ["otp-older"], "otp-older", ["claim_stale"]]);
        base();
        world.otps.push(older(email));
        // Past the job's deadline less the time kept for the send's row, inside the claim's 30 s.
        lines = await movedAtOpen(payload, 24_000);
        eq(`${system} code: the job's deadline passes while the code is opened: nothing sent, its own row closed again, the older code still open and the newest open row`,
          [dispatched(host).length, typeof own(email)?.used_at, openCodes(email).map((r) => r.id), newestOpen(email), lines.map((l) => l.outcome)], [0, "string", ["otp-older"], "otp-older", ["no_time"]]);
        base({ smtp: () => ({ ok: false, error: "Connection refused" }) });
        world.otps.push(older(email));
        lines = jobLines(await one(CODE, payload));
        eq(`${system} code: a send that is attempted and fails closes the older code and leaves the new one open`,
          [dispatched(host).length, world.otps.find((r) => r.id === "otp-older")?.used_at !== null, own(email)?.used_at ?? null, lines.map((l) => l.code ?? l.outcome)], [1, true, null, ["unreachable"]]);
      }
    }

    console.log("\nthe sender's two halves");
    {
      base();
      const to = { userId: ADMIN.id, email: ADMIN.email, platformOwner: false };
      const req: PlatformSendRequest<"platform_sign_in_link"> = { event: "platform_sign_in_link", to, organizationId: ORG, content: { link: LINK, minutes: 60 } };
      const claimed = await claimPlatformSend(req, { db, env: PLATFORM_ENV });
      const r = claimed.claimed ? await sendPlatformEmail(req, { db, env: PLATFORM_ENV, claim: claimed.claim }) : null;
      eq("a claim handed to the sender: it does not claim again (one claim, one in-flight row, one outcome)", [r?.status, claimsOfPlatform().length, inFlightOfPlatform().length, outcomesOfPlatform("platform_sign_in_link").length], ["sent", 1, 1, 1]);
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
      base();
      const owner = { userId: ADMIN.id, email: ADMIN.email, platformOwner: true };
      const ownReq: PlatformSendRequest<"platform_sign_in_link"> = { event: "platform_sign_in_link", to: owner, organizationId: null, content: { link: LINK, minutes: 60 } };
      requests.length = 0;
      const own = await claimPlatformSend(ownReq, { db, env: PLATFORM_ENV });
      eq("a platform owner's own request writes its in-flight row and reads none of the shares' four counts",
        [own.claimed, inFlightOfPlatform(ADMIN.id).length, requests.filter((q) => q.table === "platform_email_log" && (q.query.has("organization_id") || q.query.get("status") === "eq.sent" || q.query.get("error_code") === `eq.${IN_FLIGHT_WORD}`)).length], [true, 1, 0]);
      // Four claims in the hour; another request claims at the same moment as this one.
      base();
      seedPlatform(4, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN.id, status: "suppressed", error_code: "pending" }, () => 50 * MIN);
      const alongside = (table: string, row: Row) => (q: Req) => {
        if (q.table === table && q.method === "POST" && ((q.body as Row).error_code === "pending" || (q.body as Row).error === "claim") && !world.platformLog.concat(world.log).some((r) => r.id === "alongside")) {
          (table === "platform_email_log" ? world.platformLog : world.log).push({ id: "alongside", ...row, sent_at: new Date(Date.now()).toISOString() });
        }
      };
      world.onRequest = alongside("platform_email_log", { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: ADMIN.id, status: "suppressed", error_code: "pending" });
      const counted = await captureLogs(() => claimPlatformSend(req, { db, env: PLATFORM_ENV }));
      world.onRequest = null;
      eq("platform: the count after the claim finds the account past its limit: refused, the claim its only row (no in-flight row)",
        [counted.value.claimed ? "claimed" : counted.value.result, platformRowsOf((r) => r.status === "refused").length, inFlightOfPlatform().length], [{ status: "refused", errorCode: "account_limit", logged: false }, 0, 0]);
      base();
      seedTenant(4, { event_type: "magic_link", to_user_id: LEARNER.id, status: "queued", error: "claim" }, () => 50 * MIN);
      world.onRequest = alongside("notification_log", { organization_id: ORG, event_type: "magic_link", to_user_id: LEARNER.id, status: "queued", error: "claim" });
      const tl = jobLines(await one(LINK_KIND, { email: LEARNER.email, orgSlug: SLUG }));
      world.onRequest = null;
      eq("tenant: the same for a link: nothing minted or sent, no row past the claim (no in-flight row)",
        [tl.map((l) => l.outcome), requests.filter((r) => r.path === "/auth/v1/admin/generate_link").length, dispatched("tenant").length, world.log.filter((r) => !(r.status === "queued" && r.error === "claim")).length], [["account_limit"], 0, 0, 0]);
    }

    console.log("\nthe welcome, the alert and the test write no claim");
    {
      base();
      const welcome = await sendPlatformEmail(
        { event: "platform_admin_welcome", to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: false }, organizationId: ORG, content: { organizationName: "Tenant A", signInUrl: "https://lms.stub/tenant-a/login", role: "admin", setupLink: `https://lms.stub/auth/set-password#t=${"S".repeat(43)}`, days: 7 } },
        { db, env: PLATFORM_ENV }
      );
      const test = await sendPlatformEmail({ event: "platform_test", to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: true }, organizationId: null, content: {} }, { db, env: PLATFORM_ENV });
      eq("a welcome and a test: sent, one row each, no claim and no in-flight row", [welcome.status, test.status, world.platformLog.map((r) => r.status), claimsOfPlatform().length, inFlightOfPlatform().length], ["sent", "sent", ["sent", "sent"], 0, 0]);
      base();
      seedPlatform(374, { event_type: "platform_admin_welcome", organization_id: OTHER_ORG, to_user_id: id(905), status: "sent" }, () => 60 * MIN);
      for (const a of ADMINS.slice(0, 20)) seedPlatformPassed(3, { event_type: "platform_sign_in_link", organization_id: ORG, to_user_id: a.id }, () => 10_000);
      const alert = await sendPlatformEmail(
        { event: "tenant_smtp_alert", to: { userId: ADMIN.id, email: ADMIN.email, platformOwner: false }, organizationId: ORG, content: { organizationName: "Tenant A", settingsUrl: "https://lms.stub/tenant-a/settings?tab=smtp", reading: "failing", errorClass: "auth" } },
        { db, env: PLATFORM_ENV }
      );
      eq("an alert goes from its sent rows while other accounts' claims and in-flight rows are on the log, and writes neither", [alert.status, claimsOfPlatform().length, inFlightOfPlatform().length], ["sent", 60, 60]);
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
