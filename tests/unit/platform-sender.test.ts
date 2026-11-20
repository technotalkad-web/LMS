/**
 * The platform sender (ADR 0029 sections F and G; lib/email/platform-sender.ts)
 * and the send-smtp client it uses (lib/email/smtp-function.ts):
 *   - configured or not, and each half-set case (names only, never a value);
 *   - the order of section F: the account limit; the reserved test domains
 *     and the allow-list (suppressed); the organisation limit and the
 *     ceiling (refused); not configured (failed); the send;
 *   - a limit that cannot be read, or a missing table, sends nothing and
 *     writes nothing;
 *   - the limits of section G: 5 an hour and 10 a day per account and kind,
 *     one refused row an hour; a platform owner's own code and link have the
 *     hourly limit only; the test counts only sends that reached the mail
 *     server; one organisation at its limit is refused while
 *     another still sends, and alerts and welcomes are outside it; the
 *     ceiling (default 375, a deployment setting) refuses everything except
 *     a platform owner's own code, link and test;
 *   - the welcome goes to each of the add-admin route's three roles, with
 *     its setup link and never a password (ADR 0029, rules N4 and N5);
 *   - a trailing line break in the stored password is not sent;
 *   - the error classes, read from send-smtp's free text, with a recipient's
 *     refusal and a sender's failure kept apart; the 15 s wait (rule T1, the
 *     one value of both systems) and its fixed message; without a timeout
 *     the request is today's;
 *   - the allow-list's exact addresses (ADR 0029, note of 2026-11-20, part
 *     1): an address entry allows that address only, a domain entry its
 *     domain, "*" everything; a malformed entry matches nothing, and a list
 *     of only malformed entries reads as unset;
 *   - no secret value and no address in any log line or row.
 *
 * Under a stubbed fetch: PostgREST's platform_email_log (reads, counts,
 * inserts) and the send-smtp function. No database, no network.
 *
 * Run:  npx tsx tests/unit/platform-sender.test.ts   (or npm run test:unit)
 */
import {
  DEFAULT_DAILY_CEILING,
  DEFAULT_ORG_DAILY_LIMIT,
  PLATFORM_REQUIRED_SETTINGS,
  isReservedTestDomain,
  platformEmailLimits,
  platformSenderReadiness,
  scrubErrorDetail,
  sendPlatformEmail,
  type PlatformSendRequest,
  type PlatformEvent,
} from "../../lib/email/platform-sender";
import { PLATFORM_SEND_TIMEOUT_MS } from "../../lib/email/platform-sender";
import { SMTP_SEND_WAIT_MS, classifySmtpError, dispatchSmtp, dispatchTimeoutMessage } from "../../lib/email/smtp-function";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- fixtures ---------------- */

const SUPABASE = "http://stub.supabase.test";
const SERVICE_KEY = "stub-service-key-0029-abcdef";
const PASSWORD = "stub-app-password-0029";
const SMTP_USER = "platform-mailbox@platform-owner.stub";
const FROM = "LMS Platform <platform-mailbox@platform-owner.stub>";
const ENV: Record<string, string> = {
  PLATFORM_SMTP_HOST: "smtp.platform.stub",
  PLATFORM_SMTP_PORT: "465",
  PLATFORM_SMTP_SECURE: "true",
  PLATFORM_SMTP_USER: SMTP_USER,
  PLATFORM_SMTP_PASSWORD: PASSWORD,
  PLATFORM_SMTP_FROM: FROM,
  PLATFORM_EMAIL_ALLOW_DOMAINS: "*",
};
const ORG_A = "0a000000-0000-4000-8000-000000000a01";
const ORG_B = "0a000000-0000-4000-8000-000000000b01";
const OWNER = { userId: "0a000000-0000-4000-8000-0000000000f1", email: "owner@platform-owner.stub", platformOwner: true };
const ADMIN_A = { userId: "0a000000-0000-4000-8000-0000000000a2", email: "admin@tenant-a.stub", platformOwner: false };
const ADMIN_B = { userId: "0a000000-0000-4000-8000-0000000000b2", email: "admin@tenant-b.stub", platformOwner: false };
const LINK = "https://lms.stub/auth/finish?token_hash=t&type=magiclink";

const code = (to: typeof OWNER, organizationId: string | null): PlatformSendRequest<"platform_reset_code"> =>
  ({ event: "platform_reset_code", to, organizationId, content: { code: "123456", minutes: 10 } });
const link = (to: typeof OWNER, organizationId: string | null): PlatformSendRequest<"platform_sign_in_link"> =>
  ({ event: "platform_sign_in_link", to, organizationId, content: { link: LINK, minutes: 60 } });
const test = (): PlatformSendRequest<"platform_test"> => ({ event: "platform_test", to: OWNER, organizationId: null, content: {} });
/** A setup link in the form the server issues: the token alone in the fragment. */
const SETUP_LINK = `https://lms.stub/auth/set-password#t=${"S".repeat(43)}`;
const welcome = (to: typeof OWNER, organizationId: string, role: "super_owner" | "admin" | "data_analyst" = "admin"): PlatformSendRequest<"platform_admin_welcome"> =>
  ({ event: "platform_admin_welcome", to, organizationId, content: { organizationName: "Tenant A", signInUrl: "https://lms.stub/tenant-a/login", role, setupLink: SETUP_LINK, days: 7 } });
const alert = (to: typeof OWNER, organizationId: string): PlatformSendRequest<"tenant_smtp_alert"> =>
  ({ event: "tenant_smtp_alert", to, organizationId, content: { organizationName: "Tenant A", settingsUrl: "https://lms.stub/tenant-a/settings", reading: "failing", errorClass: "auth" } });

/* ---------------- the stub ---------------- */

