/**
 * The CRM sign-in rule: POST /api/integrations/sso-link signs in exactly the
 * member the request named.
 *
 *   - the link goes to the member's login address as the auth server holds it
 *     for their user id, never to the profile copy of the address;
 *   - a request that names the member by email gets a link only when that
 *     email is their login address (trimmed, ignoring case); any other
 *     address gets the same 404 as no member, and no link is issued;
 *   - a failed read of the account (an error, or an account with no address)
 *     answers 503 and issues no link;
 *   - a link the auth server reports for any other user id is never handed
 *     back (500);
 *   - an account that signs in through an identity provider (a provider named
 *     "sso:<id>" on app_metadata.provider, app_metadata.providers or an
 *     identity; any one is enough) gets the same 404 as no member, and no link
 *     is requested for its address;
 *   - resolveMember finds a profile only by its exact address, ignoring case:
 *     `%`, `_` and `\` are escaped in the pattern, and the row that comes back
 *     must carry the address asked for (which also covers `*`, a wildcard to
 *     PostgREST).
 *
 * Today's rules stay: an admin account is refused (403) with no read of the
 * auth server, a target outside the organisation is refused (400), and
 * return_url arms embedded mode.
 *
 * The real route, lib/integrations/auth.ts and supabase-js under a stubbed
 * fetch. No database, no network.
 *
 * Run:  npx tsx tests/unit/crm-sign-in-link.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import { createClient } from "@supabase/supabase-js";
import { resolveMember } from "../../lib/integrations/auth";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [], set() {} }),
      headers: async () => new Headers({ host: "lms.test", "x-forwarded-proto": "https" }),
    };
  }
  return load.call(this, request, ...rest);
};

/* ---------------- the world behind the stub ---------------- */
const SUPABASE = "http://stub.supabase.test";
const ORG = "org-1";
const KEY = "ambk_" + "0".repeat(48);
const TOKEN_HASH = "pkTokenHashSentinel4b8e1d7c3a9f";

// User ids are UUIDs: the auth client refuses any other id before it sends.
const U_MOVED = "11111111-1111-4111-8111-111111111111"; // profile copy differs from the login address
const U_SAME = "22222222-2222-4222-8222-222222222222";
const U_ADMIN = "33333333-3333-4333-8333-333333333333";
const U_ALICE = "44444444-4444-4444-8444-444444444444";
const U_UNDERSCORE = "55555555-5555-4555-8555-555555555555";
const U_NO_ADDRESS = "66666666-6666-4666-8666-666666666666";
const U_OTHER = "77777777-7777-4777-8777-777777777777";
const U_FRESH = "88888888-8888-4888-8888-888888888888"; // an account the route never named
// Accounts that sign in through an identity provider, each carrying one signal only.
const U_IDP_PROVIDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U_IDP_PROVIDERS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U_IDP_IDENTITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// A password account with an ordinary social sign-in linked: not an identity-provider account.
const U_LINKED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const IDP_PROVIDER = "sso:99999999-9999-4999-8999-999999999999";

