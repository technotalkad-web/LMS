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
 *     request takes, were one read (and one re-activation) each. The
 *     groups not there yet are created first, and the deactivated ones
 *     re-activated only after every create succeeded.
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
 * mail of a ticket included. The requester's room is held back with the
 * ticket's close (ADR 0029, note of 2026-11-24), so at every size a ticket
 * can name the requester is emailed: a large ticket emails 4 learners on a
 * grant and 11 on an assignment, and up to those sizes every learner. With
 * no room left after all (by the count or by the clock), the requester's
 * mail is left, never read or attempted, and the answer says so (`left`);
 * two cases call actOnTicket with such a budget.
 *
 * A ticket's insert can fail in two ways the one insert must answer
 * honestly (the server's unique keys are held here for both tables):
 *   - saved, with its answer lost (the fetch failed after the request was
 *     sent; supabase-js answers code ""). It is read back, never inserted
 *     again row by row: every learner is granted or assigned, emailed as
 *     the budget allows, and the ticket closes. A read-back that fails
 *     answers each learner "not confirmed", and the ticket stays open. The
 *     course assignment route shares the writer and reads back the same way.
 *   - refused with 23505 (another request wrote one of its rows since the
 *     read). Its rows go one at a time while the request has room; the
 *     rest are not tried and answered as not saved ("try again"), and the
 *     request stays within 40. At 50 the inserts use the room up and no
 *     learner is emailed. The ticket stays open (ADR 0029, note of
 *     2026-11-25, part 2): in_progress, no outcome, one thread message,
 *     the requester not mailed, `closed: false`. A second press of the
 *     same action finds the rows written the first time ("already"),
 *     writes the rest in one insert, closes the ticket and mails the
 *     requester, and nobody holds two rows. A press that finds everybody
 *     served answers 409 and leaves the ticket open; "Mark resolved"
 *     closes it.
 * And a vertical target whose group cannot be created leaves the
 * deactivated groups the request named deactivated.
 *
 * ADR 0029, note of 2026-11-25, part 3, the two writes called directly: a
 * refusal every row shares (23503) makes the batch and three row inserts
 * and no more, and nobody reads "try again"; a refusal one row causes saves
 * the others; duplicates (23505) are each tried. A lost reply whose
 * read-back finds nothing is "not confirmed", never "failed", and mails
 * nobody. The assignment's read-back takes a row for the request's own
 * only after a first read that answered and with the request's
 * assigned_by; any other row found is a duplicate (its date, its
 * conversion, no "assigned" mail). A row another press of the same action
 * finishes (not saved for room, or not confirmed) carries `retry: true`
 * (part 2, point 6), and no other row does.
 *
 * A learner's request for another attempt (POST /api/attempt-requests) and
 * a manager's new ticket (POST /api/tickets) mail up to 25 administrators;
 * each counts from its first call too, and stays within the 40.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/assignment-batch.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import { createClient } from "@supabase/supabase-js";
import { ORG, SUPABASE, eq, finish, freshWorld, installStub, removeStub, stub as worldStub, world, type Row, type World } from "./mail-world";
import { ADMIN_REQUEST_OWN_CALLS, REQUEST_SEND_WINDOW_MS, requestBudget } from "../../lib/notifications/smtp-state";
import { MAX_TICKET_PEOPLE } from "../../lib/tickets/types";
import type { TicketRow } from "../../lib/tickets/auth";

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
type Call = { method: string; path: string; table: string; query: string; body: unknown; service: boolean };
let calls: Call[] = [];
/** The tables whose one-row insert reads its new row back as one object (.single() or .maybeSingle()), with the id the server gives it. */
const SINGLE_INSERTS: Record<string, string> = { org_groups: "0e100000", help_tickets: "0e200000", attempt_requests: "0e300000" };
/**
 * The unique keys the server holds for the two tables a ticket's action
 * writes (attempt_requests_one_open_idx, course_assignments_unique_user_idx):
 * a row's key, or null when no index covers it. An insert with a row whose
 * key is taken, or taken twice in the insert, is refused whole with 23505.
 */
const UNIQUE: Record<string, (r: Row) => string | null> = {
  attempt_requests: (r) => (r.status === "pending" || (r.status === "approved" && (r.used_at ?? null) === null) ? `${r.user_id}|${r.course_id}` : null),
  course_assignments: (r) => (r.assignee_type === "user" ? `${r.course_id}|${r.user_id}` : null),
};
/**
 * A case's switches: `beforeWrite` runs as an insert arrives (another
 * request's write just before it); `loseReply` saves an insert and then
 * fails its fetch, as a connection dropped after the request was sent
 * (supabase-js answers code ""); `failRead` fails a read with an error.
 */
let beforeWrite: ((c: Call) => void) | null = null;
let loseReply: ((c: Call) => boolean) | null = null;
let failRead: ((c: Call) => boolean) | null = null;
/**
 * Two more (ADR 0029, note of 2026-11-25, part 3): `refuse` answers an
 * insert into a keyed table with its error, saving nothing (a refusal every
 * row shares, such as 23503, or one row's own, such as 23514); `dropWrite`
 * saves nothing and fails the fetch, as a connection dropped before the
 * write reached the database (supabase-js answers code "").
 */
let refuse: ((c: Call, rows: Row[]) => Row | null) | null = null;
let dropWrite: ((c: Call) => boolean) | null = null;
/** The nullable columns with no default (0083) that the grant's insert leaves out and its open-grant read selects. */
const COLUMN_NULLS: Record<string, Row> = { attempt_requests: { used_at: null, used_attempt_id: null } };
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchAll = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const key = headers.get("apikey");
  const table = url.pathname.replace("/rest/v1/", "");
  const call: Call = { method, path: url.pathname, table, query: decodeURIComponent(url.search), body, service: key === process.env.SUPABASE_SERVICE_ROLE_KEY };
  calls.push(call);
  if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify(USER), { status: 200, headers: { "content-type": "application/json" } });
  if (method === "GET" && failRead?.(call)) return json({ code: "XX000", message: "stub read failure" }, 500);
  // A column the insert leaves out is stored as the server stores it
  // (COLUMN_NULLS), so a later read that selects it answers null, not a
  // missing key. A second press reads back the first press's grants.
  if (method === "POST" && COLUMN_NULLS[table] && body && typeof body === "object") {
    const fill = (r: Row) => ({ ...COLUMN_NULLS[table], ...r });
    body = Array.isArray(body) ? (body as Row[]).map(fill) : fill(body as Row);
    init = { ...init, body: JSON.stringify(body) };
  }
  if (method === "POST" && UNIQUE[table]) {
    beforeWrite?.(call);
    const refused = refuse?.(call, (Array.isArray(body) ? body : [body]) as Row[]);
    if (refused) return json(refused, 409);
    if (dropWrite?.(call)) throw new TypeError("fetch failed");
    const keyOf = UNIQUE[table];
    const taken = new Set((world.tables[table] ?? []).map(keyOf).filter((k): k is string => k !== null));
    for (const r of (Array.isArray(body) ? body : [body]) as Row[]) {
      const k = keyOf(r);
      if (k === null) continue;
      if (taken.has(k)) return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
      taken.add(k);
    }
  }
  // A new group, ticket or attempt request read back gets its id from the
  // server (the world's generic table gives none), and .single() or
  // .maybeSingle() reads it as one object, as the server answers it.
  if (SINGLE_INSERTS[table] && method === "POST" && body && !Array.isArray(body) && /return=representation/.test(headers.get("prefer") ?? "")) {
    const res = await worldStub(input, { ...init, body: JSON.stringify({ id: `${SINGLE_INSERTS[table]}-0000-4000-8000-${String(calls.length).padStart(12, "0")}`, ...(body as Row) }) });
    const rows = (await res.json()) as Row[];
    return new Response(JSON.stringify(rows[0] ?? null), { status: res.status, headers: { "content-type": "application/json" } });
  }
  const res = await worldStub(input, init);
  if (loseReply?.(call)) throw new TypeError("fetch failed");
  return res;
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
      // No time zone of its own: a date-only due date ends in the default one.
      gamification_settings: [],
    },
    rpc: { effective_attempt_policies: () => [] },
  });
  calls = [];
  beforeWrite = null;
  loseReply = null;
  failRead = null;
  refuse = null;
  dropWrite = null;
}

