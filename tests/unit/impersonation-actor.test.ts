/**
 * Unit tests for the tenant impersonation session's tie to the platform owner
 * who started it (lib/auth/impersonation.ts), on the real code under a stubbed
 * next/headers cookie jar and a stubbed fetch (the precedent of
 * result-stored-route.test.ts). The jar stands for one browser: every request
 * a case makes reads and writes the same cookies.
 *
 *   - getImpersonation(): the owner who started the session gets it; any other
 *     signed-in user holding the same cookie gets none; signed out, a forged,
 *     malformed, expired, ended or revoked cookie gets none; no cookie costs
 *     no request at all;
 *   - requireOrgAccess(): a member holding the owner's cookie keeps their own
 *     membership role; the owner is answered super_owner on top of their own
 *     membership that counts (ADR 0030), and an owner with no membership row
 *     there is sent back to /super/organizations;
 *   - GET /api/super/impersonate answers the session to its owner only;
 *   - sign-out ends the session (row stamped, cookie deleted) before it signs
 *     out, and still signs out when ending it fails;
 *   - the other server routes that change the browser's sign-in end it too:
 *     the sign-in callback in each shape (?token_hash=, ?code= for Google and
 *     PKCE links, and the fragment hand-off), invitation accept, password
 *     change and the forgot-password reset (the owner resetting their own
 *     password, signed in or not, and another account's); a source check
 *     keeps every such route on the one shared helper.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/impersonation-actor.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { hashResetToken } from "../../lib/auth/password-reset";

let pass = 0, fail = 0;
/** `todo`, when given, is printed under a failure: what to change to pass. */
const eq = (n: string, got: unknown, want: unknown, todo?: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else {
    fail++;
    console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    if (todo) console.log(`      what to do: ${todo}`);
  }
};

type Row = Record<string, unknown>;
type User = { id: string; aud: string; role: string; email: string; email_confirmed_at: string };
type Req = { method: string; path: string; query: URLSearchParams; body: string };

const SUPABASE = "http://stub.supabase.test";
const AUTH_COOKIE = "sb-stub-auth-token";
const IMP_COOKIE = "lms_impersonation";
// The ids are UUID-shaped: auth.admin.updateUserById checks them.
const OWNER: User = { id: "6c1e0a6e-0000-4000-8000-00000000a001", aud: "authenticated", role: "authenticated", email: "owner@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
const MEMBER: User = { id: "6c1e0a6e-0000-4000-8000-00000000b001", aud: "authenticated", role: "authenticated", email: "member@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
const TOKENS: Record<string, User> = { "tok-owner": OWNER, "tok-member": MEMBER };
const ORG = { id: "org-1", name: "Acme", slug: "acme", logo_url: null, brand_color: null, brand_font: null, custom_domain: null, deleted_at: null };
const session = (token: string) =>
  ({ access_token: token, refresh_token: `r-${token}`, token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: TOKENS[token] });
// The forgot-password reset token the /verify step handed this browser.
const RESET_TOKEN = "reset-token-1";

// ---- the browser: one cookie jar for every request of a case ----
const browser = new Map<string, string>();
let deleted: string[] = [];
const jar = {
  get: (name: string) => (browser.has(name) ? { name, value: browser.get(name)! } : undefined),
  getAll: () => [...browser].map(([name, value]) => ({ name, value })),
  has: (name: string) => browser.has(name),
  set: (name: string, value: string, opts?: { maxAge?: number }) => {
    if (value === "" || opts?.maxAge === 0) browser.delete(name);
    else browser.set(name, value);
  },
  delete: (name: string) => { deleted.push(name); browser.delete(name); },
};
// Sign-ins the auth server has ended (see the admin password PUT below).
const revoked = new Set<string>();
const signIn = (token: string | null) => {
  for (const k of [...browser.keys()]) if (k.startsWith(AUTH_COOKIE)) browser.delete(k);
  if (token) { revoked.delete(token); browser.set(AUTH_COOKIE, JSON.stringify(session(token))); }
};

// The code under test reaches the request only through next/headers.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return { cookies: async () => jar, headers: async () => new Headers({ host: "lms.test" }) };
  }
  return load.call(this, request, ...rest);
};

