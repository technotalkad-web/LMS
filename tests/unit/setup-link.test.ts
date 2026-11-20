/**
 * The LMS's own "set your password" link (ADR 0029 section N, rules N9 to
 * N12 and N14, step 15; lib/auth/setup-link.ts, app/api/auth/set-password,
 * the console's admins route, and the reset and change-password routes), on
 * the real code under a stubbed fetch (PostgREST, Auth, send-smtp) and a
 * stubbed next/headers. Pull request B's part only: the console issues the
 * link; the two user routes' cases are pull request C's.
 *
 *   - issuing: the token lives only in the link's fragment; the table gets
 *     the five columns it grants, the token's SHA-256 and no time (the
 *     database stamps the 7 days); the older open link is ended first,
 *     whatever its expiry;
 *   - the account for a link is made by one function, with the address
 *     alone; a scan holds auth.admin.createUser to that one function, and
 *     the console's route to calling it;
 *   - the page's read spends nothing for a good link, however often it is
 *     made; an unknown, used, ended, expired or malformed link gets rule
 *     N10's one answer, the same status and body, and is left as it was;
 *   - rule N14: a link whose membership is gone, inactive or suspended,
 *     whose organisation is deleted, or whose account has signed in gets
 *     rule N10's answer and is ended, and stays refused when the membership
 *     counts again; for a tenant's link, a row in any other organisation and
 *     a platform owner (rule N11) are refused too, and a platform's link is
 *     not refused for a row elsewhere;
 *   - rule N14 (b), exact: "never signed in" only for an answer with no
 *     error that holds the account asked for; a sign-in time left out or
 *     null is "never"; no account, another id, an error or any other value
 *     is the failed read: 503, nothing ended, the link still good;
 *   - the order: rule N10, then rules N11 and N14, then the policy, then the
 *     claim;
 *   - the set step: the password and the confirmed mark in one admin call,
 *     an old flag cleared, no session and no cookie; two requests at once
 *     set one password; a definite refusal releases only this request's own
 *     claim; a timeout or a server error releases nothing and gives the
 *     "could not confirm" answer;
 *   - without 0117: the console refuses a new account before any account is
 *     made, with a message that names the migration, and adds an existing
 *     one as before; the page's read and the set step give rule N10's
 *     answer; "Send setup link again" is refused with the same message; and
 *     the write that ends an open link never fails a reset or a change;
 *   - the console: the welcome by the platform sender with the link; the
 *     link in the answer only when the welcome was not sent; "Send setup
 *     link again" for a never-signed-in administrator the console created
 *     with a link, at most three in 24 hours, the fixed line for anyone
 *     else, inactive for a row that does not count; the list offers it;
 *   - a welcome that timed out: "not sent" with the class timeout and the
 *     link in the answer, which the console shows as "may have been sent";
 *   - the middleware lets a signed-out visitor reach the page and the
 *     route, and the page sends no referrer;
 *   - the auth server's sent times are read nowhere in app/ and lib/;
 *   - no request address holds the token, and no log line holds a token, a
 *     link or a password.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/setup-link.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { NextRequest } from "next/server";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; table: string; query: URLSearchParams; body: unknown; raw: string; prefer: string };

const SUPABASE = "http://stub.supabase.test";
const ROOT = path.resolve(__dirname, "..", "..");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const ME = { id: "0e000000-0000-4000-8000-0000000000aa", aud: "authenticated", role: "authenticated", email: "owner@platform.stub" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: ME });
const ORG = { id: "0a000000-0000-4000-8000-0000000000a1", name: "Tenant A", slug: "tenant-a", deleted_at: null as string | null };
const OTHER = { id: "0a000000-0000-4000-8000-0000000000b1", name: "Tenant B", slug: "tenant-b", deleted_at: null as string | null };
const GONE = { id: "0a000000-0000-4000-8000-0000000000c1", name: "Gone", slug: "gone", deleted_at: "2026-11-01T00:00:00Z" as string | null };
const P = { id: "0b000000-0000-4000-8000-000000000001", email: "new.admin@platform.stub" };
const TOKEN = "Tk0123456789abcdefghijklmnopqrstuvwxyzABCDE";
const PASSWORD = "Fresh-Pass-2026";
const RESET_TOKEN = "reset-token-0029";

// ---- the browser: next/headers, one jar, no impersonation cookie ----
const jar = new Map<string, string>();
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string) => { jar.set(name, value); },
        delete: (name: string) => { jar.delete(name); },
      }),
      headers: async () => new Headers({ host: "lms.stub", "x-forwarded-proto": "https" }),
    };
  }
  return load.call(this, request, ...rest);
};

/* ---------------- the world behind the stub ---------------- */
type SignIn = "omitted" | "null" | "time" | "error" | "empty" | "other_id" | "blank" | "number" | "not_a_date" | "throw";
type Put = "ok" | "refuse" | "server_error" | "unavailable" | "throw";
let links: Row[] = [];
let members: Row[] = [];
let orgs: Row[] = [];
let owners: string[] = [];
let accounts: Array<{ id: string; email: string }> = [];
let signIn: Record<string, SignIn> = {};
let putAnswer: Put = "ok";
let linksTable: "ok" | "missing" | "fail" = "ok";
let failing = new Set<string>();
let requests: Req[] = [];
/** Every request address the code made, path and query, across all cases. */
const addresses: string[] = [];
/** What send-smtp answers. */
let smtpAnswer: { ok: true } | { ok: false; error: string } = { ok: true };
let nextLink = 1;
let created = 0;
/** Runs just before a claim (a PATCH that sets used_at) is applied: another writer gets there first. */
let beforeClaim: (() => void) | null = null;
/** Runs just before a release (a PATCH that clears used_at) is applied. */
let beforeRelease: (() => void) | null = null;
const lines: string[] = [];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const missingTable = () => json({ code: "PGRST205", message: "Could not find the table 'public.account_setup_links' in the schema cache" }, 404);
const readFailure = () => json({ code: "XX000", message: "stub failure" }, 500);

