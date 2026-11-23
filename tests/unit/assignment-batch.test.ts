/**
 * An administrator's assignment to many named learners stays inside one
 * request's calls (ADR 0029 gate G3). Measured on a local build against
 * staging: one insert per named learner made a course or a path assignment
 * of 97 named learners 130 calls, 112 of them before its first send, so on
 * the Workers free plan (50 calls a request) the platform ended it during
 * its inserts, before any mail; the mail's budget assumes the request's own
 * calls are a fixed ADMIN_REQUEST_OWN_CALLS.
 *
 * Each site that wrote one row per learner, run over the stubbed world of
 * tests/unit/mail-world.ts with 97 named learners and working mail:
 *
 *   - POST /api/assignments (app/api/assignments/route.ts);
 *   - POST /api/learning-path-assignments;
 *   - assignCourseDirect (lib/assignments/direct.ts: a manager's ticket,
 *     "assign");
 *   - grantExtraAttempts (lib/attempts/grant.ts: a manager's ticket,
 *     "grant a retry");
 *   - the vertical / department groups of an assignment's scopes
 *     (ensureScopeGroups, lib/org/scope-groups.ts): 20 pairs, the most a
 *     request takes, were one read (and one re-activation) each.
 *
 * For each: every row is written, in one insert; the calls before the first
 * send are a fixed number, whatever the number of learners (counted here
 * without the middleware's call, which the stub does not run); and for the
 * plain named case the route's own calls before its mail part are within
 * ADMIN_REQUEST_OWN_CALLS. (A request that also names vertical targets makes
 * more of its own: 12 here, see its case.)
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/assignment-batch.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import { createClient } from "@supabase/supabase-js";
import { ORG, SUPABASE, eq, finish, freshWorld, installStub, removeStub, stub as worldStub, world, type Row, type World } from "./mail-world";
import { ADMIN_REQUEST_OWN_CALLS } from "../../lib/notifications/smtp-state";

const ANON = "stub-anon-key";
const ADMIN = "0c000000-0000-4000-8000-0000000000ad";
const USER = { id: ADMIN, aud: "authenticated", role: "authenticated", email: "admin@tenant.stub" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const COURSE = "0d000000-0000-4000-8000-0000000000c1";
const PATH = "0d000000-0000-4000-8000-0000000000e1";
const VERSION = "0d000000-0000-4000-8000-0000000000f1";
const N = 97;
const learner = (i: number) => `0b000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const LEARNERS = Array.from({ length: N }, (_, i) => learner(i + 1));

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [{ name: "sb-stub-auth-token", value: SESSION }], set() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  return load.call(this, request, ...rest);
};

/** Every call in order, the session's and the service role's, the mail's included. */
type Call = { method: string; path: string; table: string; body: unknown; service: boolean };
let calls: Call[] = [];
const fetchAll = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const key = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("apikey");
  calls.push({ method, path: url.pathname, table: url.pathname.replace("/rest/v1/", ""), body, service: key === process.env.SUPABASE_SERVICE_ROLE_KEY });
  if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify(USER), { status: 200, headers: { "content-type": "application/json" } });
  return worldStub(input, init);
};

/** The calls before the first send, and the rows of the inserts into a table. */
const beforeFirstSend = () => {
  const i = calls.findIndex((c) => c.path === "/functions/v1/send-smtp");
  return i < 0 ? null : i;
};
const insertsInto = (table: string) => calls.filter((c) => c.table === table && c.method === "POST");
const rowsOf = (cs: Call[]) => cs.flatMap((c) => (Array.isArray(c.body) ? (c.body as Row[]) : [c.body as Row]));
/** A route's own calls: those before its mail part, whose first call is the service role's. */
const ownCalls = () => {
  const i = calls.findIndex((c) => c.service);
  return i < 0 ? null : i;
};

