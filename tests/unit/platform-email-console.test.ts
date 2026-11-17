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
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/platform-email-console.test.ts   (or npm run test:unit)
 */
import Module from "node:module";

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

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") return { cookies: async () => jar, headers: async () => new Headers({ host: "lms.test" }) };
  return load.call(this, request, ...rest);
};

type Req = { method: string; path: string; body: string };
let requests: Req[] = [];
let logRows: Array<Record<string, unknown>> = [];
let auditRows: Array<Record<string, unknown>> = [];
let logMissing = false;
let adminEmail: string | null = OWNER.email;
let ownerMfaRequired = false;
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
  if (p === "/functions/v1/send-smtp") return json({ ok: true });
  throw new Error(`stub: unexpected ${method} ${p}`);
};
const fresh = () => { requests = []; logRows = []; auditRows = []; logMissing = false; adminEmail = OWNER.email; ownerMfaRequired = false; browser.clear(); };
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
