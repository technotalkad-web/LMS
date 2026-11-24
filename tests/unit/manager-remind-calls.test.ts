/**
 * A manager's "send reminder now" (POST /api/manager/remind,
 * lib/manager/actions.ts sendReminders) stays inside one request's calls
 * (ADR 0029 rule FP2, gate G3), over the stubbed world of
 * tests/unit/mail-world.ts with working mail.
 *
 * Measured before, over this stub, for a team of 20 on a course target: 49
 * calls with the middleware's, 9 learners emailed (50 in this file's world,
 * where each learner also holds a journey enrolment, whose credited days
 * are one read more). Its budget assumed 16 calls of its own
 * (MANAGER_REQUEST_OWN_CALLS) where it had made 29 before its run opened:
 * the session, the membership, the reporting line, the addresses, the
 * coverage, the course and its mapping, the Report Card's reads of the
 * learners (computeLearnerInsights) and the reminder state. A journey
 * target made 30 calls and emailed 6 (14 made before its run, 16 assumed):
 * within 40 already, so its cases pin the calls and the learners emailed
 * exactly, which moved.
 *
 * The request now counts from its first call (the middleware's), each call
 * where it is made, every page and fallback of those reads included, and
 * its run opens on that one budget. So its mail stops where the 40 calls
 * of rule FP2 do, and the rest is answered as not sent for room ("try
 * again"). Each case pins the calls and the learners emailed exactly, and
 * a direct call with a budget of the test's own checks that the budget's
 * count is the calls really made, so a read left uncounted shows. With no
 * room left after the reads for the run's first send (its opening, its
 * template, one send and its group's tail), the run is not opened and
 * every learner due is answered as left for room.
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
const PATH = "0d000000-0000-4000-8000-0000000000e1";
const TEAM = "0d000000-0000-4000-8000-0000000000a1";
const STATIC_GROUP = "0d000000-0000-4000-8000-0000000000d1";
const DYNAMIC_GROUP = "0d000000-0000-4000-8000-0000000000d2";
const PROGRAM = "0d000000-0000-4000-8000-0000000000b1";
const JVERSION = "0d000000-0000-4000-8000-0000000000b2";
const learner = (i: number) => `0b000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const enrolment = (i: number) => `0e400000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** The words of a reminder the request had no room for. */
const NO_ROOM = "not sent: the request had no room left; try again";

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
type Call = { method: string; path: string; table: string };
let calls: Call[] = [];
const fetchAll = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  calls.push({ method, path: url.pathname, table: url.pathname.replace("/rest/v1/", "") });
  if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify(USER), { status: 200, headers: { "content-type": "application/json" } });
  return worldStub(input, init);
};

/** The middleware's one call (its session read) on every request, which the stub does not run. */
const MIDDLEWARE_CALLS = 1;

/**
 * An organisation of the manager and a team of `n` learners who report to
 * them, with working mail. Each learner is assigned COURSE directly and has
 * not started it; on a journey target each has an active enrolment with
 * something pending today. `rich` turns on the reads a plain world never
 * makes: a path with a released course assigned to a team, a static and a
 * dynamic group assigned COURSE, attempts on a version, a credited journey
 * day with its version's day ids, and a revision visit.
 */