// ---- the server side the stub answers from ----
const rows = new Map<string, Row>();
let nextId = 1;
let ignoreActorFilter = false;
let authDown = false;
let passwordUpdateFails = false;
let adminPasswordUpdateFails = false;
const roles: Record<string, string> = {};
let requests: Req[] = [];
let errors: string[] = [];
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const eqParam = (q: URLSearchParams, k: string) => q.get(k)?.replace(/^eq\./, "") ?? null;
const bearer = (h: Headers) => (h.get("authorization") ?? "").replace(/^Bearer /, "");

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = typeof init?.body === "string" ? init.body : "";
  const p = url.pathname;
  const q = url.searchParams;
  requests.push({ method, path: p, query: q, body });
  const object = (headers.get("accept") ?? "").includes("vnd.pgrst.object");

  if (p === "/auth/v1/user" && method === "GET") {
    if (authDown) throw new TypeError("fetch failed");
    const token = bearer(headers);
    if (revoked.has(token)) return json({ code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }, 403);
    const u = TOKENS[token];
    return u ? json(u) : json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
  }
  if (p === "/auth/v1/user" && method === "PUT") {
    if (passwordUpdateFails) return json({ code: 422, error_code: "same_password", msg: "New password should be different." }, 422);
    return json(TOKENS[bearer(headers)]);
  }
  if (p === "/auth/v1/logout") return new Response(null, { status: 204 });
  if (p === "/auth/v1/verify") return json(session("tok-member"));
  if (p === "/auth/v1/token" && q.get("grant_type") === "password") return json(session("tok-member"));
  if (p === "/auth/v1/token" && q.get("grant_type") === "pkce") return json(session("tok-member"));
  if (p === "/auth/v1/admin/users") return json({ users: [MEMBER, OWNER], aud: "authenticated" });
  if (p.startsWith("/auth/v1/admin/users/") && method === "PUT") {
    if (adminPasswordUpdateFails) return json({ code: 422, error_code: "weak_password", msg: "Password is known to be weak." }, 422);
    const u = [MEMBER, OWNER].find((x) => p === `/auth/v1/admin/users/${x.id}`);
    // Modelled as the hosted auth server is believed to behave, not checked
    // here: a password set with the service role ends all of that user's
    // sign-ins (a user's own updateUser keeps the caller's).
    if (u && "password" in (JSON.parse(body || "{}") as Row)) {
      for (const [t, x] of Object.entries(TOKENS)) if (x.id === u.id) revoked.add(t);
    }
    return u ? json(u) : json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
  }

  if (p === "/rest/v1/platform_impersonation_sessions") {
    if (method === "POST") {
      const ins = JSON.parse(body) as Row;
      const id = `0f8fad5b-d9cb-469f-a165-7086772895${String(nextId++).padStart(2, "0")}`;
      const now = Date.now();
      const row = { id, ...ins, started_at: new Date(now).toISOString(), expires_at: new Date(now + 3600_000).toISOString(), ended_at: null, revoked_at: null };
      rows.set(id, row);
      return json(object ? row : [row], 201);
    }
    if (method === "GET") {
      const id = eqParam(q, "id");
      const actor = eqParam(q, "actor_user_id");
      const found = [...rows.values()].filter((r) => r.id === id && (ignoreActorFilter || actor === null || r.actor_user_id === actor));
      return json(object ? found[0] ?? null : found);
    }
    if (method === "PATCH") {
      const id = eqParam(q, "id");
      const row = id ? rows.get(id) : undefined;
      if (row) Object.assign(row, JSON.parse(body) as Row);
      return new Response(null, { status: 204 });
    }
  }
  if (p === "/rest/v1/password_reset_otps") {
    if (method !== "GET") return new Response(null, { status: 204 });
    const otp = { id: "otp-1", reset_token_hash: hashResetToken(RESET_TOKEN), reset_token_expires: new Date(Date.now() + 600_000).toISOString(), used_at: null };
    return json(object ? otp : [otp]);
  }
  if (p === "/rest/v1/profiles") return method === "GET" ? json([{ must_change_password: false }]) : new Response(null, { status: 204 });
  if (p === "/rest/v1/organizations") return json([ORG]);
  if (p === "/rest/v1/organization_members") {
    if (method !== "GET") return new Response(null, { status: 201 });
    const role = roles[eqParam(q, "user_id") ?? ""];
    return json(role ? [{ role, status: "active" }] : []);
  }
  if (p === "/rest/v1/platform_owners") return json(eqParam(q, "user_id") === OWNER.id ? [{ user_id: OWNER.id }] : []);
  if (p === "/rest/v1/invitations") {
    if (method !== "GET") return new Response(null, { status: 204 });
    return json([{ id: "inv-1", organization_id: ORG.id, email: MEMBER.email, role: "user", accepted_at: null, expires_at: "2100-01-01T00:00:00Z" }]);
  }
  unmatched.push(`${method} ${p}`);
  return json([]);
};

