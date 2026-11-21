/**
 * The platform console's email test (ADR 0029 section F; step 5):
 * POST /api/super/email/test, called as Next calls it, under a stubbed Auth,
 * PostgREST and send-smtp and a stubbed next/headers cookie jar.
 *   - a signed-in platform owner: the fixed test message goes to their own
 *     address, read server side from their user id (the auth admin read);
 *     whatever the request body says is ignored (no recipient, subject or
 *     text can be chosen: not a relay);
 *   - one platform_email_log row (user id, no address) and one
 *     platform_audit_log row whose metadata holds the outcome and no
 *     address;
 *   - every outcome answers 200 with { status, error_code }: a reserved
 *     test domain is suppressed, a log that cannot be read sends nothing;
 *   - a signed-in user with no owner row: 403, and nothing is read, sent or
 *     written (the guard comes first; tests/unit/platform-route-guards.test.ts
 *     holds the rule for every platform handler);
 *   - an owner whose row requires the second factor, at AAL1: 403
 *     mfa_required, and nothing is read, sent or written; at AAL2: sent;
 *   - the answer and the audit row say whether the sender's log row was
 *     written (logged).
 *
 * ADR 0029 pull request B, stage 4 (step 17; rule FP4):
 *   - POST /api/super/email/limit: a platform owner sets an organisation's
 *     daily limit, or asks by name for the default (use_default); the number
 *     it replaces is read first, one write holds the organisation's id, the
 *     number and the time, and one audit row holds the number before and
 *     after; a number outside 1 to 100,000, and a null that was not asked
 *     for as the default, is 400, an organisation not found or deleted is
 *     404, and nothing is written; without migration 0114 it is refused
 *     with the console's sentence that names the migration; a signed-in
 *     user with no owner row gets 403 and nothing is read or written;
 *   - /super/email, the real server component rendered to markup over the
 *     same stubs: without migration 0114 the sentence that names it stands
 *     in place of the organisations' list and of the lost-job numbers, and
 *     the page still renders; with it, the list; a state that cannot be read
 *     reads its own sentence, with no database message; the reminder jobs
 *     through the fixed sentences: pending as a number, "at least n" and
 *     "not known" with its reason, the last successful run "not known", and
 *     whether crons are scheduled here.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/platform-email-console.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const SUPABASE = "http://stub.supabase.test";
const AUTH_COOKIE = "sb-stub-auth-token";
type User = { id: string; aud: string; role: string; email: string };
const OWNER: User = { id: "0e000000-0000-4000-8000-0000000000f1", aud: "authenticated", role: "authenticated", email: "owner@platform-owner.stub" };
const MEMBER: User = { id: "0e000000-0000-4000-8000-0000000000f2", aud: "authenticated", role: "authenticated", email: "member@tenant.stub" };
const PLATFORM_ENV: Record<string, string> = {
  PLATFORM_SMTP_HOST: "smtp.platform.stub",
  PLATFORM_SMTP_PORT: "465",
  PLATFORM_SMTP_USER: "mailbox-user-0029",
  PLATFORM_SMTP_PASSWORD: "stub-app-password-0029",
  PLATFORM_SMTP_FROM: "LMS Platform <mailbox-from-0029>",
  PLATFORM_EMAIL_ALLOW_DOMAINS: "*",
};

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (u: User, aal: "aal1" | "aal2") => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: u.id, aud: "authenticated", role: "authenticated", aal, exp: 4102444800 })}.c2ln`;
const TOKENS = new Map<string, User>();

const browser = new Map<string, string>();
const jar = {
  get: (name: string) => (browser.has(name) ? { name, value: browser.get(name)! } : undefined),
  getAll: () => [...browser].map(([name, value]) => ({ name, value })),
  has: (name: string) => browser.has(name),
  set: (name: string, value: string) => { browser.set(name, value); },
  delete: (name: string) => { browser.delete(name); },
};
const signIn = (u: User, aal: "aal1" | "aal2" = "aal2") => {
  const t = jwt(u, aal);
  TOKENS.set(t, u);
  browser.set(AUTH_COOKIE, JSON.stringify({ access_token: t, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: u }));
};

// tsx compiles the page's JSX to React.createElement.
(globalThis as { React?: unknown }).React = React;

// The page's client components call useRouter, which needs the app router
// mounted; outside it they get a router that does nothing. The rest of
// next/navigation (redirect among it) is the real module.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") return { cookies: async () => jar, headers: async () => new Headers({ host: "lms.test" }) };
  if (request === "next/navigation") {
    const real = load.call(this, request, ...rest) as Record<string, unknown>;
    return { ...real, useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} }) };
  }
  return load.call(this, request, ...rest);
};

type Req = { method: string; path: string; body: string };
let requests: Req[] = [];
let logRows: Array<Record<string, unknown>> = [];
let auditRows: Array<Record<string, unknown>> = [];
let logMissing = false;
let adminEmail: string | null = OWNER.email;
let ownerMfaRequired = false;
/** The organisations the limit route reads, and tenant_smtp_state: its rows, or no 0114, or another failure. */
const ORG_ID = "0a000000-0000-4000-8000-0000000000a1";
const GONE_ID = "0a000000-0000-4000-8000-0000000000d1";
let stateRows: Array<Record<string, unknown>> = [];
let stateTable: "ok" | "missing" | "fail" = "ok";
let stateWrites: Array<{ method: string; body: Record<string, unknown>; query: string }> = [];
/**
 * What /super/email reads besides the platform log: tenant_mail_status for
 * every organisation (its rows, the function not there, or another
 * failure), the settings, the code and link jobs' counts, the heartbeat
 * rows and the organisations' names. A failure answers DB_MESSAGE, which the
 * page must never show.
 */