/** The 25 administrators of the requests that mail them (`admin-1@` to `admin-25@`). */
const ADMINS = Array.from({ length: 25 }, (_, i) => `0c000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
/**
 * An organisation of 25 administrators, with working mail, for the two
 * requests that mail them: a learner's request for another attempt and a
 * manager's ticket. The session's user (ADMIN's id; role "user" here) is the
 * learner who asks, with one failed official attempt on COURSE, and the line
 * manager of the first MAX_TICKET_PEOPLE learners, whom the ticket names.
 * `others`: that many more members (role "user", no manager), so a large
 * organisation's hierarchy is read in more than one page of 1,000 rows.
 */
function seedAdmins(others = 0) {
  freshWorld({
    members: [
      { organization_id: ORG, user_id: ADMIN, role: "user", status: "active" },
      ...ADMINS.map((user_id) => ({ organization_id: ORG, user_id, role: "admin", status: "active" })),
      ...LEARNERS.slice(0, MAX_TICKET_PEOPLE).map((user_id) => ({ organization_id: ORG, user_id, role: "user", status: "active", line_manager_id: ADMIN })),
      ...Array.from({ length: others }, (_, i) => ({ organization_id: ORG, user_id: `0f100000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, role: "user", status: "active" })),
    ] as World["members"],
    profiles: Object.fromEntries([
      [ADMIN, "caller@tenant.stub"],
      ...ADMINS.map((u, i) => [u, `admin-${i + 1}@tenant.stub`]),
      ...LEARNERS.slice(0, MAX_TICKET_PEOPLE).map((u, i) => [u, `learner-${i + 1}@tenant.stub`]),
    ]),
    tables: {
      help_tickets: [],
      courses: [{ id: COURSE, organization_id: ORG, title: "Course K", is_active: true, pass_required: false }],
      course_versions: [{ id: VERSION, course_id: COURSE }],
      course_attempts: [{
        id: "0a100000-0000-4000-8000-0000000000ad", user_id: ADMIN, organization_id: ORG, course_version_id: VERSION,
        status: "completed", score: 0.4, started_at: "2026-10-01T09:00:00Z", completed_at: "2026-10-01T10:00:00Z",
        completion_status: "completed", success_status: "failed", is_revision: false, context_kind: "individual",
      }],
      attempt_requests: [],
    },
    rpc: { effective_attempt_policies: () => [] },
  });
  calls = [];
  beforeWrite = null;
  loseReply = null;
  failRead = null;
  refuse = null;
  dropWrite = null;
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
    {
      // The insert saved and its answer lost (the fetch failed after it was
      // sent): the route shares writeAssignmentRows, which reads the rows
      // back in one call instead of answering 400 with every row saved.
      console.log(`\nPOST /api/assignments: ${N} named learners, the insert saved and its answer lost`);
      seed();
      let lost = false;
      loseReply = (c) => !lost && c.method === "POST" && c.table === "course_assignments" && (lost = true);
      const r = await post(courseRoute, "http://lms.test/api/assignments", { courseId: COURSE, userIds: LEARNERS });
      const postAt = calls.findIndex((c) => c.method === "POST" && c.table === "course_assignments");
      eq(`200, ${N} assigned, mail sent; every row written once, in the one insert, and read back in one call`,
        [r.status, r.body.assigned, ((r.body.email as Row | null)?.emailed as number) > 0, named(world.tables.course_assignments), insertsInto("course_assignments").length,
          calls.slice(postAt + 1).filter((c) => c.method === "GET" && c.table === "course_assignments").length],
        [200, N, true, [...LEARNERS].sort(), 1, 1]);
      const own = ownCalls();
      eq(`…the route's own calls before its mail part: 9 with the read-back, within ADMIN_REQUEST_OWN_CALLS (${ADMIN_REQUEST_OWN_CALLS}); the whole request within 40`,
        [own, own !== null && own <= ADMIN_REQUEST_OWN_CALLS, calls.length + MIDDLEWARE_CALLS <= 40], [9, true, true]);
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
    {
      // A create that fails: the route answers 400, and the deactivated
      // groups the request named stay deactivated (the creates come first,
      // the re-activation only after every create succeeded). Before, the
      // deactivated groups were re-activated before the create was tried.
      seed();
      world.failWrite = (r) => r.table === "org_groups" && r.method === "POST";
      const named = ["V02", "V21", "V04"];
      const r = await post(courseRoute, "http://lms.test/api/assignments", { courseId: COURSE, scopes: named.map((vertical) => ({ vertical })) });
      const state = (v: string) => world.tables.org_groups.find((g) => g.system_key === `scope:${v}|`)?.is_active ?? null;
      eq("a create that fails: 400, V02 and V04 still deactivated, no group re-activated, none created, nothing assigned",
        [r.status, state("V02"), state("V04"), calls.filter((c) => c.table === "org_groups" && c.method === "PATCH").length, state("V21"), world.tables.course_assignments.length],
        [400, false, false, 0, null, 0]);
    }
    {
      // A master value with a double quote: each pair's group is read on its
      // own, and the order holds there too.
      seed();
      world.tables.org_field_options.push({ id: "0f000000-0000-4000-8000-000000000099", organization_id: ORG, field: "business_vertical", value: 'V"Q', parent_id: null });
      world.failWrite = (r) => r.table === "org_groups" && r.method === "POST";
      const r = await post(courseRoute, "http://lms.test/api/assignments", { courseId: COURSE, scopes: [{ vertical: "V02" }, { vertical: 'V"Q' }] });
      eq("…a key a filter list cannot carry: 400, V02 still deactivated, no group re-activated",
        [r.status, world.tables.org_groups.find((g) => g.system_key === "scope:V02|")?.is_active, calls.filter((c) => c.table === "org_groups" && c.method === "PATCH").length],
        [400, false, 0]);
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
    /** The request's last `n` calls; a send names its recipient. */
    const tail = (n: number) => calls.slice(-n).map((c) => (c.path === "/functions/v1/send-smtp" ? `send to ${String((c.body as Row | null)?.to ?? "")}` : `${c.method} ${c.table}`));
    const counts = (o: unknown) => { const x = (o ?? {}) as Row; return [x.emailed, x.not_emailed, x.not_confirmed, x.left ?? null]; };
    /** A ticket naming `people`, acted on end to end: the answer's two mail outcomes, the sends, and the whole request's calls with the middleware's. */
    const actFor = async (action: "grant_retry" | "assign", people: string[]) => {
      seed({ attempts: action === "grant_retry", ticket: ticketRow(action === "grant_retry" ? "grant_retry" : "assign_content", people) });
      const r = await actOn(action === "grant_retry" ? { action, expires_in_days: 30 } : { action });
      return { status: r.status, email: counts(r.body.email), requester: counts(r.body.requester_email), learners: learnerSends(), requesterSent: requesterSends(), total: calls.length + MIDDLEWARE_CALLS };
    };
    /** Up to these many people a ticket's action emails every learner and the requester (ADR 0029, note of 2026-11-24, part 1). */
    const EVERYBODY_UP_TO = { grant_retry: 4, assign: 11 } as const;

    // The learners' mail is sized on the calls really made before its run.
    // Over the stub, 20 calls before a grant's first send: the session, the
    // ticket and the membership 4, the people still active 1, the grant's
    // own 10 (the course, its versions, the attempts, the policy, the pass
    // mark, the grants, the expiry sweep, the open requests, the addresses,
    // the one insert), the members that count 2 and the run's opening 3.
    // 13 before an assignment's: 4, 1, the assignment's own 4 (the course,
    // the rows already there, the one insert, the addresses), the run's
    // opening 3 and the template 1. The budget also holds the middleware's
    // call, which the stub does not run, the two closing calls, and the
    // requester's five (REQUESTER_HELD_CALLS: their three reads, the send
    // and its log row), held back so the learners' mail is sized without
    // them (ADR 0029, note of 2026-11-24). So 4 and 11 learners are mailed,
    // and the requester is mailed last, in the same run. Before that hold
    // (cf34281) 6 and 15 learners were mailed and the requester was left
    // from 5 people on a grant and from 12 on an assignment.
    for (const [action, firstSend, mailed, total] of [["grant_retry", 20, 4, 37], ["assign", 13, 11, 37]] as const) {
      console.log(`\nPOST /api/tickets/[id]/act, "${action}": a ticket naming ${N} learners`);
      seed({ attempts: action === "grant_retry", ticket: ticketRow(action === "grant_retry" ? "grant_retry" : "assign_content", LEARNERS) });
      const r = await actOn(action === "grant_retry" ? { action, expires_in_days: 30 } : { action });
      const done = action === "grant_retry"
        ? world.tables.attempt_requests.filter((x) => x.status === "approved").length
        : world.tables.course_assignments.filter((x) => x.assignee_type === "user").length;
      eq(`200, all ${N} ${action === "grant_retry" ? "granted" : "assigned"}, the ticket closed with its outcome (closed true), its thread message written`,
        [r.status, done, r.body.closed, closed(), world.tables.help_ticket_messages.length],
        [200, N, true, [["closed", action === "grant_retry" ? "granted" : "assigned"]], 1]);
      eq(`the whole request, with the middleware's call: ${total} calls, within 40`, [calls.length + MIDDLEWARE_CALLS, calls.length + MIDDLEWARE_CALLS <= 40], [total, true]);
      eq("…one run: the organisation's mail state read once", runsOpened(), 1);
      eq(`…${firstSend} calls before the first send, as counted`, beforeFirstSend(), firstSend);
      eq(`the learners: ${mailed} emailed, ${N - mailed} reported as not emailed`, [learnerSends(), ...counts(r.body.email)], [mailed, mailed, N - mailed, 0, null]);
      eq("the requester emailed, in the same run", [requesterSends(), ...counts(r.body.requester_email)], [1, 1, 0, 0, null]);
      eq("…the request's last calls are the requester's send and its log row", tail(2), ["send to manager@tenant.stub", "POST notification_log"]);
    }

    for (const action of ["grant_retry", "assign"] as const) {
      const all = EVERYBODY_UP_TO[action];
      console.log(`\nPOST /api/tickets/[id]/act, "${action}": the edges, ${all} and ${all + 1} people`);
      const a = await actFor(action, LEARNERS.slice(0, all));
      eq(`${all} people: every learner emailed, and the requester, within 40`,
        [a.status, a.learners, a.email, a.requesterSent, a.requester, a.total <= 40], [200, all, [all, 0, 0, null], 1, [1, 0, 0, null], true]);
      const b = await actFor(action, LEARNERS.slice(0, all + 1));
      eq(`${all + 1} people: the requester emailed, exactly one learner left (not emailed), within 40`,
        [b.status, b.learners, b.email, b.requesterSent, b.requester, b.total <= 40], [200, all, [all, 1, 0, null], 1, [1, 0, 0, null], true]);
    }

    // Every size a ticket can name (MAX_TICKET_PEOPLE), on both actions.
    for (const action of ["grant_retry", "assign"] as const) {
      console.log(`\nPOST /api/tickets/[id]/act, "${action}": every size from 1 to ${MAX_TICKET_PEOPLE} people`);
      const requesterNotEmailed: number[] = [];
      const past40: number[] = [];
      const unbalanced: number[] = [];
      const notEverybody: number[] = [];
      const measured: string[] = [];
      for (let n = 1; n <= MAX_TICKET_PEOPLE; n++) {
        const a = await actFor(action, LEARNERS.slice(0, n));
        const [emailed, notEmailed, notConfirmed] = a.email as number[];
        if (a.status !== 200 || a.requesterSent !== 1 || JSON.stringify(a.requester) !== JSON.stringify([1, 0, 0, null])) requesterNotEmailed.push(n);
        if (a.total > 40) past40.push(n);
        if (emailed + notEmailed + notConfirmed !== n || a.learners !== emailed) unbalanced.push(n);
        if (n <= EVERYBODY_UP_TO[action] && emailed !== n) notEverybody.push(n);
        measured.push(`${n}:${emailed}/${a.total}`);
      }
      console.log(`  (size:learners emailed/calls) ${measured.join(" ")}`);
      eq("at every size the requester is emailed", requesterNotEmailed, []);
      eq("…every request within 40, with the middleware's call", past40, []);
      eq("…the learners emailed and not emailed add up to the learners the action mails, and each emailed one had a send", unbalanced, []);
      eq(`…up to ${EVERYBODY_UP_TO[action]} people every learner is emailed`, notEverybody, []);
    }

    // The answer `left: 1` keeps its cases now that a large ticket no longer
    // gives it: a request with no room left for the requester's mail, by its
    // count or by its clock. A decline, so no learner is mailed and no row
    // can come from anyone else.
    {
      const { actOnTicket } = await import("../../lib/tickets/actions");
      const requesterReads = () => calls.filter((c) => (c.table === "organization_members" || c.table === "profiles") && c.query.includes(MANAGER)).length;
      const budgets = [
        ["by the count: 30 calls spent before the action", () => requestBudget({ spent: 30 })],
        [`by the clock: past its ${REQUEST_SEND_WINDOW_MS / 1000} seconds`, () => {
          let t = 0;
          const b = requestBudget({ spent: MIDDLEWARE_CALLS, now: () => t });
          t = REQUEST_SEND_WINDOW_MS + 1;
          return b;
        }],
      ] as const;
      for (const [label, budget] of budgets) {
        console.log(`\nactOnTicket, "decline": no room for the requester's mail, ${label}`);
        seed({ ticket: ticketRow("grant_retry", LEARNERS.slice(0, 3)) });
        const out = await actOnTicket(svc, {
          ticket: { ...world.tables.help_tickets[0] } as unknown as TicketRow, admin: { id: ADMIN },
          org: { id: ORG, name: "Tenant A", slug: "tenant-a" }, origin: "http://lms.test", action: "decline", note: "Not this quarter",
          budget: budget(),
        });
        if ("error" in out) throw new Error(out.error);
        eq("the ticket closed with its outcome and its thread message", [closed(), world.tables.help_ticket_messages.length], [[["closed", "declined"]], 1]);
        eq("…the requester's mail left: emailed 0, not emailed 1, `left` 1", counts(out.requester_email), [0, 1, 0, 1]);
        eq("…no read of the requester, no send to them, no notification_log row: the last call is the thread message",
          [requesterReads(), requesterSends(), world.log.length, last()], [0, 0, 0, "POST help_ticket_messages"]);
      }
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
      eq("200, declined (closed true), nobody named is mailed, the requester emailed in the request's one run",
        [r.status, r.body.closed, closed(), learnerSends(), requesterSends(), counts(r.body.requester_email), runsOpened()],
        [200, true, [["closed", "declined"]], 0, 1, [1, 0, 0, null], 1]);
      eq(`…${calls.length + MIDDLEWARE_CALLS} calls with the middleware's, within 40`, calls.length + MIDDLEWARE_CALLS <= 40, true);
    }

    /** A date-only due date 30 days on. */
    const dueIn30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const tableOf = (action: "grant_retry" | "assign") => (action === "grant_retry" ? "attempt_requests" : "course_assignments");
    /**
     * A ticket naming `people`, acted on end to end, with `arrange` setting a
     * case's switches after the seed: the answer, the learners whose row is
     * there after it, the two mail outcomes, the sends, and the whole
     * request's calls with the middleware's.
     */
    const actWith = async (action: "grant_retry" | "assign", people: string[], arrange: () => void, dueAt?: string) => {
      seed({ attempts: action === "grant_retry", ticket: ticketRow(action === "grant_retry" ? "grant_retry" : "assign_content", people) });
      arrange();
      const r = await actOn(action === "grant_retry" ? { action, expires_in_days: 30 } : { action, ...(dueAt ? { dueAt } : {}) });
      const rows = action === "grant_retry"
        ? world.tables.attempt_requests.filter((x) => x.status === "approved" && x.decided_by === ADMIN).map((x) => String(x.user_id))
        : world.tables.course_assignments.filter((x) => x.assignee_type === "user" && x.assigned_by === ADMIN).map((x) => String(x.user_id));
      return {
        status: r.status, results: (r.body.results as Row[] | undefined) ?? [], rows, body: r.body, closed: r.body.closed ?? null,
        email: counts(r.body.email), requester: counts(r.body.requester_email),
        learners: learnerSends(), requesterSent: requesterSends(), total: calls.length + MIDDLEWARE_CALLS,
      };
    };
    /**
     * The same ticket pressed again, in the same world: the calls counted
     * afresh and the case's switches cleared (a new request). The answer,
     * the sends and the calls of this press alone.
     */
    const pressAgain = async (body: Row) => {
      calls = [];
      beforeWrite = null;
      loseReply = null;
      failRead = null;
      refuse = null;
      dropWrite = null;
      const r = await actOn(body);
      return {
        status: r.status, body: r.body, results: (r.body.results as Row[] | undefined) ?? [], closed: r.body.closed ?? null,
        learners: learnerSends(), requesterSent: requesterSends(), requester: counts(r.body.requester_email), total: calls.length + MIDDLEWARE_CALLS,
      };
    };
    /** The keys held by more than one row of `table` (a person with two open grants, or two direct assignments of the course). */
    const heldTwice = (table: string) => {
      const keys = (world.tables[table] ?? []).map(UNIQUE[table]).filter((k): k is string => k !== null);
      return [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    };
    /** The first insert into `table` is saved, and its answer lost. */
    const loseFirstInsertInto = (table: string) => {
      let done = false;
      loseReply = (c) => {
        if (done || c.method !== "POST" || c.table !== table) return false;
        done = true;
        return true;
      };
    };
    const NOT_SAVED = "not saved: the request had no room left; try again";

    // A batch insert saved whose answer is lost: the connection dropped after
    // the request was sent, and supabase-js answers code "". Before, its rows
    // were inserted again one at a time; each met its own row (23505), so
    // every learner read as failed or already assigned and nobody was
    // emailed: a grant answered 409 with every grant saved, and an
    // assignment with a due date closed the ticket as assigned while nobody
    // was told. The rows are now read back (one call per 150 learners), and
    // each found is the request's own: granted or assigned, and emailed as
    // the budget allows.
    for (const action of ["grant_retry", "assign"] as const) {
      const table = tableOf(action);
      const done = action === "grant_retry" ? "granted" : "assigned";
      const measured: string[] = [];
      for (const n of [1, 3, MAX_TICKET_PEOPLE]) {
        console.log(`\nPOST /api/tickets/[id]/act, "${action}"${action === "assign" ? " with a due date" : ""}: a ticket naming ${n}, its insert saved and its answer lost`);
        const people = LEARNERS.slice(0, n);
        const a = await actWith(action, people, () => loseFirstInsertInto(table), dueIn30);
        const postAt = calls.findIndex((c) => c.method === "POST" && c.table === table);
        eq(`200, the ticket closed as ${done} with its thread message; all ${n} ${done}, each row written once, no insert tried again`,
          [a.status, closed(), world.tables.help_ticket_messages.length, a.results.filter((x) => x.status === done).length, [...a.rows].sort(), insertsInto(table).length],
          [200, [["closed", done]], 1, n, [...people].sort(), 1]);
        eq("…its rows read back in one call", calls.slice(postAt + 1).filter((c) => c.method === "GET" && c.table === table).length, 1);
        const [emailed, notEmailed, notConfirmed] = a.email as number[];
        eq("…the learners emailed as the budget allows, the rest not emailed; the requester emailed; within 40",
          [emailed >= 1, emailed + notEmailed + notConfirmed, a.learners, a.requesterSent, a.requester, a.total <= 40],
          [true, n, emailed, 1, [1, 0, 0, null], true]);
        if (n <= 3) eq(`…a ticket of ${n}: every learner emailed`, emailed, n);
        measured.push(`${n}:${emailed}/${a.total}`);
      }
      console.log(`  (size:learners emailed/calls) ${measured.join(" ")}`);
    }

    // The read-back itself fails: each learner is "not confirmed", neither
    // granted or assigned nor "not saved", nobody is emailed, and nothing is
    // inserted again. The ticket stays open (nobody was confirmed).
    for (const action of ["grant_retry", "assign"] as const) {
      const table = tableOf(action);
      console.log(`\nPOST /api/tickets/[id]/act, "${action}": a ticket naming 3, its insert's answer lost and its read-back failed`);
      const a = await actWith(action, LEARNERS.slice(0, 3), () => {
        loseFirstInsertInto(table);
        failRead = (c) => c.table === table && calls.some((x) => x.method === "POST" && x.table === table);
      }, dueIn30);
      eq("409, the ticket still open; each of the 3 not confirmed; nobody emailed; no insert tried again",
        [a.status, closed(), a.results.length === 0 || a.results.every((x) => String(x.reason ?? "").startsWith("not confirmed")), a.learners, insertsInto(table).length],
        [409, [["open", null]], true, 0, 1]);
      // ADR 0029, note of 2026-11-25, part 2, point 4: the rows had been
      // saved after all, so a second press finds everybody served. It
      // answers today's 409 with "already" as its reason, writes nothing and
      // leaves the ticket open; "Mark resolved" closes it. (The assignment is
      // pressed without a date: a date written counts as served, and the
      // ticket would close as assigned.)
      const b = await pressAgain(action === "grant_retry" ? { action, expires_in_days: 30 } : { action });
      eq("…pressed again, everybody served: 409 reading \"already\", no insert, nobody emailed, the ticket still open",
        [b.status, String(b.body.error ?? "").includes(action === "grant_retry" ? "already has an open request or grant" : "already assigned"), insertsInto(table).length, b.learners, b.requesterSent, closed(), heldTwice(table)],
        [409, true, 0, 0, 0, [["open", null]], []]);
      const c = await pressAgain({ action: "resolve" });
      eq("…\"Mark resolved\" closes it: 200, closed true, the outcome resolved, the requester emailed",
        [c.status, c.closed, closed(), c.requesterSent], [200, true, [["closed", "resolved"]], 1]);
    }

    // A batch refused with 23505: another request wrote one of its rows
    // after this one read them. Its rows are inserted one at a time, each
    // asking the budget for room first, and the rows the request has no room
    // left for are not tried and answered as not saved ("try again"). The
    // mail's reads and the run's opening are made only while they fit.
    // Before, all 50 were tried one at a time, past 40 and past the
    // platform's 50. Those rows are marked to try again, so the ticket stays
    // open, and a second press of the same action finishes the rest and
    // closes it (ADR 0029, note of 2026-11-25, part 2).
    for (const [action, dueAt] of [["grant_retry", undefined], ["assign", undefined], ["assign", dueIn30]] as const) {
      const table = tableOf(action);
      const people = LEARNERS.slice(0, MAX_TICKET_PEOPLE);
      const raced = people[6];
      console.log(`\nPOST /api/tickets/[id]/act, "${action}"${dueAt ? " with a due date" : ""}: a ticket naming ${people.length}, its insert refused with 23505`);
      const a = await actWith(action, people, () => {
        let done = false;
        beforeWrite = (c) => {
          if (done || c.table !== table || !Array.isArray(c.body)) return;
          done = true;
          world.tables[table].push(action === "grant_retry"
            ? { organization_id: ORG, course_id: COURSE, user_id: raced, status: "pending", used_at: null, decided_by: null, decided_at: null, expires_at: null }
            : { organization_id: ORG, course_id: COURSE, assignee_type: "user", user_id: raced, team_id: null, due_at: null, release_at: null, assigned_by: MANAGER });
        };
      }, dueAt);
      const untried = a.results.filter((x) => x.reason === NOT_SAVED).map((x) => String(x.userId));
      const done = a.results.filter((x) => x.status === (action === "grant_retry" ? "granted" : "assigned")).map((x) => String(x.userId));
      const racedOutcome = a.results.find((x) => x.userId === raced);
      console.log(`  (tried one at a time, raced one included: ${people.length - untried.length}; calls ${a.total})`);
      eq("200, the whole request within 40", [a.status, a.total <= 40], [200, true]);
      // What the room left: the row-by-row inserts use it up, so the
      // learners' mail is not read or opened. The rows not tried are marked
      // to try again, so the ticket stays open: in_progress with no outcome
      // and no closing time, one thread message (its two calls were held),
      // and the requester neither read nor mailed: the last call is the
      // thread message.
      eq("…measured: no learner emailed (each saved one reported as not emailed); closed false, no outcome, no requester_email; the ticket in_progress, no closing time; one thread message; the requester not mailed",
        [a.email, a.learners, a.closed, a.body.outcome, a.body.requester_email, closed(), world.tables.help_tickets[0].closed_at, world.tables.help_ticket_messages.length, a.requesterSent, last()],
        [[0, a.rows.length, 0, null], 0, false, null, null, [["in_progress", null]], null, 1, 0, "POST help_ticket_messages"]);
      eq("…the answer's summary says how many are left and that the ticket stays open",
        String(a.body.summary ?? "").includes(`${a.results.filter((x) => x.retry === true).length} left to try again: the ticket stays open`), true);
      eq("…the rows not tried answered as not saved, \"try again\", and none of them written",
        [untried.length > 0, untried.some((u) => a.rows.includes(u))], [true, false]);
      eq("…each row tried and saved is written, and each written row was tried; the raced one is answered as already there",
        [[...done].sort(), [...a.rows].sort(), racedOutcome?.status], [[...a.rows].sort(), [...done].sort(), action === "grant_retry" ? "failed" : "already"]);
      eq("…every learner has one outcome", done.length + untried.length + 1, people.length);
      // ADR 0029, note of 2026-11-25, part 2, point 6: a row that another
      // press of the same action finishes carries the mark; no other row does.
      eq("…each row not saved for room carries retry: true, and no other row does",
        [a.results.filter((x) => x.retry === true).map((x) => String(x.userId)).sort(), [...untried].sort()].map((l) => l.join(",")),
        [[...untried].sort().join(","), [...untried].sort().join(",")]);

      // The second press (part 2, point 3): everything read again. The
      // people served the first time, and the raced one, read "already" and
      // are not written twice; the rest are written in one insert; the
      // ticket closes with its outcome and the requester is mailed.
      const b = await pressAgain(action === "grant_retry" ? { action, expires_in_days: 30 } : { action, ...(dueAt ? { dueAt } : {}) });
      const word = action === "grant_retry" ? "granted" : "assigned";
      const servedNow = b.results.filter((x) => x.status === word).map((x) => String(x.userId)).sort();
      const servedBefore = [...a.rows, raced];
      console.log(`  (second press: ${servedNow.length} ${word}, ${b.learners} learners emailed; calls ${b.total})`);
      eq("…pressed again: 200, closed true, the ticket closed with its outcome, a second thread message, the requester emailed in the same run, within 40",
        [b.status, b.closed, b.body.outcome, closed(), world.tables.help_ticket_messages.length, b.requesterSent, b.requester, b.total <= 40],
        [200, true, word, [["closed", word]], 2, 1, [1, 0, 0, null], true]);
      eq("…one insert, of exactly the people left to try again; nobody left marked to try again",
        [insertsInto(table).length, rowsOf(insertsInto(table)).map((r) => String(r.user_id)).sort(), servedNow, b.results.filter((x) => x.retry === true).length],
        [1, [...untried].sort(), [...untried].sort(), 0]);
      eq("…each person served before, and the raced one, reads \"already\" and is not written again",
        servedBefore.every((u) => /already/.test(String(b.results.find((x) => x.userId === u)?.reason ?? ""))), true);
      eq("…every person named holds exactly one row, and nobody holds two",
        [people.every((u) => (world.tables[table] ?? []).filter((r) => UNIQUE[table](r) !== null && r.user_id === u && r.course_id === COURSE).length === 1), heldTwice(table)], [true, []]);
      eq("…the learners served now mailed within the room (each counted, emailed or not)",
        [b.learners >= 1, (b.body.email as Row | undefined)?.emailed === b.learners], [true, true]);
    }

    // Case E (ADR 0029, note of 2026-11-25, part 2): a grant for 50 whose
    // batch is refused for one row leaves people marked to try again, and
    // the ticket stays open. Red on 10f13cd: the ticket closed as granted.
    {
      console.log("\n[E] POST /api/tickets/[id]/act, grant_retry for 50, the batch refused for one row (23505): the ticket stays open");
      const people = LEARNERS.slice(0, MAX_TICKET_PEOPLE);
      const a = await actWith("grant_retry", people, () => {
        let done = false;
        beforeWrite = (c) => {
          if (done || c.table !== "attempt_requests" || !Array.isArray(c.body)) return;
          done = true;
          world.tables.attempt_requests.push({ organization_id: ORG, course_id: COURSE, user_id: people[6], status: "pending", used_at: null, decided_by: null, decided_at: null, expires_at: null });
        };
      });
      const t = world.tables.help_tickets[0];
      eq("[E] 200, closed false, status in_progress, outcome null, closed_at null, one thread message, no requester send, within 40",
        [a.status, a.closed, t.status, t.outcome, t.closed_at, world.tables.help_ticket_messages.length, a.requesterSent, a.total <= 40],
        [200, false, "in_progress", null, null, 1, 0, true]);
    }

    // ADR 0029, note of 2026-11-25, part 3: the writes of a grant and of an
    // assignment to named learners, called directly (as a ticket's action
    // calls them), five learners each unless said.
    //   Row 2: a row-by-row pass stops once three rows tried alone were each
    //   refused with the batch's own code, none was saved, and that code is
    //   not 23505; the rest are answered with that refusal, with no call and
    //   no mark for another press. A refusal one row causes saves the others;
    //   duplicates (23505) are each tried.
    //   Row 6: a lost reply whose read-back finds nothing is "not confirmed",
    //   marked `retry`, and nobody is mailed for it.
    //   Row 7: the assignment's read-back takes a row for the request's own
    //   only when the first read of the rows already there answered and the
    //   row's assigned_by is the request's; any other row found is a
    //   duplicate (its new date, the conversion of a self-enrolment, no
    //   "assigned" mail).
    {
      const five = LEARNERS.slice(0, 5);
      const callGrant = (people: string[]) => grant.grantExtraAttempts(svc, {
        orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "http://lms.test", decidedBy: ADMIN,
        source: "ticket", courseId: COURSE, userIds: people, expiresInDays: 30,
      });
      const callAssign = (people: string[], dueAt: string | null = null) => direct.assignCourseDirect(svc, {
        orgId: ORG, orgName: "Tenant A", orgSlug: "tenant-a", origin: "http://lms.test", assignedBy: ADMIN,
        courseId: COURSE, userIds: people, dueAt,
      });
      type Out = { results: Array<{ userId: string; status: string; reason?: string; retry?: true }> };
      const resultsOf = (out: unknown) => {
        if (out && typeof out === "object" && "error" in out) throw new Error(String((out as { error: unknown }).error));
        return (out as Out).results;
      };
      const marked = (rs: Out["results"]) => rs.filter((r) => r.retry === true).map((r) => r.userId);
      const tryAgain = (rs: Out["results"]) => rs.filter((r) => /try again/.test(r.reason ?? "")).map((r) => r.userId);
      const FK = { code: "23503", message: "insert or update violates foreign key constraint" };

      for (const action of ["grant_retry", "assign"] as const) {
        const table = tableOf(action);
        const run = (people: string[]) => (action === "grant_retry" ? callGrant(people) : callAssign(people));
        const done = action === "grant_retry" ? "granted" : "assigned";

        console.log(`\n${action === "grant_retry" ? "grantExtraAttempts" : "assignCourseDirect"}: a refusal every row shares (23503), five learners`);
        seed({ attempts: action === "grant_retry" });
        refuse = () => FK;
        let rs = resultsOf(await run(five));
        eq("the batch and exactly three rows tried alone; nobody saved, nobody reads \"try again\", nobody carries retry",
          [insertsInto(table).length, rowsOf(insertsInto(table)).length, rs.filter((r) => r.status === done).length, tryAgain(rs), marked(rs), rs.every((r) => r.status === "failed")],
          [4, 5 + 3, 0, [], [], true]);
        eq("…the two not tried answered with the refusal", rs.slice(3).map((r) => r.reason), action === "grant_retry" ? ["the grant could not be saved", "the grant could not be saved"] : [FK.message, FK.message]);

        console.log(`\n${action === "grant_retry" ? "grantExtraAttempts" : "assignCourseDirect"}: a refusal one row causes (23502, the first learner), five learners`);
        seed({ attempts: action === "grant_retry" });
        refuse = (_c, rows) => (rows.some((r) => r.user_id === five[0]) ? { code: "23502", message: "null value violates not-null constraint" } : null);
        rs = resultsOf(await run(five));
        eq("the batch and each of the five alone; the other four saved, the first failed, nobody marked",
          [insertsInto(table).length, rs.map((r) => r.status), marked(rs)],
          [6, ["failed", done, done, done, done], []]);

        console.log(`\n${action === "grant_retry" ? "grantExtraAttempts" : "assignCourseDirect"}: four of five rows written by another request just before the insert (23505)`);
        seed({ attempts: action === "grant_retry" });
        let raced = false;
        beforeWrite = (c) => {
          if (raced || c.table !== table || !Array.isArray(c.body)) return;
          raced = true;
          for (const u of five.slice(0, 4)) {
            world.tables[table].push(action === "grant_retry"
              ? { organization_id: ORG, course_id: COURSE, user_id: u, status: "pending", used_at: null, decided_by: null, decided_at: null, expires_at: null }
              : { organization_id: ORG, course_id: COURSE, assignee_type: "user", user_id: u, team_id: null, due_at: null, release_at: null, assigned_by: MANAGER });
          }
        };
        rs = resultsOf(await run(five));
        eq("the batch and each of the five alone (duplicates are never bounded); the fifth saved, the four already there",
          [insertsInto(table).length, rs.map((r) => r.status), marked(rs)],
          [6, action === "grant_retry" ? ["failed", "failed", "failed", "failed", done] : ["already", "already", "already", "already", done], []]);

        console.log(`\n${action === "grant_retry" ? "grantExtraAttempts" : "assignCourseDirect"}: the insert's reply lost and nothing saved (the read-back finds nothing), three learners`);
        seed({ attempts: action === "grant_retry" });
        dropWrite = (c) => c.table === table;
        const sendsBefore = learnerSends();
        rs = resultsOf(await run(LEARNERS.slice(0, 3)));
        const words = action === "grant_retry" ? "not confirmed: the grant may have been saved; try again" : "not confirmed: the assignment may have been saved; try again";
        eq("each learner \"not confirmed\", marked retry; nobody mailed; one insert, no row written",
          [rs.map((r) => [r.status, r.reason, r.retry ?? null]), learnerSends() - sendsBefore, insertsInto(table).length, world.tables[table].length],
          [LEARNERS.slice(0, 3).map(() => ["failed", words, true]), 0, 1, 0]);
      }

      const dueIn30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const rowOf = (u: string) => world.tables.course_assignments.find((r) => r.assignee_type === "user" && r.user_id === u);
      const three = LEARNERS.slice(0, 3);

      console.log("\nassignCourseDirect with a due date: the reply lost, and the read-back finds the first learner's row written by another (their self-enrolment)");
      seed();
      dropWrite = (c) => c.table === "course_assignments";
      beforeWrite = (c) => {
        if (c.table !== "course_assignments" || rowOf(three[0])) return;
        world.tables.course_assignments.push({ id: "0e900000-0000-4000-8000-000000000001", organization_id: ORG, course_id: COURSE, assignee_type: "user", user_id: three[0], team_id: null, due_at: null, release_at: null, assigned_by: three[0], source: "self" });
      };
      let rs = resultsOf(await callAssign(three, dueIn30));
      eq("the first is a duplicate: its date written, the self row converted, no \"assigned\" mail; the other two not confirmed, marked retry",
        [rs.map((r) => [r.status, r.reason ?? null, r.retry ?? null]), rowOf(three[0])?.due_at !== null, rowOf(three[0])?.source, rowOf(three[0])?.assigned_by, learnerSends()],
        [[["assigned", "self-enrolment converted to an assignment", null],
          ["failed", "not confirmed: the assignment may have been saved; try again", true],
          ["failed", "not confirmed: the assignment may have been saved; try again", true]], true, "admin", ADMIN, 0]);

      console.log("\nassignCourseDirect: the reply lost, the rows saved with the request's own id, after a first read that answered");
      seed();
      loseFirstInsertInto("course_assignments");
      rs = resultsOf(await callAssign(three));
      eq("each assigned and mailed", [rs.map((r) => [r.status, r.retry ?? null]), learnerSends()], [three.map(() => ["assigned", null]), 3]);

      console.log("\nassignCourseDirect with a due date: the reply lost, the rows saved with the request's own id, after a first read that FAILED");
      seed();
      loseFirstInsertInto("course_assignments");
      failRead = (c) => c.table === "course_assignments" && !calls.some((x) => x.method === "POST" && x.table === "course_assignments");
      rs = resultsOf(await callAssign(three, dueIn30));
      eq("each a duplicate: \"already assigned — due date updated\", the date written, no \"assigned\" mail",
        [rs.map((r) => [r.status, r.reason ?? null, r.retry ?? null]), three.map((u) => rowOf(u)?.due_at !== null), calls.filter((c) => c.method === "PATCH" && c.table === "course_assignments").length > 0, learnerSends()],
        [three.map(() => ["already", "already assigned — due date updated", null]), [true, true, true], true, 0]);
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

    // A learner's request for another attempt (POST /api/attempt-requests)
    // and a manager's ticket (POST /api/tickets) each mail the organisation's
    // administrators in one run (notifyAdminsOfRequest, notifyAdminsOfTicket).
    // Their budgets assumed 8 calls before the run, where the requests had
    // made more. Measured before, over this stub, with 25 administrators and
    // the middleware's call: the learner's request 44 calls, 19
    // administrators emailed, its first send sized at a count of 11 where 18
    // calls had been made; the ticket 40 calls, 19 emailed (14 made, 11
    // counted), and 41 calls with 19 emailed for an organisation of over
    // 1,000 members. Each now counts from the request's first call (the
    // middleware's), each call where it is made, every page included, so
    // the whole request stays within the 40 of rule FP2 and the
    // administrators it has no room for are left (the run's tail kept: 4
    // calls a group).
    const adminSends = () => sendsTo((to) => to.startsWith("admin-"));
    {
      console.log("\nPOST /api/attempt-requests: a learner asks for another attempt; 25 administrators");
      const requestRoute = await import("../../app/api/attempt-requests/route");
      seedAdmins();
      const res = await requestRoute.POST(new Request("http://lms.test/api/attempt-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgSlug: "tenant-a", courseId: COURSE, reason: "One more, please" }) }));
      const body = (await res.json()) as Row;
      eq("200, the request saved, the administrators' mail in one run", [res.status, body.ok, world.tables.attempt_requests.map((x) => [x.user_id, x.status]), runsOpened()], [200, true, [[ADMIN, "pending"]], 1]);
      // The session, the membership 2, the course, its versions, the
      // attempts, the grants, the policy, the insert, attempts_used, the
      // name, the administrators that count 2, their addresses, the run's
      // opening 3: 17 before the first send.
      eq("the whole request, with the middleware's call: 36 calls, within 40 (44 before)", [calls.length + MIDDLEWARE_CALLS, calls.length + MIDDLEWARE_CALLS <= 40], [36, true]);
      eq("…17 calls before the first send; 13 of the 25 administrators emailed, the rest left (19 before)", [beforeFirstSend(), adminSends()], [17, 13]);
    }
    const raiseTicket = async () => {
      const ticketsRoute = await import("../../app/api/tickets/route");
      const res = await ticketsRoute.POST(new Request("http://lms.test/api/tickets", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug: "tenant-a", category: "grant_retry", context: { userIds: LEARNERS.slice(0, MAX_TICKET_PEOPLE), contentKind: "course", contentId: COURSE } }),
      }));
      return { status: res.status, body: (await res.json()) as Row };
    };
    for (const [label, others, total, first, mailed, before] of [
      ["", 0, 37, 13, 17, "40 calls, 19 emailed"],
      [", in an organisation of over 1,000 members (the hierarchy read in two pages)", 1_000, 37, 14, 16, "41 calls, 19 emailed"],
    ] as const) {
      console.log(`\nPOST /api/tickets: a manager raises a ticket naming ${MAX_TICKET_PEOPLE} people; 25 administrators${label}`);
      seedAdmins(others);
      const r = await raiseTicket();
      eq("200, the ticket saved, the administrators' mail in one run",
        [r.status, typeof r.body.subject, world.tables.help_tickets.map((x) => [x.user_id, x.source, x.category]), runsOpened()], [200, "string", [[ADMIN, "manager", "grant_retry"]], 1]);
      // The session, the membership 2, the hierarchy (a call a page), the
      // course, the names, the insert, the manager's own name, the
      // administrators, their addresses, the run's opening 3.
      eq(`the whole request, with the middleware's call: ${total} calls, within 40 (before: ${before})`, [calls.length + MIDDLEWARE_CALLS, calls.length + MIDDLEWARE_CALLS <= 40], [total, true]);
      eq(`…${first} calls before the first send; ${mailed} of the 25 administrators emailed, the rest left`, [beforeFirstSend(), adminSends()], [first, mailed]);
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