type Row = { id: string; sent_at: string; event_type: string; organization_id: string | null; to_user_id: string | null; status: string; error_code: string | null; error_detail: string | null };
type Req = { method: string; path: string; query: URLSearchParams; body: string; init: RequestInit | undefined };
let rows: Row[] = [];
let requests: Req[] = [];
let tableMissing = false;
let failRead: null | "rows" | "count" = null;
let smtpAnswer: () => Promise<Response> = async () => json({ ok: true });
let nextId = 1;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function matches(r: Row, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    const val = (r as Record<string, unknown>)[k];
    if (v.startsWith("eq.")) { if (String(val) !== v.slice(3)) return false; }
    else if (v.startsWith("gte.")) { if (!(String(val) >= v.slice(4))) return false; }
    else if (v.startsWith("in.(")) { if (!v.slice(4, -1).split(",").includes(String(val))) return false; }
    else throw new Error(`stub: filter ${k}=${v} not understood`);
  }
  return true;
}

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  requests.push({ method, path: url.pathname, query: url.searchParams, body, init });
  if (url.pathname === "/functions/v1/send-smtp") return smtpAnswer();
  if (url.pathname === "/rest/v1/platform_email_log") {
    if (tableMissing) return json({ code: "PGRST205", message: "Could not find the table 'public.platform_email_log' in the schema cache" }, 404);
    if (method === "POST") {
      const ins = JSON.parse(body) as Partial<Row>;
      rows.push({ id: `r${nextId++}`, sent_at: new Date().toISOString(), event_type: "", organization_id: null, to_user_id: null, status: "", error_code: null, error_detail: null, ...ins } as Row);
      return new Response(null, { status: 201 });
    }
    if (method === "HEAD") {
      if (failRead === "count") return new Response(null, { status: 500 });
      const n = rows.filter((r) => matches(r, url.searchParams)).length;
      return new Response(null, { status: 200, headers: { "content-range": `*/${n}` } });
    }
    if (method === "GET") {
      if (failRead === "rows") return json({ code: "XX000", message: "stub failure" }, 500);
      let out = rows.filter((r) => matches(r, url.searchParams));
      if (url.searchParams.get("order") === "sent_at.desc") out = out.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      return json(out.slice(0, limit));
    }
  }
  throw new Error(`stub: unexpected ${method} ${url.pathname}`);
};

const fresh = () => { rows = []; requests = []; tableMissing = false; failRead = null; smtpAnswer = async () => json({ ok: true }); };
const sends = () => requests.filter((r) => r.path === "/functions/v1/send-smtp");
const inserts = () => requests.filter((r) => r.path === "/rest/v1/platform_email_log" && r.method === "POST");
const reads = () => requests.filter((r) => r.path === "/rest/v1/platform_email_log" && (r.method === "GET" || r.method === "HEAD"));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const seed = (n: number, base: Partial<Row>, minutesAgo: (i: number) => number) => {
  for (let i = 0; i < n; i++) rows.push({ id: `s${nextId++}`, sent_at: ago(minutesAgo(i)), event_type: "platform_reset_code", organization_id: null, to_user_id: null, status: "sent", error_code: null, error_detail: null, ...base });
};

