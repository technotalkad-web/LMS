/**
 * A manager's "send reminder now" (POST /api/manager/remind,
 * lib/manager/actions.ts sendReminders) stays inside one request's calls
 * (ADR 0029 rule FP2, gate G3), over the stubbed world of
 * tests/unit/mail-world.ts with working mail.
 *
 * The request counts from its first call (the middleware's), each call
 * where it is made, every page and fallback included, and its run opens on
 * that one budget: its mail stops where the 40 calls of rule FP2 do, and
 * the rest is answered as not sent for room ("try again"). With no room
 * left after the reads for the run's first send (its opening, its
 * template, one send and its group's tail), the run is not opened and
 * every learner due is answered as left for room.
 *
 * ADR 0029, note of 2026-11-25, part 1: a course target decided who is due
 * with the Report Card's reader (computeLearnerInsights), which reads for
 * the whole organisation. Measured at 9d607f3 over this stub: 30 calls
 * before the run for a team of 20 or 50 in a plain organisation, 38 in all
 * and 1 learner emailed; with a path, a team or a group, 37 calls and
 * nobody emailed. The course target now reads only what decides, for the
 * named learners and the one course, whether each has a line and its
 * status (readCourseReminderLines, lib/manager/insights.ts), and stops
 * once every learner has one. The request's own 11 calls (the session 1,
 * the membership 2, the reporting line 1, the addresses 1, the coverage 3,
 * the course 1, its mapping 1) and the middleware's, then that read, then
 * the reminder state 1. Each case pins, over the world it names: the
 * read's calls, the calls before the run, the learners emailed and the
 * whole request. The same for a team of 20 and of 50; a team of 5 is
 * emailed whole; a second press emails the next learners and nobody twice;
 * an organisation of 2,500 members adds the reporting line's two pages.
 * Each read of the reminder's is strict: one case for each step (a to m)
 * answers 503 with nothing sent, no log row, no state written and no run
 * opened; the tolerated answers (a database without org_groups or
 * attempt_requests, read from the code, and the missing columns each read
 * through its fallback) answer. A direct call with a budget of the test's
 * own checks that the budget's count is the calls really made, in every
 * world, so a read left uncounted shows.
 *
 * A journey target does not use that read: 33 calls and 9 emailed, in
 * every world, as before.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/manager-remind-calls.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import { ORG, eq, finish, freshWorld, installStub, removeStub, stub as worldStub, world, type Row, type World } from "./mail-world";
import { requestBudget } from "../../lib/notifications/smtp-state";

const ANON = "stub-anon-key";
const MANAGER = "0c000000-0000-4000-8000-0000000000e0";
const USER = { id: MANAGER, aud: "authenticated", role: "authenticated", email: "manager@tenant.stub" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const COURSE = "0d000000-0000-4000-8000-0000000000c1";
const COURSE_2 = "0d000000-0000-4000-8000-0000000000c2";
const VERSION = "0d000000-0000-4000-8000-0000000000f1";
const VERSION_2 = "0d000000-0000-4000-8000-0000000000f2";
const PATH = "0d000000-0000-4000-8000-0000000000e1";
const TEAM = "0d000000-0000-4000-8000-0000000000a1";
const TEAM_2 = "0d000000-0000-4000-8000-0000000000a2";
const TEAM_3 = "0d000000-0000-4000-8000-0000000000a3";
const STATIC_GROUP = "0d000000-0000-4000-8000-0000000000d1";
const DYNAMIC_GROUP = "0d000000-0000-4000-8000-0000000000d2";
const PROGRAM = "0d000000-0000-4000-8000-0000000000b1";
const JVERSION = "0d000000-0000-4000-8000-0000000000b2";
const learner = (i: number) => `0b000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const enrolment = (i: number) => `0e400000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** The words of a reminder the request had no room for. */
const NO_ROOM = "not sent: the request had no room left; try again";
/** The words of a failed read of the reminder's (ADR 0029, note of 2026-11-25, part 1, point 9). */
const UNREADABLE = "The learners' assignments could not be read. Nothing was sent; try again.";

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
type Call = { method: string; path: string; table: string; query: string; select: string };
let calls: Call[] = [];
/** A case's switch: a read it answers itself (a failed step, a missing column), or null to let the world answer. */
let answerRead: ((c: Call) => { status: number; body: Row } | null) | null = null;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchAll = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const call: Call = { method, path: url.pathname, table: url.pathname.replace("/rest/v1/", ""), query: decodeURIComponent(url.search), select: url.searchParams.get("select") ?? "" };
  calls.push(call);
  if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify(USER), { status: 200, headers: { "content-type": "application/json" } });
  const own = method === "GET" ? answerRead?.(call) : null;
  if (own) return json(own.body, own.status);
  return worldStub(input, init);
};

