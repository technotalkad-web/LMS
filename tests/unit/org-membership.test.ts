/**
 * Unit test for lib/auth/org-membership.ts, the one answer to "who belongs to
 * an organisation" (ADR 0030 section B, test H.1), and for the guards built
 * on it in the same step (requireOrgAccess, requireOrgAdminApi,
 * isOrgAdminCaller and /select-org). The real code under a stubbed fetch and
 * a stubbed next/headers, as the other route tests run it.
 *
 *   (a) the predicate: only an active row in an organisation whose
 *       deleted_at is null counts; inactive, suspended, a missing status, a
 *       deleted organisation and an organisation read without deleted_at do
 *       not; administrator rights need a counting row and an admin role;
 *   (b) resolveOrgMembership, by slug and by id: an active row answers the
 *       organisation and the role as stored; inactive, suspended, no row, a
 *       deleted organisation and an unknown one all answer "none"; a failed
 *       organisation or member read answers "unreadable", never "none"; the
 *       organisation read selects deleted_at (and the columns asked for),
 *       the member read selects role and status; a deleted organisation
 *       named by slug costs no member read;
 *   (c) listCountingMemberships: only organisations that count, each with
 *       its role; a failed read answers "unreadable";
 *   (d) countingMemberIds: active members of a live organisation, by role
 *       when asked, across pages; an empty set for a deleted or unknown
 *       organisation; "unreadable" when a read fails;
 *   (e) nothing is cached: the same call made twice reads twice, and a row
 *       changed between the calls changes the answer;
 *   (f) the guards: requireOrgAccess sends a person whose membership does
 *       not count to /select-org (a platform owner to /super/organizations)
 *       and refuses with AccessUnreadableError when the check cannot be
 *       read, which a route handler answers 503 (a redirect still passes
 *       through); requireOrgAdminApi answers such a person 404 (a
 *       non-member's answer) and 503 when unreadable; isOrgAdminCaller
 *       answers false and null;
 *   (g) /select-org lists only organisations that count: one goes straight
 *       there, none shows the no-access text with a sign-out control and no
 *       redirect, and an unreadable list says "try again" and goes nowhere;
 *   (h) rule 9 in the platform console (POST, GET and PATCH of
 *       /api/super/tenants/[id]/admins): the list returns each row's
 *       status; the add writes the row active, so an inactive or suspended
 *       row is active again, and its audit row and answer say it
 *       reactivated (an active row, or none, is not reactivated); a failed
 *       read of the row before the add answers 503 and writes nothing; the
 *       role change writes the role alone and leaves the status;
 *   (i) rule 9 and rule 8 on an invitation (POST /api/invitations/accept
 *       and the /invitations/[token] page): an invitation of a deleted
 *       organisation gets the answer an unknown token gets, also when it is
 *       expired or accepted, with no account call, no write and no sign-in;
 *       a failed read answers 503 with none of those; an accepted
 *       invitation writes the role and never the status, so an inactive or
 *       suspended row stays as it was, and a new row starts active; the
 *       page shows a deleted organisation's invitation as not found and
 *       does not name it;
 *   (j) decision 4 in the four writers that can leave a row not active
 *       (POST /api/users, PATCH /api/users/[userId], POST /api/users/bulk
 *       and the CRM's DELETE /api/integrations/employees): the person they
 *       deactivate loses every live launch token of their attempts in that
 *       organisation, on a completed attempt as well as an open one, after
 *       the row is written; a token already expired, the same person's
 *       token in another organisation and another member's token are left
 *       as they were, and no attempt is written; a write that leaves the
 *       row active reads no token; the bulk upload makes one call after its
 *       loop, keyed on each person's last written status, in chunks of 200;
 *       a failed expiry leaves the deactivation standing, is logged with
 *       ids only and is reported in the answer (`tokens_expired: false`,
 *       and a line the admin sees);
 *   (k) rule 10, the organisation's mail goes only to memberships that
 *       count: a welcome only for a row written active (POST /api/users,
 *       the bulk upload) and never into a deleted organisation (the
 *       console's add, whose add itself stands); the reminders and journey
 *       nudges crons, the broadcast route and the course update mail reach
 *       only members that count, whether by name, a team, a static group or
 *       the whole organisation, from one read of them for the run or the
 *       request; a deleted organisation's course or program is skipped
 *       before any read of it, and a broadcast there is refused as for a
 *       non-member; a learner whose row does not count is not claimed,
 *       gets no reminder state (not even a stopped one past the cap) and
 *       raises no escalation, and an escalation goes only to a manager
 *       whose row counts; an attempt request reaches the active
 *       administrators only; an attempt decision and a ticket reply reach
 *       their one person only while that person's membership counts; when
 *       the members that count cannot be read, nothing is sent and the
 *       sender is not entered (a broadcast answers 503), and the log line
 *       holds the organisation's id and no address;
 *   (l) the platform notices (GET /api/broadcasts): an administrators-only
 *       notice is shown only to a person who holds an administrator row
 *       that counts somewhere; one whose only administrator row is inactive,
 *       suspended or in a deleted organisation does not see it (a notice for
 *       everyone still shows); an unreadable list answers 503;
 *   (m) rule 8 for an organisation's API key: the key of a deleted
 *       organisation is refused exactly as a revoked key is (null from
 *       authenticateApiKey, and the same 401 from an integrations route),
 *       and its use is not stamped; a live organisation's key still works.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/org-membership.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import React from "react";
import { createClient } from "@supabase/supabase-js";

// The page's JSX compiles to React.createElement here.
(globalThis as { React?: unknown }).React = React;

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; table: string; select: string; query: URLSearchParams; key: string | null; body?: unknown };

const SUPABASE = "http://stub.supabase.test";
const ANON_KEY = "stub-anon-key";
const SERVICE_KEY = "stub-service-key";
const ME = { id: "u-me", aud: "authenticated", role: "authenticated", email: "caller@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: ME });

/* ---------------- the world behind the stub ---------------- */
const LIVE = { id: "o-live", name: "Live", slug: "live", logo_url: null, brand_color: null, brand_font: null, custom_domain: null, deleted_at: null as string | null };
const SECOND = { id: "o-second", name: "Second", slug: "second", logo_url: null, brand_color: null, brand_font: null, custom_domain: null, deleted_at: null as string | null };
const GONE = { id: "o-gone", name: "Gone", slug: "gone", logo_url: null, brand_color: null, brand_font: null, custom_domain: null, deleted_at: "2026-11-01T00:00:00Z" as string | null };
let orgs: Row[] = [];
let members: Row[] = [];
let failing = new Set<string>();
let platformOwner = false;
let requests: Req[] = [];
let signedIn = true;
// (h) and (i): the accounts the auth server holds, the invitations, and
// every call to the auth server other than the session's own user read.
type Account = { id: string; email: string };
let accounts: Account[] = [];
let invitations: Row[] = [];
let authCalls: string[] = [];
// (j): attempts, their launch tokens, the organisations' API keys, and what
// the code logged with console.error.
let attempts: Row[] = [];
let tokens: Row[] = [];
let apiKeys: Row[] = [];
let logged: string[] = [];
// (l): the platform notices.
let broadcasts: Row[] = [];

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => (signedIn ? [{ name: "sb-stub-auth-token", value: SESSION }] : []), get: () => undefined, set() {} }),
      headers: async () => new Headers({ host: "lms.test", "x-forwarded-proto": "https" }),
    };
  }
  return load.call(this, request, ...rest);
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
const matches = (r: Row, q: URLSearchParams) =>
  [...q.entries()].every(([k, v]) => {
    // A filter on an embedded table ("course_attempts.user_id") is applied
    // by that table's own handler below.
    if (RESERVED.has(k) || k.includes(".")) return true;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    const cell = r[k] === null || r[k] === undefined ? "null" : String(r[k]);
    if (op === "eq") return cell === val;
    if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(cell);
    if (op === "gt") {
      if (cell === "null") return false;
      const a = Date.parse(cell), b = Date.parse(val);
      return Number.isNaN(a) || Number.isNaN(b) ? cell > val : a > b;
    }
    return true;
  });
/** Only the columns asked for, as PostgREST answers. */
const project = (r: Row, select: string) => {
  if (!select || select === "*") return r;
  const out: Row = {};
  for (const c of select.split(",")) out[c] = r[c] ?? null;
  return out;
};

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const p = url.pathname;
  const q = url.searchParams;
  const select = q.get("select") ?? "";
  const table = p.replace("/rest/v1/", "");
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: unknown = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  if (p.startsWith("/rest/v1/")) requests.push({ method, table, select, query: q, key: h.get("apikey"), body });
  if (p === "/auth/v1/user") return signedIn ? json(ME) : json({ message: "no session" }, 401);
  if (p.startsWith("/auth/v1/")) return authServer(method, p, body);
  if (!p.startsWith("/rest/v1/")) return json({ message: "unexpected" }, 500);
  if (method !== "GET") return write(method, table, q, body);
  if (failing.has(table)) return json({ code: "XX000", message: "stub read failure" }, 500);
  const page = (rows: Row[]) => {
    const offset = Number(q.get("offset") ?? 0);
    const limit = q.has("limit") ? Number(q.get("limit")) : rows.length;
    return json(rows.slice(offset, offset + limit).map((r) => project(r, select)));
  };
  if (table === "organizations") return page(orgs.filter((r) => matches(r, q)));
  if (table === "organization_members") {
    const rows = members.filter((r) => matches(r, q)).sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
    return page(rows);
  }
  if (table === "profiles") return json([{ must_change_password: false }]);
  // A platform owner whose row does not require the second factor (as the
  // e2e fixtures seed one), so the platform route guard admits the session.
  if (table === "platform_owners") return json(platformOwner ? [{ user_id: ME.id, mfa_required: false }] : []);
  if (table === "invitations") {
    // The organisation is embedded as PostgREST embeds a to-one relation.
    return json(invitations.filter((r) => matches(r, q)).map((r) => {
      const o = orgs.find((x) => x.id === r.organization_id);
      return { ...r, organizations: o ? { name: o.name, slug: o.slug, deleted_at: o.deleted_at } : null };
    }));
  }
  if (table === "cmi5_launch_tokens") {
    // The attempt is embedded as a to-one relation. Filters named
    // "course_attempts.<column>" test the attempt; with !inner a token
    // whose attempt fails them is left out, as PostgREST does.
    const inner = /course_attempts!inner\(/.test(select);
    const onAttempt = new URLSearchParams(
      [...q.entries()].filter(([k]) => k.startsWith("course_attempts.")).map(([k, v]) => [k.slice("course_attempts.".length), v])
    );
    const rows = tokens
      .filter((t) => matches(t, q))
      .map((t) => ({ t, a: attempts.find((x) => x.id === t.attempt_id && matches(x, onAttempt)) ?? null }))
      .filter(({ a }) => !inner || a !== null)
      .sort((x, y) => String(x.t.fetch_token).localeCompare(String(y.t.fetch_token)))
      .map(({ t, a }) => ({ attempt_id: t.attempt_id, course_attempts: a ? { user_id: a.user_id, organization_id: a.organization_id } : null }));
    const offset = Number(q.get("offset") ?? 0);
    const limit = q.has("limit") ? Number(q.get("limit")) : rows.length;
    return json(rows.slice(offset, offset + limit));
  }
  if (table === "platform_broadcasts") return json(broadcasts.filter((r) => matches(r, q)));
  if (table === "org_api_keys") {
    return json(apiKeys.filter((r) => matches(r, q)).map((r) => {
      const o = orgs.find((x) => x.id === r.organization_id);
      return { id: r.id, organization_id: r.organization_id, is_active: r.is_active, organizations: o ? { slug: o.slug, deleted_at: o.deleted_at } : null };
    }));
  }
  return json([]);
};