/** The 20 verticals of the scope case, V01 to V20; the learners are spread over them. */
const VERTICALS = Array.from({ length: 20 }, (_, i) => `V${String(i + 1).padStart(2, "0")}`);
const groupId = (i: number) => `0e000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

/** An organisation of the admin and 97 active learners, with working mail, a course, its version, and a path. */
function seed(over: { attempts?: boolean } = {}) {
  freshWorld({
    members: [
      { organization_id: ORG, user_id: ADMIN, role: "admin", status: "active" },
      ...LEARNERS.map((user_id, i) => ({ organization_id: ORG, user_id, role: "user", status: "active", business_vertical: VERTICALS[i % 20], department: null })),
    ] as World["members"],
    profiles: Object.fromEntries([[ADMIN, "admin@tenant.stub"], ...LEARNERS.map((u, i) => [u, `learner-${i + 1}@tenant.stub`])]),
    tables: {
      courses: [{ id: COURSE, organization_id: ORG, title: "Course K", is_active: true, pass_required: false }],
      learning_paths: [{ id: PATH, organization_id: ORG, name: "Path P", is_active: true }],
      content_scopes: [],
      course_assignments: [],
      learning_path_assignments: [],
      course_versions: [{ id: VERSION, course_id: COURSE }],
      // Each learner's one official attempt, failed: a retry can be granted to each.
      course_attempts: over.attempts
        ? LEARNERS.map((user_id, i) => ({
            id: `0a100000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, user_id, organization_id: ORG, course_version_id: VERSION,
            status: "completed", score: 0.4, started_at: "2026-10-01T09:00:00Z", completed_at: "2026-10-01T10:00:00Z",
            completion_status: "completed", success_status: "failed", is_revision: false, context_kind: "individual",
          }))
        : [],
      attempt_requests: [],
      // The master values, and each vertical's system group already there, every other one deactivated.
      org_field_options: VERTICALS.map((value, i) => ({ id: `0f000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, organization_id: ORG, field: "business_vertical", value, parent_id: null })),
      org_groups: VERTICALS.map((v, i) => ({
        id: groupId(i), organization_id: ORG, name: `${v} (everyone)`, group_type: "dynamic", rules: { verticals: [v] },
        is_active: i % 2 === 0, system_key: `scope:${v}|`,
      })),
    },
    rpc: { effective_attempt_policies: () => [] },
  });
  calls = [];
}

async function main() {
  installStub();
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  globalThis.fetch = fetchAll as typeof fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const courseRoute = await import("../../app/api/assignments/route");
    const pathRoute = await import("../../app/api/learning-path-assignments/route");
    const direct = await import("../../lib/assignments/direct");
    const grant = await import("../../lib/attempts/grant");
    const svc = createClient(SUPABASE, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const post = async (route: { POST: (r: Request) => Promise<Response> }, url: string, body: Row) => {
      const res = await route.POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgSlug: "tenant-a", ...body }) }));
      return { status: res.status, body: (await res.json()) as Row };
    };
    const named = (rows: Row[]) => [...new Set(rows.filter((r) => r.assignee_type === "user").map((r) => String(r.user_id)))].sort();

    console.log(`\nPOST /api/assignments: ${N} named learners`);
    {
      seed();
      const r = await post(courseRoute, "http://lms.test/api/assignments", { courseId: COURSE, userIds: LEARNERS });
      eq(`200, ${N} assigned, mail sent`, [r.status, r.body.assigned, ((r.body.email as Row | null)?.emailed as number) > 0], [200, N, true]);
      eq(`every row written: ${N} user rows, one for each learner named`, named(world.tables.course_assignments), [...LEARNERS].sort());
      eq("…in one insert of every row", [insertsInto("course_assignments").length, rowsOf(insertsInto("course_assignments")).length], [1, N]);
      // The route's 8 (the session, the organisation, the caller's membership,
      // the course, the named members, the course's mapping, the rows already
      // there, the one insert) and the mail's 8 before its first send (the
      // title, the members that count, the addresses, the run's opening, the
      // template). Measured before: 7 + one insert per learner + 8 = 112 with
      // the middleware's call.
      eq("the calls before the first send: 16, whatever the number of learners", beforeFirstSend(), 16);
      const own = ownCalls();
      eq(`…the route's own calls before its mail part: 8, within ADMIN_REQUEST_OWN_CALLS (${ADMIN_REQUEST_OWN_CALLS})`, [own, own !== null && own <= ADMIN_REQUEST_OWN_CALLS], [8, true]);
    }

    console.log("\nPOST /api/assignments: 20 vertical targets, each group already there, every other one deactivated");
    {
      seed();
      const r = await post(courseRoute, "http://lms.test/api/assignments", { courseId: COURSE, scopes: VERTICALS.map((vertical) => ({ vertical })) });
      eq("200, 20 group rows assigned, mail sent", [r.status, r.body.assigned, ((r.body.email as Row | null)?.emailed as number) > 0], [200, 20, true]);
      const groupReads = calls.filter((c) => c.table === "org_groups" && c.method === "GET" && !c.service);
      const groupWrites = calls.filter((c) => c.table === "org_groups" && c.method !== "GET");
      eq("the groups: one read of all 20, one re-activation of the 10 deactivated, nothing created",
        [groupReads.length, groupWrites.map((c) => c.method), world.tables.org_groups.every((g) => g.is_active === true), world.tables.org_groups.length],
        [1, ["PATCH"], true, 20]);
      eq("every group row written, in one insert",
        [[...new Set(world.tables.course_assignments.filter((x) => x.assignee_type === "group").map((x) => String(x.group_id)))].sort(), insertsInto("course_assignments").length],
        [VERTICALS.map((_, i) => groupId(i)).sort(), 1]);
      // The route's 11 (the session, the organisation, the caller's
      // membership, the course, the organisation's flag and the master
      // values, the groups, their re-activation, the course's mapping, the
      // rows already there, the one insert) and the mail's 10 before its
      // first send (the title, the members that count, the groups and their
      // members, the addresses, the run's opening, the template). Before: one
      // read per pair, one update per deactivated pair and one insert per
      // group row, 67 and 57.
      eq("the calls before the first send: 21, whatever the number of pairs", beforeFirstSend(), 21);
      eq(`…the route's own calls before its mail part: 11, one more than ADMIN_REQUEST_OWN_CALLS (${ADMIN_REQUEST_OWN_CALLS}) assumes`, ownCalls(), 11);
    }

    console.log(`\nPOST /api/learning-path-assignments: ${N} named learners`);
    {
      seed();
      const r = await post(pathRoute, "http://lms.test/api/learning-path-assignments", { pathId: PATH, userIds: LEARNERS });
      eq(`200, ${N} assigned, mail sent`, [r.status, r.body.assigned, ((r.body.email as Row | null)?.emailed as number) > 0], [200, N, true]);
      eq(`every row written: ${N} user rows, one for each learner named`, named(world.tables.learning_path_assignments), [...LEARNERS].sort());
      eq("…in one insert of every row", [insertsInto("learning_path_assignments").length, rowsOf(insertsInto("learning_path_assignments")).length], [1, N]);
      eq("the calls before the first send: 16, as the course's (the path for the course)", beforeFirstSend(), 16);
      const own = ownCalls();
      eq(`…the route's own calls before its mail part: 8, within ADMIN_REQUEST_OWN_CALLS (${ADMIN_REQUEST_OWN_CALLS})`, [own, own !== null && own <= ADMIN_REQUEST_OWN_CALLS], [8, true]);
    }

    console.log(`\nassignCourseDirect (a manager's ticket, "assign"): ${N} learners`);
    {
      seed();
      const out = await direct.assignCourseDirect(svc, {
        orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "http://lms.test", assignedBy: ADMIN,
        courseId: COURSE, userIds: LEARNERS, dueAt: null,
      });
      if ("error" in out) throw new Error(out.error);
      eq(`every learner assigned, mail sent`, [out.results.filter((x) => x.status === "assigned").length, ((out.email as Row | null)?.emailed as number) > 0], [N, true]);
      eq(`every row written: ${N} user rows`, named(world.tables.course_assignments), [...LEARNERS].sort());
      eq("…in one insert of every row", [insertsInto("course_assignments").length, rowsOf(insertsInto("course_assignments")).length], [1, N]);
      // The course, the rows already there, the one insert, the addresses, the run's opening and the template.
      eq("the calls before the first send: 8, whatever the number of learners (one insert per learner before)", beforeFirstSend(), 8);
    }

    console.log(`\ngrantExtraAttempts (a manager's ticket, "grant a retry"): ${N} learners`);
    {
      seed({ attempts: true });
      const out = await grant.grantExtraAttempts(svc, {
        orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "http://lms.test", decidedBy: ADMIN,
        source: "ticket", courseId: COURSE, userIds: LEARNERS, expiresInDays: 30,
      });
      if ("error" in out) throw new Error(out.error);
      eq(`every learner granted, mail sent`, [out.results.filter((x) => x.status === "granted").length, ((out.email as Row | undefined)?.emailed as number) > 0], [N, true]);
      const granted = world.tables.attempt_requests;
      eq(`every grant written: ${N} approved rows, one for each learner, source ticket`,
        [[...new Set(granted.map((r) => String(r.user_id)))].sort(), granted.every((r) => r.status === "approved" && r.source === "ticket" && r.attempts_used === 1)],
        [[...LEARNERS].sort(), true]);
      eq("…in one insert of every row", [insertsInto("attempt_requests").length, rowsOf(insertsInto("attempt_requests")).length], [1, N]);
      // The course, its versions, the attempts, the policy, pass_required, the
      // grants, the expiry sweep, the open requests, the addresses, the one
      // insert, the members that count and the run's opening.
      eq("the calls before the first send: 15, whatever the number of learners (one insert per learner before)", beforeFirstSend(), 15);
    }
  } finally {
    console.warn = realWarn;
    removeStub();
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
