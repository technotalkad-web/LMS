/**
 * Unit test for the explicit admin check on the org routes that act beyond
 * the caller's own RLS-checked writes, run for real under a stubbed fetch:
 *
 *   POST   /api/org/sso                       (Supabase Auth admin API)
 *   POST   /api/org/branding                  (Cloudflare custom hostnames)
 *   POST   /api/org/branding/domain-status    (Cloudflare custom hostnames)
 *   DELETE /api/assignments/{id}              (service-role notification pass)
 *   DELETE /api/learning-path-assignments/{id} (service-role notification pass)
 *   POST   /api/learning-path-assignments     (service-role notification pass)
 *   POST   /api/learning-paths/{id}/courses   (notify_update: service role)
 *
 * The rule: such a route checks the caller's role explicitly before any of
 * those calls. Reading the org (or any members-visible row) on the caller's
 * session is not a role check: every member can read it.
 *
 *   (a) a plain member and a data analyst are refused with 403, and a
 *       signed-in caller with no membership with the answer a non-member
 *       gets (ADR 0030: 404 where the route names the org by its slug, 403
 *       where it knows the org from a row it read); no service-key request,
 *       no Cloudflare request and no write of any kind is made;
 *   (b) signed out: 401, nothing else;
 *   (c) an admin and a super owner still succeed, with the calls made;
 *   (d) a session update or delete that changes no row (RLS refused it) is
 *       an error, never ok, a delete that removed nothing sends no
 *       notification, and an SSO provider the row did not record is removed
 *       again; a delete that finds the row gone by then (it crossed another
 *       one) answers 404, and 503 when that second read fails;
 *   (e) POST /api/learning-path-assignments keeps the path and the named
 *       users and teams inside the caller's org;
 *   (f) the role counted is the one in the org the call acts on: an admin
 *       of another org who is a plain member of this one is refused;
 *   (g) a failed read of the path, members, teams or groups the assignees
 *       are checked against answers 503 and writes nothing (POST
 *       /api/learning-path-assignments and POST /api/assignments), so no
 *       named assignee is dropped silently; a failed read of the row a
 *       delete removes answers 503, not the 404 the admin pages take as
 *       already removed;
 *   (h) branding validates every field (the learner theme too) before any
 *       Cloudflare call;
 *   (i) a failed read of the caller's role answers 503 "try again", not
 *       403, and a failed org read in requireOrgAdminApi 503, not 404, with
 *       no service-key, Cloudflare or write request;
 *   (j) an SSO configure whose organizations update answers an error
 *       removes the new provider only when a fresh read shows the row does
 *       not hold it: saved after all, it answers ok; unreadable, it keeps
 *       the provider;
 *   (k) the admin pages take only a 404 from an assignment delete as
 *       already removed (source check): 403 and 503 still show the error;
 *   (l) ADR 0030 rule 10 in the four notification passes: an org-wide, a
 *       direct and a team audience each mail only the members that count
 *       (an inactive and a suspended member get nothing; the active ones
 *       get what they got before), from one read of them per request; when
 *       that read fails the change stands and nothing is sent (the sender
 *       is not entered);
 *   (m) ADR 0030 rule 2: an admin or super owner whose row is inactive or
 *       suspended, and an admin of an organisation that is deleted, are
 *       each answered exactly as a signed-in caller with no membership
 *       (the same status and body), with no service-key, Cloudflare or
 *       write request; the same admin, active in the live organisation, is
 *       let through.
 *
 * The stub models RLS: a session write by a non-admin changes no row
 * (update / delete answer []) or fails (insert answers 42501). next/headers
 * is stubbed (the cookie jar and the request headers); everything below it
 * is the real code. No database, no network.
 *
 * Run:  npx tsx tests/unit/org-admin-routes.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; host: string; path: string; select: string; query: URLSearchParams; body: unknown; key: string | null };

const SUPABASE = "http://stub.supabase.test";
const SUPABASE_HOST = "stub.supabase.test";
const CLOUDFLARE_HOST = "api.cloudflare.com";
const ANON_KEY = "stub-anon-key";
const SERVICE_KEY = "stub-service-key";
const ORG = "o1";
const OTHER_ORG = "o2";
const PATH = "p1";
const FOREIGN_PATH = "p9";
const COURSE = "c1";
const ME = { id: "u-me", aud: "authenticated", role: "authenticated", email: "caller@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: ME });
const RLS_DENIED = { code: "42501", message: "new row violates row-level security policy" };

/* ---------------- the world behind the stub ---------------- */
let requests: Req[] = [];
let signedIn = true;
/** The caller's membership role in ORG; null = no membership row. */
let role: string | null = "user";
/** The caller's membership role in OTHER_ORG; null = no membership row. */
let otherRole: string | null = null;
/** The status of the caller's row in ORG (ADR 0030: only "active" counts). */
let myStatus = "active";
/** ORG is soft-deleted (deleted_at set). */
let orgDeleted = false;
/** An admin's session update / delete changes no row (as if RLS refused it). */
let zeroRows = false;
/** A table whose reads fail (the caller's own role read excepted). */
let failRead: string | null = null;
/** The caller's own role read fails. */
let failRole = false;
/** After a 0-row assignment delete, the row is gone (another delete crossed it) or its read fails. */
let afterDelete: "gone" | "fails" | null = null;
let deletedAway: "gone" | "fails" | null = null;
/**
 * An admin's organizations update answers an error: "error" (not saved),
 * "lost-reply" (saved, the reply lost), "lost-reply-unreadable" (saved, and
 * the row's reads fail after it).
 */