const userJson = (a: Account) => ({ id: a.id, aud: "authenticated", role: "authenticated", email: a.email, email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
/** The auth server: the admin user list, a new account, and a password sign-in. */
function authServer(method: string, p: string, body: unknown): Response {
  authCalls.push(`${method} ${p}`);
  if (p === "/auth/v1/admin/users" && method === "GET") return json({ users: accounts.map(userJson), aud: "authenticated" });
  if (p === "/auth/v1/admin/users" && method === "POST") {
    const a = { id: `u-new-${accounts.length + 1}`, email: (body as { email: string }).email };
    accounts.push(a);
    return json(userJson(a));
  }
  if (p === "/auth/v1/token") {
    const a = accounts.find((x) => x.email === (body as { email?: string })?.email) ?? accounts[0];
    return json({ access_token: "stub-token-2", refresh_token: "r2", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: userJson(a) });
  }
  return json({ message: "unexpected" }, 500);
}
/**
 * A write. An upsert of a member row merges the columns it names into the
 * row it meets (PostgREST's merge-duplicates), and a new row takes the
 * column default, status 'active'. A PATCH changes the rows it matches.
 */
function write(method: string, table: string, q: URLSearchParams, body: unknown): Response {
  if (failing.has(`${method} ${table}`)) return json({ code: "XX000", message: "stub write failure" }, 500);
  if (table === "organization_members" && method === "POST") {
    for (const rec of (Array.isArray(body) ? body : [body]) as Row[]) {
      const hit = members.find((r) => r.organization_id === rec.organization_id && r.user_id === rec.user_id);
      if (hit) Object.assign(hit, rec);
      else members.push({ status: "active", ...rec });
    }
    return new Response(null, { status: 201 });
  }
  if (method === "PATCH") {
    const rows =
      table === "organization_members" ? members
      : table === "invitations" ? invitations
      : table === "cmi5_launch_tokens" ? tokens
      : table === "course_attempts" ? attempts
      : [];
    for (const r of rows.filter((x) => matches(x, q))) Object.assign(r, body as Row);
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 201 });
}

const world = (o: { members?: Row[]; failing?: string[]; platformOwner?: boolean; signedIn?: boolean; accounts?: Account[]; invitations?: Row[]; attempts?: Row[]; tokens?: Row[]; apiKeys?: Row[]; broadcasts?: Row[] } = {}) => {
  broadcasts = (o.broadcasts ?? []).map((r) => ({ ...r }));
  orgs = [LIVE, SECOND, GONE].map((x) => ({ ...x }));
  members = (o.members ?? []).map((r) => ({ ...r }));
  failing = new Set(o.failing ?? []);
  platformOwner = o.platformOwner ?? false;
  signedIn = o.signedIn ?? true;
  accounts = (o.accounts ?? []).map((a) => ({ ...a }));
  invitations = (o.invitations ?? []).map((r) => ({ ...r }));
  attempts = (o.attempts ?? []).map((r) => ({ ...r }));
  tokens = (o.tokens ?? []).map((r) => ({ ...r }));
  apiKeys = (o.apiKeys ?? []).map((r) => ({ ...r }));
  logged = [];
  authCalls = [];
  requests = [];
};
const row = (org: { id: string }, role: string, status: string, user = ME.id): Row => ({ organization_id: org.id, user_id: user, role, status });
const reads = (table: string) => requests.filter((r) => r.table === table && r.method === "GET");
/** Every write made to the data API, as "METHOD table". */
const writes = () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").map((r) => `${r.method} ${r.table}`);
const memberOf = (org: { id: string }, user: string) => members.find((r) => r.organization_id === org.id && r.user_id === user);
/** The URL a redirect() threw, or "answered" / the error message. */
const outcome = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "answered";
  } catch (e) {
    const digest = (e as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    return `error ${e instanceof Error ? e.message : String(e)}`;
  }
};
/** Every string in a React element tree. */
const texts = (n: unknown): string[] => {
  if (n === null || n === undefined || typeof n === "boolean") return [];
  if (typeof n === "string" || typeof n === "number") return [String(n)];
  if (Array.isArray(n)) return n.flatMap(texts);
  const el = n as { type?: unknown; props?: { children?: unknown } };
  const own = typeof el.type === "function" ? [`<${(el.type as { name?: string }).name}>`] : [];
  return [...own, ...texts(el.props?.children)];
};

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = stub as typeof fetch;
  console.error = (...a: unknown[]) => {
    logged.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
  };
  try {
    const m = await import("../../lib/auth/org-membership");
    const { requireOrgAccess, ACCESS_UNREADABLE, AccessUnreadableError } = await import("../../lib/auth/require-org-access");
    const usersSearch = await import("../../app/api/users/search/route");
    const { requireOrgAdminApi, isOrgAdminCaller, CHECK_FAILED } = await import("../../lib/auth/api-admin");
    const selectOrg = (await import("../../app/select-org/page")).default;
    const client = () => createClient(SUPABASE, ANON_KEY, { auth: { persistSession: false } });
    const svc = () => createClient(SUPABASE, SERVICE_KEY, { auth: { persistSession: false } });

    console.log("\n(a) the predicate");
    const live = { deleted_at: null };
    const gone = { deleted_at: "2026-11-01T00:00:00Z" };
    for (const [status, want] of [["active", true], ["inactive", false], ["suspended", false], [undefined, false], [null, false], ["ACTIVE", false]] as const) {
      eq(`membershipCounts: status ${JSON.stringify(status)} in a live org → ${want}`, m.membershipCounts({ role: "user", status }, live), want);
    }
    eq("membershipCounts: an active row in a deleted org → false", m.membershipCounts({ role: "user", status: "active" }, gone), false);
    eq("membershipCounts: an org read without deleted_at → false", m.membershipCounts({ role: "user", status: "active" }, {}), false);
    eq("membershipCounts: no row, no org → false", [m.membershipCounts(null, live), m.membershipCounts({ status: "active" }, null)], [false, false]);
    for (const role of ["super_owner", "owner", "admin"]) {
      eq(`grantsAdminRights: an active ${role} in a live org → true; inactive, suspended or deleted → false`,
        [m.grantsAdminRights({ role, status: "active" }, live), m.grantsAdminRights({ role, status: "inactive" }, live), m.grantsAdminRights({ role, status: "suspended" }, live), m.grantsAdminRights({ role, status: "active" }, gone)],
        [true, false, false, false]);
    }
    for (const role of ["data_analyst", "user", "member", ""]) {
      eq(`grantsAdminRights: an active ${JSON.stringify(role)} → false`, m.grantsAdminRights({ role, status: "active" }, live), false);
    }
    eq("ADMIN_ROLES is the is_org_admin list (0056)", [...m.ADMIN_ROLES], ["super_owner", "owner", "admin"]);

    console.log("\n(b) resolveOrgMembership");
    for (const [label, ref] of [["by slug", { slug: "live" }], ["by id", { id: LIVE.id }]] as const) {
      world({ members: [row(LIVE, "admin", "active")] });
      const ok = await m.resolveOrgMembership<{ id: string; name: string }>(client(), ref, ME.id, "id, name");
      eq(`${label}, an active admin: the org (columns asked for) and the role`, ok, { org: { id: LIVE.id, name: "Live", deleted_at: null }, role: "admin" });
      eq(`${label}: the org read selects deleted_at, the member read role and status`,
        [reads("organizations").map((r) => r.select), reads("organization_members").map((r) => r.select)], [["id,name,deleted_at"], ["role,status"]]);
      eq(`${label}: the member read is the caller's own row in that org`,
        [reads("organization_members")[0]?.query.get("organization_id"), reads("organization_members")[0]?.query.get("user_id")], [`eq.${LIVE.id}`, `eq.${ME.id}`]);
      for (const status of ["inactive", "suspended"]) {
        world({ members: [row(LIVE, "admin", status)] });
        eq(`${label}, an ${status} admin → none`, await m.resolveOrgMembership(client(), ref, ME.id), "none");
      }
      world({ members: [] });
      eq(`${label}, no row → none`, await m.resolveOrgMembership(client(), ref, ME.id), "none");
      world({ members: [row(LIVE, "admin", "active", "u-other")] });
      eq(`${label}, another person's active row is not the caller's → none`, await m.resolveOrgMembership(client(), ref, ME.id), "none");
      world({ members: [row(LIVE, "user", "active")], failing: ["organizations"] });
      eq(`${label}, the org read fails → unreadable`, await m.resolveOrgMembership(client(), ref, ME.id), "unreadable");
      world({ members: [row(LIVE, "user", "active")], failing: ["organization_members"] });
      eq(`${label}, the member read fails → unreadable`, await m.resolveOrgMembership(client(), ref, ME.id), "unreadable");
    }
    for (const [label, ref] of [["by slug", { slug: "gone" }], ["by id", { id: GONE.id }]] as const) {
      world({ members: [row(GONE, "super_owner", "active")] });
      eq(`${label}, an active super owner of a deleted org → none`, await m.resolveOrgMembership(client(), ref, ME.id), "none");
    }
    world({ members: [row(GONE, "super_owner", "active")] });
    await m.resolveOrgMembership(client(), { slug: "gone" }, ME.id);
    eq("by slug, a deleted org: no member read is made", reads("organization_members").length, 0);
    for (const [label, ref] of [["by slug", { slug: "nowhere" }], ["by id", { id: "o-nowhere" }]] as const) {
      world({ members: [row({ id: "o-nowhere" }, "admin", "active")] });
      eq(`${label}, an unknown org → none`, await m.resolveOrgMembership(client(), ref, ME.id), "none");
    }
    world({ members: [row(LIVE, "owner", "active")] });
    const legacy = await m.resolveOrgMembership(client(), { slug: "live" }, ME.id);
    eq("the role is returned as stored (the legacy owner is not renamed)", typeof legacy === "object" ? legacy.role : legacy, "owner");
    world({ members: [row(LIVE, "user", "active")] });
    await m.resolveOrgMembership(client(), { id: LIVE.id }, ME.id, "id, slug, deleted_at, id");
    eq("the org select always holds id and deleted_at once each", reads("organizations")[0]?.select, "id,slug,deleted_at");

    console.log("\n(c) listCountingMemberships");
    world({ members: [row(LIVE, "admin", "active"), row(SECOND, "user", "inactive"), row(GONE, "super_owner", "active"), row({ id: "o-x" }, "user", "suspended")] });
    eq("only the org that counts, with its role", await m.listCountingMemberships(client(), ME.id), [{ id: LIVE.id, name: "Live", slug: "live", role: "admin" }]);
    eq("…the member read selects status, the org read deleted_at", [reads("organization_members")[0]?.select, reads("organizations")[0]?.select], ["organization_id,role,status", "id,name,slug,deleted_at"]);
    world({ members: [row(SECOND, "user", "inactive")] });
    eq("only rows that do not count → [] and no org read", [await m.listCountingMemberships(client(), ME.id), reads("organizations").length], [[], 0]);
    world({ members: [row(LIVE, "user", "active"), row(SECOND, "data_analyst", "active")] });
    eq("two that count → both", (await m.listCountingMemberships(client(), ME.id) as Array<{ slug: string; role: string }>).map((o) => `${o.slug}:${o.role}`), ["live:user", "second:data_analyst"]);
    world({ members: [row(LIVE, "user", "active")], failing: ["organization_members"] });
    eq("the member read fails → unreadable", await m.listCountingMemberships(client(), ME.id), "unreadable");
    world({ members: [row(LIVE, "user", "active")], failing: ["organizations"] });
    eq("the org read fails → unreadable", await m.listCountingMemberships(client(), ME.id), "unreadable");

    console.log("\n(d) countingMemberIds");
    world({ members: [
      row(LIVE, "user", "active", "u-1"), row(LIVE, "admin", "active", "u-2"), row(LIVE, "user", "inactive", "u-3"),
      row(LIVE, "admin", "suspended", "u-4"), row(SECOND, "user", "active", "u-5"),
    ] });
    eq("a live org: its active members only", [...((await m.countingMemberIds(svc(), LIVE.id)) as Set<string>)].sort(), ["u-1", "u-2"]);
    eq("…the member read filters the org and the status, and selects status", [
      reads("organization_members")[0]?.query.get("organization_id"), reads("organization_members")[0]?.query.get("status"), reads("organization_members")[0]?.select,
    ], [`eq.${LIVE.id}`, "eq.active", "user_id,role,status"]);
    world({ members: [row(LIVE, "user", "active", "u-1"), row(LIVE, "admin", "active", "u-2"), row(LIVE, "owner", "active", "u-6"), row(LIVE, "admin", "inactive", "u-3")] });
    eq("by role: the active admins only", [...((await m.countingMemberIds(svc(), LIVE.id, ["super_owner", "owner", "admin"])) as Set<string>)].sort(), ["u-2", "u-6"]);
    world({ members: [row(GONE, "user", "active", "u-1")] });
    const goneIds = await m.countingMemberIds(svc(), GONE.id);
    eq("a deleted org: an empty set and no member read", [goneIds instanceof Set ? goneIds.size : goneIds, reads("organization_members").length], [0, 0]);
    world({ members: [] });
    eq("an unknown org: an empty set", ((await m.countingMemberIds(svc(), "o-nowhere")) as Set<string>).size, 0);
    world({ members: [row(LIVE, "user", "active", "u-1")], failing: ["organizations"] });
    eq("the org read fails → unreadable", await m.countingMemberIds(svc(), LIVE.id), "unreadable");
    world({ members: [row(LIVE, "user", "active", "u-1")], failing: ["organization_members"] });
    eq("the member read fails → unreadable", await m.countingMemberIds(svc(), LIVE.id), "unreadable");
    world({ members: Array.from({ length: 1205 }, (_, i) => row(LIVE, "user", i % 7 === 0 ? "inactive" : "active", `u-${String(i).padStart(5, "0")}`)) });
    const many = (await m.countingMemberIds(svc(), LIVE.id)) as Set<string>;
    eq("more than one page: every active member, read page by page", [many.size, reads("organization_members").length], [1205 - Math.ceil(1205 / 7), 2]);

    console.log("\n(e) nothing is cached between calls");
    world({ members: [row(LIVE, "admin", "active")] });
    const first = await m.resolveOrgMembership(client(), { slug: "live" }, ME.id);
    members[0].status = "inactive";
    const second = await m.resolveOrgMembership(client(), { slug: "live" }, ME.id);
    eq("the same call twice reads twice; a row set inactive in between answers none", [typeof first === "object", second, reads("organization_members").length], [true, "none", 2]);
    members[0].status = "active";
    eq("…and set back, it counts again", typeof (await m.resolveOrgMembership(client(), { slug: "live" }, ME.id)), "object");

    console.log("\n(f) the guards");
    world({ members: [row(LIVE, "owner", "active")] });
    const access = await requireOrgAccess("live");
    eq("requireOrgAccess, an active member: the org and the normalised role, no impersonation", [access.org.id, access.role, access.impersonation], [LIVE.id, "super_owner", null]);
    for (const [what, rows, slug] of [
      ["an inactive admin", [row(LIVE, "admin", "inactive")], "live"],
      ["a suspended admin", [row(LIVE, "admin", "suspended")], "live"],
      ["no row", [], "live"],
      ["an active super owner of a deleted org", [row(GONE, "super_owner", "active")], "gone"],
      ["an unknown org", [row(LIVE, "admin", "active")], "nowhere"],
    ] as Array<[string, Row[], string]>) {
      world({ members: rows });
      eq(`requireOrgAccess, ${what}: sent to /select-org, as a non-member is`, await outcome(() => requireOrgAccess(slug)), "redirect /select-org");
    }
    world({ members: [row(LIVE, "admin", "inactive")], platformOwner: true });
    eq("requireOrgAccess, a platform owner whose row is inactive: sent to /super/organizations", await outcome(() => requireOrgAccess("live")), "redirect /super/organizations");
    for (const t of ["organizations", "organization_members"]) {
      world({ members: [row(LIVE, "admin", "active")], failing: [t] });
      eq(`requireOrgAccess, the ${t} read fails: refused with an error, no redirect`, await outcome(() => requireOrgAccess("live")), `error ${ACCESS_UNREADABLE}`);
      world({ members: [row(LIVE, "admin", "active")], failing: [t] });
      eq(`…the error is an AccessUnreadableError`, await requireOrgAccess("live").then(() => false, (e: unknown) => e instanceof AccessUnreadableError), true);
    }
    {
      const search = () => usersSearch.GET(new Request("http://lms.test/api/users/search?orgSlug=live&q=a"));
      world({ members: [row(LIVE, "admin", "active")], failing: ["organization_members"] });
      const res = await search();
      eq("a route handler on requireOrgAccess (users/search), the check unreadable: 503 try again",
        [res.status, ((await res.json()) as { error?: string }).error], [503, ACCESS_UNREADABLE]);
      world({ members: [row(LIVE, "admin", "inactive")] });
      eq("…an inactive admin: the redirect a non-member gets passes through unchanged", await outcome(search), "redirect /select-org");
      world({ members: [row(LIVE, "admin", "active")] });
      eq("…an active admin: answered", (await search()).status, 200);
    }

    for (const [what, rows, slug, want] of [
      ["an active admin", [row(LIVE, "admin", "active")], "live", 200],
      ["an active plain member", [row(LIVE, "user", "active")], "live", 403],
      ["an inactive admin", [row(LIVE, "admin", "inactive")], "live", 404],
      ["a suspended admin", [row(LIVE, "admin", "suspended")], "live", 404],
      ["an active admin of a deleted org", [row(GONE, "admin", "active")], "gone", 404],
      ["no row", [], "live", 404],
    ] as Array<[string, Row[], string, number]>) {
      world({ members: rows });
      const a = await requireOrgAdminApi(slug);
      eq(`requireOrgAdminApi, ${what}: ${want}`, "error" in a ? a.status : 200, want);
    }
    world({ members: [row(LIVE, "admin", "active")], failing: ["organization_members"] });
    const failedAdmin = await requireOrgAdminApi("live");
    eq("requireOrgAdminApi, the role read fails: 503 try again", "error" in failedAdmin ? [failedAdmin.status, failedAdmin.error] : 200, [503, CHECK_FAILED]);

    for (const [what, rows, orgId, want] of [
      ["an active admin", [row(LIVE, "admin", "active")], LIVE.id, true],
      ["an active data analyst", [row(LIVE, "data_analyst", "active")], LIVE.id, false],
      ["an inactive admin", [row(LIVE, "admin", "inactive")], LIVE.id, false],
      ["a suspended super owner", [row(LIVE, "super_owner", "suspended")], LIVE.id, false],
      ["an active admin of a deleted org", [row(GONE, "admin", "active")], GONE.id, false],
    ] as Array<[string, Row[], string, boolean]>) {
      world({ members: rows });
      eq(`isOrgAdminCaller, ${what}: ${want}`, await isOrgAdminCaller(client(), orgId, ME.id), want);
    }
    for (const t of ["organizations", "organization_members"]) {
      world({ members: [row(LIVE, "admin", "active")], failing: [t] });
      eq(`isOrgAdminCaller, the ${t} read fails: null (503), never false`, await isOrgAdminCaller(client(), LIVE.id, ME.id), null);
    }

    console.log("\n(g) /select-org");
    world({ members: [row(LIVE, "user", "active"), row(SECOND, "admin", "inactive")] });
    eq("one org that counts beside one that does not: straight to it", await outcome(() => selectOrg()), "redirect /live/dashboard");
    world({ members: [row(SECOND, "admin", "inactive")] });
    {
      let el: unknown = null;
      const o = await outcome(async () => { el = await selectOrg(); });
      const t = texts(el).join(" ").replace(/\s+/g, " ");
      eq("a single membership that does not count: the no-access page, no redirect", o, "answered");
      eq("…the text names no organisation and gives no reason, with a sign-out control",
        [/You do not have access to a workspace\. If you expected access, contact your organisation's administrator\./.test(t), /Second|second|inactive/.test(t), /<SignOut>/.test(t)], [true, false, true]);
    }
    world({ members: [row(GONE, "super_owner", "active")] });
    eq("a membership in a deleted org only: the no-access page, no redirect", await outcome(() => selectOrg()), "answered");
    world({ members: [row(LIVE, "user", "active"), row(SECOND, "data_analyst", "active")] });
    {
      let el: unknown = null;
      await outcome(async () => { el = await selectOrg(); });
      const t = texts(el).join(" ");
      eq("two that count: both listed, no redirect", [/Live/.test(t), /Second/.test(t), /do not have access/.test(t)], [true, true, false]);
    }
    world({ members: [row(LIVE, "user", "active")], failing: ["organization_members"] });
    {
      let el: unknown = null;
      const o = await outcome(async () => { el = await selectOrg(); });
      const t = texts(el).join(" ");
      eq("the list cannot be read: try again, no redirect, never the no-access text", [o, /try again/.test(t), /do not have access/.test(t)], ["answered", true, false]);
    }
    world({ members: [row(LIVE, "user", "active")], platformOwner: true });
    eq("a platform owner: /super/organizations", await outcome(() => selectOrg()), "redirect /super/organizations");

    console.log("\n(h) rule 9 in the platform console: /api/super/tenants/[id]/admins");
    {
      const adminsRoute = await import("../../app/api/super/tenants/[id]/admins/route");
      const PEOPLE: Account[] = [
        { id: "u-act", email: "active.admin@example.test" },
        { id: "u-ina", email: "inactive.admin@example.test" },
        { id: "u-sus", email: "suspended.analyst@example.test" },
        { id: "u-lrn", email: "learner@example.test" },
        { id: "u-out", email: "outsider@example.test" },
      ];
      // The platform owner (the session) holds no row in the tenant.
      const consoleWorld = (failingTables: string[] = []) => world({
        platformOwner: true,
        accounts: PEOPLE,
        failing: failingTables,
        members: [row(LIVE, "admin", "active", "u-act"), row(LIVE, "admin", "inactive", "u-ina"), row(LIVE, "data_analyst", "suspended", "u-sus"), row(LIVE, "user", "active", "u-lrn")],
      });
      const url = `http://lms.test/api/super/tenants/${LIVE.id}/admins`;
      const ctx = () => ({ params: Promise.resolve({ id: LIVE.id }) });
      const add = async (email: string, role = "admin") => {
        const res = await adminsRoute.POST(new Request(url, { method: "POST", body: JSON.stringify({ email, role }) }), ctx());
        return { status: res.status, body: (await res.json()) as Row };
      };
      const memberWrites = (method: string) => requests.filter((r) => r.table === "organization_members" && r.method === method).map((r) => r.body as Row);
      const audit = () => requests.filter((r) => r.table === "platform_audit_log" && r.method === "POST").map((r) => (r.body as { metadata?: Row }).metadata ?? {});
      /** The row before the add is read, for that person in that tenant, before the first write. */
      const priorReadFirst = (userId: string) => {
        const i = requests.findIndex((r) => r.table === "organization_members" && r.method === "GET");
        const w = requests.findIndex((r) => r.method !== "GET" && r.method !== "HEAD");
        const r = requests[i];
        return [i >= 0 && i < w, r?.select, r?.query.get("organization_id"), r?.query.get("user_id")];
      };

      consoleWorld();
      {
        const res = await adminsRoute.GET(new Request(url), ctx());
        const j = (await res.json()) as { admins: Array<{ user_id: string; role: string; status: string }> };
        eq("GET: each administrator with the status of their row; a learner is not listed",
          [res.status, j.admins.map((a) => `${a.user_id}:${a.role}:${a.status}`).sort()],
          [200, ["u-act:admin:active", "u-ina:admin:inactive", "u-sus:data_analyst:suspended"]]);
        eq("…the member read selects the status", reads("organization_members").map((r) => r.select), ["user_id,role,status"]);
      }

      for (const [who, id, email, before, role] of [
        ["an inactive admin", "u-ina", PEOPLE[1].email, "inactive", "admin"],
        ["a suspended data analyst", "u-sus", PEOPLE[2].email, "suspended", "data_analyst"],
      ] as const) {
        consoleWorld();
        const got = await add(email, role);
        eq(`POST, ${who}: 200, the row is active again with its role`, [got.status, memberOf(LIVE, id)?.status, memberOf(LIVE, id)?.role], [200, "active", role]);
        eq("…the member write names status active beside the role", memberWrites("POST").map((b) => [b.role, b.status]), [[role, "active"]]);
        eq(`…the audit row says it reactivated, from ${before}`, audit().map((a) => [a.reactivated, a.previous_status]), [[true, before]]);
        eq("…the answer says so too, and no account is made", [got.body.reactivated, got.body.invited, authCalls.filter((c) => c === "POST /auth/v1/admin/users").length], [true, false, 0]);
        eq("…the row before the add is read first: that person's status in that tenant", priorReadFirst(id), [true, "status", `eq.${LIVE.id}`, `eq.${id}`]);
      }
      consoleWorld();
      {
        const got = await add(PEOPLE[0].email);
        eq("POST, an active admin: still active; not reactivated, in the audit row and the answer",
          [got.status, memberOf(LIVE, "u-act")?.status, audit().map((a) => [a.reactivated, a.previous_status]), got.body.reactivated],
          [200, "active", [[false, "active"]], false]);
      }
      consoleWorld();
      {
        const got = await add(PEOPLE[4].email);
        eq("POST, an account with no row in the tenant: a new active row; not reactivated, no previous status",
          [got.status, memberOf(LIVE, "u-out")?.status, memberOf(LIVE, "u-out")?.role, audit().map((a) => [a.reactivated, a.previous_status]), got.body.reactivated],
          [200, "active", "admin", [[false, null]], false]);
      }
      consoleWorld(["organization_members"]);
      {
        const got = await add(PEOPLE[1].email);
        eq("POST, the row before the add cannot be read: 503 try again, nothing written, the row stays inactive",
          [got.status, /try again/i.test(String(got.body.error)), writes(), memberOf(LIVE, "u-ina")?.status],
          [503, true, [], "inactive"]);
      }
      consoleWorld();
      {
        const res = await adminsRoute.PATCH(new Request(url, { method: "PATCH", body: JSON.stringify({ user_id: "u-ina", role: "data_analyst" }) }), ctx());
        eq("PATCH, the role change of an inactive admin: 200, the write names the role alone",
          [res.status, memberWrites("PATCH").map((b) => Object.keys(b))], [200, [["role"]]]);
        eq("…the row has the new role and is still inactive", [memberOf(LIVE, "u-ina")?.role, memberOf(LIVE, "u-ina")?.status], ["data_analyst", "inactive"]);
      }
    }

    console.log("\n(i) rule 9 and rule 8 on an invitation: /api/invitations/accept and its page");
    {
      const acceptRoute = await import("../../app/api/invitations/accept/route");
      const invitationPage = (await import("../../app/invitations/[token]/page")).default;
      const INVITEE: Account = { id: "u-inv", email: "invitee@example.test" };
      const PAST = "2020-01-01T00:00:00Z";
      const invitation = (org: { id: string }, o: { expires_at?: string; accepted_at?: string | null } = {}): Row => ({
        id: "inv-1", token: "t-1", organization_id: org.id, email: INVITEE.email, role: "user",
        accepted_at: o.accepted_at ?? null, expires_at: o.expires_at ?? "2100-01-01T00:00:00Z",
      });
      const accept = async (token = "t-1") => {
        const res = await acceptRoute.POST(new Request("http://lms.test/api/invitations/accept", { method: "POST", body: JSON.stringify({ token, password: "a-long-password-1" }) }));
        return { status: res.status, body: (await res.json()) as Row };
      };
      /** Every string in an element tree, string props included (a title is a prop). */
      const allTexts = (n: unknown): string[] => {
        if (n === null || n === undefined || typeof n === "boolean") return [];
        if (typeof n === "string" || typeof n === "number") return [String(n)];
        if (Array.isArray(n)) return n.flatMap(allTexts);
        const el = n as { type?: unknown; props?: Record<string, unknown> };
        const own = typeof el.type === "function" ? [`<${(el.type as { name?: string }).name}>`] : [];
        return [...own, ...Object.entries(el.props ?? {}).flatMap(([k, v]) => (k === "children" ? allTexts(v) : typeof v === "string" ? [v] : []))];
      };
      const pageText = async () => {
        let el: unknown = null;
        const o = await outcome(async () => { el = await invitationPage({ params: Promise.resolve({ token: "t-1" }) }); });
        return { o, t: allTexts(el).join(" ").replace(/\s+/g, " ") };
      };

      world({ accounts: [INVITEE] });
      const unknown = await accept("t-unknown");
      eq("an unknown token: 404 Invalid invitation (the answer to match)", [unknown.status, unknown.body], [404, { error: "Invalid invitation" }]);

      for (const [what, inv] of [
        ["an open invitation", invitation(GONE)],
        ["an expired invitation", invitation(GONE, { expires_at: PAST })],
        ["an accepted invitation", invitation(GONE, { accepted_at: "2026-11-01T00:00:00Z" })],
      ] as Array<[string, Row]>) {
        for (const [who, accs] of [["an existing account", [INVITEE]], ["no account yet", []]] as Array<[string, Account[]]>) {
          world({ accounts: accs, invitations: [inv], members: accs.length ? [row(GONE, "user", "inactive", INVITEE.id)] : [] });
          const got = await accept();
          eq(`a deleted organisation, ${what}, ${who}: the unknown token's answer`, [got.status, got.body], [unknown.status, unknown.body]);
          eq("…no auth server call (no account looked up, made or changed, no sign-in) and no write", [authCalls, writes()], [[], []]);
        }
      }
      eq("…the invitation read asks for the organisation's deleted_at", /organizations\([^)]*deleted_at/.test(reads("invitations")[0]?.select ?? ""), true);

      world({ accounts: [INVITEE], invitations: [invitation(LIVE)], failing: ["invitations"] });
      {
        const got = await accept();
        eq("the invitation read fails: 503 try again, no auth server call, no write",
          [got.status, /try again/i.test(String(got.body.error)), authCalls, writes()], [503, true, [], []]);
      }

      for (const status of ["inactive", "suspended"]) {
        world({ accounts: [INVITEE], invitations: [invitation(LIVE)], members: [row(LIVE, "user", status, INVITEE.id)] });
        const got = await accept();
        const upserts = requests.filter((r) => r.table === "organization_members" && r.method === "POST").map((r) => Object.keys(r.body as Row).sort());
        eq(`a live organisation, the invitee's row ${status}: accepted (200 ok)`, [got.status, got.body.ok], [200, true]);
        eq("…the member write names the role and never the status", upserts, [["organization_id", "role", "user_id"]]);
        eq(`…the row is still ${status}`, memberOf(LIVE, INVITEE.id)?.status, status);
      }
      world({ accounts: [INVITEE], invitations: [invitation(LIVE)] });
      {
        const got = await accept();
        eq("a live organisation, no row yet (the control): accepted, a new active row with the invitation's role, the invitation stamped, signed in",
          [got.status, got.body.ok, memberOf(LIVE, INVITEE.id)?.status, memberOf(LIVE, INVITEE.id)?.role, typeof invitations[0].accepted_at, authCalls.includes("POST /auth/v1/token")],
          [200, true, "active", "user", "string", true]);
      }

      world({ invitations: [invitation(GONE)] });
      {
        const { o, t } = await pageText();
        eq("the page, a deleted organisation's invitation: not found, the organisation not named, no form",
          [o, /Invitation not found/.test(t), /Gone/.test(t), /<AcceptForm>/.test(t)], ["answered", true, false, false]);
        eq("…the page's read asks for the organisation's deleted_at", /organizations\([^)]*deleted_at/.test(reads("invitations")[0]?.select ?? ""), true);
      }
      world({ invitations: [invitation(LIVE)] });
      {
        const { o, t } = await pageText();
        eq("the page, a live organisation's invitation (the control): the organisation named, with the form",
          [o, /You've been invited/.test(t), /Live/.test(t), /<AcceptForm>/.test(t)], ["answered", true, true, true]);
      }
      world({ invitations: [invitation(LIVE)], failing: ["invitations"] });
      {
        const { t } = await pageText();
        eq("the page, the read fails: try again, never 'not found'", [/try again/i.test(t), /not found/.test(t), /<AcceptForm>/.test(t)], [true, false, false]);
      }
    }

    console.log("\n(j) decision 4: a deactivation closes that person's open launches in that organisation");
    {
      const usersRoute = await import("../../app/api/users/route");
      const userRoute = await import("../../app/api/users/[userId]/route");
      const bulkRoute = await import("../../app/api/users/bulk/route");
      const employeesRoute = await import("../../app/api/integrations/employees/route");
      const { hashApiKey } = await import("../../lib/integrations/auth");
      const { LAUNCH_TOKENS_NOT_EXPIRED } = await import("../../lib/attempts/abandon");

      const T: Account = { id: "u-t", email: "target@example.test" };
      const B: Account = { id: "u-b", email: "bystander@example.test" };
      const LATER = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
      const EARLIER = "2026-01-01T00:00:00.000Z";
      // A fixture key; the route stores and compares only its hash.
      const API_KEY = `ambk_${"5a".repeat(24)}`;
      // T holds, in this organisation: an open attempt and a completed one,
      // each with a live token, and an open attempt whose token has already
      // expired. The controls: T's own live token in another organisation,
      // and another member's live token here.
      const ATTEMPTS: Row[] = [
        { id: "a-open", user_id: T.id, organization_id: LIVE.id, status: "in_progress" },
        { id: "a-done", user_id: T.id, organization_id: LIVE.id, status: "completed" },
        { id: "a-old", user_id: T.id, organization_id: LIVE.id, status: "in_progress" },
        { id: "a-second", user_id: T.id, organization_id: SECOND.id, status: "in_progress" },
        { id: "a-other", user_id: B.id, organization_id: LIVE.id, status: "in_progress" },
      ];
      const TOKENS: Row[] = [
        { fetch_token: "f-open", attempt_id: "a-open", expires_at: LATER },
        { fetch_token: "f-done", attempt_id: "a-done", expires_at: LATER },
        { fetch_token: "f-old", attempt_id: "a-old", expires_at: EARLIER },
        { fetch_token: "f-second", attempt_id: "a-second", expires_at: LATER },
        { fetch_token: "f-other", attempt_id: "a-other", expires_at: LATER },
      ];
      const ALL_LIVE = ["f-done", "f-open", "f-other", "f-second"];
      // The session is an active administrator of LIVE; T and B are learners.
      const writerWorld = (o: { failing?: string[]; tStatus?: string; extraAccounts?: Account[]; extraMembers?: Row[]; extraAttempts?: Row[]; extraTokens?: Row[] } = {}) => world({
        accounts: [T, B, ...(o.extraAccounts ?? [])],
        members: [
          row(LIVE, "admin", "active"),
          { ...row(LIVE, "user", o.tStatus ?? "active", T.id), employee_id: "E-T" },
          row(SECOND, "user", "active", T.id),
          { ...row(LIVE, "user", "active", B.id), employee_id: "E-B" },
          ...(o.extraMembers ?? []),
        ],
        attempts: [...ATTEMPTS, ...(o.extraAttempts ?? [])],
        tokens: [...TOKENS, ...(o.extraTokens ?? [])],
        apiKeys: [{ id: "k-live", organization_id: LIVE.id, is_active: true, key_hash: hashApiKey(API_KEY) }],
        failing: o.failing,
      });
      const liveTokens = () => tokens.filter((t) => Date.parse(String(t.expires_at)) > Date.now()).map((t) => String(t.fetch_token)).sort();
      const tokenCalls = () => requests.filter((r) => r.table === "cmi5_launch_tokens").map((r) => r.method);
      /** Every token request comes after the last write of a member row. */
      const afterMemberWrites = () => {
        const lastWrite = requests.reduce((at, r, i) => (r.table === "organization_members" && r.method !== "GET" ? i : at), -1);
        const firstToken = requests.findIndex((r) => r.table === "cmi5_launch_tokens");
        return lastWrite >= 0 && firstToken > lastWrite;
      };
      const attemptsUntouched = () => [
        JSON.stringify(attempts) === JSON.stringify(ATTEMPTS),
        requests.filter((r) => r.table === "course_attempts" && r.method !== "GET").length,
      ];
      const failureLog = () =>
        logged
          .map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } })
          .filter((l): l is Row => l?.event === "launch_token_expiry_failed");
      const closedForT = (who: string) => {
        eq(`${who}T's live tokens in this organisation are expired, the open attempt's and the completed one's`,
          liveTokens().filter((f) => f === "f-open" || f === "f-done"), []);
        eq("…the token that had already expired is left as it was", tokens.find((t) => t.fetch_token === "f-old")?.expires_at, EARLIER);
        eq("…nobody else's: T's token in another organisation and another member's token here stay live", liveTokens(), ["f-other", "f-second"]);
        eq("…T's row in the other organisation is unchanged", memberOf(SECOND, T.id)?.status, "active");
        eq("…the attempts are as they were, and nothing is written to them", attemptsUntouched(), [true, 0]);
        eq("…one read of live tokens, then one expiry, after the member row is written", [tokenCalls(), afterMemberWrites()], [["GET", "PATCH"], true]);
        eq("…nothing is logged as failed", failureLog().length, 0);
      };
      const reportedForT = (who: string, answer: { status: number; body: Row }) => {
        eq(`${who}: still 200, and the deactivation stands`, [answer.status, memberOf(LIVE, T.id)?.status], [200, "inactive"]);
        eq("…the answer reports the failed expiry", answer.body.tokens_expired, false);
        const logs = failureLog();
        eq("…one log line, with the organisation and the person by id",
          logs.map((l) => [l.organization_id, l.user_ids]), [[LIVE.id, [T.id]]]);
        eq("…and no address in it", logs.some((l) => JSON.stringify(l).includes("@")), false);
      };

      // ---- POST /api/users: the single add, on an existing row ----
      const addUser = async (status: string) => {
        const res = await usersRoute.POST(new Request("http://lms.test/api/users", {
          method: "POST",
          body: JSON.stringify({ orgSlug: LIVE.slug, first_name: "Target", email: T.email, employee_id: "E-T", lms_role: "user", node_id: "N1", status }),
        }));
        return { status: res.status, body: (await res.json()) as Row };
      };
      for (const status of ["inactive", "suspended"]) {
        writerWorld();
        const got = await addUser(status);
        eq(`POST /api/users, T added again as ${status}: 200, the row is ${status}`, [got.status, memberOf(LIVE, T.id)?.status], [200, status]);
        closedForT("…");
        eq("…the answer carries no failure", ["tokens_expired" in got.body, got.body.warnings], [false, []]);
      }
      writerWorld({ tStatus: "inactive" });
      {
        const got = await addUser("active");
        eq("POST /api/users, T added again as active (the control): the row is active, no token is read or changed",
          [got.status, memberOf(LIVE, T.id)?.status, tokenCalls(), liveTokens()], [200, "active", [], ALL_LIVE]);
      }
      writerWorld({ failing: ["cmi5_launch_tokens"] });
      {
        const got = await addUser("inactive");
        reportedForT("POST /api/users, the token read fails", got);
        eq("…no token is expired, and the admin is told in the warnings", [liveTokens(), got.body.warnings], [ALL_LIVE, [LAUNCH_TOKENS_NOT_EXPIRED]]);
      }

      // ---- PATCH /api/users/[userId]: the admin's edit ----
      const editUser = async (body: Row) => {
        const res = await userRoute.PATCH(
          new Request(`http://lms.test/api/users/${T.id}?orgSlug=${LIVE.slug}`, { method: "PATCH", body: JSON.stringify(body) }),
          { params: Promise.resolve({ userId: T.id }) }
        );
        return { status: res.status, body: (await res.json()) as Row };
      };
      for (const status of ["inactive", "suspended"]) {
        writerWorld();
        const got = await editUser({ status });
        eq(`PATCH /api/users/[userId], status ${status}: 200, the row is ${status}`, [got.status, memberOf(LIVE, T.id)?.status], [200, status]);
        closedForT("…");
        eq("…the answer carries no failure", [got.body, "tokens_expired" in got.body], [{ ok: true, warnings: [] }, false]);
      }
      writerWorld({ tStatus: "inactive" });
      {
        const got = await editUser({ status: "active" });
        eq("PATCH, status active (the control): the row is active, no token is read or changed",
          [got.status, memberOf(LIVE, T.id)?.status, tokenCalls(), liveTokens()], [200, "active", [], ALL_LIVE]);
      }
      writerWorld();
      {
        const got = await editUser({ grade: "G2" });
        eq("PATCH that names no status: no token is read or changed", [got.status, memberOf(LIVE, T.id)?.status, tokenCalls(), liveTokens()], [200, "active", [], ALL_LIVE]);
      }
      writerWorld({ tStatus: "inactive" });
      {
        await editUser({ status: "inactive" });
        eq("PATCH, inactive saved again on an inactive row: T's live tokens are expired (a retry closes what a failure left)",
          [liveTokens(), tokenCalls()], [["f-other", "f-second"], ["GET", "PATCH"]]);
      }
      writerWorld({ failing: ["cmi5_launch_tokens"] });
      {
        const got = await editUser({ status: "inactive" });
        reportedForT("PATCH, the token read fails", got);
        eq("…no token is expired, and the admin is told in the warnings", [liveTokens(), got.body.warnings], [ALL_LIVE, [LAUNCH_TOKENS_NOT_EXPIRED]]);
      }
      writerWorld({ failing: ["PATCH cmi5_launch_tokens"] });
      {
        const got = await editUser({ status: "inactive" });
        reportedForT("PATCH, the token expiry write fails", got);
        eq("…the tokens stay live, and the admin is told in the warnings", [liveTokens(), got.body.warnings], [ALL_LIVE, [LAUNCH_TOKENS_NOT_EXPIRED]]);
      }

      // ---- POST /api/users/bulk: the upload ----
      const HEADER = "first_name,unique_id,email,lms_role,node_id,status";
      const line = (a: Account, employeeId: string, status: string) => `Person,${employeeId},${a.email},user,N1,${status}`;
      const upload = async (lines: string[]) => {
        const res = await bulkRoute.POST(new Request("http://lms.test/api/users/bulk", {
          method: "POST",
          body: JSON.stringify({ orgSlug: LIVE.slug, csv: [HEADER, ...lines].join("\n") }),
        }));
        return { status: res.status, body: (await res.json()) as Row & { results: Array<{ row: number; status: string; message?: string }> } };
      };
      for (const status of ["inactive", "suspended"]) {
        writerWorld();
        const got = await upload([line(T, "E-T", status)]);
        eq(`bulk, T's row ${status}: 200, the row is ${status}`, [got.status, got.body.results.map((r) => r.status), memberOf(LIVE, T.id)?.status], [200, ["updated"], status]);
        closedForT("…");
        eq("…the answer carries no failure", ["tokens_expired" in got.body, got.body.results.map((r) => r.message ?? null)], [false, [null]]);
      }
      {
        const C: Account = { id: "u-c", email: "colleague@example.test" };
        writerWorld({
          extraAccounts: [C],
          extraMembers: [{ ...row(LIVE, "user", "active", C.id), employee_id: "E-C" }],
          extraAttempts: [{ id: "a-c", user_id: C.id, organization_id: LIVE.id, status: "in_progress" }],
          extraTokens: [{ fetch_token: "f-c", attempt_id: "a-c", expires_at: LATER }],
        });
        const got = await upload([line(T, "E-T", "inactive"), line(B, "E-B", "suspended"), line(C, "E-C", "active")]);
        eq("bulk, T inactive, B suspended, C active: three rows updated", [got.status, got.body.results.map((r) => r.status)], [200, ["updated", "updated", "updated"]]);
        eq("…T's and B's live tokens here are expired; C's and T's in another organisation stay live", liveTokens(), ["f-c", "f-second"]);
        const rd = requests.filter((r) => r.table === "cmi5_launch_tokens" && r.method === "GET");
        eq("…one call after the loop: one read for both people, then one expiry, after every member write",
          [tokenCalls(), (rd[0]?.query.get("course_attempts.user_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").sort(), afterMemberWrites()],
          [["GET", "PATCH"], [B.id, T.id], true]);
        eq("…the attempts are not written", requests.filter((r) => r.table === "course_attempts" && r.method !== "GET").length, 0);
      }
      writerWorld();
      {
        const got = await upload([line(T, "E-T", "inactive"), line(T, "E-T", "active")]);
        eq("bulk, T inactive and then active again in the same file: the row ends active, no token is read or changed",
          [got.status, memberOf(LIVE, T.id)?.status, tokenCalls(), liveTokens()], [200, "active", [], ALL_LIVE]);
      }
      writerWorld({ tStatus: "inactive" });
      {
        const got = await upload([line(T, "E-T", "active")]);
        eq("bulk, T's row active (the control): no token is read or changed", [got.status, memberOf(LIVE, T.id)?.status, tokenCalls(), liveTokens()], [200, "active", [], ALL_LIVE]);
      }
      {
        // 201 people deactivated in one file: chunks of 200, still one call after the loop.
        const many: Account[] = Array.from({ length: 201 }, (_, i) => ({ id: `u-m${String(i).padStart(3, "0")}`, email: `member${i}@example.test` }));
        const first = many[0], last = many[200];
        writerWorld({
          extraAccounts: many,
          extraMembers: many.map((a, i) => ({ ...row(LIVE, "user", "active", a.id), employee_id: `E-M${i}` })),
          extraAttempts: [first, last].map((a) => ({ id: `a-${a.id}`, user_id: a.id, organization_id: LIVE.id, status: "in_progress" })),
          extraTokens: [first, last].map((a) => ({ fetch_token: `f-${a.id}`, attempt_id: `a-${a.id}`, expires_at: LATER })),
        });
        const got = await upload(many.map((a, i) => line(a, `E-M${i}`, "inactive")));
        const rd = requests.filter((r) => r.table === "cmi5_launch_tokens" && r.method === "GET");
        const sizes = rd.map((r) => (r.query.get("course_attempts.user_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").length);
        eq("bulk, 201 people deactivated: 201 rows updated, two reads of 200 and 1 people, then one expiry, all after the last member write",
          [got.status, got.body.results.filter((r) => r.status === "updated").length, sizes, tokenCalls().filter((m) => m === "PATCH").length, afterMemberWrites()],
          [200, 201, [200, 1], 1, true]);
        eq("…the live tokens of the first and the last person are both expired; the others' stay", liveTokens(), ALL_LIVE);
      }
      writerWorld({ failing: ["cmi5_launch_tokens"] });
      {
        const got = await upload([line(T, "E-T", "inactive"), line(B, "E-B", "active")]);
        eq("bulk, the token read fails: still 200, T's row inactive, B's active, no token expired",
          [got.status, memberOf(LIVE, T.id)?.status, memberOf(LIVE, B.id)?.status, liveTokens()], [200, "inactive", "active", ALL_LIVE]);
        eq("…the answer reports it, and T's row says so; B's row does not",
          [got.body.tokens_expired, /open course launches not closed/.test(got.body.results[0]?.message ?? ""), got.body.results[1]?.message ?? null],
          [false, true, null]);
        eq("…one log line, with the organisation and the person by id, no address",
          [failureLog().map((l) => [l.organization_id, l.user_ids]), failureLog().some((l) => JSON.stringify(l).includes("@"))],
          [[[LIVE.id, [T.id]]], false]);
      }

      // ---- DELETE /api/integrations/employees: the CRM's leaver ----
      const leave = async (employeeId: string) => {
        const res = await employeesRoute.DELETE(new Request("http://lms.test/api/integrations/employees", {
          method: "DELETE",
          headers: { authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify({ employee_id: employeeId }),
        }));
        return { status: res.status, body: (await res.json()) as Row };
      };
      writerWorld();
      {
        const got = await leave("E-T");
        eq("CRM DELETE, T: 200 deactivated, the row is inactive", [got.status, got.body, memberOf(LIVE, T.id)?.status],
          [200, { ok: true, action: "deactivated", employee_id: "E-T" }, "inactive"]);
        closedForT("…");
      }
      writerWorld({ failing: ["cmi5_launch_tokens"] });
      {
        const got = await leave("E-T");
        reportedForT("CRM DELETE, the token read fails", got);
        eq("…no token is expired, and the rest of the answer is as before", [liveTokens(), got.body.ok, got.body.action], [ALL_LIVE, true, "deactivated"]);
      }
    }
    console.log("\n(k) rule 10: the organisation's mail goes only to memberships that count");
    {
      /** "<event> <user id>" for every mail the sender logged (each send writes one notification_log row), sorted. */
      const sentEvents = () => requests.filter((r) => r.table === "notification_log" && r.method === "POST")
        .map((r) => `${(r.body as Row).event_type} ${(r.body as Row).to_user_id}`).sort();

      // ---- the welcome, on the routes of (h) and (j), under the same stub ----
      {
        const usersRoute = await import("../../app/api/users/route");
        const bulkRoute = await import("../../app/api/users/bulk/route");
        const adminsRoute = await import("../../app/api/super/tenants/[id]/admins/route");
        // N has an account and no row here; the session is an active administrator of LIVE.
        const N: Account = { id: "u-n", email: "newcomer@example.test" };
        const newcomerWorld = () => world({ accounts: [N], members: [row(LIVE, "admin", "active")] });
        for (const status of ["inactive", "suspended", "active"]) {
          newcomerWorld();
          const res = await usersRoute.POST(new Request("http://lms.test/api/users", {
            method: "POST",
            body: JSON.stringify({ orgSlug: LIVE.slug, first_name: "New", email: N.email, employee_id: "E-N", lms_role: "user", node_id: "N1", status }),
          }));
          eq(`POST /api/users, a new row written ${status}: 200, the row is ${status}, ${status === "active" ? "and the welcome is sent" : "and no welcome is sent"}`,
            [res.status, memberOf(LIVE, N.id)?.status, sentEvents()], [200, status, status === "active" ? [`account_creation ${N.id}`] : []]);
        }
        const HEADER = "first_name,unique_id,email,lms_role,node_id,status";
        for (const status of ["inactive", "suspended", "active"]) {
          newcomerWorld();
          const res = await bulkRoute.POST(new Request("http://lms.test/api/users/bulk", {
            method: "POST",
            body: JSON.stringify({ orgSlug: LIVE.slug, csv: [HEADER, `New,E-N,${N.email},user,N1,${status}`].join("\n") }),
          }));
          eq(`bulk, a new row written ${status}: 200, the row is ${status}, ${status === "active" ? "and the welcome is sent" : "and no welcome is sent"}`,
            [res.status, memberOf(LIVE, N.id)?.status, sentEvents()], [200, status, status === "active" ? [`account_creation ${N.id}`] : []]);
        }
        for (const org of [LIVE, GONE]) {
          world({ platformOwner: true });
          const res = await adminsRoute.POST(
            new Request(`http://lms.test/api/super/tenants/${org.id}/admins`, { method: "POST", body: JSON.stringify({ email: "first.admin@example.test", role: "admin" }) }),
            { params: Promise.resolve({ id: org.id }) }
          );
          const j = (await res.json()) as Row;
          const live = org.deleted_at === null;
          eq(`console add of a new administrator to ${live ? "a live" : "a deleted"} organisation: 200, the row written active, the password in the answer, ${live ? "and the welcome is sent" : "and no welcome is sent"}`,
            [res.status, memberOf(org, String(j.user_id))?.status, typeof j.temp_password, sentEvents()],
            [200, "active", "string", live ? [`account_creation ${j.user_id}`] : []]);
        }
      }

      // ---- the mail paths, under a stub that also holds assignments, teams,
      // groups, courses, journeys and the sender's tables ----
      const reminders = await import("../../app/api/cron/reminders/route");
      const nudges = await import("../../app/api/cron/journey-nudges/route");
      const broadcast = await import("../../app/api/notifications/broadcast/route");
      const { notifyCourseUpdate } = await import("../../lib/courses/notify-update");
      const { notifyAdminsOfRequest, notifyLearnerOfDecision } = await import("../../lib/attempts/requests");
      const { notifyRequesterOfTicket } = await import("../../lib/tickets/notify");
      const SECRET = "stub-cron-secret";
      process.env.CRON_SECRET = SECRET;

      // LIVE: the session (an administrator), learners of each status, two
      // managers (one inactive), two more administrators (one inactive).
      // SECOND holds a person of another organisation; GONE is deleted and
      // holds an active learner and an active administrator.
      const M = (org: { id: string }, user: string, role: string, status: string, extra: Row = {}): Row =>
        ({ organization_id: org.id, user_id: user, role, status, line_manager_id: null, ...extra });
      const MEMBERS: Row[] = [
        M(LIVE, ME.id, "admin", "active"),
        M(LIVE, "u-act", "user", "active", { line_manager_id: "u-mgr" }),
        M(LIVE, "u-act2", "user", "active", { line_manager_id: "u-mgr-ina" }),
        M(LIVE, "u-ina", "user", "inactive", { line_manager_id: "u-mgr" }),
        M(LIVE, "u-sus", "user", "suspended"),
        M(LIVE, "u-mgr", "user", "active"),
        M(LIVE, "u-mgr-ina", "user", "inactive"),
        M(LIVE, "u-adm", "admin", "active"),
        M(LIVE, "u-adm-ina", "admin", "inactive"),
        M(SECOND, "u-out", "user", "active"),
        M(GONE, "u-g", "user", "active"),
        M(GONE, "u-g-adm", "admin", "active"),
      ];
      /** LIVE's members that count. */
      const COUNTING = ["u-act", "u-act2", "u-adm", ME.id, "u-mgr"].sort();
      const orgEmbed = (o: typeof LIVE) => ({ name: o.name, slug: o.slug, deleted_at: o.deleted_at });
      const START = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
      const VERSION = {
        days: Array.from({ length: 10 }, (_, i) => ({ day: i + 1, course_id: "c-live", mission_title: `Mission ${i + 1}` })),
        days_total: 10, count_sundays: true, unlock_mode: "calendar",
      };
      const enrol = (id: string, user: string, program: string): Row => ({
        id, user_id: user, program_id: program, status: "active", start_date: START, last_nudged_at: null, last_daily_reminder_on: null, journey_versions: VERSION,
      });
      const journeyProgram = (id: string, org: typeof LIVE): Row => ({
        id, organization_id: org.id, name: `Journey ${id}`, is_active: true, nudge_enabled: true, current_version_id: "jv",
        nudge_cooldown_days: 3, reminder_hour: 0, deadline_days: null, escalation_enabled: true, escalation_after_days: 1, organizations: orgEmbed(org),
      });
      const reminderSetting = (course: string, org: typeof LIVE): Row => ({
        course_id: course, enabled: true, cadence_days: 1, cap_days: 30,
        courses: { id: course, title: `Course ${course}`, organization_id: org.id, organizations: orgEmbed(org) },
      });
      /** An assignment row of a course (or, with `path`, of a path). */
      const ca = (course: string, org: { id: string }, type: string, ref: string | null = null, path = false): Row => ({
        id: `a-${course}-${type}-${ref ?? "all"}`, ...(path ? { path_id: course } : { course_id: course }), organization_id: org.id, assignee_type: type,
        user_id: type === "user" ? ref : null, team_id: type === "team" ? ref : null, group_id: type === "group" ? ref : null, release_at: null, source: "admin",
      });
      const GONE_ROWS = [ca("c-gone", GONE, "org"), ca("c-gone", GONE, "user", "u-g")];

      let mt: Record<string, Row[]> = {};
      let mFail: (table: string, select: string) => boolean = () => false;
      let warned: string[] = [];
      const mailStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const p = url.pathname;
        const q = url.searchParams;
        const select = q.get("select") ?? "";
        const table = p.replace("/rest/v1/", "");
        const raw = typeof init?.body === "string" ? init.body : "";
        let body: unknown = null;
        if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
        if (p.startsWith("/rest/v1/")) requests.push({ method, table, select, query: q, key: h.get("apikey"), body });
        if (p === "/auth/v1/user") return json(ME);
        if (!p.startsWith("/rest/v1/")) return json({ message: "unexpected" }, 500);
        if (table === "rpc/journey_reminder_counts") {
          // Nothing credited yet: every enrolment is behind.
          const ids = (body as { p_ids?: string[] } | null)?.p_ids ?? [];
          return json(ids.map((id) => ({ enrollment_id: id, done: 0, done_today: false, credited: [] })));
        }
        if (table.startsWith("rpc/")) return json([]);
        if (method === "GET") {
          if (mFail(table, select)) return json({ code: "XX000", message: "stub read failure" }, 500);
          if (table === "profiles") {
            const id = q.get("id") ?? "";
            const ids = id.startsWith("in.(") ? id.slice(4, -1).split(",") : id.startsWith("eq.") ? [id.slice(3)] : [];
            return json(ids.filter(Boolean).map((x) => ({ id: x, email: `${x}@example.test`, first_name: null, last_name: null })));
          }
          let rows = (mt[table] ?? []).filter((r) => matches(r, q));
          if (table === "organization_members") rows = [...rows].sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
          const offset = Number(q.get("offset") ?? 0);
          const limit = q.has("limit") ? Number(q.get("limit")) : rows.length;
          const out = rows.slice(offset, offset + limit).map((r) => (select.includes("(") || select.includes("*") ? r : project(r, select)));
          if ((h.get("accept") ?? "").includes("vnd.pgrst.object")) return json(out[0] ?? null);
          return json(out);
        }
        if (method === "PATCH") {
          const hit = (mt[table] ?? []).filter((r) => matches(r, q));
          for (const r of hit) Object.assign(r, body as Row);
          return json(hit.map((r) => project(r, select)));
        }
        // An insert or an upsert: the sender's log row, reminder state, the heartbeat.
        return json([], 201);
      };
      const mailWorld = (o: {
        assignments?: Row[]; pathAssignments?: Row[]; reminderState?: Row[]; extraMembers?: Row[];
        fail?: (table: string, select: string) => boolean;
      } = {}) => {
        mt = {
          organizations: [LIVE, SECOND, GONE].map((x) => ({ ...x })),
          organization_members: [...MEMBERS, ...(o.extraMembers ?? [])].map((r) => ({ ...r })),
          reminder_state: (o.reminderState ?? []).map((r) => ({ ...r })),
          team_members: ["u-act", "u-ina", "u-sus"].map((u) => ({ team_id: "t-live", user_id: u })),
          org_groups: [{ id: "g-live", organization_id: LIVE.id, group_type: "static", rules: {}, is_active: true }],
          org_group_members: ["u-act", "u-ina", "u-sus"].map((u) => ({ group_id: "g-live", user_id: u })),
          course_reminder_settings: [reminderSetting("c-live", LIVE), reminderSetting("c-gone", GONE)],
          course_assignments: (o.assignments ?? []).map((r) => ({ ...r })),
          learning_path_assignments: (o.pathAssignments ?? []).map((r) => ({ ...r })),
          courses: [{ id: "c-live", organization_id: LIVE.id, title: "Course L" }, { id: "c-gone", organization_id: GONE.id, title: "Course G" }],
          journey_programs: [journeyProgram("p-live", LIVE), journeyProgram("p-gone", GONE)],
          journey_enrollments: [enrol("e-act", "u-act", "p-live"), enrol("e-act2", "u-act2", "p-live"), enrol("e-ina", "u-ina", "p-live"), enrol("e-g", "u-g", "p-gone")],
        };
        mFail = o.fail ?? (() => false);
        requests = [];
        warned = [];
      };
      /** The user ids the sender logged a mail for (for one event, when named), sorted. */
      const mailed = (event?: string) => requests.filter((r) => r.table === "notification_log" && r.method === "POST")
        .map((r) => r.body as Row).filter((b) => !event || b.event_type === event).map((b) => String(b.to_user_id)).sort();
      /** The sender's first read: false means it was never entered. */
      const senderEntered = () => requests.some((r) => r.table === "notification_settings");
      /** countingMemberIds' member read. */
      const COUNTING_READ = (table: string, select: string) => table === "organization_members" && select === "user_id,role,status";
      const countingReads = () => requests.filter((r) => r.method === "GET" && COUNTING_READ(r.table, r.select)).length;
      /** Any read of an organisation's row or of its member rows. */
      const readsOfOrg = (org: { id: string }) => requests.filter((r) => r.method === "GET" && (
        (r.table === "organization_members" && r.query.get("organization_id") === `eq.${org.id}`) ||
        (r.table === "organizations" && r.query.get("id") === `eq.${org.id}`))).length;
      const unreadableLogged = () => warned
        .map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } })
        .filter((l): l is Row => l?.event === "mail_recipients_unreadable");

      const realWarn = console.warn;
      globalThis.fetch = mailStub as typeof fetch;
      console.warn = (...a: unknown[]) => { warned.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")); };
      try {
        // ---- the reminders cron ----
        const remind = async () =>
          (await reminders.POST(new Request("http://lms.test/api/cron/reminders", { method: "POST", headers: { "x-cron-secret": SECRET } }))).status;
        const stateFor = () => requests.filter((r) => r.table === "reminder_state" && r.method === "POST")
          .flatMap((r) => (r.body as Row[]).map((x) => String(x.user_id))).sort();
        const AUDIENCES: Array<[string, Row[], string[]]> = [
          ["to three people by name (active, inactive, suspended)", ["u-act", "u-ina", "u-sus"].map((u) => ca("c-live", LIVE, "user", u)), ["u-act"]],
          ["to a team of those three", [ca("c-live", LIVE, "team", "t-live")], ["u-act"]],
          ["to a static group of those three", [ca("c-live", LIVE, "group", "g-live")], ["u-act"]],
          ["org-wide", [ca("c-live", LIVE, "org")], COUNTING],
        ];
        for (const [name, rows, want] of AUDIENCES) {
          mailWorld({ assignments: [...rows, ...GONE_ROWS] });
          const status = await remind();
          eq(`reminders, a course assigned ${name}: only members that count are reminded, and only they get reminder state`,
            [status, mailed("asset_reminder"), stateFor()], [200, want, want]);
          eq("…a deleted organisation's course reminds nobody, and none of its rows is read; one read of the members that count",
            [mailed().includes("u-g"), readsOfOrg(GONE), countingReads()], [false, 0, 1]);
        }
        {
          // Both first assigned 40 days ago, past the 30-day cap: an active
          // learner's reminders are stopped (written stopped, no mail); a
          // learner whose row does not count is skipped before that rule.
          const OLD = new Date(Date.now() - 40 * 86400000).toISOString();
          const old = (u: string): Row => ({ user_id: u, course_id: "c-live", first_assigned_at: OLD, last_nudge_at: OLD, nudge_count: 3, stopped: false });
          mailWorld({ assignments: ["u-act", "u-ina"].map((u) => ca("c-live", LIVE, "user", u)), reminderState: [old("u-act"), old("u-ina")] });
          const status = await remind();
          const upserts = requests.filter((r) => r.table === "reminder_state" && r.method === "POST")
            .flatMap((r) => (r.body as Row[]).map((x) => `${x.user_id} stopped=${x.stopped}`)).sort();
          eq("reminders past the cap: the active learner's state is written stopped and nobody is mailed; nothing is written for the inactive learner",
            [status, mailed(), upserts], [200, [], ["u-act stopped=true"]]);
        }
        mailWorld({ assignments: [ca("c-live", LIVE, "org"), ca("c-live", LIVE, "user", "u-act")], fail: COUNTING_READ });
        {
          const status = await remind();
          eq("reminders, the members that count cannot be read: 200, nobody reminded, the sender not entered, no state written",
            [status, mailed(), senderEntered(), stateFor()], [200, [], false, []]);
          eq("…logged once, with the organisation's id and no address",
            [unreadableLogged().map((l) => [l.site, l.org_id]), warned.some((l) => l.includes("@"))], [[["cron/reminders", LIVE.id]], false]);
        }

        // ---- the journey nudges cron ----
        const nudge = async () => {
          const res = await nudges.POST(new Request("http://lms.test/api/cron/journey-nudges", { method: "POST", headers: { "x-cron-secret": SECRET } }) as never);
          return { status: res.status, body: (await res.json()) as Row };
        };
        const claims = () => requests.filter((r) => r.table === "journey_enrollments" && r.method === "PATCH").map((r) => String(r.query.get("id")));
        mailWorld();
        {
          const r = await nudge();
          eq("journey nudges: both active learners are reminded; the inactive one is not", [r.status, mailed("journey_nudge")], [200, ["u-act", "u-act2"]]);
          eq("…an escalation goes to the active manager; the learner whose manager is inactive escalates to nobody, and the inactive learner raises none",
            mailed("journey_escalation"), ["u-mgr"]);
          eq("…the inactive learner's enrolment is never claimed or stamped", claims().filter((id) => id === "eq.e-ina"), []);
          eq("…the managers are read from active rows only", requests.filter((q) => q.table === "organization_members" && q.select === "user_id,line_manager_id").map((q) => q.query.get("status")), ["eq.active"]);
          eq("…the deleted organisation's program is skipped before any read of it, and counted",
            [readsOfOrg(GONE), requests.filter((q) => q.table === "journey_enrollments" && q.query.get("program_id") === "eq.p-gone").length, r.body.skipped_org_programs, mailed().includes("u-g")],
            [0, 0, 1, false]);
          eq("…one read of the members that count", countingReads(), 1);
        }
        mailWorld({ fail: COUNTING_READ });
        {
          const r = await nudge();
          eq("journey nudges, the members that count cannot be read: nobody mailed, the sender not entered, no enrolment claimed",
            [r.status, mailed(), senderEntered(), claims()], [200, [], false, []]);
          eq("…logged with the organisation's id", unreadableLogged().map((l) => [l.site, l.org_id]), [["cron/journey-nudges", LIVE.id]]);
        }

        // ---- the broadcast route (the session is an active administrator of LIVE) ----
        const cast = async (b: Row) => {
          const res = await broadcast.POST(new Request("http://lms.test/api/notifications/broadcast", {
            method: "POST",
            body: JSON.stringify({ orgSlug: LIVE.slug, subject: "Hello", body_md: "Body", ...b }),
          }));
          return { status: res.status, body: (await res.json()) as Row };
        };
        const CASTS: Array<[string, Row, { assignments?: Row[]; pathAssignments?: Row[] }, string[]]> = [
          ["to named people (active, inactive, suspended, and a member of another organisation)", { audience: "users", user_ids: ["u-act", "u-ina", "u-sus", "u-out"] }, {}, ["u-act"]],
          ["to a team", { audience: "team", team_id: "t-live" }, {}, ["u-act"]],
          ["to a course's audience of a static group and a suspended person by name", { audience: "course", course_id: "c-live" },
            { assignments: [ca("c-live", LIVE, "group", "g-live"), ca("c-live", LIVE, "user", "u-sus")] }, ["u-act"]],
          ["to a course's org-wide audience", { audience: "course", course_id: "c-live" }, { assignments: [ca("c-live", LIVE, "org")] }, COUNTING],
          ["to a path's team audience", { audience: "path", path_id: "p-1" }, { pathAssignments: [ca("p-1", LIVE, "team", "t-live", true)] }, ["u-act"]],
          ["to everyone", { audience: "all" }, {}, COUNTING],
        ];
        for (const [name, b, w, want] of CASTS) {
          mailWorld(w);
          const r = await cast(b);
          eq(`broadcast ${name}: only members that count, from one read of them`,
            [r.status, mailed("custom_broadcast"), r.body.total, countingReads()], [200, want, want.length, 1]);
        }
        mailWorld();
        {
          const r = await cast({ audience: "users", user_ids: ["u-ina", "u-sus"] });
          eq("broadcast to an inactive and a suspended person only: 400 no recipients, nothing sent", [r.status, mailed(), senderEntered()], [400, [], false]);
        }
        mailWorld({ fail: COUNTING_READ });
        {
          const r = await cast({ audience: "all" });
          eq("broadcast, the members that count cannot be read: 503 try again, nothing sent, the sender not entered",
            [r.status, /try again/.test(String(r.body.error)), mailed(), senderEntered()], [503, true, [], false]);
        }
        // The session holds an active administrator row in the deleted organisation.
        mailWorld({ extraMembers: [M(GONE, ME.id, "admin", "active")] });
        {
          const r = await cast({ orgSlug: GONE.slug, audience: "all" });
          eq("broadcast in a deleted organisation, by an administrator whose row there is active: 404 as for a non-member, nothing sent, the sender not entered, its members not read",
            [r.status, mailed(), senderEntered(), countingReads()], [404, [], false, 0]);
        }
        mailWorld({ extraMembers: [M(GONE, ME.id, "admin", "active")] });
        {
          const r = await cast({ audience: "all" });
          eq("…the control: the same session in the live organisation still reaches every member that counts", [r.status, mailed("custom_broadcast")], [200, COUNTING]);
        }

        // ---- the course update mail ----
        const update = (org: typeof LIVE, course: string) => notifyCourseUpdate({ org: { id: org.id, slug: org.slug, name: org.name }, courseId: course });
        const UPDATES: Array<[string, Row[], string[]]> = [
          ["to three people by name", ["u-act", "u-ina", "u-sus"].map((u) => ca("c-live", LIVE, "user", u)), ["u-act"]],
          ["to a team", [ca("c-live", LIVE, "team", "t-live")], ["u-act"]],
          ["org-wide", [ca("c-live", LIVE, "org")], COUNTING],
        ];
        for (const [name, rows, want] of UPDATES) {
          mailWorld({ assignments: rows });
          await update(LIVE, "c-live");
          eq(`course update, assigned ${name}: only members that count`, [mailed("asset_update"), countingReads()], [want, 1]);
        }
        mailWorld({ assignments: GONE_ROWS });
        await update(GONE, "c-gone");
        eq("course update in a deleted organisation: nobody, the sender not entered", [mailed(), senderEntered()], [[], false]);
        mailWorld({ assignments: [ca("c-live", LIVE, "org")], fail: COUNTING_READ });
        await update(LIVE, "c-live");
        eq("course update, the members that count cannot be read: nobody, the sender not entered", [mailed(), senderEntered()], [[], false]);

        // ---- the attempt request, to the administrators ----
        const asked = (org: typeof LIVE) => notifyAdminsOfRequest(svc(), {
          orgId: org.id, orgName: org.name, orgSlug: org.slug, origin: "", courseTitle: "Course L",
          learnerEmail: "learner@example.test", learnerName: "Learner", reason: null,
        });
        mailWorld();
        await asked(LIVE);
        eq("an attempt request mails the active administrators only: not the inactive one, not a learner", mailed("custom_broadcast"), ["u-adm", ME.id].sort());
        mailWorld();
        await asked(GONE);
        eq("…in a deleted organisation: nobody, the sender not entered", [mailed(), senderEntered()], [[], false]);
        mailWorld({ fail: COUNTING_READ });
        await asked(LIVE);
        eq("…the administrators that count cannot be read: nobody, the sender not entered", [mailed(), senderEntered()], [[], false]);

        // ---- one person's mail: an attempt decision, a ticket reply ----
        const decide = (org: typeof LIVE, who: string, counting?: ReadonlySet<string>) => notifyLearnerOfDecision(svc(), {
          orgId: org.id, orgName: org.name, orgSlug: org.slug, origin: "", courseId: "c-live", courseTitle: "Course L",
          learner: { id: who, email: `${who}@example.test` }, approved: true, note: null, expiresAt: null, ...(counting ? { counting } : {}),
        });
        const reply = (org: typeof LIVE, who: string) => notifyRequesterOfTicket(svc(), {
          orgId: org.id, orgName: org.name, orgSlug: org.slug, origin: "",
          requester: { id: who, email: `${who}@example.test` }, subject: "Help", headline: "Reply from your admin", message: "Done",
        });
        for (const [kind, send] of [["attempt decision", decide], ["ticket reply", reply]] as const) {
          for (const [who, org, want] of [["u-act", LIVE, true], ["u-ina", LIVE, false], ["u-sus", LIVE, false], ["u-out", LIVE, false], ["u-g", GONE, false]] as const) {
            mailWorld();
            await send(org, who);
            eq(`${kind} to ${who} (${org === GONE ? "a deleted organisation" : who === "u-out" ? "no row here" : MEMBERS.find((r) => r.user_id === who)?.status}): ${want ? "sent" : "not sent, the sender not entered"}`,
              [mailed(), senderEntered()], [want ? [who] : [], want]);
          }
          mailWorld({ fail: (t) => t === "organization_members" });
          await send(LIVE, "u-act");
          eq(`${kind}, the person's membership cannot be read: not sent, the sender not entered, logged with the organisation's id`,
            [mailed(), senderEntered(), unreadableLogged().map((l) => l.org_id)], [[], false, [LIVE.id]]);
        }
        mailWorld();
        await decide(LIVE, "u-act", new Set(["u-act"]));
        eq("attempt decision with the org's counting ids passed in (a run of several): sent, and no member row is read",
          [mailed(), requests.filter((r) => r.table === "organization_members").length], [["u-act"], 0]);
        mailWorld();
        await decide(LIVE, "u-act", new Set());
        eq("…an id not among them: not sent, the sender not entered", [mailed(), senderEntered()], [[], false]);
      } finally {
        globalThis.fetch = stub as typeof fetch;
        console.warn = realWarn;
      }
    }

    console.log("\n(l) the platform notices: an administrators-only notice needs an administrator row that counts");
    {
      const route = await import("../../app/api/broadcasts/route");
      const NOTICES: Row[] = [
        { id: "n-all", title: "For everyone", body_md: "x", tone: "info", audience: "all", dismissable: false, is_active: true, posted_at: "2026-11-01T00:00:00Z", expires_at: null },
        { id: "n-admins", title: "For administrators", body_md: "x", tone: "info", audience: "admins_only", dismissable: false, is_active: true, posted_at: "2026-11-01T00:00:00Z", expires_at: null },
      ];
      const shown = async (members: Row[], failing: string[] = []) => {
        world({ members, broadcasts: NOTICES, failing });
        const res = await route.GET();
        const body = (await res.json()) as { broadcasts?: Row[]; error?: string };
        return { status: res.status, ids: (body.broadcasts ?? []).map((b) => String(b.id)).sort() };
      };
      eq("an active administrator of a live organisation: both notices", await shown([row(LIVE, "admin", "active")]), { status: 200, ids: ["n-admins", "n-all"] });
      for (const [label, members] of [
        ["an inactive administrator row only", [row(LIVE, "admin", "inactive")]],
        ["a suspended super owner row only", [row(LIVE, "super_owner", "suspended")]],
        ["an active administrator row in a deleted organisation only", [row(GONE, "admin", "active")]],
        ["an inactive administrator row beside an active learner row elsewhere", [row(LIVE, "admin", "inactive"), row(SECOND, "user", "active")]],
      ] as Array<[string, Row[]]>) {
        eq(`${label}: the notice for everyone only`, await shown(members), { status: 200, ids: ["n-all"] });
      }
      eq("the memberships cannot be read: 503, no notice", await shown([row(LIVE, "admin", "active")], ["organization_members"]), { status: 503, ids: [] });
    }

    console.log("\n(m) rule 8: the API key of a deleted organisation is refused as a revoked key is");
    {
      const { authenticateApiKey, generateApiKey } = await import("../../lib/integrations/auth");
      const catalog = await import("../../app/api/integrations/catalog/route");
      const live = generateApiKey();
      const gone = generateApiKey();
      const revoked = generateApiKey();
      const keys = () => [
        { id: "k-live", organization_id: LIVE.id, is_active: true, key_hash: live.hash },
        { id: "k-gone", organization_id: GONE.id, is_active: true, key_hash: gone.hash },
        { id: "k-revoked", organization_id: LIVE.id, is_active: false, key_hash: revoked.hash },
      ];
      const authAs = async (key: string) => {
        world({ apiKeys: keys() });
        const r = await authenticateApiKey(new Request("http://lms.test/api/integrations/catalog", { headers: { authorization: `Bearer ${key}` } }));
        await new Promise((done) => setTimeout(done, 0)); // the use stamp is fire-and-forget
        return { org: r?.orgId ?? null, stamped: writes().filter((w) => w === "PATCH org_api_keys").length };
      };
      eq("a live organisation's key: accepted, its use stamped", await authAs(live.key), { org: LIVE.id, stamped: 1 });
      eq("a revoked key (the reference answer): refused, not stamped", await authAs(revoked.key), { org: null, stamped: 0 });
      eq("a deleted organisation's key: refused as the revoked one, not stamped", await authAs(gone.key), { org: null, stamped: 0 });
      eq("…the key read embeds the organisation's deleted_at",
        reads("org_api_keys").some((r) => /organizations\(slug,\s*deleted_at\)/.test(r.select)), true);
      const viaRoute = async (key: string) => {
        world({ apiKeys: keys() });
        const res = await catalog.GET(new Request("http://lms.test/api/integrations/catalog", { headers: { authorization: `Bearer ${key}` } }));
        return { status: res.status, body: await res.text(), writes: writes() };
      };
      const refusedRevoked = await viaRoute(revoked.key);
      eq("GET /api/integrations/catalog with a deleted organisation's key: the revoked key's status and body, nothing written",
        await viaRoute(gone.key), { ...refusedRevoked, writes: [] });
      eq("…and that answer is a 401", refusedRevoked.status, 401);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
