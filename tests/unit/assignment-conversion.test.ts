/**
 * Unit tests for the conversion of a self-enrolment (ADR 0024 step 24, P2-6
 * item 2). The launch page records a Start on an "Everyone" course or path as
 * the learner's own `user` row with source = 'self'; an admin who later
 * assigns that learner converts it (source 'admin', assigned_by the admin,
 * the admin's dates). The three sites, each the real code under a stubbed
 * fetch (result-stored-route.test.ts's form; next/headers answers with one
 * session cookie):
 *
 *   - POST /api/assignments (app/api/assignments/route.ts);
 *   - assignCourseDirect (lib/assignments/direct.ts: the admin API and a
 *     manager's ticket), and convertSelfEnrolments itself;
 *   - POST /api/learning-path-assignments.
 *
 * For each: with the column, a self row is converted by one update that names
 * source = 'self' (so an admin row is never touched, and an undated
 * re-assign writes no date); without it (PGRST204 from the payload or 42703
 * from the filter), today's request sequence and answer plus the one refused
 * update, never an error; any other error is not swallowed; a team, org or
 * group row that already exists is never a conversion candidate.
 *
 * Also ADR 0030 rule 10 at POST /api/assignments: a learner whose row does
 * not count is assigned but not emailed, and an org-wide row emails the
 * active members only.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/assignment-conversion.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import { createClient } from "@supabase/supabase-js";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; table: string; query: string; body: unknown; apikey: string | null };

const SUPABASE = "http://stub.supabase.test";
const ANON = "stub-anon-key";
const SERVICE = "stub-service-role-key";
const USER = { id: "u-admin", aud: "authenticated", role: "authenticated", email: "admin@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const ORG = "org-1";
const COURSE = "c-course";
const PATH = "p-path";
const DUE = "2099-01-31T00:00:00.000Z";
const RELEASE = "2099-01-01T00:00:00.000Z";

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

/**
 * The database as the stub answers it.
 *   rows: the `user` rows already there, by user id, with their source
 *         ('self' or 'admin'); a POST naming one answers 23505.
 *   dupNonUser: a team, org or group row is already there too.
 *   conversion: how the update naming source = 'self' answers.
 *   unseen: learners whose row is there but written after the read of the
 *         rows already there (a race): the read misses them, the insert
 *         meets their 23505.
 *   badInsert: a learner whose insert fails with another error (23503).
 */