/** The middleware's one call (its session read) on every request, which the stub does not run. */
const MIDDLEWARE_CALLS = 1;

/**
 * How COURSE reaches the named learners (ADR 0029, note of 2026-11-25,
 * part 1, point 7):
 *   - plain: each by a row of their own, nobody has opened it;
 *   - opened: the same, and each has opened it, nobody has finished it;
 *   - finished: plain, and the first learner has passed it;
 *   - dynamic: only through a dynamic group that holds everybody, the course on no path;
 *   - pathDynamic: only through a path (its released step) that such a group is assigned;
 *   - every: the first learner passed it, the second opened it, the third
 *     by a row of their own, two through a team's row, two through a static
 *     group's, two through a dynamic group's (a field rule and a team rule),
 *     one by the path's row of their own, two through the path's team row;
 *     the rest are reached by nothing.
 */
type Kind = "plain" | "opened" | "finished" | "dynamic" | "pathDynamic" | "every";

/**
 * An organisation of the manager and a team of `n` learners who report to
 * them, with working mail, COURSE reaching them as `kind` says, and on a
 * journey target each with an active enrolment with something pending
 * today. `others`: that many more members (no manager), so the reporting
 * line reads more pages. `extraTeamRows`: that many more team rows on
 * COURSE, for teams of nobody named (a second page of the course's rows).
 */
