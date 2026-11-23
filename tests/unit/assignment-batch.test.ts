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
 * A manager's ticket acted on (POST /api/tickets/[id]/act, "grant a retry"
 * and "assign") and the bulk grant (POST /api/attempt-requests/bulk) run
 * end to end here, and each whole request, with the middleware's call,
 * stays within the 40 of rule FP2: one budget counted from the request's
 * first call, each call where it is made, and one run, the requester's
 * mail of a ticket included. With no room left, the requester's mail is
 * left, never read or attempted, and the answer says so (`left`). A ticket
 * naming one learner still mails both.
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
  // A new group gets its id from the server (the world's generic table gives
  // none), and .single() reads it as one object, as the server answers it.
  if (url.pathname === "/rest/v1/org_groups" && method === "POST" && body && !Array.isArray(body)) {
    const res = await worldStub(input, { ...init, body: JSON.stringify({ id: `0e100000-0000-4000-8000-${String(calls.length).padStart(12, "0")}`, ...(body as Row) }) });
    const rows = (await res.json()) as Row[];
    return new Response(JSON.stringify(rows[0] ?? null), { status: res.status, headers: { "content-type": "application/json" } });
  }
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

/** The manager who raised the ticket of the ticket cases, and the ticket. */
const MANAGER = "0c000000-0000-4000-8000-0000000000e0";
const TICKET = "0d000000-0000-4000-8000-0000000000a7";
/** The middleware's one call (its session read) on every request, which the stub does not run. */
const MIDDLEWARE_CALLS = 1;
/** A ticket naming `people`, raised by MANAGER, about COURSE. */
const ticketRow = (category: "grant_retry" | "assign_content", people: string[]): Row => ({
  id: TICKET, organization_id: ORG, user_id: MANAGER, subject: "Team K", body: null, status: "open", priority: "normal",
  admin_note: null, source: "manager", category, requested_by_level: 1, outcome: null, outcome_at: null,
  created_at: "2026-11-20T09:00:00Z", updated_at: "2026-11-20T09:00:00Z", closed_at: null,
  context: { userIds: people, contentKind: "course", contentId: COURSE, contentTitle: "Course K", exception: null, origin: null },
});