type World = {
  rows: Record<string, "self" | "admin">;
  dupNonUser: boolean;
  conversion: "ok" | "PGRST204" | "42703" | "42501";
  unseen: string[];
  badInsert: string | null;
};
const base = (): World => ({ rows: {}, dupNonUser: false, conversion: "ok", unseen: [], badInsert: null });
let world: World = base();
let requests: Req[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const DUP = { code: "23505", message: "duplicate key value violates unique constraint", details: null, hint: null };
const FK = { code: "23503", message: "insert or update violates foreign key constraint", details: null, hint: null };
const conversionError = (table: string) => ({
  PGRST204: [400, { code: "PGRST204", message: `Could not find the 'source' column of '${table}' in the schema cache`, details: null, hint: null }],
  "42703": [400, { code: "42703", message: `column ${table}.source does not exist`, details: null, hint: null }],
  "42501": [403, { code: "42501", message: `permission denied for table ${table}`, details: null, hint: null }],
} as Record<string, [number, unknown]>);

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const p = url.pathname;
  const table = p.replace("/rest/v1/", "");
  const query = decodeURIComponent(url.search);
  requests.push({ method, table, query, body, apikey: headers.get("apikey") });
  if (p === "/auth/v1/user") return json(USER);
  if (table === "organizations") return json([{ id: ORG, name: "Org", slug: "org", deleted_at: null }]);
  if (table === "organization_members" && method === "GET") {
    const sel = url.searchParams.get("select") ?? "";
    // The caller's own row, read by lib/auth/org-membership.ts (role and status).
    if (sel === "role,status") return json([{ role: "admin", status: "active" }]);
    // The org's members that count, read by countingMemberIds for the mail
    // (ADR 0030 rule 10): every learner here is an active member but u-gone,
    // whose row is inactive (the assignee check above still finds it).
    if (sel === "user_id,role,status") {
      return json(["u-adm", "u-new", "u-self"].map((user_id) => ({ user_id, role: "user", status: "active" })));
    }
    const inList = /user_id=in\.\(([^)]*)\)/.exec(query)?.[1] ?? "";
    return json(inList.split(",").filter(Boolean).map((u) => ({ user_id: u, business_vertical: null, department: null })));
  }
  if (table === "courses") return json([{ id: COURSE, organization_id: ORG, title: "Course K", is_active: true }]);
  // The path belongs to the org (the route checks it before any write).
  if (table === "learning_paths") return json([{ id: PATH, organization_id: ORG, name: "Path P" }]);
  if (table === "teams") return json([{ id: "t-1" }]);
  if (table === "content_scopes") return json([]);
  // The routes' read of the rows already there (writeAssignmentRows in
  // lib/assignments/direct.ts): one read per assignee type, as the server
  // answers it from the rows above.
  if ((table === "course_assignments" || table === "learning_path_assignments") && method === "GET") {
    const type = /assignee_type=eq\.(\w+)/.exec(query)?.[1];
    const listed = (col: string) => (new RegExp(`${col}=in\\.\\(([^)]*)\\)`).exec(query)?.[1] ?? "").split(",").filter(Boolean);
    if (type === "user") return json(listed("user_id").filter((u) => u in world.rows && !world.unseen.includes(u)).map((user_id) => ({ user_id })));
    if (!world.dupNonUser) return json([]);
    if (type === "team") return json(listed("team_id").map((team_id) => ({ team_id })));
    if (type === "group") return json(listed("group_id").map((group_id) => ({ group_id })));
    if (type === "org") return json([{ id: "row-org" }]);
    return json([]);
  }
  if ((table === "course_assignments" || table === "learning_path_assignments") && method === "POST") {
    // One row or several in one insert: a row already there fails the whole insert (23505).
    const list = (Array.isArray(body) ? body : [body]) as Row[];
    const dup = (row: Row) => (row.assignee_type === "user" ? (row.user_id as string) in world.rows : world.dupNonUser);
    if (list.some(dup)) return json(DUP, 409);
    if (world.badInsert && list.some((row) => row.user_id === world.badInsert)) return json(FK, 409);
    return json(list.map((row) => ({ id: `row-${String(row.user_id ?? row.team_id ?? row.assignee_type)}`, ...row })), 201);
  }
  if ((table === "course_assignments" || table === "learning_path_assignments") && method === "PATCH") {
    if (!query.includes("source=eq.self")) return json([{ id: "row-dated" }]);
    if (world.conversion !== "ok") {
      const [status, err] = conversionError(table)[world.conversion];
      return json(err, status);
    }
    const ids = (/user_id=in\.\(([^)]*)\)/.exec(query)?.[1] ?? "").split(",").filter(Boolean);
    return json(ids.filter((u) => world.rows[u] === "self").map((u) => ({ user_id: u })));
  }
  if (table === "profiles") {
    const inList = /id=in\.\(([^)]*)\)/.exec(query)?.[1] ?? "";
    return json(inList.split(",").filter(Boolean).map((id) => ({ id, email: `${id}@example.test`, first_name: null, last_name: null })));
  }
  // The notification path: paused, so each send is one log row and nothing leaves.
  if (table === "notification_settings") return json([{ email_paused: true, event_paused: {} }]);
  if (table === "notification_log") return json([], 201);
  return json([]);
};

const isConversion = (q: Req) => q.method === "PATCH" && q.query.includes("source=eq.self");
/**
 * Every write in order: an insert by its assignees (one insert may hold
 * several rows, ADR 0029 gate G3), a date update, or the conversion. A row
 * already there is found by the read before the insert, so it is never in
 * an insert.
 */
const writesOf = (rs: Req[], table: string) =>
  rs.filter((q) => q.table === table && q.method !== "GET").map((q) => {
    if (q.method === "POST") {
      const rows = (Array.isArray(q.body) ? q.body : [q.body]) as Row[];
      return `insert ${rows.map((b) => String(b.user_id ?? b.team_id ?? b.group_id ?? b.assignee_type)).join(",")}`;
    }
    return isConversion(q) ? "conversion" : `dates ${JSON.stringify(q.body)}`;
  });