function seed(n: number, opts: { kind?: Kind; others?: number; extraTeamRows?: number } = {}) {
  const team = Array.from({ length: n }, (_, i) => learner(i + 1));
  const kind = opts.kind ?? "plain";
  let seq = 0;
  const id = (prefix: string) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const courseRow = (over: Row): Row => ({
    id: id("0e300000"), organization_id: ORG, course_id: COURSE, assignee_type: "user", user_id: null, team_id: null, group_id: null,
    due_at: null, release_at: null, assigned_at: "2026-11-01T09:00:00Z", ...over,
  });
  const pathRow = (over: Row): Row => ({
    id: id("0e500000"), organization_id: ORG, path_id: PATH, assignee_type: "user", user_id: null, team_id: null, group_id: null,
    due_at: null, release_at: null, assigned_at: "2026-11-01T09:00:00Z", ...over,
  });
  const attempt = (user_id: string, done: boolean): Row => ({
    id: id("0a100000"), user_id, organization_id: ORG, course_version_id: VERSION,
    status: done ? "completed" : "in_progress", score: done ? 0.9 : null, started_at: "2026-11-10T09:00:00Z",
    completed_at: done ? "2026-11-10T10:00:00Z" : null, last_activity_at: "2026-11-10T09:30:00Z",
    completion_status: done ? "completed" : "incomplete", success_status: done ? "passed" : "unknown",
    is_revision: false, context_kind: "individual", progress_pct: done ? 100 : 10, units: null,
  });
  const courseRows: Row[] = [];
  const pathRows: Row[] = [];
  const attempts: Row[] = [];
  const teamMembers: Row[] = [];
  const groupMembers: Row[] = [];
  const groups: Row[] = [];
  const vertical = new Map<string, string>();
  let onPath = false;
  const everybody = () => groups.push({ id: DYNAMIC_GROUP, organization_id: ORG, name: "Dynamic D", group_type: "dynamic", rules: { verticals: ["V1", "V2"] }, is_active: true });
  if (kind === "plain" || kind === "opened" || kind === "finished") {
    for (const u of team) courseRows.push(courseRow({ user_id: u }));
    if (kind === "opened") for (const u of team) attempts.push(attempt(u, false));
    if (kind === "finished") attempts.push(attempt(team[0], true));
  } else if (kind === "dynamic") {
    everybody();
    courseRows.push(courseRow({ assignee_type: "group", group_id: DYNAMIC_GROUP }));
  } else if (kind === "pathDynamic") {
    everybody();
    onPath = true;
    pathRows.push(pathRow({ assignee_type: "group", group_id: DYNAMIC_GROUP }));
  } else {
    onPath = true;
    attempts.push(attempt(team[0], true), attempt(team[1], false));
    courseRows.push(
      courseRow({ user_id: team[2] }),
      courseRow({ assignee_type: "team", team_id: TEAM }),
      courseRow({ assignee_type: "group", group_id: STATIC_GROUP }),
      courseRow({ assignee_type: "group", group_id: DYNAMIC_GROUP }),
    );
    teamMembers.push({ team_id: TEAM, user_id: team[3] }, { team_id: TEAM, user_id: team[4] });
    groups.push(
      { id: STATIC_GROUP, organization_id: ORG, name: "Static S", group_type: "static", rules: {}, is_active: true },
      { id: DYNAMIC_GROUP, organization_id: ORG, name: "Dynamic D", group_type: "dynamic", rules: { verticals: ["V9"], team_ids: [TEAM_3] }, is_active: true },
    );
    groupMembers.push({ group_id: STATIC_GROUP, user_id: team[5] }, { group_id: STATIC_GROUP, user_id: team[6] });
    for (const u of [team[7], team[8]]) {
      vertical.set(u, "V9");
      teamMembers.push({ team_id: TEAM_3, user_id: u });
    }
    pathRows.push(pathRow({ user_id: team[9] }), pathRow({ assignee_type: "team", team_id: TEAM_2 }));
    teamMembers.push({ team_id: TEAM_2, user_id: team[10] }, { team_id: TEAM_2, user_id: team[11] });
  }
  for (let i = 0; i < (opts.extraTeamRows ?? 0); i++) courseRows.push(courseRow({ assignee_type: "team", team_id: `0d100000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` }));
  freshWorld({
    members: [
      { organization_id: ORG, user_id: MANAGER, role: "user", status: "active" },
      ...team.map((user_id, i) => ({ organization_id: ORG, user_id, role: "user", status: "active", line_manager_id: MANAGER, business_vertical: vertical.get(user_id) ?? (i % 2 === 0 ? "V1" : "V2") })),
      ...Array.from({ length: opts.others ?? 0 }, (_, i) => ({ organization_id: ORG, user_id: `0f100000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, role: "user", status: "active", business_vertical: "V1" })),
    ] as World["members"],
    profiles: Object.fromEntries([[MANAGER, "manager@tenant.stub"], ...team.map((u, i) => [u, `learner-${i + 1}@tenant.stub`])]),
    tables: {
      gamification_settings: [],
      manager_coverage: [],
      content_scopes: [],
      courses: [
        { id: COURSE, organization_id: ORG, title: "Course K", is_active: true, pass_required: false },
        { id: COURSE_2, organization_id: ORG, title: "Course L", is_active: true, pass_required: false },
      ],
      course_versions: [{ id: VERSION, course_id: COURSE, manifest_data: {} }, { id: VERSION_2, course_id: COURSE_2, manifest_data: {} }],
      course_attempts: attempts,
      course_assignments: courseRows,
      learning_paths: onPath ? [{ id: PATH, organization_id: ORG, name: "Path P", is_active: true }] : [],
      learning_path_courses: onPath ? [{ path_id: PATH, course_id: COURSE, step_number: 1, release_at: null }] : [],
      learning_path_assignments: pathRows,
      team_members: teamMembers,
      org_groups: groups,
      org_group_members: groupMembers,
      attempt_requests: [],
      reminder_state: [],
      journey_programs: [{ id: PROGRAM, organization_id: ORG, name: "Journey J", is_active: true, deadline_days: null }],
      journey_versions: [{ id: JVERSION, day_ids: {} }],
      journey_enrollments: team.map((user_id, i) => ({
        id: enrolment(i + 1), organization_id: ORG, user_id, program_id: PROGRAM, version_id: JVERSION,
        status: "active", start_date: "2026-11-01", last_daily_reminder_on: null,
        journey_versions: { days: [{ day: 1, course_id: COURSE, mission_title: "Mission 1" }], days_total: 10, count_sundays: true, unlock_mode: "calendar" },
        journey_programs: { id: PROGRAM, name: "Journey J", is_active: true, deadline_days: null },
      })),
      journey_day_progress: [],
      // Read by the Report Card's reader only, which the reminder no longer calls; kept so a call of it is answered, and seen.
      revision_visits: [],
      mv_course_performance: [],
    },
    rpc: {
      effective_attempt_policies: () => [],
      journey_reminder_counts: (body) => ((body?.p_ids as string[] | undefined) ?? []).map((id) => ({ enrollment_id: id, done_days: 0, done_today: false, credited: [] })),
    },
  });
  calls = [];
  answerRead = null;
  return team;
}

async function main() {
  installStub();
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  globalThis.fetch = fetchAll as typeof fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const route = await import("../../app/api/manager/remind/route");
    const actions = await import("../../lib/manager/actions");
    const bodyFor = (target: "course" | "journey", team: string[]): Row =>
      target === "course" ? { userIds: team, target, contentId: COURSE } : { userIds: team, target, contentId: PROGRAM };
    /** The learners' outcomes, and the request's whole calls with the middleware's. */
    const outcome = (results: Row[]) => ({
      sent: results.filter((x) => x.status === "sent").length,
      left: results.filter((x) => x.status === "failed" && x.reason === NO_ROOM).length,
      other: [...new Set(results.filter((x) => x.status !== "sent" && !(x.status === "failed" && x.reason === NO_ROOM)).map((x) => `${x.status}: ${x.reason}`))]
        .map((k) => `${results.filter((x) => `${x.status}: ${x.reason}` === k).length} ${k}`).sort(),
      total: calls.length + MIDDLEWARE_CALLS,
    });
    const remind = async (body: Row) => {
      const res = await route.POST(new Request("http://lms.test/api/manager/remind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgSlug: "tenant-a", ...body }) }));
      return { status: res.status, body: (await res.json()) as Row };
    };
    /** authorizeManager and sendReminders called with a budget of the test's own, which holds the middleware's call. */
    const direct = async (body: Row) => {
      const budget = requestBudget({ spent: MIDDLEWARE_CALLS });
      const a = await actions.authorizeManager("tenant-a", budget);
      if (actions.isActionError(a)) return { budget, results: [] as Row[], error: a.error };
      const r = await actions.sendReminders(a, body as Parameters<typeof actions.sendReminders>[1]);
      if (actions.isActionError(r)) return { budget, results: [] as Row[], error: r.error };
      return { budget, results: r.results as unknown as Row[], error: null };
    };
    /** The read's calls (between the course's mapping and the reminder state's read), and the calls before the run, with the middleware's. */
    const measure = () => {
      const mapping = calls.findIndex((c) => c.table === "content_scopes");
      const state = calls.findIndex((c) => c.table === "reminder_state" && c.method === "GET");
      return { reader: state - mapping - 1, beforeRun: state + 1 + MIDDLEWARE_CALLS };
    };
    const opened = () => calls.some((c) => c.table === "rpc/tenant_mail_status");
    /** Nothing was sent, logged, written or opened. */
    const nothingDone = () => [world.log.length, calls.filter((c) => c.path === "/functions/v1/send-smtp").length, calls.filter((c) => c.table === "reminder_state" && c.method !== "GET").length, opened()];

    // The worlds of the note's sums (part 1, point 7). Measured; each row
    // within the note's rules: within 40, somebody due is emailed, and the
    // read's calls are the same for a team of 20 and of 50.
    const SUMS: Array<[Kind, string, number, number, number, number, (n: number) => string[]]> = [
      ["opened", "each has opened it, nobody has finished it", 2, 14, 10, 37, () => []],
      ["plain", "each by a row of their own, nobody has opened it", 3, 15, 9, 35, () => []],
      ["finished", "the same, and somebody has finished it", 4, 16, 9, 36, () => ["1 skipped: already completed"]],
      ["dynamic", "only through a dynamic group, the course on no path", 7, 19, 7, 37, () => []],
      ["pathDynamic", "only through a path that a dynamic group is assigned", 10, 22, 5, 36, () => []],
      ["every", "every step: a team, a static and a dynamic group, a path, a finished learner", 13, 25, 3, 37, (n) => ["1 skipped: already completed", `${n - 12} skipped: not assigned this course`]],
    ];
    for (const [kind, label, reader, before, emailed, total, others] of SUMS) {
      for (const n of [20, 50]) {
        console.log(`\nPOST /api/manager/remind, a course target, a team of ${n}: ${label}`);
        const team = seed(n, { kind });
        const r = await remind(bodyFor("course", team));
        const o = outcome((r.body.results as Row[] | undefined) ?? []);
        const m = measure();
        eq(`200; the read ${reader} calls, ${before} before the run, ${total} in all with the middleware's, within 40`,
          [r.status, m.reader, m.beforeRun, o.total, o.total <= 40], [200, reader, before, total, true]);
        const due = n - others(n).reduce((s, x) => s + Number(x.split(" ")[0]), 0);
        eq(`…${emailed} emailed, the other ${due - emailed} due answered as not sent for room ("try again")${others(n).length ? ", the rest as the world says" : ""}`,
          [o.sent, o.left, o.other], [emailed, due - emailed, others(n)]);
        eq("…a notification_log row for each one emailed, and none for the rest", world.log.filter((x) => x.status === "sent").length, emailed);
      }
      console.log(`\nauthorizeManager and sendReminders, a course target, a team of 20 (${kind}): the budget holds every call`);
      const team = seed(20, { kind });
      const { budget, error } = await direct(bodyFor("course", team));
      eq("the budget's count is the calls made, with the middleware's, and at most 40; none of the Report Card's own reads (the policies, the visits, the benchmark, the journeys), the addresses read once",
        [error, budget.calls, budget.calls <= 40, calls.filter((c) => ["rpc/effective_attempt_policies", "revision_visits", "mv_course_performance", "journey_enrollments", "profiles"].includes(c.table)).length],
        [null, calls.length + MIDDLEWARE_CALLS, true, 1]);
    }

    {
      console.log("\nPOST /api/manager/remind, a course target, a team of 5, each by a row of their own");
      const team = seed(5);
      const r = await remind(bodyFor("course", team));
      const o = outcome((r.body.results as Row[] | undefined) ?? []);
      eq("200, everybody emailed, within 40", [r.status, o.sent, o.left, o.other, o.total <= 40], [200, 5, 0, [], true]);
    }

    {
      // Pressing again now helps (part 1, point 7): those emailed read
      // "reminded in the last day" and the next are emailed; nobody twice.
      // Measured: the second press, with 11 due, emails 10 of them (the run
      // sizes its last group on the learners left as well as on the room).
      console.log("\nPOST /api/manager/remind, a course target, a team of 20: a second press");
      const team = seed(20);
      const first = outcome(((await remind(bodyFor("course", team))).body.results as Row[] | undefined) ?? []);
      calls = [];
      const r = await remind(bodyFor("course", team));
      const second = outcome((r.body.results as Row[] | undefined) ?? []);
      const sentTo = world.log.filter((x) => x.status === "sent").map((x) => String(x.to_user_id ?? ""));
      eq("the first press emails 9; the second emails the next 10 of the 11 due, the first 9 read \"reminded in the last day\", within 40",
        [first.sent, r.status, second.sent, second.other, second.left, second.total <= 40], [9, 200, 10, ["9 skipped: reminded in the last day"], 1, true]);
      eq("…19 sends in all, nobody emailed twice", [sentTo.length, new Set(sentTo).size], [19, 19]);
    }

    {
      // The reporting line reads every member (part 1, point 8): one call for each 1,000.
      console.log("\nPOST /api/manager/remind, a course target, a team of 20 in an organisation of 2,500 members");
      const team = seed(20, { others: 2_479 });
      const r = await remind(bodyFor("course", team));
      const o = outcome((r.body.results as Row[] | undefined) ?? []);
      const m = measure();
      // Measured: the two calls more come out of the room the run's last
      // group had spare, so as many are emailed as in an organisation of 21.
      eq("200; the read 3 calls, two pages of members more before the run (17), 37 in all, within 40; 9 emailed, the other 11 left for room",
        [r.status, m.reader, m.beforeRun, o.total, o.total <= 40, o.sent, o.left, o.other], [200, 3, 17, 37, true, 9, 11, []]);
    }

    console.log("\nPOST /api/manager/remind, a course target: a failed read of the reminder's, step by step (part 1, point 9)");
    {
      const fail = { status: 500, body: { code: "XX000", message: "stub read failure" } };
      const STEPS: Array<[string, (c: Call) => boolean]> = [
        ["a, the course's versions", (c) => c.table === "course_versions"],
        ["b, the learners' rows", (c) => c.table === "course_attempts"],
        ["c, the course's own rows", (c) => c.table === "course_assignments" && c.query.includes("assignee_type=eq.user")],
        ["d, the course's other rows", (c) => c.table === "course_assignments" && c.query.includes("assignee_type=neq.user")],
        ["e, the path steps", (c) => c.table === "learning_path_courses"],
        ["f, the paths", (c) => c.table === "learning_paths"],
        ["g, the paths' own rows", (c) => c.table === "learning_path_assignments" && c.query.includes("assignee_type=eq.user")],
        ["h, the paths' other rows", (c) => c.table === "learning_path_assignments" && c.query.includes("assignee_type=neq.user")],
        ["i, the groups", (c) => c.table === "org_groups"],
        ["j, the teams", (c) => c.table === "team_members"],
        ["k, the static groups' rows", (c) => c.table === "org_group_members"],
        ["l, the member fields", (c) => c.table === "organization_members" && c.select.includes("job_role")],
        ["m, the grants", (c) => c.table === "attempt_requests"],
      ];
      for (const [step, failing] of STEPS) {
        const team = seed(20, { kind: "every" });
        let hit = 0;
        answerRead = (c) => (failing(c) ? (hit++, fail) : null);
        const r = await remind(bodyFor("course", team));
        eq(`${step} fails: 503 with the words; the read was made; nothing sent, no log row, no state written, no run opened`,
          [r.status, r.body.error, hit > 0, ...nothingDone()], [503, UNREADABLE, true, 0, 0, 0, false]);
      }
      {
        // A later page: the course's other rows over two pages, the second failing.
        const team = seed(20, { kind: "every", extraTeamRows: 1_000 });
        let hit = 0;
        answerRead = (c) => (c.table === "course_assignments" && c.query.includes("assignee_type=neq.user") && c.query.includes("offset=1000") ? (hit++, fail) : null);
        const r = await remind(bodyFor("course", team));
        eq("a later page that fails (the course's other rows, page 2): 503; nothing sent, no log row, no state written, no run opened",
          [r.status, r.body.error, hit, ...nothingDone()], [503, UNREADABLE, 1, 0, 0, 0, false]);
      }
      {
        // An error that only names a relation is a failed read, never a database without the table.
        const team = seed(20, { kind: "every" });
        answerRead = (c) => (c.table === "org_groups" ? { status: 500, body: { code: "XX000", message: "could not open relation with OID 16384" } } : null);
        const r = await remind(bodyFor("course", team));
        eq("the groups' error names a relation, with no missing-table code: 503, nothing sent", [r.status, ...nothingDone()], [503, 0, 0, 0, false]);
      }
      {
        // The course itself (the reminder's own read, orgCourse): a failed read answers 404 and sends nothing, as at 9d607f3.
        const team = seed(20);
        answerRead = (c) => (c.table === "courses" && c.query.includes(`id=eq.${COURSE}`) ? fail : null);
        const r = await remind(bodyFor("course", team));
        eq("the course cannot be read: 404 \"Course not found\", nothing sent, no run opened", [r.status, r.body.error, ...nothingDone()], [404, "Course not found", 0, 0, 0, false]);
      }
    }

    console.log("\nPOST /api/manager/remind, a course target, every step: what is still tolerated, each read from its code");
    {
      const team = seed(20, { kind: "every" });
      const base = await remind(bodyFor("course", team));
      const baseline = { ...measure(), outcome: outcome((base.body.results as Row[] | undefined) ?? []) };
      /** A read that answers 42703 for `column` of `table` (the column a database before its migration lacks). */
      const missingColumn = (column: string, table: string, when: (c: Call) => boolean) => (c: Call) =>
        c.table === table && when(c) ? { status: 400, body: { code: "42703", message: `column ${table}.${column} does not exist` } } : null;
      const CASES: Array<[string, () => void, number]> = [
        ["a database without is_revision (0103): the learners' rows read again without it", () => { answerRead = missingColumn("is_revision", "course_attempts", (c) => c.select.includes("is_revision")); }, 1],
        ["a database without context_kind (0107): the learners' rows read again without the preview filter", () => { answerRead = missingColumn("context_kind", "course_attempts", (c) => c.query.includes("context_kind=neq.preview")); }, 1],
        ["a database without reissued_from (0103): the grants read again without it", () => { answerRead = missingColumn("reissued_from", "attempt_requests", (c) => c.select.includes("reissued_from")); }, 1],
        ["a database without department (0096): the member fields read again without it", () => { answerRead = missingColumn("department", "organization_members", (c) => c.select.includes("job_role") && c.select.includes("department")); }, 1],
        ["a database without attempt_requests (before 0083): no grants", () => { world.missingTables = ["attempt_requests"]; }, 0],
      ];
      for (const [label, arrange, more] of CASES) {
        seed(20, { kind: "every" });
        arrange();
        const r = await remind(bodyFor("course", team));
        const o = outcome((r.body.results as Row[] | undefined) ?? []);
        const m = measure();
        eq(`${label}: 200, the read ${13 + more} calls, ${25 + more} before the run, the same answers but for room, somebody emailed, within 40`,
          [r.status, m.reader, m.beforeRun, o.sent + o.left, o.other, o.sent > 0, o.total <= 40],
          [200, 13 + more, 25 + more, baseline.outcome.sent + baseline.outcome.left, baseline.outcome.other, true, true]);
      }
      {
        seed(20, { kind: "every" });
        world.missingTables = ["org_groups"];
        const r = await remind(bodyFor("course", team));
        const o = outcome((r.body.results as Row[] | undefined) ?? []);
        const byGroup = new Set([team[5], team[6], team[7], team[8]]);
        const results = (r.body.results as Row[] | undefined) ?? [];
        eq("a database without org_groups (before 0067): 200, no groups; the four reached only through a group read \"not assigned this course\", within 40",
          [r.status, results.filter((x) => byGroup.has(String(x.userId))).map((x) => x.reason), o.sent > 0, o.total <= 40],
          [200, ["not assigned this course", "not assigned this course", "not assigned this course", "not assigned this course"], true, true]);
      }
    }

    // A journey target does not use the course's read: its calls and its
    // learners emailed are as before, in every world.
    for (const kind of ["plain", "every"] as const) {
      for (const n of [20, 50]) {
        console.log(`\nPOST /api/manager/remind, a journey target, a team of ${n} (${kind})`);
        const team = seed(n, { kind });
        const r = await remind(bodyFor("journey", team));
        const o = outcome((r.body.results as Row[] | undefined) ?? []);
        eq("200, the whole request with the middleware's call: 33 calls, within 40 (before ADR 0029's count: 30 calls, 6 emailed)", [r.status, o.total, o.total <= 40], [200, 33, true]);
        eq(`…9 emailed, the other ${n - 9} answered as not sent for room, nobody else`, [o.sent, o.left, o.other], [9, n - 9, []]);
        const claimed = world.tables.journey_enrollments.filter((e) => e.last_daily_reminder_on !== null).length;
        eq("…today's reminder claimed for those emailed only: the rest can be reminded later today", claimed, 9);
      }
    }
    {
      console.log("\nauthorizeManager and sendReminders, a journey target, a team of 20: the budget holds every call");
      const team = seed(20);
      const { budget, error } = await direct(bodyFor("journey", team));
      eq("the request answers", error, null);
      eq("the budget's count is the calls made, with the middleware's, and at most 40", [budget.calls, budget.calls <= 40], [calls.length + MIDDLEWARE_CALLS, true]);
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