/** auth.users: id → login address */
const AUTH: Record<string, string> = {
  [U_MOVED]: "current@example.test",
  [U_SAME]: "same@example.test",
  [U_ADMIN]: "admin@example.test",
  [U_ALICE]: "alice@example.test",
  [U_UNDERSCORE]: "first_last@example.test",
  [U_NO_ADDRESS]: "",
  [U_OTHER]: "other@example.test",
  [U_IDP_PROVIDER]: "idp-provider@example.test",
  [U_IDP_PROVIDERS]: "idp-providers@example.test",
  [U_IDP_IDENTITY]: "idp-identity@example.test",
  [U_LINKED]: "linked@example.test",
};
const identity = (id: string, provider: string) => ({ id: `${provider}-${id}`, identity_id: `${provider}-${id}`, user_id: id, provider });
/** auth.users: the provider fields the admin read sends; every other account is a password account */
const ACCOUNT_SHAPE: Record<string, { app_metadata: Record<string, unknown>; identities: unknown[] }> = {
  [U_IDP_PROVIDER]: { app_metadata: { provider: IDP_PROVIDER }, identities: [] },
  [U_IDP_PROVIDERS]: { app_metadata: { providers: [IDP_PROVIDER] }, identities: [] },
  [U_IDP_IDENTITY]: { app_metadata: {}, identities: [identity(U_IDP_IDENTITY, IDP_PROVIDER)] },
  [U_LINKED]: {
    app_metadata: { provider: "email", providers: ["email", "google"] },
    identities: [identity(U_LINKED, "email"), identity(U_LINKED, "google")],
  },
};
const shapeOf = (id: string) => ACCOUNT_SHAPE[id] ?? { app_metadata: { provider: "email", providers: ["email"] }, identities: [identity(id, "email")] };
/** The accounts that sign in through an identity provider (the stub's own list, not the route's rule). */
const IDP_ACCOUNTS = new Set([U_IDP_PROVIDER, U_IDP_PROVIDERS, U_IDP_IDENTITY]);
/** profiles: the display copy of the address */
const PROFILES = [
  { id: U_MOVED, email: "previous@example.test" },
  { id: U_SAME, email: "same@example.test" },
  { id: U_ADMIN, email: "admin@example.test" },
  { id: U_ALICE, email: "alice@example.test" },
  { id: U_UNDERSCORE, email: "first_last@example.test" },
  { id: U_NO_ADDRESS, email: "no-address@example.test" },
  { id: U_IDP_PROVIDER, email: "idp-provider@example.test" },
  { id: U_IDP_PROVIDERS, email: "idp-providers@example.test" },
  { id: U_IDP_IDENTITY, email: "idp-identity@example.test" },
  { id: U_LINKED, email: "linked@example.test" },
];
const MEMBERS = [
  // An id the auth client refuses before it sends (it throws).
  { user_id: "not-a-uuid", role: "user", employee_id: "E-BAD-ID" },
  { user_id: U_MOVED, role: "user", employee_id: "E-MOVED" },
  { user_id: U_SAME, role: "user", employee_id: "E-SAME" },
  { user_id: U_ADMIN, role: "admin", employee_id: "E-ADMIN" },
  { user_id: U_ALICE, role: "user", employee_id: "E-ALICE" },
  { user_id: U_UNDERSCORE, role: "user", employee_id: "E-UNDERSCORE" },
  { user_id: U_NO_ADDRESS, role: "user", employee_id: "E-NO-ADDRESS" },
  { user_id: U_IDP_PROVIDER, role: "user", employee_id: "E-IDP-PROVIDER" },
  { user_id: U_IDP_PROVIDERS, role: "user", employee_id: "E-IDP-PROVIDERS" },
  { user_id: U_IDP_IDENTITY, role: "user", employee_id: "E-IDP-IDENTITY" },
  { user_id: U_LINKED, role: "user", employee_id: "E-LINKED" },
].map((m) => ({ ...m, organization_id: ORG, status: "active" }));

type Req = { method: string; path: string; query: URLSearchParams; body: unknown };
let requests: Req[] = [];
let authReadFails = false;
let mintFor: "same" | "other" | "none" = "same";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const eqOf = (q: URLSearchParams, k: string) => (q.get(k) ?? "").replace(/^eq\./, "");
const reEscape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * PostgREST's `ilike`: `*` is an alias of `%` (every `*`), then LIKE with `\`
 * as the escape character, without case.
 */
