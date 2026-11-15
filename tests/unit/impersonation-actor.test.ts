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
 *     membership role; the owner is answered super_owner;
 *   - GET /api/super/impersonate answers the session to its owner only;
 *   - sign-out ends the session (row stamped, cookie deleted) before it signs
 *     out, and still signs out when ending it fails;
 *   - the other server routes that change the browser's sign-in (the email
 *     link callback, invitation accept, password change) end it too, and a
 *     source check keeps every such route on the one shared helper.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/impersonation-actor.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type User = { id: string; aud: string; role: string; email: string; email_confirmed_at: string };
type Req = { method: string; path: string; query: URLSearchParams; body: string };

const SUPABASE = "http://stub.supabase.test";
const AUTH_COOKIE = "sb-stub-auth-token";
const IMP_COOKIE = "lms_impersonation";
const OWNER: User = { id: "owner-1", aud: "authenticated", role: "authenticated", email: "owner@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
const MEMBER: User = { id: "member-1", aud: "authenticated", role: "authenticated", email: "member@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
const TOKENS: Record<string, User> = { "tok-owner": OWNER, "tok-member": MEMBER };
const ORG = { id: "org-1", name: "Acme", slug: "acme", logo_url: null, brand_color: null, brand_font: null, custom_domain: null };
const session = (token: string) =>
  ({ access_token: token, refresh_token: `r-${token}`, token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: TOKENS[token] });

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
const signIn = (token: string | null) => {
  for (const k of [...browser.keys()]) if (k.startsWith(AUTH_COOKIE)) browser.delete(k);
  if (token) browser.set(AUTH_COOKIE, JSON.stringify(session(token)));
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
    const u = TOKENS[bearer(headers)];
    return u ? json(u) : json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
  }
  if (p === "/auth/v1/user" && method === "PUT") {
    if (passwordUpdateFails) return json({ code: 422, error_code: "same_password", msg: "New password should be different." }, 422);
    return json(TOKENS[bearer(headers)]);
  }
  if (p === "/auth/v1/logout") return new Response(null, { status: 204 });
  if (p === "/auth/v1/verify") return json(session("tok-member"));
  if (p === "/auth/v1/token" && q.get("grant_type") === "password") return json(session("tok-member"));
  if (p === "/auth/v1/admin/users") return json({ users: [MEMBER], aud: "authenticated" });

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
  if (p === "/rest/v1/profiles") return method === "GET" ? json([{ must_change_password: false }]) : new Response(null, { status: 204 });
  if (p === "/rest/v1/organizations") return json([ORG]);
  if (p === "/rest/v1/organization_members") {
    if (method !== "GET") return new Response(null, { status: 201 });
    const role = roles[eqParam(q, "user_id") ?? ""];
    return json(role ? [{ role }] : []);
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
  for (const k of Object.keys(roles)) delete roles[k];
  requests = []; deleted = []; errors = [];
  ignoreActorFilter = false; authDown = false; passwordUpdateFails = false;
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
      const owner = await requireOrgAccess(ORG.slug);
      eq("the owner (no membership) is answered super_owner with the impersonation", [owner.role, owner.impersonation?.actorUserId], ["super_owner", OWNER.id]);

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
    {
      const id = await ownerStarts();
      const res = await callbackRoute.GET(new Request(`http://lms.test/auth/callback?token_hash=abc&type=magiclink&next=${encodeURIComponent(`/${ORG.slug}/dashboard`)}`));
      const end = indexOf((r) => r.path === "/rest/v1/platform_impersonation_sessions" && r.method === "PATCH");
      const verify = indexOf((r) => r.path === "/auth/v1/verify");
      eq("email link callback: redirects to next", [res.status >= 300 && res.status < 400, (res.headers.get("location") ?? "").endsWith(`/${ORG.slug}/dashboard`)], [true, true]);
      eq("…the owner's row is ended before the link's sign-in", [typeof rows.get(id)?.ended_at, end >= 0 && end < verify], ["string", true]);
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
      // comment naming one does not count.
      const SIGN_IN_OUT = new Set(["signOut", "signInWithPassword", "signInWithIdToken", "exchangeCodeForSession", "verifyOtp", "setSession"]);
      const HELPER = "endImpersonationForSessionChange";
      const sites: string[] = [];
      for (const f of files) {
        const src = fs.readFileSync(f, "utf8");
        const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        // Browser code cannot reach the HttpOnly cookie; the read's user check covers it.
        const first = sf.statements[0];
        if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client") continue;
        const changes: number[] = [], updates: number[] = [], helper: number[] = [];
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
              if (callee.name.text === "updateUser") updates.push(n.getStart(sf));
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        if (changes.length === 0 && updates.length === 0) continue;
        const rel = path.relative(root, f).split(path.sep).join("/");
        sites.push(rel);
        eq(`${rel}: imports the helper from lib/auth/impersonation`, imported, true);
        eq(`${rel}: ends the impersonation before each sign-in or sign-out`, changes.every((c) => helper.some((h) => h < c)), true);
        eq(`${rel}: ends it after each password change`, updates.every((u) => helper.some((h) => h > u)), true);
      }
      eq("the server sites are the four known routes", sites.sort(), [
        "app/api/auth/change-password/route.ts",
        "app/api/invitations/accept/route.ts",
        "app/auth/callback/route.ts",
        "app/auth/sign-out/route.ts",
      ]);
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