let orgUpdate: "error" | "lost-reply" | "lost-reply-unreadable" | null = null;
let orgSaved: Row | null = null;
let orgUpdated = false;
const unmatched: string[] = [];
const isAdmin = () => role === "super_owner" || role === "owner" || role === "admin";

// The routes' only cookie-bound import. Everything below it is the real code.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => (signedIn ? [{ name: "sb-stub-auth-token", value: SESSION }] : []), set() {} }),
      headers: async () => new Headers({ host: "lms.test", "x-forwarded-proto": "https" }),
    };
  }
  return load.call(this, request, ...rest);
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
/** PostgREST's eq / neq / in, enough for these routes' reads. */
const matches = (r: Row, q: URLSearchParams) =>
  [...q.entries()].every(([k, v]) => {
    if (RESERVED.has(k)) return true;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    const cell = r[k] === null || r[k] === undefined ? "null" : String(r[k]);
    if (op === "eq") return cell === val;
    if (op === "neq") return cell !== val;
    if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(cell);
    return true;
  });

const orgRow = (): Row => ({
  id: ORG, name: "Org", slug: "org", deleted_at: orgDeleted ? "2026-11-01T00:00:00Z" : null, sso_provider_id: "prov-old",
  custom_domain: "old.example.test", custom_domain_verified: false, custom_domain_status: "pending", cf_hostname_id: "cf-old",
});
/** Every member row the service role reads; u-3 and u-4 hold rows that do not count (ADR 0030). */
const MEMBERS: Row[] = [
  { user_id: ME.id, organization_id: ORG, role: "user", status: "active" },
  { user_id: "u-2", organization_id: ORG, role: "user", status: "active" },
  { user_id: "u-3", organization_id: ORG, role: "user", status: "inactive" },
  { user_id: "u-4", organization_id: ORG, role: "user", status: "suspended" },
  { user_id: "u-x", organization_id: OTHER_ORG, role: "user", status: "active" },
];
const TEAMS: Row[] = [{ id: "t1", organization_id: ORG }, { id: "t9", organization_id: OTHER_ORG }];
const TEAM_MEMBERS: Row[] = [
  { team_id: "t1", user_id: "u-2" }, { team_id: "t1", user_id: "u-3" }, { team_id: "t1", user_id: "u-4" },
  { team_id: "t9", user_id: "u-x" },
];
const PATHS: Row[] = [
  { id: PATH, organization_id: ORG, name: "Path", organizations: { name: "Org", slug: "org" } },
  { id: FOREIGN_PATH, organization_id: OTHER_ORG, name: "Other path", organizations: { name: "Other", slug: "other" } },
];
/** Org-wide rows: every member of the org can read them (0069 select policies). */
const COURSE_ASSIGNMENT: Row = {
  id: "a1", course_id: COURSE, organization_id: ORG, assignee_type: "org", user_id: null, team_id: null, group_id: null,
  courses: { title: "Course" }, organizations: { name: "Org", slug: "org" },
};
const PATH_ASSIGNMENT: Row = {
  id: "pa1", path_id: PATH, organization_id: ORG, assignee_type: "org", user_id: null, team_id: null, group_id: null,
  learning_paths: { name: "Path" }, organizations: { name: "Org" },
};
/** Team rows (t1: one active, one inactive and one suspended member), for (l). */
const COURSE_TEAM_ASSIGNMENT: Row = { ...COURSE_ASSIGNMENT, id: "a2", assignee_type: "team", team_id: "t1" };
const PATH_TEAM_ASSIGNMENT: Row = { ...PATH_ASSIGNMENT, id: "pa2", assignee_type: "team", team_id: "t1" };
const PROFILES: Row[] = [
  { id: ME.id, email: ME.email }, { id: "u-2", email: "two@example.test" }, { id: "u-3", email: "three@example.test" },
  { id: "u-4", email: "four@example.test" }, { id: "u-x", email: "x@example.test" },
];

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const accept = h.get("accept") ?? "";
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  let body: unknown = null;
  if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  requests.push({ method, host: url.host, path: p, select, query: url.searchParams, body, key: h.get("apikey") });
  const q = url.searchParams;
  const asObject = accept.includes("vnd.pgrst.object");
  const list = (rows: Row[]) => (asObject ? json(rows[0] ?? null) : json(rows));

  if (url.host === CLOUDFLARE_HOST) {
    if (method === "POST") {
      const hostname = (body as Row | null)?.hostname;
      return json({ success: true, result: { id: "cf-new", hostname, status: "pending", ssl: { status: "pending_validation", validation_records: [{ txt_name: "_cf.learn", txt_value: "token" }] } } });
    }
    if (method === "DELETE") return json({ success: true, result: { id: "cf-old" } });
    return json({ success: true, result: { id: "cf-old", hostname: "old.example.test", status: "active", ssl: { status: "active" } } });
  }
  if (url.host !== SUPABASE_HOST) {
    unmatched.push(`${method} ${url.host}${p}`);
    return json({}, 404);
  }
  if (p === "/auth/v1/user") return signedIn ? json(ME) : json({ message: "no session" }, 401);
  if (p.startsWith("/auth/v1/admin/sso/providers")) {
    if (method === "POST") return json({ id: "prov-new", domains: [{ domain: "acme.test" }] });
    return json({});
  }
  if (!p.startsWith("/rest/v1/")) {
    unmatched.push(`${method} ${p}`);
    return json({}, 404);
  }

  const session = h.get("apikey") !== SERVICE_KEY;
  // RLS on the admin-only tables: a non-admin session update / delete changes
  // no row and answers no error; an insert fails.
  if (method === "PATCH" || method === "DELETE") {
    if (session && isAdmin() && orgUpdate && method === "PATCH" && p === "/rest/v1/organizations") {
      if (orgUpdate !== "error") orgSaved = body as Row;
      orgUpdated = true;
      return json({ code: "08006", message: "stub connection lost" }, 500);
    }
    if (session && (!isAdmin() || zeroRows)) {
      if (method === "DELETE" && afterDelete) deletedAway = afterDelete;
      return json([]);
    }
    const id = (q.get("id") ?? "eq.x").replace(/^eq\./, "");
    return json([{ id }]);
  }
  if (method === "POST") {
    if (session && !isAdmin()) return json(RLS_DENIED, 403);
    const rows = (Array.isArray(body) ? body : [body]) as Row[];
    const out = rows.map((r, i) => ({ id: `new-${requests.length}-${i}`, ...r }));
    return asObject ? json(out[0], 201) : json(out, 201);
  }

  const readFailure = () => json({ code: "XX000", message: "stub read failure" }, 500);
  // The caller's own membership read (lib/auth/org-membership.ts): role and status.
  const ownRead = select === "role,status";
  if (failRead && p === `/rest/v1/${failRead}` && !ownRead) return readFailure();
  if (failRole && p === "/rest/v1/organization_members" && ownRead) return readFailure();
  if (deletedAway && (p === "/rest/v1/course_assignments" || p === "/rest/v1/learning_path_assignments")) {
    return deletedAway === "fails" ? readFailure() : list([]);
  }
  if (p === "/rest/v1/organizations") {
    if (orgUpdate === "lost-reply-unreadable" && orgUpdated) return readFailure();
    return list([{ ...orgRow(), ...(orgSaved ?? {}) }].filter((r) => matches(r, q)));
  }
  if (p === "/rest/v1/organization_members") {
    if (ownRead) {
      // The caller's own membership rows, filtered as asked (org and user).
      const mine: Row[] = [];
      if (role) mine.push({ user_id: ME.id, organization_id: ORG, role, status: myStatus });
      if (otherRole) mine.push({ user_id: ME.id, organization_id: OTHER_ORG, role: otherRole, status: "active" });
      const hit = mine.filter((r) => matches(r, q));
      if (asObject && hit.length > 1) return json({ code: "PGRST116", message: "multiple rows" }, 406);
      return list(hit.map((r) => ({ role: r.role, status: r.status })));
    }
    return list(MEMBERS.filter((r) => matches(r, q)));
  }
  if (p === "/rest/v1/course_assignments") return list([COURSE_ASSIGNMENT, COURSE_TEAM_ASSIGNMENT].filter((r) => matches(r, q)));
  // The service role reads it too: the notify_update pass of a path's courses lists the path's audience.
  if (p === "/rest/v1/learning_path_assignments") return list([PATH_ASSIGNMENT, PATH_TEAM_ASSIGNMENT].filter((r) => matches(r, q)));
  if (p === "/rest/v1/learning_paths") return list(PATHS.filter((r) => matches(r, q)));
  if (p === "/rest/v1/courses") return list([{ id: COURSE, organization_id: ORG }].filter((r) => matches(r, q)));
  if (p === "/rest/v1/teams") return list(TEAMS.filter((r) => matches(r, q)));
  if (p === "/rest/v1/team_members") return list(TEAM_MEMBERS.filter((r) => matches(r, q)));
  if (p === "/rest/v1/profiles") return list(PROFILES.filter((r) => matches(r, q)));
  return list([]);
};