const DB_MESSAGE = "stub database message 0029";
type Read = "ok" | "missing" | "fail";
let page: { status: Read; statusRows: Array<Record<string, unknown>>; settings: Array<Record<string, unknown>>; jobs: Read; jobRows: Array<Record<string, unknown>>; beats: Array<Record<string, unknown>> | "fail"; orgs: Array<{ id: string; name: string }> };
const freshPage = () => {
  page = { status: "ok", statusRows: [], settings: [], jobs: "ok", jobRows: [], beats: [], orgs: [] };
};
freshPage();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" ? init.body : "";
  const p = url.pathname;
  requests.push({ method, path: p, body });
  const object = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
  if (p === "/auth/v1/user") {
    const u = TOKENS.get((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    return u ? json(u) : json({ msg: "invalid JWT" }, 401);
  }
  if (p.startsWith("/auth/v1/admin/users/")) {
    const id = p.split("/").pop();
    return json({ id, aud: "authenticated", role: "authenticated", email: id === OWNER.id ? adminEmail : MEMBER.email });
  }
  if (p === "/rest/v1/platform_owners") {
    const id = (url.searchParams.get("user_id") ?? "").replace(/^eq\./, "");
    const r = id === OWNER.id ? { user_id: OWNER.id, mfa_required: ownerMfaRequired } : null;
    return json(object ? r : r ? [r] : []);
  }
  if (p === "/rest/v1/profiles") return json(object ? { must_change_password: false } : [{ must_change_password: false }]);
  if (p === "/rest/v1/platform_email_log") {
    if (logMissing) return json({ code: "PGRST205", message: "Could not find the table" }, 404);
    if (method === "POST") { logRows.push(JSON.parse(body)); return new Response(null, { status: 201 }); }
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    return json([]);
  }
  if (p === "/rest/v1/platform_audit_log" && method === "POST") { auditRows.push(JSON.parse(body)); return new Response(null, { status: 201 }); }
  if (p === "/rest/v1/organizations") {
    // The page's list of names: every organisation not deleted.
    if (!url.searchParams.has("id")) return json(page.orgs);
    const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    const r = id === ORG_ID ? { id, deleted_at: null } : id === GONE_ID ? { id, deleted_at: "2026-11-01T00:00:00Z" } : null;
    return json(object ? r : r ? [r] : []);
  }
  if (p === "/rest/v1/tenant_smtp_state") {
    if (stateTable === "missing") return json({ code: "PGRST205", message: "Could not find the table 'public.tenant_smtp_state' in the schema cache" }, 404);
    if (stateTable === "fail") return json({ code: "XX000", message: "stub failure" }, 500);
    if (method === "GET") {
      const id = (url.searchParams.get("organization_id") ?? "").replace(/^eq\./, "");
      const r = stateRows.find((s) => s.organization_id === id) ?? null;
      return json(object ? r : r ? [r] : []);
    }
    const rec = JSON.parse(body) as Record<string, unknown>;
    stateWrites.push({ method, body: rec, query: url.search });
    const existing = stateRows.find((s) => s.organization_id === rec.organization_id);
    if (existing) Object.assign(existing, rec); else stateRows.push({ ...rec });
    return new Response(null, { status: 201 });
  }
  if (p === "/functions/v1/send-smtp") return json({ ok: true });
  if (p === "/rest/v1/rpc/tenant_mail_status") {
    if (page.status === "missing") return json({ code: "PGRST202", message: "Could not find the function public.tenant_mail_status(p_org) in the schema cache" }, 404);
    if (page.status === "fail") return json({ code: "XX000", message: DB_MESSAGE }, 500);
    return json(page.statusRows);
  }
  if (p === "/rest/v1/notification_settings") return json(page.settings);
  if (p === "/rest/v1/organization_members") return json([]);
  if (p === "/rest/v1/mail_job_counts") {
    if (page.jobs === "missing") return json({ code: "PGRST205", message: "Could not find the table 'public.mail_job_counts' in the schema cache" }, 404);
    if (page.jobs === "fail") return json({ code: "XX000", message: DB_MESSAGE }, 500);
    return json(page.jobRows);
  }
  if (p === "/rest/v1/ops_heartbeats") return page.beats === "fail" ? json({ code: "XX000", message: DB_MESSAGE }, 500) : json(page.beats);
  throw new Error(`stub: unexpected ${method} ${p}`);
};
const fresh = () => {
  requests = []; logRows = []; auditRows = []; logMissing = false; adminEmail = OWNER.email; ownerMfaRequired = false; browser.clear();
  stateRows = []; stateTable = "ok"; stateWrites = [];
  freshPage();
};
const smtp = () => requests.filter((r) => r.path === "/functions/v1/send-smtp").map((r) => JSON.parse(r.body) as Record<string, unknown>);

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  Object.assign(process.env, PLATFORM_ENV);
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const route = await import("../../app/api/super/email/test/route");
    const post = (body?: unknown) =>
      (route.POST as unknown as (r: Request) => Promise<Response>)(
        new Request("http://lms.test/api/super/email/test", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })
      );

    console.log("\na platform owner sends the test");
    {
      fresh(); signIn(OWNER);
      const res = await post({ to: "someone@elsewhere.stub", subject: "Hello", text: "free text", html: "<b>x</b>" });
      const out = (await res.json()) as Record<string, unknown>;
      eq("200, sent, logged, audited", [res.status, out.status, out.error_code, out.logged, out.audited], [200, "sent", null, true, true]);
      const sent = smtp();
      eq("one send, to the owner's own address read from their user id", [sent.length, sent[0]?.to], [1, OWNER.email]);
      eq("…with the fixed subject and text, whatever the body asked for", [sent[0]?.subject, String(sent[0]?.text).includes("free text"), String(sent[0]?.html).includes("<b>x</b>")], ["LMS platform sender test", false, false]);
      eq("…the address came from the auth admin read of the caller's id", requests.some((r) => r.path === `/auth/v1/admin/users/${OWNER.id}`), true);
      eq("one log row: platform_test, the owner's id, no organisation, sent", logRows.map((r) => [r.event_type, r.to_user_id, r.organization_id, r.status]), [["platform_test", OWNER.id, null, "sent"]]);
      eq("one audit row: the action, the outcome, no address", [auditRows.length, auditRows[0]?.action, auditRows[0]?.actor_user_id, JSON.stringify(auditRows[0]?.metadata), JSON.stringify(auditRows).includes("@")], [1, "platform_email.test", OWNER.id, JSON.stringify({ status: "sent", error_code: null, logged: true }), false]);
    }

    console.log("\nevery outcome answers 200 with its status");
    {
      fresh(); signIn(OWNER); adminEmail = "owner@platform.test";
      const r1 = await post();
      eq("an owner address on a reserved test domain: suppressed, nothing sent, still audited", [r1.status, ((await r1.json()) as Record<string, unknown>).error_code, smtp().length, auditRows.length], [200, "test_domain", 0, 1]);
      fresh(); signIn(OWNER); logMissing = true;
      const r2 = await post();
      eq("the log not there (0113 not pasted): failed, log_unreadable, nothing sent", [r2.status, ((await r2.json()) as Record<string, unknown>).error_code, smtp().length], [200, "log_unreadable", 0]);
      fresh(); signIn(OWNER); adminEmail = null;
      const r3 = await post();
      eq("an owner account with no address: 409, nothing sent, nothing written", [r3.status, smtp().length, logRows.length, auditRows.length], [409, 0, 0, 0]);
    }

    console.log("\nnot a platform owner");
    {
      fresh(); signIn(MEMBER);
      const res = await post({ to: MEMBER.email });
      eq("403, and nothing is read beyond the guard, sent or written", [res.status, smtp().length, logRows.length, auditRows.length, requests.some((r) => r.path.startsWith("/auth/v1/admin") || r.path === "/rest/v1/platform_email_log")], [403, 0, 0, 0, false]);
    }

    console.log("\nthe second factor");
    {
      fresh(); ownerMfaRequired = true; signIn(OWNER, "aal1");
      const res = await post();
      eq("an owner whose row requires it, at AAL1: 403 mfa_required, and nothing is read beyond the guard, sent or written", [res.status, ((await res.json()) as Record<string, unknown>).error, smtp().length, logRows.length, auditRows.length, requests.some((r) => r.path.startsWith("/auth/v1/admin") || r.path === "/rest/v1/platform_email_log")], [403, "mfa_required", 0, 0, 0, false]);
      fresh(); ownerMfaRequired = true; signIn(OWNER, "aal2");
      const ok = await post();
      eq("…the same owner at AAL2: sent", [ok.status, ((await ok.json()) as Record<string, unknown>).status, smtp().length], [200, "sent", 1]);
    }

    console.log("\nthe daily limit: POST /api/super/email/limit (step 17; rule FP4)");
    {
      const { TENANT_MAIL_NEEDS_0114 } = await import("../../lib/notifications/smtp-state");
      const limit = await import("../../app/api/super/email/limit/route");
      const set = async (b: unknown) => {
        const res = await (limit.POST as unknown as (r: Request) => Promise<Response>)(new Request("http://lms.test/api/super/email/limit", { method: "POST", body: JSON.stringify(b) }));
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      fresh(); signIn(OWNER);
      const first = await set({ organization_id: ORG_ID, daily_limit: 1500 });
      eq("a platform owner sets 1,500: 200, the number, none before it, audited", [first.status, first.body], [200, { ok: true, daily_limit: 1500, previous: null, audited: true }]);
      eq("…one write: the organisation's id, the number and the time, nothing else, on the organisation's row",
        [stateWrites.length, Object.keys(stateWrites[0]?.body ?? {}).sort(), stateWrites[0]?.body.daily_limit, stateWrites[0]?.query.includes("on_conflict=organization_id")], [1, ["daily_limit", "organization_id", "updated_at"], 1500, true]);
      eq("…one audit row with the number before and after, on the organisation",
        auditRows.map((r) => [r.action, r.actor_user_id, r.target_type, r.target_id, JSON.stringify(r.metadata)]), [["tenant_email.daily_limit", OWNER.id, "organization", ORG_ID, JSON.stringify({ previous: null, daily_limit: 1500 })]]);
      const writesBefore = stateWrites.length;
      const nullOnly = await set({ organization_id: ORG_ID, daily_limit: null });
      eq("a null limit that was not asked for as the default (a box the form could not read): 400, nothing written, no audit row, the limit kept",
        [nullOnly.status, stateWrites.length - writesBefore, auditRows.length], [400, 0, 1]);
      const back = await set({ organization_id: ORG_ID, use_default: true });
      eq("the default asked for by name: 200, null, and the number it replaced is read first", [back.status, back.body.daily_limit, back.body.previous, JSON.stringify(auditRows[1]?.metadata)], [200, null, 1500, JSON.stringify({ previous: 1500, daily_limit: null })]);

      for (const bad of [0, 1.5, "1500", 100_001, -3, null, undefined]) {
        fresh(); signIn(OWNER);
        const r = await set({ organization_id: ORG_ID, daily_limit: bad });
        eq(`a number outside 1 to 100,000, or none (${JSON.stringify(bad) ?? "absent"}): 400, nothing written, no audit row`, [r.status, stateWrites.length, auditRows.length], [400, 0, 0]);
      }
      fresh(); signIn(OWNER);
      const both = await set({ organization_id: ORG_ID, daily_limit: 50, use_default: true });
      eq("a number and the default together: 400, nothing written", [both.status, stateWrites.length, auditRows.length], [400, 0, 0]);

      console.log("\nthe daily limit's form reads the box itself (step 17)");
      const { parseDailyLimitText } = await import("../../app/(super-owner)/super/email/daily-limit-form");
      eq("a plain number, and one written in groups of three, are read as that number",
        ["1500", "1,500", "1 500", " 375 ", "100000"].map((t) => parseDailyLimitText(t)), [1500, 1500, 1500, 375, 100000].map((value) => ({ ok: true, value })));
      eq("an empty box, and text that is no whole number from 1 to 100,000, are refused: never the default",
        ["", "   ", "-", "1e", "1e3", "15,00", "1.5", "0", "100001", "abc"].map((t) => parseDailyLimitText(t).ok), Array(10).fill(false));
      eq("…the refusal says what to type and names the default's own button", (parseDailyLimitText("1,5,00") as { message?: string }).message, "Type a whole number from 1 to 100,000, or choose Use the default.");
      const { routineOffNote } = await import("../../app/(super-owner)/super/email/daily-limit-form");
      const { DAILY_LIMIT_RESERVE_MIN } = await import("../../lib/notifications/smtp-state");
      eq(`a limit of ${DAILY_LIMIT_RESERVE_MIN} or less is accepted, and the form says when it is saved that routine mail never goes at it; above, nothing more`,
        [routineOffNote(10, DAILY_LIMIT_RESERVE_MIN)?.includes("routine mail never goes"), routineOffNote(DAILY_LIMIT_RESERVE_MIN, DAILY_LIMIT_RESERVE_MIN) !== null, routineOffNote(DAILY_LIMIT_RESERVE_MIN + 1, DAILY_LIMIT_RESERVE_MIN)], [true, true, null]);
      for (const [label, id] of [["an organisation that does not exist", "0a000000-0000-4000-8000-0000000000ff"], ["a deleted organisation", GONE_ID], ["an id that is not one", "acme"]] as const) {
        fresh(); signIn(OWNER);
        const r = await set({ organization_id: id, daily_limit: 100 });
        eq(`${label}: 404, nothing written`, [r.status, stateWrites.length, auditRows.length], [404, 0, 0]);
      }
      fresh(); signIn(OWNER); stateTable = "missing";
      const no0114 = await set({ organization_id: ORG_ID, daily_limit: 100 });
      eq("without 0114: refused with the console's sentence that names the migration, nothing written, no audit row", [no0114.status, no0114.body.error, stateWrites.length, auditRows.length], [503, TENANT_MAIL_NEEDS_0114, 0, 0]);
      eq("…the sentence names the migration", TENANT_MAIL_NEEDS_0114.includes("0114"), true);
      fresh(); signIn(OWNER); stateTable = "fail";
      const failed = await set({ organization_id: ORG_ID, daily_limit: 100 });
      eq("another failure: 503 with the route's own words, nothing written, no audit row", [failed.status, String(failed.body.error).includes("stub"), stateWrites.length, auditRows.length], [503, false, 0, 0]);
      fresh(); signIn(MEMBER);
      const member = await set({ organization_id: ORG_ID, daily_limit: 100 });
      eq("a signed-in user with no owner row: 403, and nothing is read beyond the guard or written", [member.status, requests.some((r) => r.path === "/rest/v1/tenant_smtp_state" || r.path === "/rest/v1/organizations"), auditRows.length], [403, false, 0]);
    }

    console.log("\n/super/email, rendered: the organisations, the lost jobs and the line without 0114");
    {
      const { TENANT_MAIL_NEEDS_0114 } = await import("../../lib/notifications/smtp-state");
      const hs = await import("../../lib/ops/health-status");
      const emailPage = (await import("../../app/(super-owner)/super/email/page")).default;
      const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      /** The page as a signed-in platform owner sees it; a throw is an error page. */
      const render = async () => {
        signIn(OWNER);
        try {
          return decode(renderToStaticMarkup((await emailPage()) as ReactElement));
        } catch (e) {
          return `ERROR PAGE: ${e instanceof Error ? e.message : String(e)}`;
        }
      };
      /** The markup between two headings or labels of the page. */
      const between = (html: string, from: string, to: string) => {
        const a = html.indexOf(from);
        const b = html.indexOf(to, a + from.length);
        return a < 0 || b < 0 ? "" : html.slice(a, b);
      };
      const ORGS = (html: string) => between(html, "Organisations' email", "Lost mail and skipped mail");
      const JOBS = (html: string) => between(html, "Code and link jobs the platform ended", "Last request that skipped its mail");
      const count = (html: string, s: string) => html.split(s).length - 1;
      const UNREADABLE_ORGS = "The organisations' email state could not be read just now. Reload the page to try again.";

      fresh(); page.status = "missing"; page.jobs = "missing"; page.orgs = [{ id: ORG_ID, name: "Tenant A" }];
      const no0114 = await render();
      eq("without 0114: the page renders (its heading and its other sections), no error page",
        [no0114.startsWith("ERROR PAGE"), no0114.includes("Platform Email"), no0114.includes("Reminder jobs"), no0114.includes("Send test")], [false, true, true, true]);
      eq("…the sentence that names the migration, twice: in place of the organisations' list, and in place of the lost-job numbers",
        [count(no0114, TENANT_MAIL_NEEDS_0114), ORGS(no0114).includes(TENANT_MAIL_NEEDS_0114), JOBS(no0114).includes(TENANT_MAIL_NEEDS_0114)], [2, true, true]);
      eq("…and neither the list nor the numbers: no table, no organisation's name, no \"lost of\", and no \"could not be read just now\"",
        [no0114.includes("<table"), ORGS(no0114).includes("Tenant A"), JOBS(no0114).includes(" lost of "), no0114.includes("could not be read just now")], [false, false, false, false]);

      fresh();
      page.statusRows = [{ organization_id: ORG_ID, state: "healthy", state_changed_at: "2026-11-20T08:00:00.000Z", last_success_at: "2026-11-21T07:30:00.000Z", last_error_code: null, daily_limit: 1500, sent_24h: 12 }];
      page.settings = [{ organization_id: ORG_ID, smtp_host: "smtp.tenant.stub", smtp_port: 465, from_email: "from-0029" }];
      page.jobRows = [{ day: new Date().toISOString().slice(0, 10), kind: "reset_code", started: 4, finished: 3 }];
      page.orgs = [{ id: ORG_ID, name: "Tenant A" }];
      const withIt = await render();
      eq("with 0114: the organisations' list, a row with the name, the reading, the count of the limit and the limit's form holding the stored number",
        [withIt.includes("<table"), ORGS(withIt).includes("Tenant A"), ORGS(withIt).includes("Healthy"), ORGS(withIt).includes("12 of 1500"), ORGS(withIt).includes('aria-label="Daily email limit"'), ORGS(withIt).includes('value="1500"')],
        [true, true, true, true, true, true]);
      eq("…the lost-job numbers, and no sentence that names the migration", [JOBS(withIt).includes("1 lost of 4 started"), withIt.includes(TENANT_MAIL_NEEDS_0114)], [true, false]);

      fresh();
      page.statusRows = [{ organization_id: ORG_ID, state: null, state_changed_at: "2026-11-21T09:00:00.000Z", last_success_at: null, last_error_code: null, daily_limit: 1500, sent_24h: 0 }];
      page.settings = [{ organization_id: ORG_ID, smtp_host: "smtp.tenant.stub", smtp_port: 465, from_email: "from-0029" }];
      page.orgs = [{ id: ORG_ID, name: "Tenant A" }];
      const limitOnly = await render();
      eq("configured, nothing sent yet, with only the limit set: the row shows no \"since\" time, the edit's time nowhere",
        [ORGS(limitOnly).includes("Configured, nothing sent yet"), ORGS(limitOnly).includes("2026-11-21 09:00 UTC")], [true, false]);

      fresh();
      page.statusRows = [{ organization_id: ORG_ID, state: "healthy", state_changed_at: "2026-11-20T08:00:00.000Z", last_success_at: "2026-11-21T07:30:00.000Z", last_error_code: null, daily_limit: 10, sent_24h: 0 }];
      page.settings = [{ organization_id: ORG_ID, smtp_host: "smtp.tenant.stub", smtp_port: 465, from_email: "from-0029" }];
      page.orgs = [{ id: ORG_ID, name: "Tenant A" }];
      const lowLimit = await render();
      eq("a limit of 10: the reading says routine mail is off at this limit, not that it stopped for today",
        [ORGS(lowLimit).includes("routine mail off at this limit"), ORGS(lowLimit).includes("stopped for today"), ORGS(lowLimit).includes("0 of 10")], [true, false, true]);

      fresh(); page.status = "fail"; page.jobs = "fail"; page.beats = "fail"; page.orgs = [{ id: ORG_ID, name: "Tenant A" }];
      const failed = await render();
      eq("a state that cannot be read: its own sentences, in place of the list, the numbers and the jobs; no sentence that names the migration; no error page",
        [ORGS(failed).includes(UNREADABLE_ORGS), ORGS(failed).includes("<table"), JOBS(failed).includes("could not be read just now"), failed.includes("The jobs' heartbeats could not be read just now."), failed.includes(TENANT_MAIL_NEEDS_0114), failed.startsWith("ERROR PAGE")],
        [true, false, true, true, false, false]);
      eq("…and no database message anywhere on the page", failed.includes(DB_MESSAGE), false);

      console.log("\n/super/email, rendered: the reminder jobs through the fixed sentences");
      const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
      const beat = (name: string, status: "ok" | "error", minAgo: number, run: Parameters<typeof hs.buildMailCronDetail>[0]) =>
        ({ name, last_run_at: at(minAgo), last_status: status, last_detail: hs.buildMailCronDetail(run).heartbeat });
      /** The text of each job's row, in the page's order: reminders, then journey-nudges. */
      const cell = (html: string, label: string) =>
        [...html.matchAll(new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>(.*?)</dd>`, "g"))].map((m) => m[1].replace(/<[^>]+>/g, ""));
      const NO_ERRORS = { errors: {}, unreadableOrgs: 0, no0114: false };

      fresh(); page.status = "missing"; page.jobs = "missing";
      page.beats = [
        beat("reminders", "ok", 60, { ...NO_ERRORS, stoppedBeforeSend: false, due: 5, sent: 2, failed: 0, left: 3, leftComplete: true, leftDailyLimit: 0, leftOrgs: 0 }),
        beat("journey-nudges", "ok", 30, { ...NO_ERRORS, stoppedBeforeSend: false, due: 6, sent: 2, failed: 0, left: 4, leftComplete: false, leftDailyLimit: 0, leftOrgs: 1 }),
      ];
      delete process.env.OPS_EXPECT_CRONS;
      const clean = await render();
      eq("two clean runs: pending as a number, and as \"at least n\" when the count is not whole", cell(clean, "Pending reminders"), ["3", "at least 4"]);
      eq("…each last successful run is its own time, the state the clean sentence, and the program that waited said once",
        [cell(clean, "Last successful run").every((t) => t.endsWith(" UTC")), cell(clean, "State").map((t) => t.startsWith(hs.cronStateSentence("ok", true))), count(clean, "1 organisation or program waited for the next run.")], [true, [true, true], 1]);
      eq("…where crons are not scheduled the page says so, and counts neither job",
        [clean.includes("Not scheduled here: shown, not counted."), count(clean, "not counted</span>"), clean.includes("Scheduled here:")], [true, 2, false]);

      fresh(); page.status = "missing"; page.jobs = "missing";
      page.beats = [beat("reminders", "error", 60, { errors: { call_limit: 1 }, unreadableOrgs: 0, no0114: false, stoppedBeforeSend: true, leftOrgs: 1 })];
      process.env.OPS_EXPECT_CRONS = "1";
      const stopped = await render();
      delete process.env.OPS_EXPECT_CRONS;
      eq("a run that stopped before it counted: \"not known\" with its reason; a job with no run: \"not known\"", cell(stopped, "Pending reminders"), ["not known: the run failed before it counted", "not known"]);
      eq("…the last successful run reads \"not known\" when none is known, for both", cell(stopped, "Last successful run"), ["not known", "not known"]);
      eq("…the failure details are the job's own stop's sentence alone, and the job with no run reads none recorded",
        [cell(stopped, "Failure details")[0], cell(stopped, "Failure details")[1], cell(stopped, "State")[1]], [hs.callLimitSentence(true), "not known", hs.cronStateSentence("never-seen", true)]);
      eq("…where crons are scheduled the page says so, and counts them", [stopped.includes("Scheduled here: a failed run reads warn on the health check until the job's next clean run."), stopped.includes("not counted</span>")], [true, false]);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
    for (const k of Object.keys(PLATFORM_ENV)) delete process.env[k];
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
