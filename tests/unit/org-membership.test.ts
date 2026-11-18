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
 *       redirect, and an unreadable list says "try again" and goes nowhere.
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
type Req = { method: string; table: string; select: string; query: URLSearchParams; key: string | null };

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
    if (RESERVED.has(k)) return true;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    const cell = r[k] === null || r[k] === undefined ? "null" : String(r[k]);
    if (op === "eq") return cell === val;
    if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(cell);
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
  if (p.startsWith("/rest/v1/")) requests.push({ method, table, select, query: q, key: h.get("apikey") });
  if (p === "/auth/v1/user") return signedIn ? json(ME) : json({ message: "no session" }, 401);
  if (!p.startsWith("/rest/v1/") || method !== "GET") return json({ message: "unexpected" }, 500);
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
  if (table === "platform_owners") return json(platformOwner ? [{ user_id: ME.id }] : []);
  return json([]);
};

const world = (o: { members?: Row[]; failing?: string[]; platformOwner?: boolean; signedIn?: boolean } = {}) => {
  orgs = [LIVE, SECOND, GONE].map((x) => ({ ...x }));
  members = (o.members ?? []).map((r) => ({ ...r }));
  failing = new Set(o.failing ?? []);
  platformOwner = o.platformOwner ?? false;
  signedIn = o.signedIn ?? true;
  requests = [];
};
const row = (org: { id: string }, role: string, status: string, user = ME.id): Row => ({ organization_id: org.id, user_id: user, role, status });
const reads = (table: string) => requests.filter((r) => r.table === table);
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
  console.error = () => {};
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