/* ---------------- what a call did ---------------- */
const serviceCalls = () => requests.filter((r) => r.key === SERVICE_KEY);
const external = () => requests.filter((r) => r.host !== SUPABASE_HOST);
const writes = () => requests.filter((r) => r.host === SUPABASE_HOST && r.path.startsWith("/rest/v1/") && r.method !== "GET" && r.method !== "HEAD");
const ssoAdmin = () => requests.filter((r) => r.path.startsWith("/auth/v1/admin/sso/providers")).map((r) => `${r.method} ${r.path.replace("/auth/v1/admin/sso/providers", "") || "/"}`);
const cloudflare = () => requests.filter((r) => r.host === CLOUDFLARE_HOST).map((r) => `${r.method} ${r.path.replace(/^.*\/custom_hostnames/, "") || "/"}`);
const sessionWrites = (table: string, method: string) => writes().filter((r) => r.path === `/rest/v1/${table}` && r.method === method && r.key !== SERVICE_KEY);

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  // Cloudflare configured and a hostname / provider stored, so the unguarded
  // code would make the external calls: the refusals below are not vacuous.
  process.env.CF_API_TOKEN = "stub-cf-token";
  process.env.CF_ZONE_ID = "zone1";
  process.env.CF_SAAS_CNAME_TARGET = "saas.example.test";
  delete process.env.RESEND_API_KEY;
  delete process.env.SEND_SMTP_URL;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  globalThis.fetch = stub as typeof fetch;
  console.warn = () => {};
  console.error = () => {};
  try {
    const sso = await import("../../app/api/org/sso/route");
    const branding = await import("../../app/api/org/branding/route");
    const domainStatus = await import("../../app/api/org/branding/domain-status/route");
    const assignment = await import("../../app/api/assignments/[id]/route");
    const pathAssignment = await import("../../app/api/learning-path-assignments/[id]/route");
    const pathAssign = await import("../../app/api/learning-path-assignments/route");
    const pathCourses = await import("../../app/api/learning-paths/[id]/courses/route");
    const assignCourse = await import("../../app/api/assignments/route");

    const post = (u: string, b: unknown) => new Request(`http://lms.test${u}`, { method: "POST", body: JSON.stringify(b) });
    const del = (u: string) => new Request(`http://lms.test${u}`, { method: "DELETE" });
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    /** bySlug: the route names the org by its slug (requireOrgAdminApi); otherwise it knows the org from a row (isOrgAdminCaller). */
    type Call = { name: string; run: () => Promise<Response>; table: string; verb: "PATCH" | "DELETE" | "POST"; bySlug: boolean };
    const CALLS: Call[] = [
      { name: "POST /api/org/sso (configure)", table: "organizations", verb: "PATCH", bySlug: true,
        run: () => sso.POST(post("/api/org/sso", { orgSlug: "org", action: "configure", metadataUrl: "https://idp.example.test/metadata", domains: ["acme.test"] })) },
      { name: "POST /api/org/sso (disable)", table: "organizations", verb: "PATCH", bySlug: true,
        run: () => sso.POST(post("/api/org/sso", { orgSlug: "org", action: "disable" })) },
      { name: "POST /api/org/branding (domain change)", table: "organizations", verb: "PATCH", bySlug: true,
        run: () => branding.POST(post("/api/org/branding", { orgSlug: "org", name: "New name", custom_domain: "learn.acme.test" })) },
      { name: "POST /api/org/branding/domain-status", table: "organizations", verb: "PATCH", bySlug: true,
        run: () => domainStatus.POST(post("/api/org/branding/domain-status", { orgSlug: "org" })) },
      { name: "DELETE /api/assignments/{id}", table: "course_assignments", verb: "DELETE", bySlug: false,
        run: () => assignment.DELETE(del("/api/assignments/a1"), params("a1")) },
      { name: "DELETE /api/learning-path-assignments/{id}", table: "learning_path_assignments", verb: "DELETE", bySlug: false,
        run: () => pathAssignment.DELETE(del("/api/learning-path-assignments/pa1"), params("pa1")) },
      { name: "POST /api/learning-path-assignments", table: "learning_path_assignments", verb: "POST", bySlug: true,
        run: () => pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, assignToOrg: true, userIds: ["u-2"], scopes: [{ vertical: "Sales" }] })) },
      { name: "POST /api/learning-paths/{id}/courses (notify_update)", table: "learning_path_courses", verb: "POST", bySlug: false,
        run: () => pathCourses.POST(post(`/api/learning-paths/${PATH}/courses`, { courseId: COURSE, notify_update: true }), params(PATH)) },
    ];

    const world = (o: {
      role?: string | null; otherRole?: string | null; signedIn?: boolean; zeroRows?: boolean; failRead?: string;
      failRole?: boolean; afterDelete?: "gone" | "fails"; orgUpdate?: "error" | "lost-reply" | "lost-reply-unreadable";
      status?: string; orgDeleted?: boolean;
    }) => {
      requests = [];
      role = o.role === undefined ? "user" : o.role;
      otherRole = o.otherRole ?? null;
      myStatus = o.status ?? "active";
      orgDeleted = o.orgDeleted ?? false;
      signedIn = o.signedIn ?? true;
      zeroRows = o.zeroRows ?? false;
      failRead = o.failRead ?? null;
      failRole = o.failRole ?? false;
      afterDelete = o.afterDelete ?? null;
      deletedAway = null;
      orgUpdate = o.orgUpdate ?? null;
      orgSaved = null;
      orgUpdated = false;
    };
    const call = async (c: Call, o: Parameters<typeof world>[0]) => {
      world(o);
      const res = await c.run();
      return { status: res.status, body: (await res.json()) as Row };
    };

    console.log("\n(a) refused: a plain member, a data analyst (403), a caller with no membership (a non-member's answer) — no service-role, external or write call");
    for (const c of CALLS) {
      for (const r of ["user", "data_analyst", null]) {
        const out = await call(c, { role: r });
        const want = r === null && c.bySlug ? 404 : 403;
        eq(`${c.name} as ${r ?? "no membership"}: ${want} with an error, no service-key / Cloudflare / write request`,
          [out.status, typeof out.body.error, out.body.ok ?? null, serviceCalls().length, external().length, writes().length],
          [want, "string", null, 0, 0, 0]);
      }
    }

    console.log("\n(b) signed out — 401, nothing else");
    for (const c of CALLS) {
      const out = await call(c, { signedIn: false });
      eq(`${c.name} signed out: 401, no service-key / Cloudflare / write request`,
        [out.status, serviceCalls().length, external().length, writes().length], [401, 0, 0, 0]);
    }

    console.log("\n(c) an admin and a super owner still succeed");
    for (const r of ["admin", "super_owner"]) {
      {
        const out = await call(CALLS[0], { role: r });
        eq(`sso configure as ${r}: 200 ok with the new provider`, [out.status, out.body.ok, out.body.providerId], [200, true, "prov-new"]);
        eq("…the old provider is removed and the new one created (Auth admin API, service key)", ssoAdmin(), ["DELETE /prov-old", "POST /"]);
        eq("…then the organizations row records it on the caller's session",
          sessionWrites("organizations", "PATCH").map((w) => (w.body as Row).sso_provider_id), ["prov-new"]);
      }
      {
        const out = await call(CALLS[1], { role: r });
        eq(`sso disable as ${r}: 200 ok, disabled`, [out.status, out.body.ok, out.body.disabled], [200, true, true]);
        eq("…the provider is removed and the row cleared", [ssoAdmin(), sessionWrites("organizations", "PATCH").map((w) => (w.body as Row).sso_enabled)], [["DELETE /prov-old"], [false]]);
      }
      {
        const out = await call(CALLS[2], { role: r });
        eq(`branding as ${r}: 200 ok with the provisioning details`,
          [out.status, out.body.ok, (out.body.domain as Row | undefined)?.status, (out.body.domain as Row | undefined)?.cnameTarget], [200, true, "pending", "saas.example.test"]);
        eq("…the old hostname is torn down and the new one registered", cloudflare(), ["DELETE /cf-old", "POST /"]);
        eq("…the row saves the name and the new hostname id",
          sessionWrites("organizations", "PATCH").map((w) => [(w.body as Row).name, (w.body as Row).cf_hostname_id]), [["New name", "cf-new"]]);
      }
      {
        const out = await call(CALLS[3], { role: r });
        eq(`domain-status as ${r}: 200 active, verified`, [out.status, out.body.status, out.body.verified], [200, "active", true]);
        eq("…one Cloudflare read, one row update", [cloudflare(), sessionWrites("organizations", "PATCH").length], [["GET /cf-old"], 1]);
      }
      {
        const out = await call(CALLS[4], { role: r });
        eq(`assignment delete as ${r}: 200 ok, the row deleted, the notification pass ran (service key)`,
          [out.status, out.body.ok, sessionWrites("course_assignments", "DELETE").length, serviceCalls().length > 0], [200, true, 1, true]);
      }
      {
        const out = await call(CALLS[5], { role: r });
        eq(`path assignment delete as ${r}: 200 ok, the row deleted, the notification pass ran (service key)`,
          [out.status, out.body.ok, sessionWrites("learning_path_assignments", "DELETE").length, serviceCalls().length > 0], [200, true, 1, true]);
      }
      {
        world({ role: r });
        const res = await pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, assignToOrg: true, userIds: ["u-2"] }));
        const b = (await res.json()) as Row;
        eq(`path assign as ${r}: 200, two rows (org + user), the notification pass ran (service key)`,
          [res.status, b.assigned, sessionWrites("learning_path_assignments", "POST").length, serviceCalls().length > 0], [200, 2, 2, true]);
      }
      {
        const out = await call(CALLS[7], { role: r });
        eq(`path add-course as ${r}: 200 ok at step 1, the notify_update pass ran (service key)`,
          [out.status, out.body.ok, out.body.step, sessionWrites("learning_path_courses", "POST").length, serviceCalls().length > 0], [200, true, 1, 1, true]);
      }
    }

    console.log("\n(d) a session update / delete that changes no row is an error, never ok");
    for (const c of CALLS.slice(0, 6)) {
      const out = await call(c, { role: "admin", zeroRows: true });
      eq(`${c.name}, 0 rows changed: 403 with an error, not ok`, [out.status, typeof out.body.error, out.body.ok ?? null], [403, "string", null]);
      if (c.verb === "DELETE") eq("…and no notification pass (no service-key request)", serviceCalls().length, 0);
      else eq("…the update was attempted once", sessionWrites(c.table, c.verb).length, 1);
      if (c === CALLS[0]) eq("…and the new provider the row did not record is removed again", ssoAdmin(), ["DELETE /prov-old", "POST /", "DELETE /prov-new"]);
    }
    for (const c of [CALLS[4], CALLS[5]]) {
      {
        const out = await call(c, { role: "admin", zeroRows: true, afterDelete: "gone" });
        eq(`${c.name}, 0 rows changed and the row gone by then (a crossed delete): 404, the delete tried once, no notification pass`,
          [out.status, typeof out.body.error, out.body.ok ?? null, sessionWrites(c.table, "DELETE").length, serviceCalls().length], [404, "string", null, 1, 0]);
      }
      {
        const out = await call(c, { role: "admin", zeroRows: true, afterDelete: "fails" });
        eq(`${c.name}, 0 rows changed and the second read fails: 503, no notification pass`,
          [out.status, typeof out.body.error, out.body.ok ?? null, serviceCalls().length], [503, "string", null, 0]);
      }
    }

    console.log("\n(e) POST /api/learning-path-assignments keeps the path and the assignees inside the org");
    {
      world({ role: "admin" });
      const res = await pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: FOREIGN_PATH, assignToOrg: true }));
      eq("another org's path: 404, no write, no service-key request",
        [res.status, writes().length, serviceCalls().length], [404, 0, 0]);
    }
    {
      world({ role: "admin" });
      const res = await pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, userIds: ["u-2", "u-x"], teamIds: ["t1", "t9"] }));
      const inserted = sessionWrites("learning_path_assignments", "POST").map((w) => w.body as Row);
      eq("named users and teams of another org are dropped: one user row (u-2), one team row (t1)",
        [res.status, inserted.map((r) => r.user_id ?? r.team_id)], [200, ["u-2", "t1"]]);
      const svcText = serviceCalls().map((r) => r.query.toString()).join(" ");
      eq("…and the service-role notification pass never reads them", [/u-x/.test(svcText), /t9/.test(svcText), serviceCalls().length > 0], [false, false, true]);
    }
    {
      world({ role: "admin" });
      const res = await pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, userIds: ["u-x"] }));
      eq("only foreign assignees: 400 No assignees specified, nothing written", [res.status, writes().length], [400, 0]);
    }

    console.log("\n(f) the role counted is the caller's role in the org the call acts on");
    for (const c of CALLS) {
      const out = await call(c, { role: "user", otherRole: "admin" });
      eq(`${c.name}: an admin of another org, a plain member here — 403, no service-key / Cloudflare / write request`,
        [out.status, serviceCalls().length, external().length, writes().length], [403, 0, 0, 0]);
    }
    {
      const out = await call(CALLS[4], { role: "admin", otherRole: "user" });
      eq("…and an admin here who is a plain member elsewhere still succeeds", [out.status, out.body.ok], [200, true]);
    }

    console.log("\n(g) a failed check read answers 503 and writes nothing");
    {
      const checks: Array<[string, string, () => Promise<Response>]> = [
        ["POST /api/learning-path-assignments", "learning_paths",
          () => pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, assignToOrg: true }))],
        ["POST /api/learning-path-assignments", "organization_members",
          () => pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, assignToOrg: true, userIds: ["u-2"] }))],
        ["POST /api/learning-path-assignments", "teams",
          () => pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, assignToOrg: true, teamIds: ["t1"] }))],
        ["POST /api/learning-path-assignments", "org_groups",
          () => pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, assignToOrg: true, groupIds: ["g1"] }))],
        ["POST /api/assignments", "organization_members",
          () => assignCourse.POST(post("/api/assignments", { orgSlug: "org", courseId: COURSE, assignToOrg: true, userIds: ["u-2"] }))],
        ["POST /api/assignments", "teams",
          () => assignCourse.POST(post("/api/assignments", { orgSlug: "org", courseId: COURSE, assignToOrg: true, teamIds: ["t1"] }))],
        ["POST /api/assignments", "org_groups",
          () => assignCourse.POST(post("/api/assignments", { orgSlug: "org", courseId: COURSE, assignToOrg: true, groupIds: ["g1"] }))],
        ["DELETE /api/assignments/{id}", "course_assignments",
          () => assignment.DELETE(del("/api/assignments/a1"), params("a1"))],
        ["DELETE /api/learning-path-assignments/{id}", "learning_path_assignments",
          () => pathAssignment.DELETE(del("/api/learning-path-assignments/pa1"), params("pa1"))],
      ];
      for (const [name, table, run] of checks) {
        world({ role: "admin", failRead: table });
        const res = await run();
        const b = (await res.json()) as Row;
        eq(`${name}, the ${table} read fails: 503 with an error, nothing written, no service-key request`,
          [res.status, typeof b.error, writes().length, serviceCalls().length], [503, "string", 0, 0]);
      }
    }

    console.log("\n(h) branding validates every field before any Cloudflare call");
    {
      world({ role: "admin" });
      const res = await branding.POST(post("/api/org/branding", { orgSlug: "org", custom_domain: "learn.acme.test", learner_theme: "no-such-theme" }));
      eq("a domain change sent with an unknown learner theme: 400, no Cloudflare request, no write",
        [res.status, cloudflare(), writes().length], [400, [], 0]);
    }

    console.log("\n(i) a failed read of the caller's role answers 503, not 403");
    for (const c of CALLS) {
      const out = await call(c, { role: "admin", failRole: true });
      eq(`${c.name}, the role read fails: 503 with an error, no service-key / Cloudflare / write request`,
        [out.status, typeof out.body.error, out.body.ok ?? null, serviceCalls().length, external().length, writes().length],
        [503, "string", null, 0, 0, 0]);
    }
    for (const c of [CALLS[0], CALLS[1], CALLS[2], CALLS[3], CALLS[6]]) {
      const out = await call(c, { role: "admin", failRead: "organizations" });
      eq(`${c.name}, the org read fails (requireOrgAdminApi): 503 with an error, no service-key / Cloudflare / write request`,
        [out.status, typeof out.body.error, out.body.ok ?? null, serviceCalls().length, external().length, writes().length],
        [503, "string", null, 0, 0, 0]);
    }

    console.log("\n(j) an SSO configure whose update answers an error removes the new provider only when the row does not hold it");
    {
      const out = await call(CALLS[0], { role: "admin", orgUpdate: "error" });
      eq("not saved: 400 with an error, and the new provider is removed again",
        [out.status, typeof out.body.error, out.body.ok ?? null, ssoAdmin()], [400, "string", null, ["DELETE /prov-old", "POST /", "DELETE /prov-new"]]);
    }
    {
      const out = await call(CALLS[0], { role: "admin", orgUpdate: "lost-reply" });
      eq("saved, the reply lost: 200 ok with the new provider, which is kept",
        [out.status, out.body.ok, out.body.providerId, ssoAdmin()], [200, true, "prov-new", ["DELETE /prov-old", "POST /"]]);
    }
    {
      const out = await call(CALLS[0], { role: "admin", orgUpdate: "lost-reply-unreadable" });
      eq("saved, and the row cannot be read again: 400 with an error, and the provider is kept",
        [out.status, typeof out.body.error, out.body.ok ?? null, ssoAdmin()], [400, "string", null, ["DELETE /prov-old", "POST /"]]);
    }

    console.log("\n(k) the admin pages take only a 404 from an assignment delete as already removed (source check)");
    for (const [file, api] of [
      ["app/[org]/(admin)/library/[courseId]/assign-section.tsx", "/api/assignments/"],
      ["app/[org]/(admin)/learning-paths/learning-paths-client.tsx", "/api/learning-path-assignments/"],
    ] as const) {
      const src = fs.readFileSync(path.join(__dirname, "../..", file), "utf8").replace(/\r\n/g, "\n");
      const start = src.indexOf("async function unassign(");
      const body = start < 0 ? "" : src.slice(start, src.indexOf("\n  }\n", start));
      const statusTests = body.match(/res\.status\s*[!=]==?\s*\d+/g) ?? [];
      const arm404 = /if \(res\.status === 404\) \{\s*router\.refresh\(\);\s*return;\s*\}/.exec(body);
      const notOk = body.indexOf("if (!res.ok)");
      eq(`${file}: unassign() calls DELETE ${api}{id}; its only status test is === 404, whose arm refreshes and returns with no toast, before a !res.ok arm that shows the error`,
        [body.includes(`fetch(\`${api}\${id}\``), statusTests, !!arm404, !!arm404 && notOk > arm404.index, notOk >= 0 && /toast\.error\(/.test(body.slice(notOk))],
        [true, ["res.status === 404"], true, true, true]);
    }

    console.log("\n(l) ADR 0030 rule 10: the notification pass mails only members that count");
    {
      /** Who the sender logged a mail for (each send writes one notification_log row). */
      const mailed = () => requests.filter((r) => r.path === "/rest/v1/notification_log" && r.method === "POST")
        .map((r) => String((r.body as Row).to_user_id)).sort();
      /** The sender's first read: zero means it was never entered. */
      const senderEntered = () => requests.some((r) => r.path === "/rest/v1/notification_settings");
      /** The one read of the members that count (countingMemberIds). */
      const countingReads = () => requests.filter((r) => r.path === "/rest/v1/organization_members" && r.key === SERVICE_KEY && r.select === "user_id,role,status").length;
      const ACTIVE = [ME.id, "u-2"].sort();
      {
        const out = await call(CALLS[4], { role: "admin" });
        eq("DELETE /api/assignments/{id}, an org-wide row: the active members are told; the inactive and the suspended member are not",
          [out.status, mailed()], [200, ACTIVE]);
        eq("…from one read of the members that count", countingReads(), 1);
      }
      {
        const out = await call(CALLS[5], { role: "admin" });
        eq("DELETE /api/learning-path-assignments/{id}, an org-wide row: the same", [out.status, mailed(), countingReads()], [200, ACTIVE, 1]);
      }
      {
        world({ role: "admin" });
        const res = await assignment.DELETE(del("/api/assignments/a2"), params("a2"));
        eq("DELETE /api/assignments/{id}, a team row of one active, one inactive and one suspended member: only the active one told",
          [res.status, mailed()], [200, ["u-2"]]);
      }
      {
        world({ role: "admin" });
        const res = await pathAssignment.DELETE(del("/api/learning-path-assignments/pa2"), params("pa2"));
        eq("DELETE /api/learning-path-assignments/{id}, the same team row: only the active one told", [res.status, mailed()], [200, ["u-2"]]);
      }
      {
        world({ role: "admin" });
        const res = await pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, assignToOrg: true }));
        eq("POST /api/learning-path-assignments, org-wide: the same", [res.status, mailed(), countingReads()], [200, ACTIVE, 1]);
      }
      {
        world({ role: "admin" });
        const res = await pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, userIds: ["u-2", "u-3", "u-4"] }));
        const named = sessionWrites("learning_path_assignments", "POST").map((w) => (w.body as Row).user_id);
        eq("POST /api/learning-path-assignments, three people named directly: all three assigned, only the active one told",
          [res.status, named, mailed()], [200, ["u-2", "u-3", "u-4"], ["u-2"]]);
      }
      {
        world({ role: "admin" });
        const res = await pathAssign.POST(post("/api/learning-path-assignments", { orgSlug: "org", pathId: PATH, teamIds: ["t1"] }));
        eq("POST /api/learning-path-assignments, a team of one active, one inactive and one suspended member: only the active one told",
          [res.status, mailed()], [200, ["u-2"]]);
      }
      {
        const out = await call(CALLS[7], { role: "admin" });
        eq("POST /api/learning-paths/{id}/courses (notify_update), a path assigned org-wide and to that team: the active members only",
          [out.status, mailed(), countingReads()], [200, ACTIVE, 1]);
      }
      for (const c of [CALLS[4], CALLS[5], CALLS[7]]) {
        const out = await call(c, { role: "admin", failRead: "organization_members" });
        eq(`${c.name}, the members that count cannot be read: the change stands (200), nothing is sent, the sender is not entered`,
          [out.status, mailed(), senderEntered()], [200, [], false]);
      }
    }

    console.log("\n(m) ADR 0030 rule 2: a row that does not count, or a deleted organisation, is answered as no membership");
    for (const c of CALLS) {
      const outsider = await call(c, { role: null });
      const variants: Array<[string, Parameters<typeof world>[0]]> = [
        ["an admin whose row is inactive", { role: "admin", status: "inactive" }],
        ["an admin whose row is suspended", { role: "admin", status: "suspended" }],
        ["a super owner whose row is inactive", { role: "super_owner", status: "inactive" }],
        ["an active admin of a deleted organisation", { role: "admin", orgDeleted: true }],
      ];
      for (const [label, o] of variants) {
        const out = await call(c, o);
        eq(`${c.name}, ${label}: the no-membership answer (${outsider.status}), no service-key / Cloudflare / write request`,
          [out.status, out.body, serviceCalls().length, external().length, writes().length],
          [outsider.status, outsider.body, 0, 0, 0]);
      }
      // The control beside it: the same admin, active, in the live organisation, is let through.
      const control = await call(c, { role: "admin" });
      eq(`${c.name}, the control (an active admin of the live organisation): answered ${control.status}, not the no-membership answer`,
        control.status !== outsider.status, true);
    }

    eq("no request left the stub", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