const ilike = (pattern: string, value: string) => {
  const p = pattern.replace(/\*/g, "%");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) re += reEscape(p[++i]);
    else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += reEscape(c);
  }
  return new RegExp(`^${re}$`, "i").test(value);
};

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: unknown = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  requests.push({ method, path: url.pathname, query: url.searchParams, body });
  const p = url.pathname;
  const q = url.searchParams;

  if (p === "/rest/v1/org_api_keys") {
    if (method !== "GET") return new Response(null, { status: 204 });
    return json([{ id: "key-1", organization_id: ORG, is_active: true, organizations: { slug: "org", deleted_at: null } }]);
  }
  if (p === "/rest/v1/profiles") {
    if (q.has("id")) return json(PROFILES.filter((r) => r.id === eqOf(q, "id")));
    const pattern = (q.get("email") ?? "").replace(/^ilike\./, "");
    return json(PROFILES.filter((r) => ilike(pattern, r.email)));
  }
  if (p === "/rest/v1/organization_members") {
    return json(MEMBERS.filter((m) =>
      m.organization_id === eqOf(q, "organization_id") &&
      m.status === eqOf(q, "status") &&
      (!q.has("user_id") || m.user_id === eqOf(q, "user_id")) &&
      (!q.has("employee_id") || m.employee_id === eqOf(q, "employee_id"))
    ).map(({ user_id, role, employee_id }) => ({ user_id, role, employee_id })));
  }
  const userPath = p.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
  if (userPath && method === "GET") {
    if (authReadFails) return json({ code: 500, error_code: "unexpected_failure", msg: "Unexpected failure" }, 500);
    const id = userPath[1];
    if (!(id in AUTH)) return json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
    return json({ id, aud: "authenticated", role: "authenticated", email: AUTH[id], ...shapeOf(id), user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
  }
  if (p === "/auth/v1/admin/generate_link") {
    const email = (body as { email: string }).email;
    // The stub resolves an address only to an account outside IDP_ACCOUNTS;
    // any other address gets a link for U_FRESH, a user id the route never
    // named and must never hand back.
    const owner = Object.keys(AUTH).find((id) => AUTH[id] !== "" && AUTH[id] === email.toLowerCase() && !IDP_ACCOUNTS.has(id));
    const id = mintFor === "other" ? U_OTHER : owner ?? U_FRESH;
    const user = mintFor === "none" ? {} : { id, aud: "authenticated", role: "authenticated", email: AUTH[id] ?? email, ...shapeOf(id), user_metadata: {} };
    return json({ ...user, action_link: "https://stub/verify", email_otp: "000000", hashed_token: TOKEN_HASH, redirect_to: "", verification_type: "magiclink" });
  }
  return json([]);
};

const mints = () => requests.filter((r) => r.path === "/auth/v1/admin/generate_link");
const mintedAddress = () => (mints()[0]?.body as { email?: string } | undefined)?.email ?? null;
const authAdminReads = () => requests.filter((r) => r.path.startsWith("/auth/v1/admin/")).length;
const profileFilters = () => requests.filter((r) => r.path === "/rest/v1/profiles").map((r) => r.query.get("email"));

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings: string[] = [];
  globalThis.fetch = stub as typeof fetch;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  try {
    const route = await import("../../app/api/integrations/sso-link/route");
    const ask = async (payload: Record<string, string>) => {
      // Let the key check's fire-and-forget usage write land before the next case.
      await new Promise((r) => setTimeout(r, 0));
      requests = [];
      const res = await route.POST(new Request("http://lms.test/api/integrations/sso-link", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: JSON.stringify(payload),
      }));
      const text = await res.text();
      let parsed: { login_url?: string; error?: string } = {};
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, body: parsed };
    };

    // The no-member answer, captured from this run.
    const nobody = await ask({ email: "nobody@example.test" });
    console.log("\nno member: 404, nothing minted");
    eq("404", nobody.status, 404);
    eq("no link minted", mints().length, 0);

    console.log("\nthe link goes to the login address the auth server holds, not the profile copy");
    {
      const r = await ask({ employee_id: "E-MOVED" });
      eq("200", r.status, 200);
      eq("one link minted", mints().length, 1);
      eq("…to the address the auth server holds for that user id", mintedAddress(), AUTH[U_MOVED]);
      eq("one read of that account on the auth server", requests.filter((q) => q.path === `/auth/v1/admin/users/${U_MOVED}`).length, 1);
      eq("the login_url carries the token", (r.body.login_url ?? "").includes(`token_hash=${TOKEN_HASH}`), true);
    }

    console.log("\nnamed by email: the address must be the login address");
    {
      const r = await ask({ email: "previous@example.test" });
      eq("the profile copy of the address: the same status and body as no member", [r.status, r.text], [nobody.status, nobody.text]);
      eq("…no link minted", mints().length, 0);
      eq("…no login_url", r.body.login_url ?? null, null);
    }
    {
      const r = await ask({ email: "  SAME@Example.TEST " });
      eq("the login address, other case and spacing: 200", r.status, 200);
      eq("…one link, to the login address", [mints().length, mintedAddress()], [1, AUTH[U_SAME]]);
    }
    {
      const r = await ask({ employee_id: "E-MOVED", email: "unrelated@example.test" });
      eq("employee_id and email: the person is named by employee_id, the email is not read (as today)", [r.status, mintedAddress()], [200, AUTH[U_MOVED]]);
    }

    console.log("\na failed read of the account: 503, nothing minted");
    {
      authReadFails = true;
      const logged = warnings.length;
      const r = await ask({ employee_id: "E-SAME" });
      authReadFails = false;
      eq("the auth server answers an error: 503", r.status, 503);
      eq("…the error itself is read: its code is logged", warnings.slice(logged).some((w) => w.includes('"code":"unexpected_failure"')), true);
      eq("…account_lookup_unavailable", r.body.error ?? null, "account_lookup_unavailable");
      eq("…no link minted", mints().length, 0);
    }
    {
      const r = await ask({ employee_id: "E-NO-ADDRESS" });
      eq("an account with no address: 503", r.status, 503);
      eq("…no link minted, and the profile copy is not used", mints().length, 0);
    }
    {
      const r = await ask({ employee_id: "E-BAD-ID" });
      eq("the auth client throws: 503, no link minted", [r.status, mints().length], [503, 0]);
    }

    console.log("\nthe auth server reports another user for the link: 500, no link");
    for (const mode of ["other", "none"] as const) {
      mintFor = mode;
      const r = await ask({ employee_id: "E-SAME" });
      mintFor = "same";
      eq(`${mode === "other" ? "a different user id" : "no user id"}: 500`, r.status, 500);
      eq("…no login_url", r.body.login_url ?? null, null);
      eq("…no token anywhere in the answer", r.text.includes(TOKEN_HASH), false);
    }

    console.log("\nan account that signs in through an identity provider: no link, the same answer as no member");
    for (const [label, id, employeeId] of [
      ["app_metadata.provider names an identity provider", U_IDP_PROVIDER, "E-IDP-PROVIDER"],
      ["app_metadata.providers lists an identity provider", U_IDP_PROVIDERS, "E-IDP-PROVIDERS"],
      ["an identity comes from an identity provider", U_IDP_IDENTITY, "E-IDP-IDENTITY"],
    ] as const) {
      const r = await ask({ employee_id: employeeId });
      eq(`${label}: the same status and body as no member`, [r.status, r.text], [nobody.status, nobody.text]);
      eq("…no link requested", mints().length, 0);
      eq("…the one call to the auth server is the read of that account", requests.filter((q) => q.path.startsWith("/auth/v1/admin/")).map((q) => q.path), [`/auth/v1/admin/users/${id}`]);
    }
    {
      const r = await ask({ email: "idp-identity@example.test" });
      eq("named by email: the same answer as no member, no link requested", [r.status, r.text, mints().length], [nobody.status, nobody.text, 0]);
    }
    {
      const r = await ask({ employee_id: "E-LINKED" });
      eq("a password account with a social sign-in linked: 200, its own link", [r.status, mints().length, mintedAddress()], [200, 1, AUTH[U_LINKED]]);
      eq("…the login_url carries the token", (r.body.login_url ?? "").includes(`token_hash=${TOKEN_HASH}`), true);
    }

    console.log("\nan email finds only its exact address: no character is a wildcard");
    eq("(the stub's ilike reads unescaped `%`, `_`, `\\` and `*` as patterns, escaped ones literally)",
      [ilike("al%@example.test", "alice@example.test"), ilike("al_ce@example.test", "alice@example.test"), ilike("al\\ice@example.test", "alice@example.test"), ilike("al*@example.test", "alice@example.test"),
        ilike("al\\%@example.test", "alice@example.test"), ilike("al\\_ce@example.test", "alice@example.test"), ilike("al\\\\ice@example.test", "alice@example.test")],
      [true, true, true, true, false, false, false]);
    {
      const r = await ask({ email: "al%@example.test" });
      eq("`%`: the pattern sent is escaped", profileFilters(), ["ilike.al\\%@example.test"]);
      eq("…the same answer as no member, nothing minted", [r.status, r.text, mints().length], [nobody.status, nobody.text, 0]);
    }
    {
      const r = await ask({ email: "al_ce@example.test" });
      eq("`_`: the pattern sent is escaped", profileFilters(), ["ilike.al\\_ce@example.test"]);
      eq("…the same answer as no member, nothing minted", [r.status, r.text, mints().length], [nobody.status, nobody.text, 0]);
    }
    {
      const r = await ask({ email: "al\\ice@example.test" });
      eq("`\\`: the pattern sent is escaped", profileFilters(), ["ilike.al\\\\ice@example.test"]);
      eq("…the same answer as no member, nothing minted", [r.status, r.text, mints().length], [nobody.status, nobody.text, 0]);
    }
    {
      const r = await ask({ email: "first_last@example.test" });
      eq("an address with a real `_` still matches: 200, its own link", [r.status, mintedAddress()], [200, AUTH[U_UNDERSCORE]]);
    }

    console.log("\nresolveMember on its own (the rule also serves learner-summary)");
    {
      const svc = createClient(SUPABASE, "stub-service-role-key", { auth: { persistSession: false } });
      const found = async (email: string) => (await resolveMember(svc, ORG, { email }))?.userId ?? null;
      eq("`*` (a wildcard to PostgREST): no member", await found("al*@example.test"), null);
      eq("`%`: no member", await found("al%@example.test"), null);
      eq("`_`: no member", await found("al_ce@example.test"), null);
      eq("`\\`: no member", await found("al\\ice@example.test"), null);
      eq("the address itself, other case: the member", await found(" ALICE@example.test "), U_ALICE);
      eq("an address with a real `_`: the member", await found("first_last@example.test"), U_UNDERSCORE);
      eq("by employee_id: unchanged", (await resolveMember(svc, ORG, { employee_id: "E-ALICE" }))?.userId ?? null, U_ALICE);
    }

    console.log("\ntoday's rules stay");
    {
      const r = await ask({ employee_id: "E-ADMIN" });
      eq("an admin account: 403", r.status, 403);
      eq("…no read of the auth server and no link", authAdminReads(), 0);
      const byEmail = await ask({ email: "admin@example.test" });
      eq("…named by email too", [byEmail.status, authAdminReads()], [403, 0]);
    }
    {
      const r = await ask({ employee_id: "E-SAME", target: "/elsewhere/dashboard" });
      eq("a target outside the organisation: 400", r.status, 400);
      eq("…no link minted", mints().length, 0);
    }
    {
      const r = await ask({ employee_id: "E-SAME", target: "/org/courses/c-1/launch", return_url: "https://crm.example.test/learning" });
      const next = new URL(r.body.login_url ?? "http://x/").searchParams.get("next") ?? "";
      eq("target and return_url: 200", r.status, 200);
      eq("…the link goes through embedded mode to the target", next, `/api/integrations/enter?to=${encodeURIComponent("/org/courses/c-1/launch")}&return_url=${encodeURIComponent("https://crm.example.test/learning")}`);
    }
    {
      const r = await ask({ employee_id: "E-SAME", return_url: "http://crm.example.test/learning" });
      eq("a return_url that is not https: 400", [r.status, mints().length], [400, 0]);
    }
    {
      const r = await ask({});
      eq("neither employee_id nor email: 400", r.status, 400);
    }

    console.log("\nlogs");
    eq("the refusals above were logged", ["sso_link_account_unreadable", "sso_link_user_mismatch", "sso_link_identity_provider_account"].map((e) => warnings.some((w) => w.includes(e))), [true, true, true]);
    eq("no log line carries an address", warnings.filter((w) => w.includes("@")).length, 0);
    eq("no log line carries a provider id", warnings.filter((w) => w.includes(IDP_PROVIDER.slice(4))).length, 0);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "test crashed");
  process.exit(1);
});