function matches(r: Row, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (["select", "limit", "order", "offset", "on_conflict", "columns"].includes(k)) continue;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const arg = v.slice(dot + 1);
    const cell = r[k];
    if (v === "is.null") { if (cell !== null && cell !== undefined) return false; continue; }
    if (op === "eq") {
      const a = Date.parse(String(cell)), b = Date.parse(arg);
      if (typeof cell === "string" && /\dT\d/.test(arg) && Number.isFinite(a) && Number.isFinite(b)) { if (a !== b) return false; continue; }
      if (String(cell) !== arg) return false;
      continue;
    }
    if (op === "in") { if (!arg.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(cell))) return false; continue; }
    if (op === "gt") { if (!(Date.parse(String(cell)) > Date.parse(arg))) return false; continue; }
    if (op === "gte") { if (!(Date.parse(String(cell)) >= Date.parse(arg))) return false; continue; }
  }
  return true;
}
const project = (r: Row, select: string | null) => {
  if (!select || select === "*") return { ...r };
  const out: Row = {};
  for (const c of select.split(",").map((x) => x.trim())) out[c] = r[c] ?? null;
  return out;
};
const userJson = (id: string, email: string, extra: Row = {}) => ({ id, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z", ...extra });

function authServer(method: string, p: string, body: Row | null, q: URLSearchParams): Response {
  if (p === "/auth/v1/user" && method === "GET") return json(ME);
  if (p === "/auth/v1/user" && method === "PUT") return json(ME);
  if (p === "/auth/v1/admin/users" && method === "GET") return json({ users: accounts.map((a) => userJson(a.id, a.email)), aud: "authenticated" });
  void q;
  if (p === "/auth/v1/admin/users" && method === "POST") {
    const a = { id: `0b000000-0000-4000-8000-00000000f${String(++created).padStart(3, "0")}`, email: String(body?.email ?? "") };
    accounts.push(a);
    signIn[a.id] = "omitted";
    return json(userJson(a.id, a.email));
  }
  const m = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(p);
  if (m && method === "GET") {
    const a = accounts.find((x) => x.id === m[1]);
    const mode = signIn[m[1]] ?? "omitted";
    if (mode === "error") return json({ code: 500, error_code: "unexpected_failure", msg: "stub failure" }, 500);
    if (!a) return json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
    if (mode === "empty") return json({});
    if (mode === "other_id") return json(userJson("0b000000-0000-4000-8000-0000000000ff", a.email));
    if (mode === "null") return json(userJson(a.id, a.email, { last_sign_in_at: null }));
    if (mode === "time") return json(userJson(a.id, a.email, { last_sign_in_at: "2026-11-20T10:00:00Z" }));
    if (mode === "blank") return json(userJson(a.id, a.email, { last_sign_in_at: "" }));
    if (mode === "number") return json(userJson(a.id, a.email, { last_sign_in_at: 1763632800 }));
    if (mode === "not_a_date") return json(userJson(a.id, a.email, { last_sign_in_at: "yesterday" }));
    return json(userJson(a.id, a.email));
  }
  if (m && method === "PUT") {
    if (putAnswer === "refuse") return json({ code: 422, error_code: "weak_password", msg: "Password is known to be weak", weak_password: { reasons: ["pwned"] } }, 422);
    if (putAnswer === "server_error") return json({ code: 500, error_code: "unexpected_failure", msg: "stub failure" }, 500);
    if (putAnswer === "unavailable") return json({ message: "upstream" }, 503);
    const a = accounts.find((x) => x.id === m[1]);
    return a ? json(userJson(a.id, a.email)) : json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
  }
  return json({ message: `unexpected ${method} ${p}` }, 500);
}

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const p = url.pathname;
  const q = url.searchParams;
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: unknown = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  const table = p.replace("/rest/v1/", "");
  const prefer = headers.get("prefer") ?? "";
  requests.push({ method, path: p, table, query: q, body, raw, prefer });
  addresses.push(decodeURIComponent(p + url.search));
  if (p.startsWith("/auth/v1/")) {
    if (method === "PUT" && putAnswer === "throw" && p.startsWith("/auth/v1/admin/users/")) throw new TypeError("fetch failed");
    if (method === "GET" && p.startsWith("/auth/v1/admin/users/")) {
      const id = p.split("/").pop() ?? "";
      if (signIn[id] === "throw") throw new TypeError("fetch failed");
    }
    return authServer(method, p, body as Row | null, q);
  }
  if (p === "/functions/v1/send-smtp") return json(smtpAnswer);
  const object = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const answer = (rows: Row[]) => json(object ? rows[0] ?? null : rows);
  if (failing.has(`${method} ${table}`) || (method === "GET" && failing.has(table))) return readFailure();

  if (table === "account_setup_links") {
    if (linksTable === "missing") return missingTable();
    if (linksTable === "fail") return readFailure();
    if (method === "GET") {
      let hit = links.filter((r) => matches(r, q));
      const limit = Number(q.get("limit") ?? "0");
      if (limit > 0) hit = hit.slice(0, limit);
      return answer(hit.map((r) => project(r, q.get("select"))));
    }
    if (method === "POST") {
      const rec = body as Row;
      // The partial unique index: one open link for an account.
      if (links.some((r) => r.user_id === rec.user_id && r.used_at === null && r.ended_at === null)) {
        return json({ code: "23505", message: "duplicate key value violates unique constraint \"account_setup_links_one_open_idx\"" }, 409);
      }
      const now = Date.now();
      links.push({ id: `link-${nextLink++}`, ...rec, created_at: new Date(now).toISOString(), expires_at: new Date(now + 7 * 86_400_000).toISOString(), used_at: null, ended_at: null });
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      const set = body as Row;
      if ("used_at" in set && set.used_at !== null && beforeClaim) { const f = beforeClaim; beforeClaim = null; f(); }
      if ("used_at" in set && set.used_at === null && beforeRelease) { const f = beforeRelease; beforeRelease = null; f(); }
      const hit = links.filter((r) => matches(r, q));
      for (const r of hit) Object.assign(r, set);
      return prefer.includes("return=representation") ? json(hit.map((r) => project(r, q.get("select")))) : new Response(null, { status: 204 });
    }
  }
  if (table === "organization_members") {
    if (method === "GET") return answer(members.filter((r) => matches(r, q)).map((r) => project(r, q.get("select"))));
    if (method === "POST") {
      const rec = body as Row;
      const hit = members.find((r) => r.organization_id === rec.organization_id && r.user_id === rec.user_id);
      if (hit) Object.assign(hit, rec); else members.push({ ...rec });
      return new Response(null, { status: 201 });
    }
  }
  if (table === "organizations") return answer(orgs.filter((r) => matches(r, q)).map((r) => project(r, q.get("select"))));
  if (table === "platform_owners") {
    const uid = (q.get("user_id") ?? "").replace(/^eq\./, "");
    return answer([...owners, ME.id].includes(uid) ? [{ user_id: uid, mfa_required: false }] : []);
  }
  if (table === "profiles") {
    if (method === "GET") {
      if ((q.get("select") ?? "").includes("email")) {
        const ids = (q.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
        return json(accounts.filter((a) => ids.includes(a.id)).map((a) => ({ id: a.id, email: a.email })));
      }
      return answer([{ must_change_password: false }]);
    }
    return new Response(null, { status: method === "POST" ? 201 : 204 });
  }
  if (table === "password_reset_otps") {
    if (method === "GET") return answer([{ id: "otp-1", reset_token_hash: sha(RESET_TOKEN), reset_token_expires: new Date(Date.now() + 600_000).toISOString(), used_at: null }]);
    return new Response(null, { status: 204 });
  }
  if (table === "platform_email_log") {
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    if (method === "GET") return json([]);
    return new Response(null, { status: 201 });
  }
  if (table === "platform_audit_log") return new Response(null, { status: 201 });
  return json({ message: `unexpected ${method} ${p}` }, 500);
};

/* ---------------- helpers ---------------- */
const member = (org: { id: string }, userId: string, role: string, status = "active"): Row => ({ organization_id: org.id, user_id: userId, role, status });
const linkRow = (over: Row = {}): Row => ({
  id: `link-${nextLink++}`, user_id: P.id, organization_id: ORG.id, issuer: "platform", issued_by: ME.id, token_hash: sha(TOKEN),
  created_at: new Date(Date.now() - 3600_000).toISOString(), expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(), used_at: null, ended_at: null, ...over,
});
function world(o: { links?: Row[]; members?: Row[]; signIn?: SignIn; owners?: string[]; table?: "ok" | "missing" | "fail"; failing?: string[]; put?: Put } = {}) {
  requests = [];
  // Copies: a case's rows are never shared with the next case.
  links = (o.links ?? [linkRow()]).map((r) => ({ ...r }));
  members = (o.members ?? [member(ORG, P.id, "admin")]).map((r) => ({ ...r }));
  orgs = [ORG, OTHER, GONE].map((x) => ({ ...x }));
  owners = o.owners ?? [];
  accounts = [{ id: P.id, email: P.email }, { id: ME.id, email: ME.email }];
  signIn = { [P.id]: o.signIn ?? "omitted" };
  putAnswer = o.put ?? "ok";
  linksTable = o.table ?? "ok";
  failing = new Set(o.failing ?? []);
  beforeClaim = null;
  beforeRelease = null;
  smtpAnswer = { ok: true };
  jar.clear();
  jar.set("sb-stub-auth-token", SESSION);
}
const writes = (table = "account_setup_links") => requests.filter((r) => r.table === table && r.method !== "GET" && r.method !== "HEAD");
const linkPatches = () => writes().filter((r) => r.method === "PATCH").map((r) => r.body as Row);
const adminPuts = () => requests.filter((r) => r.path.startsWith("/auth/v1/admin/users/") && r.method === "PUT");

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.IMPERSONATION_SECRET = "stub-impersonation-secret";
  const PLATFORM_ENV: Record<string, string> = {
    PLATFORM_SMTP_HOST: "smtp.platform.stub", PLATFORM_SMTP_PORT: "465", PLATFORM_SMTP_USER: "platform-mailer",
    PLATFORM_SMTP_PASSWORD: "stub-platform-app-password", PLATFORM_SMTP_FROM: "LMS <noreply@platform.stub>", PLATFORM_EMAIL_ALLOW_DOMAINS: "platform.stub",
  };
  for (const [k, v] of Object.entries(PLATFORM_ENV)) process.env[k] = v;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const real = { warn: console.warn, error: console.error };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const lib = await import("../../lib/auth/setup-link");
    const { createClient } = await import("@supabase/supabase-js");
    const svc = () => createClient(SUPABASE, "stub-service-key", { auth: { persistSession: false } });
    const route = await import("../../app/api/auth/set-password/route");
    const post = async (b: Row) => {
      const res = await route.POST(new Request("https://lms.stub/api/auth/set-password", { method: "POST", body: JSON.stringify(b) }));
      return { status: res.status, body: (await res.json()) as Row, cookie: res.headers.get("set-cookie") };
    };
    const N10 = { status: lib.LINK_UNUSABLE_STATUS, body: { error: lib.LINK_UNUSABLE_MESSAGE, code: "unusable" } };
    const asN10 = (r: { status: number; body: Row }) => ({ status: r.status, body: r.body });
    const TRY = { status: 503, body: { error: lib.LINK_TRY_AGAIN_MESSAGE, code: "unreadable" } };

    console.log("\nissuing a link");
    {
      world({ links: [linkRow({ token_hash: sha("older"), expires_at: new Date(Date.now() - 60_000).toISOString() })] });
      const r = await lib.issueSetupLink(svc(), { userId: P.id, organizationId: ORG.id, issuer: "platform", issuedBy: ME.id, origin: "https://lms.stub" });
      const url = r.ok ? new URL(r.url) : null;
      const token = url?.hash.slice(3) ?? "";
      eq("the address: /auth/set-password, no query, the token alone in the fragment (43 characters)", [url?.origin, url?.pathname, url?.search, /^#t=[A-Za-z0-9_-]{43}$/.test(url?.hash ?? "")], ["https://lms.stub", "/auth/set-password", "", true]);
      eq("…the token is in no other part of the address", [url?.pathname.includes(token), url?.search.includes(token)], [false, false]);
      const ins = writes().filter((w) => w.method === "POST");
      eq("the row: exactly the five granted columns, the token's SHA-256, never the token or a time", [ins.length, Object.keys(ins[0]?.body as Row).sort(), (ins[0]?.body as Row).token_hash === sha(token), ins[0]?.raw.includes(token)],
        [1, ["issued_by", "issuer", "organization_id", "token_hash", "user_id"], true, false]);
      const end = writes().find((w) => w.method === "PATCH");
      eq("the older open link is ended first, whatever its expiry (it still holds the one open slot)", [end && writes().indexOf(end) < writes().indexOf(ins[0]), end?.query.get("user_id"), end?.query.get("used_at"), end?.query.get("ended_at"), end?.query.has("expires_at"), Object.keys(end?.body as Row)],
        [true, `eq.${P.id}`, "is.null", "is.null", false, ["ended_at"]]);
      eq("…so the account holds one open link, the new one", links.filter((l) => l.used_at === null && l.ended_at === null).map((l) => l.token_hash), [sha(token)]);
      eq("the life is the database's: 7 days, stated as SETUP_LINK_DAYS", lib.SETUP_LINK_DAYS, 7);
      world({ table: "missing", links: [] });
      eq("without 0117: not issued, and the answer says the table is missing", await lib.issueSetupLink(svc(), { userId: P.id, organizationId: ORG.id, issuer: "platform", issuedBy: ME.id, origin: "https://lms.stub" }), { ok: false, missing: true });
      world({ table: "fail", links: [] });
      eq("…another failure is not read as missing", await lib.issueSetupLink(svc(), { userId: P.id, organizationId: ORG.id, issuer: "platform", issuedBy: ME.id, origin: "https://lms.stub" }), { ok: false, missing: false });
    }

    console.log("\nthe account for a link: one function, the address alone");
    {
      world();
      const before = accounts.length;
      const r = await lib.createAccountForSetupLink(svc(), "someone@platform.stub");
      const creates = requests.filter((q) => q.path === "/auth/v1/admin/users" && q.method === "POST");
      eq("createAccountForSetupLink: one auth.admin.createUser call, whose arguments are the address only", [creates.length, creates.map((c) => c.body)], [1, [{ email: "someone@platform.stub" }]]);
      eq("…it answers the account made", ["user" in r, accounts.length - before], [true, 1]);
      // The scan: createUser in setup-link.ts is called in exactly one function,
      // and the console's route reaches it only through that function.
      const callsIn = (file: string, name: string) => {
        const src = fs.readFileSync(path.join(ROOT, file), "utf8");
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
        const found: string[] = [];
        const visit = (n: ts.Node, fn: string) => {
          let here = fn;
          if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) here = n.name.getText(sf);
          if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) here = n.name.getText(sf);
          if (ts.isCallExpression(n)) {
            const c = n.expression;
            const callee = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : "";
            if (callee === name) found.push(here);
          }
          ts.forEachChild(n, (k) => visit(k, here));
        };
        visit(sf, "(top)");
        return found;
      };
      eq("scan: lib/auth/setup-link.ts calls createUser in exactly one function, createAccountForSetupLink", callsIn("lib/auth/setup-link.ts", "createUser"), ["createAccountForSetupLink"]);
      eq("scan: the console's admins route calls no createUser itself, and calls createAccountForSetupLink once (the add)", [callsIn("app/api/super/tenants/[id]/admins/route.ts", "createUser"), callsIn("app/api/super/tenants/[id]/admins/route.ts", "createAccountForSetupLink")], [[], ["POST"]]);
      eq("scan: the set-password route creates no account", callsIn("app/api/auth/set-password/route.ts", "createUser"), []);
    }

    console.log("\nthe auth server's sent times decide nothing");
    {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const q = path.join(dir, d.name);
          if (d.isDirectory()) walk(q); else if (/\.(ts|tsx)$/.test(d.name)) files.push(q);
        }
      };
      walk(path.join(ROOT, "app"));
      walk(path.join(ROOT, "lib"));
      const hits = (re: RegExp) => files.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();
      eq(`non-vacuous: the scan reads app/ and lib/ (${files.length} files)`, files.length > 200, true);
      eq("no file under app/ or lib/ names confirmation_sent_at, recovery_sent_at or email_change_sent_at", hits(/\b(confirmation_sent_at|recovery_sent_at|email_change_sent_at)\b/), []);
      // invited_at is also a column of the LMS's own invitations table (0005):
      // only the two Users pages that list those invitations name it.
      eq("invited_at is named only by the Users pages' own invitations list, never by the setup link's code", hits(/\binvited_at\b/), ["app/[org]/(admin)/users/learners-client.tsx", "app/[org]/(admin)/users/page.tsx"]);
    }

    console.log("\nrule N14 (b), exact: never signed in");
    {
      const state = async (mode: SignIn) => { world({ signIn: mode }); return lib.signInState(svc(), P.id); };
      eq("no error, the account asked for, the time left out: never", await state("omitted"), "never");
      eq("…the time null: never", await state("null"), "never");
      eq("…a time: signed in", await state("time"), "signed_in");
      for (const mode of ["error", "empty", "other_id", "blank", "number", "not_a_date", "throw"] as const) {
        eq(`a failed read (${mode}): unreadable, never "never"`, await state(mode), "unreadable");
      }
      world();
      eq("no account at the auth server (404): unreadable", await lib.signInState(svc(), "0b000000-0000-4000-8000-0000000000ee"), "unreadable");
    }

    console.log("\nthe page's read spends nothing");
    {
      world();
      const reads = [await post({ token: TOKEN }), await post({ token: TOKEN }), await post({ token: TOKEN })];
      eq("a good link: 200 with the organisation's name and the password rule, each time", reads.map((r) => [r.status, r.body.organization, r.body.rule]), Array(3).fill([200, "Tenant A", "At least 10 characters, with at least two of: lowercase, uppercase, digit, symbol."]));
      eq("…and nothing is written, however often it is read", [writes().length, links[0].used_at, links[0].ended_at, adminPuts().length], [0, null, null, 0]);
    }
    {
      const cases: Array<[string, Row[], unknown]> = [
        ["an unknown link", [linkRow({ token_hash: sha("another-token") })], TOKEN],
        ["a used link", [linkRow({ used_at: new Date(Date.now() - 1000).toISOString() })], TOKEN],
        ["an ended link", [linkRow({ ended_at: new Date(Date.now() - 1000).toISOString() })], TOKEN],
        ["an expired link", [linkRow({ expires_at: new Date(Date.now() - 1000).toISOString() })], TOKEN],
        ["a malformed token", [linkRow()], "short"],
        ["no token", [linkRow()], undefined],
      ];
      for (const [label, rows, token] of cases) {
        world({ links: rows });
        const before = JSON.stringify(links);
        const r = await post(token === undefined ? {} : { token });
        eq(`${label}: rule N10's one answer, the same status and body, and the row left as it was`, [asN10(r), writes().length, JSON.stringify(links) === before], [N10, 0, true]);
      }
      world({ links: [linkRow()] });
      const r = await post({ token: TOKEN, password: PASSWORD });
      eq("…the set step of a good link is not that answer (the control)", r.status, 200);
    }

    console.log("\nrule N14: the reason the link was issued still holds");
    {
      const ended = () => linkPatches().filter((b) => typeof b.ended_at === "string").length;
      const refusals: Array<[string, Parameters<typeof world>[0]]> = [
        ["the membership removed", { members: [] }],
        ["the membership inactive", { members: [member(ORG, P.id, "admin", "inactive")] }],
        ["the membership suspended", { members: [member(ORG, P.id, "admin", "suspended")] }],
        ["the organisation deleted", { links: [linkRow({ organization_id: GONE.id })], members: [member(GONE, P.id, "admin")] }],
        ["the account has signed in", { signIn: "time" }],
      ];
      for (const [label, w] of refusals) {
        for (const what of ["the page's read", "the set step"] as const) {
          world(w);
          const r = await post(what === "the page's read" ? { token: TOKEN } : { token: TOKEN, password: PASSWORD });
          eq(`${label}, ${what}: rule N10's answer, the link ended, no password set`, [asN10(r), ended(), typeof links[0].ended_at, adminPuts().length], [N10, 1, "string", 0]);
        }
      }
      world({ members: [member(ORG, P.id, "admin", "inactive")] });
      await post({ token: TOKEN });
      members = [member(ORG, P.id, "admin", "active")];
      eq("a link refused once is refused again after the membership counts again", asN10(await post({ token: TOKEN })), N10);

      const tenant = (o: Parameters<typeof world>[0] = {}) => world({ links: [linkRow({ issuer: "tenant" })], ...o });
      for (const [label, rows] of [
        ["a row in another organisation (active)", [member(ORG, P.id, "user"), member(OTHER, P.id, "user")]],
        ["a row in another organisation (inactive)", [member(ORG, P.id, "user"), member(OTHER, P.id, "user", "inactive")]],
        ["a row in a deleted organisation", [member(ORG, P.id, "user"), member(GONE, P.id, "admin")]],
        ["an administrator of another organisation (rule N11)", [member(ORG, P.id, "user"), member(OTHER, P.id, "admin")]],
      ] as const) {
        tenant({ members: [...rows] });
        eq(`a tenant's link, ${label}: refused and ended`, [asN10(await post({ token: TOKEN })), typeof links[0].ended_at], [N10, "string"]);
      }
      tenant({ members: [member(ORG, P.id, "user")], owners: [P.id] });
      eq("a tenant's link for a platform owner (rule N11): refused and ended", [asN10(await post({ token: TOKEN })), typeof links[0].ended_at], [N10, "string"]);
      for (const role of ["user", "data_analyst", "admin"]) {
        tenant({ members: [member(ORG, P.id, role)] });
        eq(`a tenant's link for a ${role} of the issuing organisation only: good`, (await post({ token: TOKEN })).status, 200);
      }
      world({ members: [member(ORG, P.id, "admin"), member(OTHER, P.id, "admin")], owners: [P.id] });
      eq("a platform's link is not refused for a row elsewhere, nor for a platform owner", (await post({ token: TOKEN })).status, 200);
      for (const role of ["super_owner", "admin", "data_analyst"]) {
        world({ members: [member(ORG, P.id, role)] });
        eq(`a platform's link works for a ${role}`, (await post({ token: TOKEN, password: PASSWORD })).status, 200);
      }
    }

    console.log("\na read that fails ends nothing (rule N14), and the exact sign-in rule");
    {
      const failures: Array<[string, Parameters<typeof world>[0]]> = [
        ["the memberships cannot be read", { failing: ["organization_members"] }],
        ["the organisation cannot be read", { failing: ["organizations"] }],
        ["the platform owners cannot be read (a tenant's link)", { links: [linkRow({ issuer: "tenant" })], members: [member(ORG, P.id, "user")], failing: ["platform_owners"] }],
        ["the link itself cannot be read", { table: "fail" }],
        ["the sign-in read answers an error", { signIn: "error" }],
        ["the sign-in read answers no account", { signIn: "empty" }],
        ["the sign-in read answers another id", { signIn: "other_id" }],
        ["the sign-in read answers a value that is not a time", { signIn: "not_a_date" }],
        ["the sign-in read gets no answer", { signIn: "throw" }],
      ];
      for (const [label, w] of failures) {
        world(w);
        const r = await post({ token: TOKEN });
        eq(`${label}: 503, try again, nothing ended`, [asN10(r), writes().length], [TRY, 0]);
        world(w);
        const s = await post({ token: TOKEN, password: PASSWORD });
        eq(`…and on the set step: 503, no claim, no password set`, [asN10(s), writes().length, adminPuts().length], [TRY, 0, 0]);
      }
      world({ signIn: "error" });
      await post({ token: TOKEN });
      signIn[P.id] = "omitted";
      eq("…the link is still good once the read works", (await post({ token: TOKEN })).status, 200);
      for (const mode of ["omitted", "null"] as const) {
        world({ signIn: mode });
        eq(`a sign-in time ${mode === "omitted" ? "left out" : "null"}: never signed in, the link good`, (await post({ token: TOKEN })).status, 200);
      }
    }

    console.log("\nthe order: rule N10, then rules N11 and N14, then the policy, then the claim");
    {
      world({ links: [linkRow({ expires_at: new Date(Date.now() - 1000).toISOString() })], failing: ["organization_members"] });
      const a = await post({ token: TOKEN });
      eq("rule N10 first: an expired link gets its answer before any membership is read", [asN10(a), requests.some((q) => q.table === "organization_members")], [N10, false]);
      world({ members: [], signIn: "omitted" });
      const b = await post({ token: TOKEN, password: "short" });
      eq("rule N14 before the policy: a refused link with a weak password gets rule N10's answer", asN10(b), N10);
      world();
      const c = await post({ token: TOKEN, password: "alllowercaseletters" });
      eq("the policy before the claim: refused with the policy's message, no claim, the link still usable", [c.status, c.body.code, c.body.error, linkPatches().length, links[0].used_at], [400, "policy", "Password must mix at least two of: lowercase, uppercase, digit, symbol.", 0, null]);
      eq("…a password below 10 characters likewise", (await post({ token: TOKEN, password: "Short-1" })).body.error, "Password must be at least 10 characters.");
      eq("…and the link then works", (await post({ token: TOKEN, password: PASSWORD })).status, 200);
    }

    console.log("\nthe set step");
    {
      world();
      const r = await post({ token: TOKEN, password: PASSWORD });
      const puts = adminPuts();
      eq("200, and the answer names the organisation's sign-in page", [r.status, r.body], [200, { ok: true, next: "/tenant-a/login" }]);
      eq("one admin call, for the link's account, with the password and the confirmed mark together and nothing else",
        [puts.length, puts[0]?.path, Object.keys(puts[0]?.body as Row).sort(), (puts[0]?.body as Row).email_confirm], [1, `/auth/v1/admin/users/${P.id}`, ["email_confirm", "password"], true]);
      const claim = writes().find((w) => w.method === "PATCH" && typeof (w.body as Row).used_at === "string");
      eq("the claim: one conditional update (not used, not ended, not expired) before the admin call",
        [claim?.query.get("id"), claim?.query.get("used_at"), claim?.query.get("ended_at"), (claim?.query.get("expires_at") ?? "").startsWith("gt."), claim ? requests.indexOf(claim) < requests.indexOf(puts[0]) : false],
        [`eq.${links[0].id}`, "is.null", "is.null", true, true]);
      const flag = requests.find((q) => q.table === "profiles" && q.method === "PATCH");
      eq("an old forced-change flag is cleared, only where it is set", [flag?.body, flag?.query.get("must_change_password")], [{ must_change_password: false }, "eq.true"]);
      eq("no session and no cookie: no sign-in at the auth server, no Set-Cookie", [requests.some((q) => q.path === "/auth/v1/token"), r.cookie], [false, null]);
      eq("the same link then gets rule N10's answer", asN10(await post({ token: TOKEN, password: PASSWORD })), N10);
    }
    {
      world();
      const both = await Promise.all([post({ token: TOKEN, password: PASSWORD }), post({ token: TOKEN, password: "Other-Pass-2026" })]);
      eq("two requests at once: one sets the password, the other gets rule N10's answer", [both.map((x) => x.status).sort(), adminPuts().length], [[200, 400], 1]);
    }
    {
      world({ put: "refuse" });
      const r = await post({ token: TOKEN, password: PASSWORD });
      const release = linkPatches().find((b) => "used_at" in b && b.used_at === null);
      const releaseReq = writes().find((w) => w.method === "PATCH" && (w.body as Row).used_at === null);
      eq("a definite refusal (422): the claim is released, the person may try again", [r.status, r.body.code, release !== undefined, links[0].used_at], [400, "refused", true, null]);
      eq("…the release matches only this request's own claim", [releaseReq?.query.get("id"), (releaseReq?.query.get("used_at") ?? "").startsWith("eq."), releaseReq?.query.get("ended_at")], [`eq.${links[0].id}`, true, "is.null"]);
      putAnswer = "ok";
      eq("…and the link then works", (await post({ token: TOKEN, password: PASSWORD })).status, 200);
      world({ put: "refuse" });
      beforeRelease = () => { links[0].used_at = "2026-11-21T00:00:00.000Z"; };
      const s = await post({ token: TOKEN, password: PASSWORD });
      eq("…a row another request has since taken is not freed: rule N10's answer, its value kept", [asN10(s), links[0].used_at], [N10, "2026-11-21T00:00:00.000Z"]);
    }
    for (const [label, put] of [["a server error (500)", "server_error"], ["no answer (503)", "unavailable"], ["a dropped connection", "throw"]] as const) {
      world({ put });
      const r = await post({ token: TOKEN, password: PASSWORD });
      eq(`${label}: the claim stands, and the "could not confirm" answer`, [r.status, r.body.error, typeof links[0].used_at, linkPatches().filter((b) => b.used_at === null).length], [502, lib.LINK_NOT_CONFIRMED_MESSAGE, "string", 0]);
    }

    console.log("\nwithout 0117");
    {
      world({ table: "missing" });
      const read = await post({ token: TOKEN });
      world({ table: "missing" });
      const set = await post({ token: TOKEN, password: PASSWORD });
      eq("the page's read and the set step: rule N10's answer, the same status and body", [asN10(read), asN10(set), adminPuts().length], [N10, N10, 0]);
      world({ table: "missing" });
      eq("setupLinksReady: missing", await lib.setupLinksReady(svc()), "missing");
      const probe = requests.find((q) => q.table === "account_setup_links");
      eq("…the probe is one plain read of the table, by its exact name", [probe?.method, probe?.path, probe?.query.get("select"), probe?.query.get("limit")], ["GET", "/rest/v1/account_setup_links", "id", "1"]);
      world({ table: "fail" });
      eq("…another failure is unreadable, never missing", await lib.setupLinksReady(svc()), "unreadable");
      world();
      eq("…with the table: ready", await lib.setupLinksReady(svc()), "ready");
    }

    console.log("\na completed reset and a password change end the open link, and its failure never fails them");
    {
      const reset = await import("../../app/api/auth/forgot-password/reset/route");
      const change = await import("../../app/api/auth/change-password/route");
      const doReset = () => reset.POST(new Request("https://lms.stub/api/auth/forgot-password/reset", { method: "POST", body: JSON.stringify({ email: P.email, reset_token: RESET_TOKEN, new_password: PASSWORD }) }));
      const doChange = () => change.POST(new Request("https://lms.stub/api/auth/change-password", { method: "POST", body: JSON.stringify({ new_password: PASSWORD }) }));
      for (const [label, run, who] of [["the reset", doReset, P.id], ["the change", doChange, ME.id]] as const) {
        world({ links: [linkRow({ user_id: who })] });
        const ok = await run();
        const end = writes().find((w) => w.method === "PATCH");
        const pw = requests.findIndex((q) => (q.path.startsWith("/auth/v1/admin/users/") || q.path === "/auth/v1/user") && q.method === "PUT");
        eq(`${label}: 200, and the account's open link is ended after the password is set`,
          [ok.status, end?.query.get("user_id"), end?.query.get("used_at"), end?.query.get("ended_at"), typeof links[0].ended_at, end ? requests.indexOf(end) > pw && pw >= 0 : false],
          [200, `eq.${who}`, "is.null", "is.null", "string", true]);
        for (const [what, table] of [["without 0117", "missing"], ["with the write failing", "fail"]] as const) {
          world({ table, links: [] });
          lines.length = 0;
          const res = await run();
          eq(`${label} ${what}: still a success, and an error class is logged`, [res.status, ((await res.json()) as Row).ok, lines.some((l) => l.includes("setup_link_end_failed") && l.includes(table === "missing" ? "no_0117" : "XX000"))], [200, true, true]);
        }
      }
      world({ links: [] });
      const strong = await doChange();
      eq("the change takes the shared policy: a password of 10 characters or more, of two kinds or more, is accepted", [strong.status, ((await strong.json()) as Row).error], [200, undefined]);
      const short = await change.POST(new Request("https://lms.stub/api/auth/change-password", { method: "POST", body: JSON.stringify({ new_password: "lowercaseonly" }) }));
      eq("…one kind of character is refused with the policy's message", [short.status, ((await short.json()) as Row).error], [400, "Password must mix at least two of: lowercase, uppercase, digit, symbol."]);
    }

    console.log("\nthe console: a new administrator gets a setup link, by the platform sender");
    {
      const admins = await import("../../app/api/super/tenants/[id]/admins/route");
      const ctx = { params: Promise.resolve({ id: ORG.id }) };
      const add = async (email: string, role = "admin") => {
        const res = await admins.POST(new Request(`https://lms.stub/api/super/tenants/${ORG.id}/admins`, { method: "POST", body: JSON.stringify({ email, role }) }), ctx);
        return { status: res.status, body: (await res.json()) as Row };
      };
      const creates = () => requests.filter((q) => q.path === "/auth/v1/admin/users" && q.method === "POST");
      const smtp = () => requests.filter((q) => q.path === "/functions/v1/send-smtp").map((q) => q.body as Row);

      world({ links: [], members: [] });
      const got = await add("first.admin@platform.stub");
      const mail = smtp();
      const linkInMail = /https:\/\/lms\.stub\/auth\/set-password#t=[A-Za-z0-9_-]{43}/.exec(String(mail[0]?.text ?? ""))?.[0] ?? "";
      eq("a new account: made with the address alone, then its link issued by the platform", [got.status, creates().map((c) => c.body), links.map((l) => [l.organization_id, l.issuer, l.issued_by])], [200, [{ email: "first.admin@platform.stub" }], [[ORG.id, "platform", ME.id]]]);
      eq("…the welcome went by the platform sender with the link, and the answer holds no link and no password", [got.body.email_outcome, mail.length, linkInMail !== "", "setup_link" in got.body, JSON.stringify(got.body).includes("password")], [{ status: "sent" }, 1, true, false, false]);
      eq("…the mailed link is the issued one", links[0].token_hash === sha(new URL(linkInMail || "https://x/#t=").hash.slice(3)), true);
      const profile = requests.find((q) => q.table === "profiles" && q.method === "POST");
      eq("…the forced change is not set for the new account", (profile?.body as Row | undefined)?.must_change_password, false);

      world({ links: [], members: [] });
      process.env.PLATFORM_EMAIL_ALLOW_DOMAINS = "elsewhere.stub";
      const notSent = await add("first.admin@platform.stub");
      process.env.PLATFORM_EMAIL_ALLOW_DOMAINS = PLATFORM_ENV.PLATFORM_EMAIL_ALLOW_DOMAINS;
      eq("a welcome that was not sent (not allowed): the answer says so and holds the link, once", [notSent.body.email_outcome, typeof notSent.body.setup_link, String(notSent.body.setup_link).includes("/auth/set-password#t=")], [{ status: "not_sent", class: "not_allowed" }, "string", true]);

      world({ links: [], members: [] });
      smtpAnswer = { ok: false, error: "Connection timed out" };
      const timedOut = await add("first.admin@platform.stub");
      eq("a welcome that timed out (rule N8): not sent with the class timeout, and the answer holds the link",
        [timedOut.body.email_outcome, String(timedOut.body.setup_link ?? "").includes("/auth/set-password#t=")], [{ status: "not_sent", class: "timeout" }, true]);
      const editor = fs.readFileSync(path.join(ROOT, "app", "(super-owner)", "super", "organizations", "[id]", "tenant-detail-editor.tsx"), "utf8");
      eq("…and the console shows it as a welcome that may have been sent, keyed on that class",
        [editor.includes('mayHaveArrived: outcome.class === "timeout"'), editor.includes("The welcome email may have been sent")], [true, true]);

      world({ links: [], members: [] });
      const found = await add(P.email);
      eq("an account that already existed: added, no account made, no link, no mail, its flag not written",
        [found.status, creates().length, links.length, smtp().length, "must_change_password" in ((requests.find((q) => q.table === "profiles" && q.method === "POST")?.body as Row) ?? {}), "setup_link" in found.body],
        [200, 0, 0, 0, false, false]);

      world({ table: "missing", links: [], members: [] });
      const refused = await add("first.admin@platform.stub");
      eq("without 0117, a new account: refused before any account is made, with a message that names the migration",
        [refused.status, String(refused.body.error).includes("0117"), creates().length, requests.filter((q) => q.table === "organization_members" && q.method !== "GET").length], [503, true, 0, 0]);
      world({ table: "missing", links: [], members: [] });
      const existing = await add(P.email);
      eq("…an account that already existed is added as before", [existing.status, members.map((m) => [m.user_id, m.status])], [200, [[P.id, "active"]]]);
      world({ table: "fail", links: [], members: [] });
      const unread = await add("first.admin@platform.stub");
      eq("…a probe that fails otherwise: 503 try again, nothing made", [unread.status, creates().length], [503, 0]);

      console.log("\nthe console: \"Send setup link again\" (rule N12)");
      const again = async (userId: string) => {
        const res = await admins.PUT(new Request(`https://lms.stub/api/super/tenants/${ORG.id}/admins`, { method: "PUT", body: JSON.stringify({ user_id: userId }) }), ctx);
        return { status: res.status, body: (await res.json()) as Row };
      };
      world();
      const older = links[0];
      const sent = await again(P.id);
      eq("an administrator the console made with a link, never signed in: a new link mailed, the older ended",
        [sent.status, sent.body.email_outcome, smtp().length, typeof older.ended_at, links.filter((l) => l.used_at === null && l.ended_at === null).length], [200, { status: "sent" }, 1, "string", 1]);
      for (const [label, w] of [
        ["one who has signed in", { signIn: "time" }],
        ["one with no link row here (an account that already existed)", { links: [] }],
        ["a link row of another organisation only", { links: [linkRow({ organization_id: OTHER.id })] }],
        ["a learner of this organisation", { members: [member(ORG, P.id, "user")] }],
        ["a person with no row here", { members: [] }],
      ] as const) {
        world(w as Parameters<typeof world>[0]);
        const r = await again(P.id);
        eq(`${label}: the fixed line, nothing written or sent`, [r.status, r.body.error, writes().length, smtp().length], [409, lib.HAS_A_WAY_IN_MESSAGE, 0, 0]);
      }
      world({ links: [linkRow({ created_at: new Date(Date.now() - 3600_000).toISOString() }), linkRow({ created_at: new Date(Date.now() - 7200_000).toISOString(), ended_at: new Date().toISOString() }), linkRow({ created_at: new Date(Date.now() - 10_800_000).toISOString(), ended_at: new Date().toISOString() })] });
      const fourth = await again(P.id);
      eq("the fourth link in 24 hours is refused, and nothing is written", [fourth.status, writes().length], [429, 0]);
      world({ members: [member(ORG, P.id, "admin", "inactive")] });
      const inactive = await again(P.id);
      eq("a row that does not count: not sent, inactive, and no new row", [inactive.status, inactive.body.email_outcome, writes().length, smtp().length], [200, { status: "not_sent", class: "inactive" }, 0, 0]);
      world({ table: "missing" });
      const no0117 = await again(P.id);
      eq("without 0117: refused with the message that names the migration", [no0117.status, String(no0117.body.error).includes("0117"), smtp().length], [503, true, 0]);
      world({ signIn: "empty" });
      const unreadable = await again(P.id);
      eq("a sign-in read that answers no account: 503, nothing written", [unreadable.status, writes().length], [503, 0]);

      console.log("\nthe console's list offers it only where it applies");
      const list = async () => {
        const res = await admins.GET(new Request(`https://lms.stub/api/super/tenants/${ORG.id}/admins`), ctx);
        return ((await res.json()) as { admins: Array<{ user_id: string; setup_link: boolean }> }).admins.map((a) => [a.user_id, a.setup_link]);
      };
      world();
      eq("never signed in, with the platform's link row here: offered", await list(), [[P.id, true]]);
      world({ signIn: "time" });
      eq("signed in: not offered", await list(), [[P.id, false]]);
      world({ links: [linkRow({ issuer: "tenant" })] });
      eq("a tenant's link row only: not offered on the console", await list(), [[P.id, false]]);
      world({ table: "missing" });
      eq("without 0117: not offered", await list(), [[P.id, false]]);
    }

    console.log("\nthe middleware: a signed-out visitor reaches the page and the route");
    {
      const { updateSession } = await import("../../lib/supabase/middleware");
      delete process.env.CUSTOM_DOMAINS_ENABLED;
      delete process.env.PLATFORM_OWNER_IP_ALLOWLIST;
      const through = async (url: string, method = "GET") => {
        const res = await updateSession(new NextRequest(url, { method }));
        return { status: res.status, location: res.headers.get("location"), referrer: res.headers.get("referrer-policy") };
      };
      const page = await through("https://lms.stub/auth/set-password");
      eq("the page, signed out: not sent to a sign-in page, and it sends no referrer", [page.location, page.referrer], [null, "no-referrer"]);
      const api = await through("https://lms.stub/api/auth/set-password", "POST");
      eq("the route, signed out: not sent to a sign-in page", api.location, null);
      const other = await through("https://lms.stub/tenant-a/dashboard");
      eq("…the control: a signed-out page of an organisation is sent to its sign-in page", [other.status, other.location ? new URL(other.location).pathname : null, other.referrer], [307, "/tenant-a/login", null]);
    }

    console.log("\nno request address holds the token");
    {
      eq(`non-vacuous: the code made requests (${addresses.length})`, addresses.length > 100, true);
      eq("no request the code made carries the token in its path or query", addresses.filter((a) => a.includes(TOKEN)).length, 0);
      const form = fs.readFileSync(path.join(ROOT, "app", "auth", "set-password", "set-password-form.tsx"), "utf8");
      const posts = [...form.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]);
      eq("the page posts the token to the route in the body, to an address with no query", [posts, /body: JSON\.stringify\(\{ token: token\.current/.test(form)], [["/api/auth/set-password", "/api/auth/set-password"], true]);
    }

    console.log("\nno log line holds a token, a link or a password");
    {
      const all = lines.join("\n");
      eq(`non-vacuous: the code logged (${lines.length} lines)`, lines.length > 0, true);
      eq("no line holds the token, a set-password address with its token, or a password", [all.includes(TOKEN), /set-password#t=/.test(all), all.includes(PASSWORD)], [false, false, false]);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = real.warn;
    console.error = real.error;
    for (const k of Object.keys(PLATFORM_ENV)) delete process.env[k];
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