// Everything printed while the sender runs, to check that no secret and no address is in it.
let printed: string[] = [];
async function send<E extends PlatformEvent>(req: PlatformSendRequest<E>, env: Record<string, string> = ENV) {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const cap = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = cap; console.warn = cap; console.error = cap; console.info = cap;
  try {
    return await sendPlatformEmail(req, { env });
  } finally {
    Object.assign(console, saved);
  }
}
const short = (r: { status: string; errorCode: string | null; logged: boolean }) => [r.status, r.errorCode, r.logged];

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  for (const k of Object.keys(ENV)) delete process.env[k];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    console.log("\nconfigured or not (names only, never a value)");
    {
      eq("every required setting present: configured", platformSenderReadiness(ENV), { configured: true, missing: [] });
      eq("the required settings are host, port, user, password, From and the allow-list", [...PLATFORM_REQUIRED_SETTINGS], ["PLATFORM_SMTP_HOST", "PLATFORM_SMTP_PORT", "PLATFORM_SMTP_USER", "PLATFORM_SMTP_PASSWORD", "PLATFORM_SMTP_FROM", "PLATFORM_EMAIL_ALLOW_DOMAINS"]);
      for (const name of PLATFORM_REQUIRED_SETTINGS) {
        const half = { ...ENV }; delete half[name];
        eq(`without ${name}: not configured, and only that name is missing`, platformSenderReadiness(half), { configured: false, missing: [name] });
        eq(`…set to blanks: the same`, platformSenderReadiness({ ...ENV, [name]: "   " }), { configured: false, missing: [name] });
      }
      for (const port of ["abc", "0", "70000", "46 5"]) eq(`port "${port}": missing`, platformSenderReadiness({ ...ENV, PLATFORM_SMTP_PORT: port }).missing, ["PLATFORM_SMTP_PORT"]);
      eq("an allow-list of only separators: missing", platformSenderReadiness({ ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: " , " }).missing, ["PLATFORM_EMAIL_ALLOW_DOMAINS"]);
      eq("nothing set: every required name missing", platformSenderReadiness({}).missing.length, 6);
      eq("the answer never holds a value", JSON.stringify(platformSenderReadiness({ ...ENV, PLATFORM_SMTP_HOST: "" })).includes(PASSWORD), false);
      eq("process.env is read by default", platformSenderReadiness().configured, false);
      eq("limits: defaults 375 and 50", platformEmailLimits({}), { dailyCeiling: 375, orgDailyLimit: 50 });
      eq("…the record's numbers", [DEFAULT_DAILY_CEILING, DEFAULT_ORG_DAILY_LIMIT], [375, 50]);
      eq("…set by the deployment", platformEmailLimits({ PLATFORM_EMAIL_DAILY_CEILING: "1500", PLATFORM_EMAIL_ORG_DAILY_LIMIT: "20" }), { dailyCeiling: 1500, orgDailyLimit: 20 });
      eq("…a value that is not a positive whole number falls back to the default", platformEmailLimits({ PLATFORM_EMAIL_DAILY_CEILING: "0", PLATFORM_EMAIL_ORG_DAILY_LIMIT: "ten" }), { dailyCeiling: 375, orgDailyLimit: 50 });

      fresh();
      const half = { ...ENV }; delete half.PLATFORM_SMTP_PASSWORD;
      eq("a send while not configured: failed, not_configured, one row, nothing dispatched", [short(await send(code(ADMIN_A, ORG_A), half)), sends().length, rows.map((r) => [r.status, r.error_code])], [["failed", "not_configured", true], 0, [["failed", "not_configured"]]]);
      fresh();
      const noAllow = { ...ENV }; delete noAllow.PLATFORM_EMAIL_ALLOW_DOMAINS;
      eq("the allow-list unset: suppressed, not_allowed, nothing dispatched", [short(await send(code(ADMIN_A, ORG_A), noAllow)), sends().length], [["suppressed", "not_allowed", true], 0]);
    }

    console.log("\na send: the payload, the row");
    {
      fresh();
      const r = await send(code(ADMIN_A, ORG_A));
      eq("sent, one row", short(r), ["sent", null, true]);
      const p = JSON.parse(sends()[0].body) as Record<string, unknown>;
      eq("the payload carries the platform's settings and the fixed text", [p.host, p.port, p.secure, p.user, p.from, p.to, p.subject], ["smtp.platform.stub", 465, true, SMTP_USER, FROM, ADMIN_A.email, "Your LMS password reset code"]);
      eq("…no Reply-To unless set", "replyTo" in p && p.replyTo !== undefined, false);
      eq("…the request is bounded by a signal (the 15 s wait)", sends()[0].init?.signal instanceof AbortSignal, true);
      eq("the row: the event, the organisation, the user id, sent; no address, no content", rows.map((x) => [x.event_type, x.organization_id, x.to_user_id, x.status, x.error_code, x.error_detail]), [["platform_reset_code", ORG_A, ADMIN_A.userId, "sent", null, null]]);
      eq("the insert names only the log's columns", Object.keys(JSON.parse(inserts()[0].body)).sort(), ["error_code", "error_detail", "event_type", "organization_id", "status", "to_user_id"]);
      fresh();
      await send(code(ADMIN_A, ORG_A), { ...ENV, PLATFORM_EMAIL_REPLY_TO: "help@platform-owner.stub", PLATFORM_SMTP_SECURE: "" , PLATFORM_SMTP_PORT: "587" });
      const p2 = JSON.parse(sends()[0].body) as Record<string, unknown>;
      eq("Reply-To when set; secure unset reads false on 587", [p2.replyTo, p2.secure, p2.port], ["help@platform-owner.stub", false, 587]);
      fresh();
      await send(code(ADMIN_A, ORG_A), { ...ENV, PLATFORM_SMTP_SECURE: "" });
      eq("…and true on 465", (JSON.parse(sends()[0].body) as Record<string, unknown>).secure, true);
    }

    console.log("\nthe order of section F");
    {
      fresh();
      seed(5, { to_user_id: ADMIN_A.userId, event_type: "platform_reset_code" }, (i) => 5 + i);
      eq("1. the account limit comes first: an account at its limit with a reserved-domain address is refused, not suppressed", short(await send(code({ ...ADMIN_A, email: "admin@tenant-a.test" }, ORG_A))), ["refused", "account_limit", true]);
      fresh();
      seed(DEFAULT_DAILY_CEILING, { status: "sent" }, () => 30);
      eq("2. a reserved test domain is suppressed before the ceiling is read", [short(await send(welcome({ ...ADMIN_A, email: "admin@tenant-a.test" }, ORG_A))), reads().length, sends().length], [["suppressed", "test_domain", true], 0, 0]);
      eq("…the allow-list before the ceiling", [short(await send(welcome(ADMIN_A, ORG_A), { ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: "tenant-b.stub" })), sends().length], [["suppressed", "not_allowed", true], 0]);
      fresh();
      seed(DEFAULT_DAILY_CEILING, { status: "sent", event_type: "platform_sign_in_link", organization_id: ORG_A }, () => 30);
      eq("3. the organisation limit before the ceiling", short(await send(link(ADMIN_A, ORG_A))), ["refused", "org_limit", true]);
      eq("…then the ceiling", short(await send(link(ADMIN_B, ORG_B))), ["refused", "ceiling", true]);
      const half = { ...ENV }; delete half.PLATFORM_SMTP_HOST;
      eq("4. the ceiling before \"not configured\"", short(await send(link(ADMIN_B, ORG_B), half)), ["refused", "ceiling", true]);
      fresh();
      eq("…\"not configured\" before the send", [short(await send(link(ADMIN_B, ORG_B), half)), sends().length], [["failed", "not_configured", true], 0]);
      eq("5. then the send", short(await send(link(ADMIN_B, ORG_B))), ["sent", null, true]);
    }

    console.log("\nreserved test domains, on any environment, and the allow-list");
    {
      const reserved = ["a@x.test", "a@test", "a@x.example", "a@x.invalid", "a@localhost", "a@x.localhost", "a@example.com", "a@mail.example.com", "a@example.net", "a@example.org", "a@EXAMPLE.ORG"];
      fresh();
      const got: unknown[] = [];
      for (const email of reserved) got.push((await send(welcome({ ...ADMIN_A, email }, ORG_A), { ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: "*" })).errorCode);
      eq(`each reserved domain is suppressed even with the allow-list "*" (${reserved.length})`, [got.every((g) => g === "test_domain"), sends().length], [true, 0]);
      eq("…a look-alike is not reserved", ["myexample.com", "test.stub", "example.co"].map(isReservedTestDomain), [false, false, false]);
      fresh();
      const list = { ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: "tenant-a.stub, @Tenant-B.stub" };
      eq("a listed domain sends (case and a leading @ ignored)", [(await send(welcome(ADMIN_A, ORG_A), list)).status, (await send(welcome(ADMIN_B, ORG_B), list)).status], ["sent", "sent"]);
      eq("…a subdomain of a listed one is not listed", (await send(welcome({ ...ADMIN_A, email: "a@mail.tenant-a.stub" }, ORG_A), list)).errorCode, "not_allowed");
      eq("…an unlisted one is suppressed", (await send(welcome({ ...ADMIN_A, email: "a@elsewhere.stub" }, ORG_A), list)).errorCode, "not_allowed");
      eq("…an address that is not one plain address is suppressed", (await send(welcome({ ...ADMIN_A, email: "a@b.stub, c@d.stub" }, ORG_A), list)).errorCode, "not_allowed");
      eq("only the two listed sends were dispatched", sends().length, 2);
    }

    console.log("\nthe allow-list takes exact addresses (note of 2026-11-20, part 1)");
    {
      const LISTED = "listed.person@tenant-a.stub";
      const as = (email: string) => ({ ...ADMIN_A, email });
      const send1 = async (email: string, list: string) => {
        fresh();
        const r = await send(welcome(as(email), ORG_A), { ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: list });
        return [short(r), sends().length, rows.length];
      };
      eq("an address entry lets that address through", await send1(LISTED, LISTED), [["sent", null, true], 1, 1]);
      eq("…whatever the letter case of the recipient", await send1("Listed.Person@TENANT-A.stub", LISTED), [["sent", null, true], 1, 1]);
      eq("…whatever the letter case of the entry, with spaces and commas around it", await send1(LISTED, "  , LISTED.Person@Tenant-A.STUB ,  "), [["sent", null, true], 1, 1]);
      eq("…and with spaces around the recipient's address", await send1(`  ${LISTED} `, LISTED), [["sent", null, true], 1, 1]);
      eq("another address at the same domain: suppressed, not_allowed, one row, no dispatch", await send1("other.person@tenant-a.stub", LISTED), [["suppressed", "not_allowed", true], 0, 1]);
      eq("a dot variant is another address", await send1("listedperson@tenant-a.stub", LISTED), [["suppressed", "not_allowed", true], 0, 1]);
      eq("a \"+tag\" variant is another address", await send1("listed.person+spec@tenant-a.stub", LISTED), [["suppressed", "not_allowed", true], 0, 1]);
      eq("…unless it is listed by itself", await send1("listed.person+spec@tenant-a.stub", `${LISTED} listed.person+spec@tenant-a.stub`), [["sent", null, true], 1, 1]);
      eq("a domain entry still allows the whole domain", await send1("anyone@tenant-a.stub", "tenant-a.stub"), [["sent", null, true], 1, 1]);
      eq("…and an \"@domain\" entry", await send1("anyone@tenant-a.stub", "@tenant-a.stub"), [["sent", null, true], 1, 1]);
      eq("\"*\" alone allows every domain that is not reserved", await send1("anyone@elsewhere.stub", "*"), [["sent", null, true], 1, 1]);
      eq("\"*\" beside addresses allows everything too", await send1("anyone@elsewhere.stub", `${LISTED}, *`), [["sent", null, true], 1, 1]);
      const mixed = `${LISTED} tenant-b.stub`;
      eq("an address and a domain in one list: the address works", await send1(LISTED, mixed), [["sent", null, true], 1, 1]);
      eq("…the domain works", await send1("anyone@tenant-b.stub", mixed), [["sent", null, true], 1, 1]);
      eq("…and another address at the address's domain does not", await send1("other.person@tenant-a.stub", mixed), [["suppressed", "not_allowed", true], 0, 1]);
      eq("an address entry at a reserved test domain is still suppressed with test_domain", await send1("listed.person@spec.test", "listed.person@spec.test"), [["suppressed", "test_domain", true], 0, 1]);
      eq("…and so is one at example.com", await send1("someone@example.com", "someone@example.com"), [["suppressed", "test_domain", true], 0, 1]);
      for (const bad of ["a@@tenant-a.stub", "a@b@tenant-a.stub", "listed.person@", "@", "not_a_domain!", "tenant-a..stub", "@a@tenant-a.stub"]) {
        eq(`a malformed entry "${bad}" beside a good one matches nothing, and the good one still works`, [await send1("a@tenant-a.stub", `${bad} tenant-b.stub`), (await send1("anyone@tenant-b.stub", `${bad} tenant-b.stub`))[0]], [[["suppressed", "not_allowed", true], 0, 1], ["sent", null, true]]);
      }
      const onlyBad = "a@@tenant-a.stub, listed.person@ ,@";
      eq("a list of only malformed entries names the variable as missing, as a list of only separators does", platformSenderReadiness({ ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: onlyBad }), { configured: false, missing: ["PLATFORM_EMAIL_ALLOW_DOMAINS"] });
      eq("…and nothing is dispatched (not_allowed, as for an unset list)", await send1("a@tenant-a.stub", onlyBad), [["suppressed", "not_allowed", true], 0, 1]);
      eq("a list of exact addresses is configured", platformSenderReadiness({ ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: `${LISTED} second.person@tenant-a.stub` }), { configured: true, missing: [] });
      fresh(); printed = [];
      const secretList = `${LISTED} hidden.second@tenant-c.stub tenant-d.stub`;
      await send(welcome(as("other.person@tenant-a.stub"), ORG_A), { ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: secretList });
      await send(welcome(as(LISTED), ORG_A), { ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: secretList });
      // A listed send the mail server refuses writes a log line: the case reads a log that is there.
      smtpAnswer = async () => json({ ok: false, error: "421 4.7.0 try again later" });
      await send(welcome(as(LISTED), ORG_A), { ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: secretList });
      eq("…the privacy case reads a log that holds lines (a refused send wrote one)", printed.length > 0, true);
      const answer = JSON.stringify(platformSenderReadiness({ ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: secretList })) + JSON.stringify(platformSenderReadiness({ ...ENV, PLATFORM_EMAIL_ALLOW_DOMAINS: onlyBad }));
      const stored = JSON.stringify(rows) + inserts().map((i) => i.body).join("\n");
      const logText = printed.join("\n");
      eq("no row, log line or readiness answer holds the list or an address", ["listed.person", "hidden.second", "tenant-c.stub", "tenant-d.stub", "@"].filter((x) => stored.includes(x) || logText.includes(x) || answer.includes(x)), []);
    }

    console.log("\na limit that cannot be read sends nothing and writes nothing");
    {
      fresh(); failRead = "rows";
      eq("the account read fails: nothing sent, no row", [short(await send(code(ADMIN_A, ORG_A))), sends().length, inserts().length], [["failed", "log_unreadable", false], 0, 0]);
      fresh(); failRead = "count";
      eq("the organisation count fails: the same", [short(await send(code(ADMIN_A, ORG_A))), sends().length, inserts().length], [["failed", "log_unreadable", false], 0, 0]);
      fresh(); failRead = "count";
      eq("the ceiling count fails (a welcome): the same", [short(await send(welcome(ADMIN_A, ORG_A))), sends().length, inserts().length], [["failed", "log_unreadable", false], 0, 0]);
      fresh(); tableMissing = true;
      const all = [await send(code(ADMIN_A, ORG_A)), await send(link(OWNER, null)), await send(test()), await send(welcome(ADMIN_A, ORG_A)), await send(alert(ADMIN_A, ORG_A))];
      eq("the table not there yet (0113 not pasted): every event sends nothing", [all.map((r) => r.errorCode), sends().length, inserts().length], [["log_unreadable", "log_unreadable", "log_unreadable", "log_unreadable", "log_unreadable"], 0, 0]);
      eq("…and the line logged names the class, not the person", printed.slice(-5).every((l) => /log_unreadable/.test(l) && !l.includes("@")), true);
    }

    console.log("\nthe account limits (section G)");
    {
      fresh();
      seed(4, { to_user_id: ADMIN_A.userId, event_type: "platform_sign_in_link" }, (i) => 10 + i);
      eq("four links in the hour: the fifth is sent", (await send(link(ADMIN_A, ORG_A))).status, "sent");
      eq("…the sixth is refused, with one refused row", [short(await send(link(ADMIN_A, ORG_A))), rows.filter((r) => r.status === "refused").length], [["refused", "account_limit", true], 1]);
      eq("…the seventh in that hour writes no further row", [short(await send(link(ADMIN_A, ORG_A))), rows.filter((r) => r.status === "refused").length, sends().length], [["refused", "account_limit", false], 1, 1]);
      eq("…another kind for the same account is counted on its own", (await send(code(ADMIN_A, ORG_A))).status, "sent");
      eq("…another account is not touched", (await send(link(ADMIN_B, ORG_B))).status, "sent");
      fresh();
      seed(5, { to_user_id: ADMIN_A.userId, event_type: "platform_sign_in_link" }, (i) => 61 + i);
      seed(1, { to_user_id: ADMIN_A.userId, event_type: "platform_sign_in_link", status: "refused", error_code: "account_limit" }, () => 70);
      eq("an hour later the hourly limit has passed (its refused row is not an attempt)", (await send(link(ADMIN_A, ORG_A))).status, "sent");
      fresh();
      seed(10, { to_user_id: ADMIN_A.userId, event_type: "platform_reset_code" }, (i) => 90 + i * 60);
      eq("ten codes in the day, none in the hour: an administrator is refused (the daily limit)", short(await send(code(ADMIN_A, ORG_A))), ["refused", "account_limit", true]);
      seed(10, { to_user_id: OWNER.userId, event_type: "platform_reset_code" }, (i) => 90 + i * 60);
      eq("…a platform owner's own code is sent (hourly limit only)", (await send(code(OWNER, null))).status, "sent");
      seed(10, { to_user_id: OWNER.userId, event_type: "platform_sign_in_link" }, (i) => 90 + i * 60);
      eq("…and the owner's own link", (await send(link(OWNER, null))).status, "sent");
      seed(5, { to_user_id: OWNER.userId, event_type: "platform_reset_code" }, (i) => 1 + i);
      eq("…but five owner codes in the hour refuse the next one", short(await send(code(OWNER, null))), ["refused", "account_limit", true]);
      fresh();
      seed(10, { to_user_id: OWNER.userId, event_type: "platform_test" }, (i) => 90 + i * 60);
      eq("the test keeps its daily limit for the owner (10 a day)", short(await send(test())), ["refused", "account_limit", true]);
      fresh();
      seed(5, { to_user_id: OWNER.userId, event_type: "platform_test" }, (i) => 1 + i);
      eq("…and its hourly limit (5 an hour)", short(await send(test())), ["refused", "account_limit", true]);
      fresh();
      seed(6, { to_user_id: OWNER.userId, event_type: "platform_test", status: "suppressed", error_code: "not_allowed" }, (i) => 1 + i);
      seed(6, { to_user_id: OWNER.userId, event_type: "platform_test", status: "failed", error_code: "not_configured" }, (i) => 1 + i);
      eq("the test counts only sends that reached the mail server: twelve suppressed or not-configured tests in the hour, the next is sent", short(await send(test())), ["sent", null, true]);
      fresh();
      seed(2, { to_user_id: OWNER.userId, event_type: "platform_test" }, (i) => 1 + i);
      seed(2, { to_user_id: OWNER.userId, event_type: "platform_test", status: "failed", error_code: "auth" }, (i) => 3 + i);
      seed(1, { to_user_id: OWNER.userId, event_type: "platform_test", status: "failed", error_code: "rejected" }, () => 6);
      seed(3, { to_user_id: OWNER.userId, event_type: "platform_test", status: "failed", error_code: "not_configured" }, (i) => 7 + i);
      eq("…a failed send that reached it counts (two sent, two auth, one rejected: the sixth is refused)", short(await send(test())), ["refused", "account_limit", true]);
      fresh();
      seed(30, { to_user_id: ADMIN_A.userId, event_type: "platform_admin_welcome", organization_id: ORG_A }, () => 5);
      eq("welcomes and alerts have no account limit", [(await send(welcome(ADMIN_A, ORG_A))).status, (await send(alert(ADMIN_A, ORG_A))).status], ["sent", "sent"]);
      fresh();
      seed(4, { to_user_id: ADMIN_A.userId, event_type: "platform_reset_code", status: "suppressed", error_code: "test_domain" }, (i) => 1 + i);
      seed(1, { to_user_id: ADMIN_A.userId, event_type: "platform_reset_code", status: "refused", error_code: "ceiling" }, () => 2);
      eq("every request counts, whatever its outcome (four suppressed and one refused by the ceiling: the sixth is refused)", short(await send(code(ADMIN_A, ORG_A))), ["refused", "account_limit", true]);
    }

    console.log("\nthe organisation limit (section G)");
    {
      fresh();
      seed(DEFAULT_ORG_DAILY_LIMIT, { status: "sent", event_type: "platform_reset_code", organization_id: ORG_A }, (i) => 30 + i);
      eq("organisation A at 50 sent codes and links: its administrator is refused", short(await send(code(ADMIN_A, ORG_A))), ["refused", "org_limit", true]);
      eq("…organisation B's administrator still sends", (await send(code(ADMIN_B, ORG_B))).status, "sent");
      eq("…an alert for A is outside the limit", (await send(alert(ADMIN_A, ORG_A))).status, "sent");
      eq("…a welcome for A is outside the limit", (await send(welcome(ADMIN_A, ORG_A))).status, "sent");
      eq("…a platform owner's own code is outside it", (await send(code(OWNER, null))).status, "sent");
      fresh();
      seed(49, { status: "sent", event_type: "platform_sign_in_link", organization_id: ORG_A }, (i) => 30 + i);
      seed(20, { status: "sent", event_type: "tenant_smtp_alert", organization_id: ORG_A }, (i) => 30 + i);
      seed(20, { status: "sent", event_type: "platform_admin_welcome", organization_id: ORG_A }, (i) => 30 + i);
      seed(20, { status: "failed", error_code: "timeout", event_type: "platform_reset_code", organization_id: ORG_A }, (i) => 30 + i);
      seed(5, { status: "sent", event_type: "platform_reset_code", organization_id: ORG_A }, () => 25 * 60);
      eq("only sent codes and links of the last 24 hours count (49 of them: the next is sent)", (await send(code(ADMIN_A, ORG_A))).status, "sent");
      eq("…then the 51st is refused", (await send(code(ADMIN_A, ORG_A))).errorCode, "org_limit");
      fresh();
      seed(3, { status: "sent", event_type: "platform_reset_code", organization_id: ORG_A }, () => 30);
      eq("the deployment's PLATFORM_EMAIL_ORG_DAILY_LIMIT is used", (await send(code(ADMIN_A, ORG_A), { ...ENV, PLATFORM_EMAIL_ORG_DAILY_LIMIT: "3" })).errorCode, "org_limit");
    }

    console.log("\nthe ceiling (section G)");
    {
      fresh();
      seed(DEFAULT_DAILY_CEILING, { status: "sent", event_type: "platform_admin_welcome" }, () => 60);
      eq(`${DEFAULT_DAILY_CEILING} sent in 24 hours (the default): an administrator's code is refused`, short(await send(code(ADMIN_A, ORG_A))), ["refused", "ceiling", true]);
      eq("…a welcome is refused", (await send(welcome(ADMIN_A, ORG_A))).errorCode, "ceiling");
      eq("…an alert is refused", (await send(alert(ADMIN_A, ORG_A))).errorCode, "ceiling");
      eq("…a platform owner's own code, link and test are sent", [(await send(code(OWNER, null))).status, (await send(link(OWNER, null))).status, (await send(test())).status], ["sent", "sent", "sent"]);
      fresh();
      seed(DEFAULT_DAILY_CEILING - 1, { status: "sent" }, () => 60);
      seed(50, { status: "failed", error_code: "auth" }, () => 60);
      seed(50, { status: "sent" }, () => 25 * 60);
      eq("only sent rows of the last 24 hours count (one under: sent)", (await send(code(ADMIN_A, ORG_A))).status, "sent");
      fresh();
      seed(2, { status: "sent" }, () => 60);
      eq("the deployment's PLATFORM_EMAIL_DAILY_CEILING is used", (await send(code(ADMIN_A, ORG_A), { ...ENV, PLATFORM_EMAIL_DAILY_CEILING: "2" })).errorCode, "ceiling");
    }

    console.log("\nthe welcome goes to each of the add-admin route's three roles");
    // The welcome's fixed lines that name a password: the setup link's lead-in and the way after it.
    const PASSWORD_LINES = ["Set your own password with this link:", "After that, choose \"Forgot password?\" on the sign-in page."];
    for (const role of ["super_owner", "admin", "data_analyst"] as const) {
      fresh();
      // A caller that slips a password into the content (not a field of the type): it is never sent.
      const req = welcome(ADMIN_A, ORG_A, role);
      const sentinel = "Sentinel-Pass-0029!";
      const r = await send({ ...req, content: { ...req.content, password: sentinel } as typeof req.content });
      const p = JSON.parse(sends()[0]?.body ?? "{}") as { text?: string; html?: string; subject?: string };
      // The link's own line names its path (/auth/set-password), not a password.
      const passwordLines = (p.text ?? "").split("\n").filter((l) => /password/i.test(l) && l !== SETUP_LINK);
      eq(`${role}: sent, with the role and the setup link in the text; the only lines about a password are the fixed ones, and the slipped-in value is in no part of the mail`, [r.status, (p.text ?? "").includes("Your role:"), (p.text ?? "").includes(SETUP_LINK), passwordLines, [p.subject, p.text, p.html].some((x) => (x ?? "").includes(sentinel))], ["sent", true, true, PASSWORD_LINES, false]);
      eq(`${role}: no log row holds the setup link or its token`, inserts().some((i) => i.body.includes(SETUP_LINK.split("#t=")[1])), false);
    }

    console.log("\nthe password setting: a trailing line break is not part of it");
    {
      for (const [label, stored] of [["a trailing newline", `${PASSWORD}\n`], ["a trailing CR LF", `${PASSWORD}\r\n`]] as const) {
        fresh();
        await send(code(ADMIN_A, ORG_A), { ...ENV, PLATFORM_SMTP_PASSWORD: stored });
        eq(`stored with ${label}: the password sent is without it`, (JSON.parse(sends()[0].body) as Record<string, unknown>).pass, PASSWORD);
      }
      fresh();
      await send(code(ADMIN_A, ORG_A), { ...ENV, PLATFORM_SMTP_PASSWORD: "abcd efgh ijkl mnop" });
      eq("inner spaces are kept (an app password shown in groups)", (JSON.parse(sends()[0].body) as Record<string, unknown>).pass, "abcd efgh ijkl mnop");
    }

    console.log("\nthe test goes to a platform owner only; content is checked before anything is read");
    {
      fresh();
      let threw = "no throw";
      try { await sendPlatformEmail({ event: "platform_test", to: ADMIN_A, organizationId: null, content: {} }, { env: ENV }); } catch (e) { threw = e instanceof TypeError ? "TypeError" : String(e); }
      eq("a test to someone who is not a platform owner throws, and nothing is read or sent", [threw, requests.length], ["TypeError", 0]);
      threw = "no throw";
      try { await sendPlatformEmail({ event: "platform_reset_code", to: ADMIN_A, organizationId: ORG_A, content: { code: "12", minutes: 10 } }, { env: ENV }); } catch (e) { threw = (e as Error).name; }
      eq("a bad code throws before any request", [threw, requests.length], ["PlatformTemplateError", 0]);
      threw = "no throw";
      try { await sendPlatformEmail({ event: "password_reset" as PlatformEvent, to: ADMIN_A, organizationId: ORG_A, content: {} as never }, { env: ENV }); } catch (e) { threw = e instanceof TypeError ? "TypeError" : String(e); }
      eq("a tenant event is refused", [threw, requests.length], ["TypeError", 0]);
    }

    console.log("\nthe error classes (send-smtp's free text)");
    {
      // Strings the repository holds: send-smtp's own answers and the
      // dispatcher's (supabase/functions/send-smtp/index.ts,
      // lib/email/smtp-function.ts) and the runbook's lived case (ops/RUNBOOK.md §6.3).
      const recorded: Array<[string, string]> = [
        ["Timed out after 25000ms: SMTP send to smtp.platform.stub:465", "timeout"],
        [dispatchTimeoutMessage(15000), "timeout"],
        ["SMTP 535 BadCredentials", "auth"],
        ["Authentication failed", "auth"],
        ["Connection refused", "unreachable"],
        ["self signed certificate", "unreachable"],
        ["SMTP client construction failed: invalid hostname", "unreachable"],
        ["Gmail SMTP requires port 465 with implicit TLS (Secure = on) in this app due to a denomailer/STARTTLS incompatibility on port 587. Update notification settings to: host=smtp.gmail.com, port=465, secure=true.", "unreachable"],
        ["Edge Function returned HTTP 503.", "unreachable"],
        ["Edge Function returned HTTP 404.", "unreachable"],
        ["Edge Function returned HTTP 400.", "unknown"],
        ["Edge Function rejected service-role bearer.", "unknown"],
        ["SUPABASE_SERVICE_ROLE_KEY missing.", "unknown"],
        ["Unknown SMTP error.", "unknown"],
        ["invalid cmd", "unknown"],
      ];
      for (const [m, c] of recorded) eq(`recorded: "${m.slice(0, 60)}" → ${c}`, classifySmtpError(m), c);
      // Representative provider replies (their documented shapes, not
      // captured from this system): until real messages are recorded on
      // staging, these hold the table to the providers' published codes.
      const representative: Array<[string, string]> = [
        ["535-5.7.8 Username and Password not accepted. For more information, go to 535 5.7.8 https://support.google.com/mail/?p=BadCredentials", "auth"],
        ["534-5.7.9 Application-specific password required.", "auth"],
        ["535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.", "auth"],
        ["550-5.4.5 Daily user sending limit exceeded.", "quota"],
        ["554 5.2.0 STOREDRV.Submission.Exception:SubmissionQuotaExceededException", "quota"],
        ["454 Throttling failure: Maximum sending rate exceeded.", "quota"],
        ["550 5.1.1 The email account that you tried to reach does not exist.", "rejected"],
        ["failed to lookup address information: Name or service not known", "unreachable"],
        ["invalid peer certificate: UnknownIssuer", "unreachable"],
      ];
      for (const [m, c] of representative) eq(`representative: "${m.slice(0, 60)}" → ${c}`, classifySmtpError(m), c);
      // The sides kept apart: a recipient's refusal never reads as a sender's
      // failure (that would mark a working sender dead), and a sender's
      // failure never reads as a recipient's refusal (that would hide a dead
      // sender). Representative shapes as above.
      const sides: Array<[string, string]> = [
        ["552 5.2.2 Mailbox quota exceeded", "rejected"],
        ["452 4.2.2 The email account that you tried to reach is over quota. Mailbox is full; quota exceeded", "rejected"],
        ["552-5.2.2 The recipient's mailbox is full", "rejected"],
        ["550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup", "rejected"],
        ["550 5.7.1 Recipient address rejected: Access denied", "rejected"],
        ["554 5.2.2 mailbox full; STOREDRV.Submission.Exception:SubmissionQuotaExceededException", "quota"],
        ["550 5.2.2 Submission quota exceeded", "quota"],
        ["553 5.1.8 Sender address rejected: Domain not found", "unknown"],
        ["450 4.1.8 Sender address rejected: Domain not found", "unknown"],
        ["553 5.7.1 Sender address rejected: not owned by user", "unknown"],
        ["552 5.3.4 Message size limit exceeded", "unknown"],
        ["421 4.7.0 Try again later, closing connection (rate limit)", "unknown"],
      ];
      for (const [m, c] of sides) eq(`one side only: "${m.slice(0, 60)}" → ${c}`, classifySmtpError(m), c);
      eq("empty or missing text → unknown", [classifySmtpError(""), classifySmtpError(undefined), classifySmtpError(null)], ["unknown", "unknown", "unknown"]);
      eq("a port number is not a reply code (no auth from :535)", classifySmtpError("SMTP send to host:535 failed oddly"), "unknown");

      for (const [m, c] of [["535 5.7.8 Username and Password not accepted", "auth"], ["550 5.1.1 User unknown", "rejected"], ["Timed out after 25000ms: SMTP send to smtp.platform.stub:465", "timeout"]] as const) {
        fresh();
        smtpAnswer = async () => json({ ok: false, error: m });
        const r = await send(code(ADMIN_A, ORG_A));
        eq(`a send answered "${m.slice(0, 40)}": failed, ${c}, its detail kept`, [short(r), rows[0]?.error_code, typeof rows[0]?.error_detail], [["failed", c, true], c, "string"]);
      }
      fresh();
      smtpAnswer = async () => new Response("", { status: 503 });
      eq("send-smtp answers 503: failed, unreachable", short(await send(code(ADMIN_A, ORG_A))), ["failed", "unreachable", true]);
    }

    console.log("\nthe wait: 15 s for a send, a fixed message, and today's request without a timeout");
    {
      eq("rule T1: one wait for both systems, 15 s, kept in smtp-function.ts and read by the platform sender", [SMTP_SEND_WAIT_MS, PLATFORM_SEND_TIMEOUT_MS], [15000, 15000]);
      fresh();
      smtpAnswer = () => new Promise<Response>(() => {});
      const hang = (_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          const s = init?.signal;
          s?.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
        });
      globalThis.fetch = hang as typeof fetch;
      const t0 = Date.now();
      const r = await dispatchSmtp({ host: "h", port: 465, secure: true, from: "f", to: "t", subject: "s", html: "h", text: "t" }, { timeoutMs: 60 });
      const took = Date.now() - t0;
      globalThis.fetch = stub as typeof fetch;
      eq("a hung function answers the fixed timeout text after the wait", [r.ok, r.error, took >= 50 && took < 2000], [false, "Timed out after 60ms waiting for the send-smtp function.", true]);
      eq("…which reads as timeout", classifySmtpError(r.error), "timeout");
      fresh();
      await dispatchSmtp({ host: "h", port: 465, secure: true, from: "f", to: "t", subject: "s", html: "h", text: "t" });
      eq("without a timeout the request is the one send.ts made before the move (method, headers, body; no signal)", Object.keys(sends()[0].init ?? {}).sort(), ["body", "headers", "method"]);
    }

    console.log("\nno secret value and no address in any log line or row");
    {
      fresh(); printed = [];
      smtpAnswer = async () => json({ ok: false, error: `535 5.7.8 Authentication failed for ${SMTP_USER} with password ${PASSWORD} sending to ${ADMIN_A.email}; key ${SERVICE_KEY}; From ${FROM}` });
      await send(code(ADMIN_A, ORG_A));
      tableMissing = true; await send(code(ADMIN_A, ORG_A)); tableMissing = false;
      const half = { ...ENV }; delete half.PLATFORM_SMTP_HOST; await send(code(ADMIN_B, ORG_B), half);
      await send(welcome({ ...ADMIN_A, email: "x@tenant-a.test" }, ORG_A));
      const secrets = [PASSWORD, SMTP_USER, SERVICE_KEY, FROM, ADMIN_A.email, ADMIN_B.email, "x@tenant-a.test", "platform-owner.stub"];
      const rowText = JSON.stringify(rows) + inserts().map((i) => i.body).join("\n");
      eq("the rows hold no secret, no address, no '@'", [secrets.filter((s) => rowText.includes(s)), rowText.includes("@")], [[], false]);
      eq("the detail is kept, scrubbed and short", [rows[0].error_code, rows[0].error_detail!.length <= 200, rows[0].error_detail!.includes("[redacted]")], ["auth", true, true]);
      const logText = printed.join("\n");
      eq(`the log lines (${printed.length}) hold no secret and no address`, [printed.length > 0, secrets.filter((s) => logText.includes(s)), logText.includes("@")], [true, [], false]);
      eq("scrubErrorDetail cuts to 200 characters after scrubbing", scrubErrorDetail("word ".repeat(100) + "a@b.stub", []).length, 200);
      eq("…and removes an address it was not told about", scrubErrorDetail("rejected by someone@else.stub today", []), "rejected by [address] today");
      eq("…collapses line breaks", scrubErrorDetail("a\r\nb\tc", []), "a b c");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