/** An organisation of the admin and 97 active learners, with working mail, a course, its version, and a path. */
function seed(over: { attempts?: boolean; ticket?: Row } = {}) {
  freshWorld({
    members: [
      { organization_id: ORG, user_id: ADMIN, role: "admin", status: "active" },
      ...LEARNERS.map((user_id, i) => ({ organization_id: ORG, user_id, role: "user", status: "active", business_vertical: VERTICALS[i % 20], department: null })),
      ...(over.ticket ? [{ organization_id: ORG, user_id: MANAGER, role: "user", status: "active" }] : []),
    ] as World["members"],
    profiles: Object.fromEntries([
      [ADMIN, "admin@tenant.stub"],
      ...LEARNERS.map((u, i) => [u, `learner-${i + 1}@tenant.stub`]),
      ...(over.ticket ? [[MANAGER, "manager@tenant.stub"]] : []),
    ]),
    tables: {
      help_tickets: over.ticket ? [{ ...over.ticket }] : [],
      help_ticket_messages: [],
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
      // V21 is master data with no group yet.
      org_field_options: [...VERTICALS, "V21"].map((value, i) => ({ id: `0f000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, organization_id: ORG, field: "business_vertical", value, parent_id: null })),
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
    {
      // A pair with no group yet, named twice beside one that has its group:
      // one read of both, the new group created once, as before.
      seed();
      const r = await post(courseRoute, "http://lms.test/api/assignments", { courseId: COURSE, scopes: [{ vertical: "V01" }, { vertical: "V21" }, { vertical: "V21" }] });
      const created = world.tables.org_groups.filter((g) => g.system_key === "scope:V21|");
      const groupRows = world.tables.course_assignments.filter((x) => x.assignee_type === "group").map((x) => String(x.group_id));
      eq("a new pair named twice beside one already there: one read, one group created (active, dynamic, its rule), two group rows assigned",
        [r.status, r.body.assigned, calls.filter((c) => c.table === "org_groups" && c.method === "GET" && !c.service).length,
          calls.filter((c) => c.table === "org_groups" && c.method === "POST").length,
          created.map((g) => [g.is_active, g.group_type, JSON.stringify(g.rules), g.name]), groupRows.sort()],
        [200, 2, 1, 1, [[true, "dynamic", JSON.stringify({ verticals: ["V21"] }), "V21 (everyone)"]], [groupId(0), String(created[0]?.id)].sort()]);
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

    // A ticket's action is one request: the middleware's call, the session,
    // the ticket, the caller's membership, the people still active, the
    // action's own reads and writes, the learners' mail, the ticket's close
    // and its thread message, and the requester's mail. All of it is one
    // budget and one run, so the whole request stays within the 40 of rule
    // FP2 (CALL_SUM_LIMIT). Measured before, over this stub: 53 calls for a
    // grant and 44 for an assignment (54 and 45 with the middleware's), the
    // grant's mail sized on 11 calls before its run where it had made 18,
    // and the requester's mail in a second run with a budget of its own.
    const act = await import("../../app/api/tickets/[id]/act/route");
    const actOn = async (body: Row) => {
      const res = await act.POST(
        new Request(`http://lms.test/api/tickets/${TICKET}/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: TICKET }) }
      );
      return { status: res.status, body: (await res.json()) as Row };
    };
    const sendsTo = (pick: (to: string) => boolean) => calls.filter((c) => c.path === "/functions/v1/send-smtp" && pick(String((c.body as Row | null)?.to ?? ""))).length;
    const requesterSends = () => sendsTo((to) => to === "manager@tenant.stub");
    const learnerSends = () => sendsTo((to) => to.startsWith("learner-"));
    const closed = () => world.tables.help_tickets.map((t) => [t.status, t.outcome]);
    const runsOpened = () => calls.filter((c) => c.table === "rpc/tenant_mail_status").length;
    const last = () => { const c = calls[calls.length - 1]; return c ? `${c.method} ${c.table}` : null; };
    const counts = (o: unknown) => { const x = o as Row; return [x.emailed, x.not_emailed, x.not_confirmed, x.left ?? null]; };

    // The learners' mail is sized on the calls really made before its run.
    // Over the stub, 20 calls before a grant's first send: the session, the
    // ticket and the membership 4, the people still active 1, the grant's
    // own 10 (the course, its versions, the attempts, the policy, the pass
    // mark, the grants, the expiry sweep, the open requests, the addresses,
    // the one insert), the members that count 2 and the run's opening 3.
    // 13 before an assignment's: 4, 1, the assignment's own 4 (the course,
    // the rows already there, the one insert, the addresses), the run's
    // opening 3 and the template 1. The budget also holds the middleware's
    // call, which the stub does not run, and the two closing calls, held
    // back. So 6 and 15 learners are mailed (11 and 15 before, past the 40),
    // and the requester's mail has no room left: it is left, and the answer
    // says so. On a grant the requester is left from 5 learners on, on an
    // assignment from 12.
    for (const [action, firstSend, mailed, total] of [["grant_retry", 20, 6, 36], ["assign", 13, 15, 37]] as const) {
      console.log(`\nPOST /api/tickets/[id]/act, "${action}": a ticket naming ${N} learners`);
      seed({ attempts: action === "grant_retry", ticket: ticketRow(action === "grant_retry" ? "grant_retry" : "assign_content", LEARNERS) });
      const r = await actOn(action === "grant_retry" ? { action, expires_in_days: 30 } : { action });
      const done = action === "grant_retry"
        ? world.tables.attempt_requests.filter((x) => x.status === "approved").length
        : world.tables.course_assignments.filter((x) => x.assignee_type === "user").length;
      eq(`200, all ${N} ${action === "grant_retry" ? "granted" : "assigned"}, the ticket closed with its outcome, its thread message written`,
        [r.status, done, closed(), world.tables.help_ticket_messages.length],
        [200, N, [["closed", action === "grant_retry" ? "granted" : "assigned"]], 1]);
      eq(`the whole request, with the middleware's call: ${total} calls, within 40`, [calls.length + MIDDLEWARE_CALLS, calls.length + MIDDLEWARE_CALLS <= 40], [total, true]);
      eq("…one run: the organisation's mail state read once", runsOpened(), 1);
      eq(`…${firstSend} calls before the first send, as counted`, beforeFirstSend(), firstSend);
      eq(`the learners: ${mailed} emailed, ${N - mailed} reported as not emailed`, [learnerSends(), ...counts(r.body.email)], [mailed, mailed, N - mailed, 0, null]);
      eq("the requester's mail: left for room, reported as not emailed with `left`, never attempted",
        [requesterSends(), ...counts(r.body.requester_email)], [0, 0, 1, 0, 1]);
      eq("…and nothing of it was read: the request's last call is the thread message", last(), "POST help_ticket_messages");
    }

    for (const [action, total] of [["grant_retry", 31], ["assign", 24]] as const) {
      console.log(`\nPOST /api/tickets/[id]/act, "${action}": a ticket naming one learner`);
      seed({ attempts: action === "grant_retry", ticket: ticketRow(action === "grant_retry" ? "grant_retry" : "assign_content", [LEARNERS[0]]) });
      const r = await actOn(action === "grant_retry" ? { action, expires_in_days: 30 } : { action });
      eq("200, the learner emailed and the requester emailed, in one run",
        [r.status, learnerSends(), counts(r.body.email), requesterSends(), counts(r.body.requester_email), runsOpened()],
        [200, 1, [1, 0, 0, null], 1, [1, 0, 0, null], 1]);
      eq(`…${total} calls with the middleware's, within 40`, [calls.length + MIDDLEWARE_CALLS, calls.length + MIDDLEWARE_CALLS <= 40], [total, true]);
    }

    {
      // No mail of the action's own: the requester's mail opens the request's run on its budget.
      console.log(`\nPOST /api/tickets/[id]/act, "decline": a ticket naming ${N} learners`);
      seed({ ticket: ticketRow("grant_retry", LEARNERS) });
      const r = await actOn({ action: "decline", note: "Not this quarter" });
      eq("200, declined, nobody named is mailed, the requester emailed in the request's one run",
        [r.status, closed(), learnerSends(), requesterSends(), counts(r.body.requester_email), runsOpened()],
        [200, [["closed", "declined"]], 0, 1, [1, 0, 0, null], 1]);
      eq(`…${calls.length + MIDDLEWARE_CALLS} calls with the middleware's, within 40`, calls.length + MIDDLEWARE_CALLS <= 40, true);
    }

    // The bulk grant (POST /api/attempt-requests/bulk) was one run, but its
    // mail was sized from ADMIN_REQUEST_OWN_CALLS (10) where the route had
    // made 15 calls before its run, the middleware's included: 41 calls,
    // 11 learners emailed. Its budget now counts from the request's first
    // call, each call where it is made.
    {
      console.log(`\nPOST /api/attempt-requests/bulk: ${N} failed learners`);
      const bulk = await import("../../app/api/attempt-requests/bulk/route");
      seed({ attempts: true });
      const res = await bulk.POST(new Request("http://lms.test/api/attempt-requests/bulk?orgSlug=tenant-a", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courseId: COURSE, expires_in_days: 30 }) }));
      const body = (await res.json()) as Row;
      eq(`200, all ${N} granted in one insert, one run`, [res.status, body.granted, insertsInto("attempt_requests").length, runsOpened()], [200, N, 1, 1]);
      eq("the whole request, with the middleware's call: 37 calls, within 40 (41 before)", [calls.length + MIDDLEWARE_CALLS, calls.length + MIDDLEWARE_CALLS <= 40], [37, true]);
      eq(`…17 calls before the first send; 9 learners emailed, ${N - 9} reported as not emailed`, [beforeFirstSend(), learnerSends(), ...counts(body.email)], [17, 9, 9, N - 9, 0, null]);
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