/** A fresh browser, server and request log. */
const fresh = () => {
  browser.clear();
  rows.clear();
  revoked.clear();
  for (const k of Object.keys(roles)) delete roles[k];
  requests = []; deleted = []; errors = [];
  ignoreActorFilter = false; authDown = false; passwordUpdateFails = false; adminPasswordUpdateFails = false;
};
const writes = () => requests.filter((r) => r.path === "/rest/v1/platform_impersonation_sessions" && r.method === "PATCH");
const indexOf = (pred: (r: Req) => boolean) => requests.findIndex(pred);

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.IMPERSONATION_SECRET = "stub-impersonation-secret";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")); };
  try {
    const imp = await import("../../lib/auth/impersonation");
    const { requireOrgAccess } = await import("../../lib/auth/require-org-access");
    const impersonateRoute = await import("../../app/api/super/impersonate/route");
    const signOutRoute = await import("../../app/auth/sign-out/route");
    const callbackRoute = await import("../../app/auth/callback/route");
    const acceptRoute = await import("../../app/api/invitations/accept/route");
    const passwordRoute = await import("../../app/api/auth/change-password/route");
    const resetRoute = await import("../../app/api/auth/forgot-password/reset/route");

    /** The owner signs in on a fresh browser and starts an impersonation of ORG. */
    const ownerStarts = async () => {
      fresh();
      signIn("tok-owner");
      const id = await imp.startImpersonation({ actorUserId: OWNER.id, targetOrgId: ORG.id, reason: "unit test" });
      requests = []; deleted = [];
      return id;
    };
    const read = async () => {
      requests = [];
      const s = await imp.getImpersonation();
      return { s, calls: requests.map((r) => `${r.method} ${r.path}`) };
    };

    console.log("\ngetImpersonation: the session applies to the owner who started it");
    {
      const id = await ownerStarts();
      eq("startImpersonation sets the signed cookie for the new row", [browser.has(IMP_COOKIE), browser.get(IMP_COOKIE)?.startsWith(`${id}.`)], [true, true]);
      const own = await read();
      eq("the owner gets the session for the target organisation", [own.s?.id, own.s?.actor_user_id, own.s?.target_org_id], [id, OWNER.id, ORG.id]);
      const rowRead = requests.find((r) => r.path === "/rest/v1/platform_impersonation_sessions");
      eq("…the row read names the session id and the signed-in user", [rowRead && eqParam(rowRead.query, "id"), rowRead && eqParam(rowRead.query, "actor_user_id")], [id, OWNER.id]);

      signIn("tok-member");
      const other = await read();
      eq("another signed-in user holding the same cookie gets no impersonation", other.s, null);
      eq("…and the session row stays active for its owner", rows.get(id)?.ended_at, null);
      ignoreActorFilter = true;
      eq("…even when the row read ignores the user filter (the comparison in code decides)", (await read()).s, null);
      ignoreActorFilter = false;

      signIn(null);
      const out = await read();
      eq("signed out with a valid cookie: no impersonation, no row read", [out.s, out.calls.filter((c) => c.includes("/rest/v1/")).length], [null, 0]);

      signIn("tok-owner");
      authDown = true;
      eq("the sign-in check failing answers no impersonation (fails closed)", (await read()).s, null);
      authDown = false;
      eq("the owner signed back in still gets it", (await read()).s?.id, id);
    }

    console.log("\ngetImpersonation: missing, forged, expired, ended, revoked");
    {
      fresh();
      signIn("tok-owner");
      const none = await read();
      eq("no cookie: null and no request at all", [none.s, none.calls.length], [null, 0]);

      const id = await ownerStarts();
      const good = browser.get(IMP_COOKIE)!;
      browser.set(IMP_COOKIE, `${id}.${"0".repeat(64)}`);
      const forged = await read();
      eq("a forged signature: null, no request at all", [forged.s, forged.calls.length], [null, 0]);
      browser.set(IMP_COOKIE, id);
      eq("a cookie without a signature: null", (await read()).s, null);
      browser.set(IMP_COOKIE, `0f8fad5b-d9cb-469f-a165-708677289599.${good.slice(good.indexOf(".") + 1)}`);
      eq("another session id under this session's signature: null", (await read()).s, null);

      browser.set(IMP_COOKIE, good);
      rows.get(id)!.expires_at = new Date(Date.now() - 1000).toISOString();
      eq("an expired row: null for the owner too", (await read()).s, null);
      rows.get(id)!.expires_at = new Date(Date.now() + 3600_000).toISOString();
      rows.get(id)!.ended_at = new Date().toISOString();
      eq("an ended row: null", (await read()).s, null);
      rows.get(id)!.ended_at = null;
      rows.get(id)!.revoked_at = new Date().toISOString();
      eq("a revoked row: null", (await read()).s, null);
    }

    console.log("\nrequireOrgAccess: every caller inherits the check");
    {
      await ownerStarts();
      // ADR 0030: the impersonation answer is given only on top of the
      // owner's own membership that counts; with no row the owner is sent
      // back, as a non-member is (/super/organizations for a platform owner).
      const noRow = await requireOrgAccess(ORG.slug).then(
        () => "answered",
        (e: unknown) => String((e as { digest?: unknown })?.digest ?? e).split(";")[2] ?? "error"
      );
      eq("the owner with no membership row is sent back to /super/organizations, never answered super_owner", noRow, "/super/organizations");
      roles[OWNER.id] = "user";
      const owner = await requireOrgAccess(ORG.slug);
      eq("the owner with an active membership is answered super_owner with the impersonation", [owner.role, owner.impersonation?.actorUserId], ["super_owner", OWNER.id]);
      delete roles[OWNER.id];

      signIn("tok-member");
      roles[MEMBER.id] = "user";
      const member = await requireOrgAccess(ORG.slug);
      eq("a member holding the owner's cookie keeps their own role, no impersonation", [member.user.id, member.role, member.impersonation], [MEMBER.id, "user", null]);
    }

    console.log("\nGET /api/super/impersonate");
    {
      const id = await ownerStarts();
      const own = (await (await impersonateRoute.GET()).json()) as { session: Row | null };
      eq("answers the session to its owner", own.session?.id, id);
      signIn("tok-member");
      const other = (await (await impersonateRoute.GET()).json()) as { session: Row | null };
      eq("answers null to anyone else holding the cookie", other.session, null);
    }

    const signOut = async (org?: string) => {
      requests = []; deleted = []; errors = [];
      const form = new FormData();
      if (org) form.set("org", org);
      const res = await signOutRoute.POST(new Request("http://lms.test/auth/sign-out", { method: "POST", body: form }));
      const logout = indexOf((r) => r.path === "/auth/v1/logout");
      const end = indexOf((r) => r.path === "/rest/v1/platform_impersonation_sessions" && r.method === "PATCH");
      return { status: res.status, location: res.headers.get("location") ?? "", logout, end };
    };

    console.log("\nsign-out ends the impersonation before it signs out");
    {
      const id = await ownerStarts();
      const r = await signOut(ORG.slug);
      eq("the owner signs out: 303 to the organisation's sign-in page", [r.status, r.location.endsWith(`/${ORG.slug}/login`)], [303, true]);
      eq("…the session row is stamped ended", typeof rows.get(id)?.ended_at, "string");
      eq("…the stamp names that row only", writes().map((w) => eqParam(w.query, "id")), [id]);
      eq("…the cookie is deleted", [deleted.includes(IMP_COOKIE), browser.has(IMP_COOKIE)], [true, false]);
      eq("…the row is ended before the sign-out call", [r.end >= 0, r.logout >= 0, r.end < r.logout], [true, true, true]);
      signIn("tok-owner");
      eq("…signing back in does not bring it back", (await read()).s, null);
    }
    {
      const id = await ownerStarts();
      signIn("tok-member");
      const r = await signOut();
      eq("another user signs out holding the owner's cookie: 303 to /login, signed out", [r.status, r.location.endsWith("/login"), r.logout >= 0], [303, true, true]);
      eq("…the cookie is deleted", browser.has(IMP_COOKIE), false);
      eq("…the owner's row is not theirs to end", [rows.get(id)?.ended_at, writes().length], [null, 0]);
    }
    {
      fresh();
      signIn("tok-member");
      const r = await signOut(ORG.slug);
      eq("no impersonation cookie: signs out with no impersonation request", [r.status, r.logout >= 0, requests.filter((q) => q.path.startsWith("/rest/v1/")).length], [303, true, 0]);
    }
    {
      const id = await ownerStarts();
      delete process.env.IMPERSONATION_SECRET;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      let r: Awaited<ReturnType<typeof signOut>> | null = null;
      try { r = await signOut(); } finally {
        process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
        process.env.IMPERSONATION_SECRET = "stub-impersonation-secret";
      }
      eq("ending fails (no signing secret): sign-out still answers 303 and signs out", [r?.status, (r?.logout ?? -1) >= 0], [303, true]);
      eq("…the cookie is deleted all the same", browser.has(IMP_COOKIE), false);
      eq("…the failure is logged, the row untouched", [errors.some((e) => e.includes("[impersonation]")), rows.get(id)?.ended_at], [true, null]);
    }

    console.log("\nother server routes that change the browser's sign-in end it too");
    const NEXT = `/${ORG.slug}/dashboard`;
    const callback = (query: string) => {
      const qs = new URLSearchParams(query);
      qs.set("next", NEXT);
      return callbackRoute.GET(new Request(`http://lms.test/auth/callback?${qs}`));
    };
    const location = (res: Response) => [res.status >= 300 && res.status < 400, res.headers.get("location") ?? ""] as const;
    {
      const id = await ownerStarts();
      const res = await callback("token_hash=abc&type=magiclink");
      const end = indexOf((r) => r.path === "/rest/v1/platform_impersonation_sessions" && r.method === "PATCH");
      const verify = indexOf((r) => r.path === "/auth/v1/verify");
      const [redirected, to] = location(res);
      eq("email link callback (?token_hash=): redirects to next", [redirected, to.endsWith(NEXT)], [true, true]);
      eq("…the owner's row is ended before the link's sign-in", [typeof rows.get(id)?.ended_at, verify >= 0, end >= 0 && end < verify], ["string", true, true]);
      eq("…the cookie is deleted", browser.has(IMP_COOKIE), false);
    }
    {
      // The PKCE shape: a Google sign-in or a PKCE email link. The browser
      // holds the code verifier its sign-in started with.
      const id = await ownerStarts();
      browser.set(`${AUTH_COOKIE}-code-verifier`, JSON.stringify("verifier-1"));
      const res = await callback("code=code-1");
      const end = indexOf((r) => r.path === "/rest/v1/platform_impersonation_sessions" && r.method === "PATCH");
      const exchange = indexOf((r) => r.path === "/auth/v1/token" && r.query.get("grant_type") === "pkce");
      const sent = (exchange >= 0 ? JSON.parse(requests[exchange].body) : {}) as Row;
      const [redirected, to] = location(res);
      eq("callback with ?code= (Google, PKCE link): exchanges the code and redirects to next", [exchange >= 0, sent.auth_code, sent.code_verifier, redirected, to.endsWith(NEXT)], [true, "code-1", "verifier-1", true, true]);
      eq("…the owner's row is ended before the code exchange", [typeof rows.get(id)?.ended_at, end >= 0 && end < exchange], ["string", true]);
      eq("…the cookie is deleted", browser.has(IMP_COOKIE), false);
    }
    {
      // Neither shape: the tokens are in the URL fragment, and /auth/finish
      // signs in from the browser, where the HttpOnly cookie is out of reach,
      // so the hand-off is the server's last chance to end the session.
      const id = await ownerStarts();
      const realWarn = console.warn;
      console.warn = () => {};
      let res: Response;
      try { res = await callback(""); } finally { console.warn = realWarn; }
      const [redirected, to] = location(res);
      const signIns = requests.filter((r) => r.path === "/auth/v1/token" || r.path === "/auth/v1/verify").length;
      eq("callback with neither code nor token_hash: hands off to /auth/finish with next", [redirected, to.endsWith(`/auth/finish?next=${encodeURIComponent(NEXT)}`)], [true, true]);
      eq("…the owner's row is ended on the way, with no sign-in request on the server", [typeof rows.get(id)?.ended_at, signIns], ["string", 0]);
      eq("…the cookie is deleted", browser.has(IMP_COOKIE), false);
    }
    {
      const id = await ownerStarts();
      const res = await acceptRoute.POST(new Request("http://lms.test/api/invitations/accept", { method: "POST", body: JSON.stringify({ token: "t1", password: "a-long-password-1" }) }));
      const end = indexOf((r) => r.path === "/rest/v1/platform_impersonation_sessions" && r.method === "PATCH");
      const signin = indexOf((r) => r.path === "/auth/v1/token");
      eq("invitation accept: answers ok", [res.status, ((await res.json()) as Row).ok], [200, true]);
      eq("…the owner's row is ended before the invited user is signed in", [typeof rows.get(id)?.ended_at, end >= 0 && end < signin], ["string", true]);
      eq("…the cookie is deleted", browser.has(IMP_COOKIE), false);
    }
    {
      const id = await ownerStarts();
      passwordUpdateFails = true;
      const bad = await passwordRoute.POST(new Request("http://lms.test/api/auth/change-password", { method: "POST", body: JSON.stringify({ new_password: "Another-Pass-1" }) }));
      eq("password change refused: 400, the impersonation stands", [bad.status, rows.get(id)?.ended_at, browser.has(IMP_COOKIE)], [400, null, true]);
      passwordUpdateFails = false;
      const ok = await passwordRoute.POST(new Request("http://lms.test/api/auth/change-password", { method: "POST", body: JSON.stringify({ new_password: "Another-Pass-1" }) }));
      eq("password changed: 200, the row ended and the cookie deleted", [ok.status, typeof rows.get(id)?.ended_at, browser.has(IMP_COOKIE)], [200, "string", false]);
    }
    // The forgot-password reset sets the password with the service role and
    // spends the reset token; then the browser signs in with the password.
    const reset = (who: User = OWNER) => {
      requests = []; deleted = [];
      return resetRoute.POST(new Request("http://lms.test/api/auth/forgot-password/reset", { method: "POST", body: JSON.stringify({ email: who.email, reset_token: RESET_TOKEN, new_password: "Another-Pass-1" }) }));
    };
    const adminPut = (who: User = OWNER) => indexOf((r) => r.path === `/auth/v1/admin/users/${who.id}` && r.method === "PUT");
    const tokenSpent = () => indexOf((r) => r.path === "/rest/v1/password_reset_otps" && r.method === "PATCH");
    // The reset route makes no sign-in check of its own: this one is the helper's.
    const userCheck = () => indexOf((r) => r.path === "/auth/v1/user" && r.method === "GET");
    {
      // The owner, still signed in and impersonating, resets their own
      // password on the same browser (by a direct POST or from another tab:
      // the page sends a signed-in user on). The password set ends the
      // owner's sign-ins (the stub's model), so the row can no longer be
      // shown to be theirs: the cookie goes and the row runs to its expiry.
      const id = await ownerStarts();
      adminPasswordUpdateFails = true;
      const bad = await reset();
      eq("forgot-password reset refused: 400, the impersonation stands", [bad.status, adminPut() >= 0, rows.get(id)?.ended_at, browser.has(IMP_COOKIE), writes().length], [400, true, null, true, 0]);
      adminPasswordUpdateFails = false;
      const ok = await reset();
      const put = adminPut();
      const sent = (put >= 0 ? JSON.parse(requests[put].body) : {}) as Row;
      eq("forgot-password reset: 200, the owner's password set", [ok.status, ((await ok.json()) as Row).ok, sent.password], [200, true, "Another-Pass-1"]);
      eq("…the impersonation is ended after the password is set and the token spent, and the cookie deleted",
        [put >= 0 && tokenSpent() > put, userCheck() > tokenSpent(), deleted.includes(IMP_COOKIE), browser.has(IMP_COOKIE)], [true, true, true, false]);
      eq("…the owner's sign-in ended with the password set, so the row runs to its expiry", [rows.get(id)?.ended_at, writes().length], [null, 0]);
      signIn("tok-owner");
      const back = await read();
      eq("…the owner signing back in with the new password has no impersonation, and no request is made", [back.s, back.calls.length], [null, 0]);
    }
    {
      // The owner's sign-in lapsed while impersonating, and they reset their
      // own password on the same browser. With no one signed in the row
      // cannot be shown to be theirs, so it is left to expire (as sign-out
      // leaves another user's); the cookie goes.
      const id = await ownerStarts();
      signIn(null);
      const ok = await reset();
      eq("forgot-password reset with the owner's sign-in lapsed: 200, the cookie deleted", [ok.status, deleted.includes(IMP_COOKIE), browser.has(IMP_COOKIE)], [200, true, false]);
      eq("…the row is left to expire, not ended by a signed-out request", [rows.get(id)?.ended_at, writes().length], [null, 0]);
      signIn("tok-owner");
      const back = await read();
      eq("…the owner signing back in with the new password has no impersonation, and no request is made", [back.s, back.calls.length], [null, 0]);
    }
    {
      // The owner, signed in and impersonating, resets another account's
      // password on the same browser. The owner's sign-in is untouched, so
      // the row is shown to be theirs and stamped ended.
      const id = await ownerStarts();
      const ok = await reset(MEMBER);
      const put = adminPut(MEMBER);
      const end = indexOf((r) => r.path === "/rest/v1/platform_impersonation_sessions" && r.method === "PATCH");
      eq("forgot-password reset of another account by the signed-in owner: 200, that account's password set", [ok.status, put >= 0, adminPut(OWNER)], [200, true, -1]);
      eq("…the owner's row is stamped ended after the password is set and the token spent, and the cookie deleted",
        [typeof rows.get(id)?.ended_at, put >= 0 && tokenSpent() > put && end > tokenSpent(), writes().map((w) => eqParam(w.query, "id")), deleted.includes(IMP_COOKIE), browser.has(IMP_COOKIE)],
        ["string", true, [id], true, false]);
    }

    console.log("\nsource check: every server route that changes the sign-in uses the shared helper");
    {
      const root = path.resolve(__dirname, "../..");
      const walk = (dir: string, out: string[]) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, out);
          else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
        }
      };
      const files: string[] = [];
      walk(path.join(root, "app"), files);
      walk(path.join(root, "lib"), files);
      // Calls on a Supabase auth client (`<x>.auth.<method>(...)`), parsed, so a
      // comment naming one does not count. A password change is
      // `<x>.auth.updateUser(attrs)` or, with the service role,
      // `<x>.auth.admin.updateUserById(id, attrs)`, when attrs may set one.
      const SIGN_IN_OUT = new Set(["signOut", "signInWithPassword", "signInWithIdToken", "exchangeCodeForSession", "verifyOtp", "setSession"]);
      const HELPER = "endImpersonationForSessionChange";
      // The server routes that change the browser's sign-in, each with a
      // behavioural case above.
      const KNOWN = [
        "app/api/auth/change-password/route.ts",
        "app/api/auth/forgot-password/reset/route.ts",
        "app/api/invitations/accept/route.ts",
        "app/auth/callback/route.ts",
        "app/auth/sign-out/route.ts",
      ];
      // The scan cannot tell this browser's password from another user's. A
      // route that sets another user's password (an admin action that leaves
      // this browser's sign-in alone) must not call the helper: it would end
      // the acting owner's own impersonation.
      const OTHERS = `if it only sets another user's password and this browser's sign-in does not change, do not call ${HELPER}() (it would end the acting owner's own impersonation): exempt the file from this check, with the reason, instead`;
      const ADD = `call ${HELPER}() from @/lib/auth/impersonation before the sign-in or sign-out (after a password change), add a behavioural case above, then add the file to KNOWN in this test; ${OTHERS}`;

      /** May these updateUser / updateUserById attributes set a password? An
       *  object literal only when it has a password key; anything the check cannot read (a
       *  variable, a spread, a computed key) counts, so it fails closed. */
      const setsPassword = (arg: ts.Expression | undefined) => {
        if (!arg) return false;
        if (!ts.isObjectLiteralExpression(arg)) return true;
        return arg.properties.some((p) => {
          if (ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) return true;
          return (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
            && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "password";
        });
      };
      /** Source positions of the sign-in changes, password changes and helper
       *  calls in one file; null for browser code ("use client"), which cannot
       *  reach the HttpOnly cookie (the read's user check covers it). */
      const scan = (file: string, src: string) => {
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const first = sf.statements[0];
        if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client") return null;
        const changes: number[] = [], passwords: number[] = [], helper: number[] = [];
        let imported = false;
        const visit = (n: ts.Node) => {
          if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === "@/lib/auth/impersonation") {
            const named = n.importClause?.namedBindings;
            if (named && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === HELPER)) imported = true;
          }
          if (ts.isCallExpression(n)) {
            const callee = n.expression;
            if (ts.isIdentifier(callee) && callee.text === HELPER) helper.push(n.getStart(sf));
            if (ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "auth") {
              if (SIGN_IN_OUT.has(callee.name.text)) changes.push(n.getStart(sf));
              if (callee.name.text === "updateUser" && setsPassword(n.arguments[0])) passwords.push(n.getStart(sf));
            }
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === "updateUserById"
              && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "admin"
              && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === "auth"
              && setsPassword(n.arguments[1])) passwords.push(n.getStart(sf));
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return { imported, changes, passwords, helper };
      };

      // The scan itself, on small sources.
      const probe = (src: string) => scan("probe.ts", src)!;
      const count = (src: string) => probe(src).passwords.length;
      eq("scan: an updateUser that sets only metadata is not a password change", [count("await s.auth.updateUser({ data: { name } });"), count("await s.auth.updateUser({ email });")], [0, 0]);
      eq("scan: a password key counts, written plain, shorthand or quoted", [count("s.auth.updateUser({ password: pw })"), count("s.auth.updateUser({ password })"), count(`s.auth.updateUser({ "password": pw, data: {} })`)], [1, 1, 1]);
      eq("scan: an updateUser argument it cannot read counts (a variable, a spread)", [count("s.auth.updateUser(attrs)"), count("s.auth.updateUser({ ...attrs })")], [1, 1]);
      eq("scan: a service-role auth.admin.updateUserById that sets a password counts; one that only confirms the email does not",
        [count("await svc.auth.admin.updateUserById(id, { password: pw })"), count("await a.svc.auth.admin.updateUserById(id, { password })"), count("await svc.auth.admin.updateUserById(id, { email_confirm: true })")], [1, 1, 0]);
      eq("scan: updateUserById attributes it cannot read count (a variable, a spread)", [count("svc.auth.admin.updateUserById(id, attrs)"), count("svc.auth.admin.updateUserById(id, { ...attrs })")], [1, 1]);
      const bare = probe("// s.auth.signOut()\nawait s.auth.signOut();");
      eq("scan: a sign-out with no helper call is found; a comment naming one is not", [bare.changes.length, bare.helper.length, bare.imported], [1, 0, false]);
      eq("scan: browser code is skipped", scan("probe.tsx", `"use client";\nawait s.auth.signOut();`), null);

      const sites: string[] = [];
      for (const f of files) {
        const r = scan(f, fs.readFileSync(f, "utf8"));
        if (!r || (r.changes.length === 0 && r.passwords.length === 0)) continue;
        const rel = path.relative(root, f).split(path.sep).join("/");
        sites.push(rel);
        eq(`${rel}: imports ${HELPER} from @/lib/auth/impersonation`, r.imported, true,
          `${rel}: import ${HELPER} from @/lib/auth/impersonation and call it before the sign-in or sign-out (after a password change)${r.passwords.length > 0 ? `; ${OTHERS}` : ""}`);
        if (r.changes.length > 0) {
          eq(`${rel}: ${HELPER}() is called earlier in the source than each sign-in or sign-out (position only; the cases above check the run-time order)`,
            r.changes.every((c) => r.helper.some((h) => h < c)), true,
            `${rel}: call ${HELPER}() before the sign-in or sign-out change, while the current user is still signed in`);
        }
        if (r.passwords.length > 0) {
          eq(`${rel}: ${HELPER}() is called later in the source than each updateUser or updateUserById that may set a password`,
            r.passwords.every((u) => r.helper.some((h) => h > u)), true,
            `${rel}: call ${HELPER}() after the password change succeeds; ${OTHERS}`);
        }
        eq(`${rel}: is on the known list of server routes that change the sign-in`, KNOWN.includes(rel), true,
          `${rel} changes the sign-in on the server: ${ADD}`);
      }
      for (const k of KNOWN) {
        eq(`${k}: on the known list and still changes the sign-in`, sites.includes(k), true,
          `${k} no longer signs in, signs out or sets a password on the server: remove it from KNOWN in this test, or update its path if it moved`);
      }
    }

    eq("the stub answered every request the code made", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