/** The conversion's filters, read from its query string. */
const filtersOf = (q: Req) => q.query.replace(/^\?/, "").split("&").filter((f) => !f.startsWith("select=")).sort();
const emailedOf = (rs: Req[]) => rs.filter((q) => q.table === "profiles").map((q) => /id=in\.\(([^)]*)\)/.exec(q.query)?.[1] ?? "");

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const courseRoute = await import("../../app/api/assignments/route");
    const pathRoute = await import("../../app/api/learning-path-assignments/route");
    const direct = await import("../../lib/assignments/direct");
    const svc = createClient(SUPABASE, SERVICE, { auth: { persistSession: false } });

    const post = async (route: { POST: (r: Request) => Promise<Response> }, url: string, w: Partial<World>, body: Row) => {
      world = { ...base(), ...w };
      requests = [];
      const res = await route.POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgSlug: "org", ...body }) }));
      return { status: res.status, body: (await res.json()) as Row, rs: requests };
    };
    const course = (w: Partial<World>, body: Row) => post(courseRoute, "http://lms.test/api/assignments", w, { courseId: COURSE, ...body });
    const path = (w: Partial<World>, body: Row) => post(pathRoute, "http://lms.test/api/learning-path-assignments", w, { pathId: PATH, ...body });
    const CA = "course_assignments";
    const LPA = "learning_path_assignments";

    // ------------------------------------------------------------------
    console.log("\nPOST /api/assignments: with the column");
    {
      const r = await course({ rows: { "u-self": "self" } }, { userIds: ["u-self"] });
      eq("an undated assign of a self-enrolled learner: no insert (the row is read as there), one conversion and no date update", writesOf(r.rs, CA), ["conversion"]);
      const c = r.rs.find(isConversion)!;
      eq("…the conversion writes source 'admin' and the admin as assigned_by, nothing else", c.body, { source: "admin", assigned_by: USER.id });
      eq("…it names the course, the org, a user row, the learner and source = 'self'", filtersOf(c), [
        "assignee_type=eq.user", `course_id=eq.${COURSE}`, `organization_id=eq.${ORG}`, "source=eq.self", "user_id=in.(u-self)",
      ]);
      eq("…on the admin's own session (the RLS client)", c.apikey, ANON);
      eq("…200, no new row reported", [r.status, r.body.assigned], [200, 0]);
    }
    {
      const r = await course({ rows: { "u-self": "self" } }, { userIds: ["u-self"], dueAt: DUE, releaseAt: RELEASE });
      eq("a dated assign: today's date update first, then the conversion", writesOf(r.rs, CA), [
        `dates ${JSON.stringify({ due_at: DUE, release_at: RELEASE })}`, "conversion",
      ]);
      eq("…the conversion does not write the dates again", r.rs.find(isConversion)!.body, { source: "admin", assigned_by: USER.id });
      eq("…200, rescheduled as today", [r.status, r.body.rescheduled], [200, 1]);
    }
    {
      const r = await course({ rows: { "u-adm": "admin" } }, { userIds: ["u-adm"] });
      eq("an admin row re-assigned without dates: the conversion matches nothing and no date is written", writesOf(r.rs, CA), ["conversion"]);
      eq("…200", r.status, 200);
    }
    {
      const r = await course({ rows: { "u-self": "self" } }, { userIds: ["u-self", "u-new"] });
      eq("a new learner beside a self-enrolled one: the conversion names only the one already there", filtersOf(r.rs.find(isConversion)!).filter((f) => f.startsWith("user_id")), ["user_id=in.(u-self)"]);
      eq("…only the new learner is emailed (no email for a converted row)", emailedOf(r.rs), ["u-new"]);
      eq("…200, one assigned", [r.status, r.body.assigned], [200, 1]);
    }
    {
      const r = await course({ dupNonUser: true }, { assignToOrg: true, teamIds: ["t-1"], dueAt: DUE });
      eq("an org and a team row already there: today's date updates, no conversion", writesOf(r.rs, CA), [
        `dates ${JSON.stringify({ due_at: DUE, release_at: null })}`, `dates ${JSON.stringify({ due_at: DUE, release_at: null })}`,
      ]);
      const none = await course({}, { userIds: ["u-new"] });
      eq("nothing already there: no conversion call", none.rs.filter(isConversion).length, 0);
    }

    console.log("\nPOST /api/assignments: ADR 0030 rule 10, only members that count are emailed");
    {
      // A group's log rows are one insert (ADR 0029): read every row of every insert.
      const logged = (rs: Req[]) => rs.filter((q) => q.table === "notification_log" && q.method === "POST").flatMap((q) => (Array.isArray(q.body) ? (q.body as Row[]) : [q.body as Row])).map((r) => String(r.to_user_id)).sort();
      const r = await course({}, { userIds: ["u-new", "u-gone"] });
      eq("an active and an inactive learner named directly: both assigned, only the active one emailed",
        [r.status, r.body.assigned, writesOf(r.rs, CA), emailedOf(r.rs), logged(r.rs)],
        [200, 2, ["insert u-new,u-gone"], ["u-new"], ["u-new"]]);
      const org = await course({}, { assignToOrg: true });
      eq("an org-wide row: every active member emailed, the inactive one not", [org.status, logged(org.rs)], [200, ["u-adm", "u-new", "u-self"]]);
    }

    console.log("\nPOST /api/assignments: without the column (today's sequence)");
    for (const code of ["PGRST204", "42703"] as const) {
      const dated = await course({ rows: { "u-self": "self" }, conversion: code }, { userIds: ["u-self"], dueAt: DUE, releaseAt: RELEASE });
      eq(`${code}, dated: today's date update, then the one refused conversion`, writesOf(dated.rs, CA), [
        `dates ${JSON.stringify({ due_at: DUE, release_at: RELEASE })}`, "conversion",
      ]);
      eq(`…${code}: today's answer`, [dated.status, dated.body.assigned, dated.body.rescheduled], [200, 0, 1]);
      const plain = await course({ rows: { "u-self": "self" }, conversion: code }, { userIds: ["u-self"] });
      eq(`${code}, undated: no insert (the row is there), the refused conversion, nothing else`, [plain.status, writesOf(plain.rs, CA)], [200, ["conversion"]]);
    }

    console.log("\nPOST /api/assignments: any other error is not swallowed");
    {
      const r = await course({ rows: { "u-self": "self" }, conversion: "42501" }, { userIds: ["u-self"] });
      eq("42501: 400 with the message", [r.status, r.body.error], [400, `permission denied for table ${CA}`]);
    }

    console.log("\nPOST /api/assignments: the insert of all rows meets an error (ADR 0029 gate G3)");
    {
      // A race: the learner's row was written after the read, so the insert
      // of all rows answers 23505 and each row is then inserted on its own.
      const r = await course({ rows: { "u-self": "self" }, unseen: ["u-self"] }, { userIds: ["u-self", "u-new"], dueAt: DUE, releaseAt: RELEASE });
      eq("a row written since the read: the refused insert of all rows, then one insert per row, the date update and the conversion", writesOf(r.rs, CA), [
        "insert u-self,u-new", "insert u-self", "insert u-new", `dates ${JSON.stringify({ due_at: DUE, release_at: RELEASE })}`, "conversion",
      ]);
      eq("…the answer one insert per row gave: one assigned, one rescheduled; the conversion names the learner already there; the new one emailed",
        [r.status, r.body.assigned, r.body.rescheduled, filtersOf(r.rs.find(isConversion)!).filter((f) => f.startsWith("user_id")), emailedOf(r.rs)],
        [200, 1, 1, ["user_id=in.(u-self)"], ["u-new"]]);
    }
    {
      const r = await course({ badInsert: "u-bad" }, { userIds: ["u-new", "u-bad"] });
      eq("another error on the insert of all rows: 400 with its message, no insert row by row, no conversion, no mail",
        [r.status, r.body.error, writesOf(r.rs, CA), emailedOf(r.rs)],
        [400, FK.message, ["insert u-new,u-bad"], []]);
    }

    // ------------------------------------------------------------------
    console.log("\nassignCourseDirect (lib/assignments/direct.ts)");
    const assign = async (w: Partial<World>, userIds: string[], dueAt: string | null, notify = true) => {
      world = { ...base(), ...w };
      requests = [];
      const out = await direct.assignCourseDirect(svc, {
        orgId: ORG, orgName: "Org", orgSlug: "org", origin: "http://lms.test", assignedBy: USER.id,
        courseId: COURSE, userIds, dueAt, notify,
      });
      if ("error" in out) throw new Error(out.error);
      return { results: out.results.map((x) => [x.userId, x.status, x.reason ?? null]), rs: requests };
    };
    {
      const r = await assign({ rows: { "u-self": "self", "u-adm": "admin" } }, ["u-self", "u-adm", "u-new"], null);
      eq("an undated assign: one insert of the new learner, then one conversion naming the two already there", writesOf(r.rs, CA), ["insert u-new", "conversion"]);
      const c = r.rs.find(isConversion)!;
      eq("…source 'admin', the admin, on the service client", [c.body, c.apikey], [{ source: "admin", assigned_by: USER.id }, SERVICE]);
      eq("…its filters", filtersOf(c), ["assignee_type=eq.user", `course_id=eq.${COURSE}`, `organization_id=eq.${ORG}`, "source=eq.self", "user_id=in.(u-self,u-adm)"]);
      eq("…the converted learner reads assigned (a ticket's 'assign' counts them), the admin row already, the new one assigned", r.results, [
        ["u-self", "assigned", "self-enrolment converted to an assignment"],
        ["u-adm", "already", "already assigned"],
        ["u-new", "assigned", null],
      ]);
      eq("…only the inserted learner is emailed", emailedOf(r.rs), ["u-new"]);
    }
    {
      const r = await assign({ rows: { "u-self": "self", "u-adm": "admin" } }, ["u-self", "u-adm"], DUE, false);
      eq("a due-date change (a ticket's extend_due): one date update for both, then the conversion", writesOf(r.rs, CA), [
        `dates ${JSON.stringify({ due_at: DUE })}`, "conversion",
      ]);
      eq("…both count for extend_due: converted, and already with the date updated", r.results, [
        ["u-self", "assigned", "self-enrolment converted to an assignment"],
        ["u-adm", "already", "already assigned — due date updated"],
      ]);
      eq("…no email when notify is false", emailedOf(r.rs), []);
    }
    for (const code of ["PGRST204", "42703"] as const) {
      const r = await assign({ rows: { "u-self": "self", "u-adm": "admin" }, conversion: code }, ["u-self", "u-adm"], DUE, false);
      eq(`${code}: the one date update, then the one refused conversion`, writesOf(r.rs, CA), [
        `dates ${JSON.stringify({ due_at: DUE })}`, "conversion",
      ]);
      eq(`…${code}: today's results`, r.results, [
        ["u-self", "already", "already assigned — due date updated"],
        ["u-adm", "already", "already assigned — due date updated"],
      ]);
    }
    {
      const r = await assign({ rows: { "u-self": "self" }, conversion: "42501" }, ["u-self", "u-new"], null);
      eq("42501: the learner already there reads failed with the reason; the new one is still assigned and emailed", [r.results, emailedOf(r.rs)], [[
        ["u-self", "failed", `self-enrolment not converted: permission denied for table ${CA}`],
        ["u-new", "assigned", null],
      ], ["u-new"]]);
    }
    {
      // ADR 0029 gate G3: the insert of all rows fails for one learner; each
      // row is then inserted on its own, so the others are still assigned.
      const r = await assign({ badInsert: "u-bad" }, ["u-new", "u-bad", "u-two"], null);
      eq("one learner's insert fails: the refused insert of all rows, then one insert per row", writesOf(r.rs, CA), [
        "insert u-new,u-bad,u-two", "insert u-new", "insert u-bad", "insert u-two",
      ]);
      eq("…that learner failed with the message, the others assigned and emailed", [r.results, emailedOf(r.rs)], [[
        ["u-new", "assigned", null],
        ["u-bad", "failed", FK.message],
        ["u-two", "assigned", null],
      ], ["u-new,u-two"]]);
    }

    console.log("\nconvertSelfEnrolments: chunks of 150, no state between calls");
    {
      world = { ...base(), rows: Object.fromEntries(Array.from({ length: 151 }, (_, i) => [`u${i}`, i % 2 ? "self" : "admin"])) };
      requests = [];
      const ids = Object.keys(world.rows);
      const out = await direct.convertSelfEnrolments(svc, CA, { orgId: ORG, column: "course_id", id: COURSE, userIds: [...ids, "u0"] }, { assignedBy: USER.id });
      const sizes = requests.filter(isConversion).map((q) => (/user_id=in\.\(([^)]*)\)/.exec(q.query)?.[1] ?? "").split(",").length);
      eq("151 learners (one named twice): two updates, 150 and 1", sizes, [150, 1]);
      eq("…the self rows are converted, the admin rows are not", [out.converted.length, out.missing, out.error], [75, false, null]);
      requests = [];
      const none = await direct.convertSelfEnrolments(svc, CA, { orgId: ORG, column: "course_id", id: COURSE, userIds: [] }, { assignedBy: USER.id });
      eq("no learner: no request", [requests.length, none.converted, none.missing, none.error], [0, [], false, null]);
      world = { ...base(), rows: { a: "self" }, conversion: "PGRST204" };
      const missing = await direct.convertSelfEnrolments(svc, CA, { orgId: ORG, column: "course_id", id: COURSE, userIds: ["a"] }, { assignedBy: USER.id });
      eq("a missing column: missing, no error", [missing.missing, missing.error, missing.converted], [true, null, []]);
      world = { ...base(), rows: { a: "self" } };
      const after = await direct.convertSelfEnrolments(svc, CA, { orgId: ORG, column: "course_id", id: COURSE, userIds: ["a"] }, { assignedBy: USER.id });
      eq("…the next call decides again (nothing kept from the last)", [after.missing, after.converted], [false, ["a"]]);
    }

    // ------------------------------------------------------------------
    console.log("\nPOST /api/learning-path-assignments: with the column");
    {
      const r = await path({ rows: { "u-self": "self" } }, { userIds: ["u-self"] });
      eq("an undated assign of a self-enrolled learner: no insert (the row is there), then one conversion", writesOf(r.rs, LPA), ["conversion"]);
      const c = r.rs.find(isConversion)!;
      eq("…source 'admin' and the admin; no due date given, none written", c.body, { source: "admin", assigned_by: USER.id });
      eq("…it names the path, the org, a user row, the learner and source = 'self'", filtersOf(c), [
        "assignee_type=eq.user", `organization_id=eq.${ORG}`, `path_id=eq.${PATH}`, "source=eq.self", "user_id=in.(u-self)",
      ]);
      eq("…200", [r.status, r.body.assigned], [200, 0]);
      const dated = await path({ rows: { "u-self": "self" } }, { userIds: ["u-self"], dueAt: DUE });
      eq("a dated assign: the conversion carries the admin's due date (the route writes no date on a 23505)", [writesOf(dated.rs, LPA), dated.rs.find(isConversion)!.body], [
        ["conversion"], { source: "admin", assigned_by: USER.id, due_at: DUE },
      ]);
      const adm = await path({ rows: { "u-adm": "admin" } }, { userIds: ["u-adm"], dueAt: DUE });
      eq("an admin row: the conversion matches nothing; no other write (today's no-op)", [adm.status, writesOf(adm.rs, LPA)], [200, ["conversion"]]);
      const team = await path({ dupNonUser: true }, { teamIds: ["t-1"], assignToOrg: true });
      eq("a team and an org row already there: no conversion call, and no insert (both are read as there)", [team.status, writesOf(team.rs, LPA)], [200, []]);
    }

    console.log("\nPOST /api/learning-path-assignments: without the column (today's no-op)");
    for (const code of ["PGRST204", "42703"] as const) {
      const r = await path({ rows: { "u-self": "self" }, conversion: code }, { userIds: ["u-self"], dueAt: DUE });
      eq(`${code}: no insert (the row is there), the refused conversion, nothing else; 200`, [r.status, r.body.assigned, writesOf(r.rs, LPA)], [200, 0, ["conversion"]]);
    }

    console.log("\nPOST /api/learning-path-assignments: any other error is not swallowed");
    {
      const r = await path({ rows: { "u-self": "self" }, conversion: "42501" }, { userIds: ["u-self"] });
      eq("42501: 400 with the message", [r.status, r.body.error], [400, `permission denied for table ${LPA}`]);
    }
    {
      const r = await path({ rows: { "u-self": "self" }, unseen: ["u-self"] }, { userIds: ["u-self", "u-new"] });
      eq("a row written since the read (gate G3): the refused insert of all rows, one insert per row, then the conversion; one assigned",
        [r.status, r.body.assigned, writesOf(r.rs, LPA)], [200, 1, ["insert u-self,u-new", "insert u-self", "insert u-new", "conversion"]]);
      const bad = await path({ badInsert: "u-bad" }, { userIds: ["u-new", "u-bad"] });
      eq("another error on the insert of all rows: 400 with its message, nothing more written",
        [bad.status, bad.body.error, writesOf(bad.rs, LPA)], [400, FK.message, ["insert u-new,u-bad"]]);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