function seed(n: number, opts: { rich?: boolean } = {}) {
  const team = Array.from({ length: n }, (_, i) => learner(i + 1));
  const rich = opts.rich === true;
  freshWorld({
    members: [
      { organization_id: ORG, user_id: MANAGER, role: "user", status: "active" },
      ...team.map((user_id, i) => ({ organization_id: ORG, user_id, role: "user", status: "active", line_manager_id: MANAGER, business_vertical: i % 2 === 0 ? "V1" : "V2" })),
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
      learning_paths: rich ? [{ id: PATH, organization_id: ORG, name: "Path P", is_active: true }] : [],
      learning_path_courses: rich ? [{ path_id: PATH, course_id: COURSE_2, step_number: 1, release_at: null }] : [],
      learning_path_assignments: rich
        ? [{ id: "0e500000-0000-4000-8000-000000000001", organization_id: ORG, path_id: PATH, assignee_type: "team", user_id: null, team_id: TEAM, group_id: null, due_at: null, release_at: null, assigned_at: "2026-11-01T09:00:00Z" }]
        : [],
      team_members: rich ? team.slice(0, 5).map((user_id) => ({ team_id: TEAM, user_id })) : [],
      org_groups: rich
        ? [
            { id: STATIC_GROUP, organization_id: ORG, name: "Static S", group_type: "static", rules: {}, is_active: true },
            { id: DYNAMIC_GROUP, organization_id: ORG, name: "Dynamic D", group_type: "dynamic", rules: { verticals: ["V1"] }, is_active: true },
          ]
        : [],
      org_group_members: rich ? team.slice(0, 3).map((user_id) => ({ group_id: STATIC_GROUP, user_id })) : [],
      journey_programs: [{ id: PROGRAM, organization_id: ORG, name: "Journey J", is_active: true, deadline_days: null }],
      journey_versions: [{ id: JVERSION, day_ids: {} }],
      course_versions: [{ id: VERSION, course_id: COURSE, manifest_data: {} }],
      course_attempts: rich
        ? team.slice(0, 2).map((user_id, i) => ({
            id: `0a100000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, user_id, organization_id: ORG, course_version_id: VERSION,
            status: "in_progress", score: null, started_at: "2026-11-10T09:00:00Z", completed_at: null, last_activity_at: "2026-11-10T09:30:00Z",
            completion_status: "incomplete", success_status: "unknown", is_revision: false, context_kind: "individual", progress_pct: 10, units: null,
          }))
        : [],
      course_assignments: [
        ...team.map((user_id, i) => ({
          id: `0e300000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, organization_id: ORG, course_id: COURSE, assignee_type: "user",
          user_id, team_id: null, group_id: null, due_at: null, release_at: null, assigned_at: "2026-11-01T09:00:00Z",
        })),
        ...(rich
          ? [STATIC_GROUP, DYNAMIC_GROUP].map((group_id, i) => ({
              id: `0e310000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, organization_id: ORG, course_id: COURSE, assignee_type: "group",
              user_id: null, team_id: null, group_id, due_at: null, release_at: null, assigned_at: "2026-11-01T09:00:00Z",
            }))
          : []),
      ],
      journey_enrollments: team.map((user_id, i) => ({
        id: enrolment(i + 1), organization_id: ORG, user_id, program_id: PROGRAM, version_id: JVERSION,
        status: "active", start_date: "2026-11-01", last_daily_reminder_on: null,
        journey_versions: { days: [{ day: 1, course_id: COURSE, mission_title: "Mission 1" }], days_total: 10, count_sundays: true, unlock_mode: "calendar" },
        journey_programs: { id: PROGRAM, name: "Journey J", is_active: true, deadline_days: null },
      })),
      journey_day_progress: rich ? [{ id: "0e600000-0000-4000-8000-000000000001", enrollment_id: enrolment(1), day_number: 1, completed_at: "2026-11-02T09:00:00Z", course_id: COURSE, day_id: null }] : [],
      reminder_state: [],
      attempt_requests: [],
      revision_visits: rich ? [{ id: "0e700000-0000-4000-8000-000000000001", organization_id: ORG, user_id: team[0], course_id: COURSE, launched_at: "2026-11-11T09:00:00Z" }] : [],
      mv_course_performance: [],
    },
    rpc: {
      effective_attempt_policies: () => [],
      journey_reminder_counts: (body) => ((body?.p_ids as string[] | undefined) ?? []).map((id) => ({ enrollment_id: id, done_days: 0, done_today: false, credited: [] })),
    },
  });
  calls = [];
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
      other: results.filter((x) => x.status !== "sent" && !(x.status === "failed" && x.reason === NO_ROOM)).map((x) => `${x.status}: ${x.reason}`),
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
      if (actions.isActionError(a)) throw new Error(a.error);
      const r = await actions.sendReminders(a, body as Parameters<typeof actions.sendReminders>[1]);
      if (actions.isActionError(r)) throw new Error(r.error);
      return { budget, results: r.results as unknown as Row[] };
    };

    // The reads before the run, by target, with the middleware's call: the
    // course's 30 (the session 1, the membership 2, the reporting line 1,
    // the addresses 1, the coverage 3, the course 1, its mapping 1, the
    // Report Card's reads 18, the reminder state 1), the journey's 14 (the
    // session 1, the membership 2, the reporting line 1, the addresses 1,
    // the coverage 3, the time zone 1, the enrolments 1, their mapping 1,
    // the credited days 1, and the middleware's). The run then opens (3)
    // and reads its template (1). A course group's tail holds its log row
    // and the state write, and the reminder state's write; a journey group's
    // its claim before, and up to four give-backs after.
    for (const [target, total, emailed, before] of [["course", 38, 1, "50 calls, 9 emailed"], ["journey", 33, 9, "30 calls, 6 emailed"]] as const) {
      for (const n of [20, 50]) {
        console.log(`\nPOST /api/manager/remind, a ${target} target: a team of ${n}`);
        const team = seed(n);
        const r = await remind(bodyFor(target, team));
        const o = outcome((r.body.results as Row[] | undefined) ?? []);
        eq(`200, the whole request with the middleware's call: ${total} calls, within 40 (before, at 20: ${before})`, [r.status, o.total, o.total <= 40], [200, total, true]);
        eq(`…${emailed} emailed, the other ${n - emailed} answered as not sent for room ("try again"), nobody else`, [o.sent, o.left, o.other], [emailed, n - emailed, []]);
        const sentRows = world.log.filter((x) => x.status === "sent").length;
        eq("…a notification_log row for each one emailed, and none for the rest", sentRows, emailed);
        if (target === "journey") {
          const claimed = world.tables.journey_enrollments.filter((e) => e.last_daily_reminder_on !== null).length;
          eq("…today's reminder claimed for those emailed only: the rest can be reminded later today", claimed, emailed);
        }
      }
    }

    // The budget's count is the calls really made: a direct call with a
    // budget of the test's own, which then holds every call of the request.
    for (const target of ["course", "journey"] as const) {
      console.log(`\nauthorizeManager and sendReminders, a ${target} target, a team of 20: the budget holds every call`);
      const team = seed(20);
      const { budget, results } = await direct(bodyFor(target, team));
      eq("the budget's count is the calls made, with the middleware's", budget.calls, calls.length + MIDDLEWARE_CALLS);
      eq("…and at most 40", budget.calls <= 40, true);
      void results;
    }

    // Every read a plain world does not make: a path with its course (a
    // team's assignment), a static and a dynamic group assigned the course
    // (their members), attempts on a version, a journey's credited day and
    // its version's day ids, and a revision visit. They are made before the
    // run; counted, they leave no room for its first send on a course
    // target, so the run is not opened and every learner due is answered as
    // left for room. The journey's reads are not the Report Card's.
    for (const target of ["course", "journey"] as const) {
      console.log(`\nPOST /api/manager/remind, a ${target} target, a team of 20, with every read on`);
      let team = seed(20, { rich: true });
      const { budget } = await direct(bodyFor(target, team));
      eq("the budget's count is the calls made, with the middleware's, every read of the rich world included", budget.calls, calls.length + MIDDLEWARE_CALLS);
      team = seed(20, { rich: true });
      const r = await remind(bodyFor(target, team));
      const o = outcome((r.body.results as Row[] | undefined) ?? []);
      const opened = calls.some((c) => c.table === "rpc/tenant_mail_status");
      if (target === "course") {
        eq("200, 37 calls, all before any mail, the run not opened, within 40", [r.status, o.total, opened, o.total <= 40], [200, 37, false, true]);
        eq("…nobody emailed, all 20 answered as not sent for room", [o.sent, o.left, o.other], [0, 20, []]);
      } else {
        eq("200, the journey's reads do not change: 33 calls, within 40", [r.status, o.total, opened, o.total <= 40], [200, 33, true, true]);
        eq("…9 emailed, the other 11 answered as not sent for room", [o.sent, o.left, o.other], [9, 11, []]);
      }
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
