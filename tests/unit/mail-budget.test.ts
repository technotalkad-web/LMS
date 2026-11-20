/**
 * The budgets of a request and of a cron call (ADR 0029, rules T4, T5, FP2
 * and FP3 of the notes of 2026-11-18; lib/notifications/smtp-state.ts), the
 * run's cases. The routes' sums come with stage 2.
 *   - the rule: at most 40 calls (0.8 of the plan's 50) for a request or a
 *     cron call; an alert's cost and a scheduled call's two sums;
 *   - an ESTIMATE, not proof: the sum of an administrator's request adds the
 *     code's call costs to read counts typed by hand. It is labelled so until
 *     gate G3 measures the routes;
 *   - the two cron routes, run here over the stubbed world (ADR 0029, note of
 *     2026-11-21, part 2): the reminders call's calls before its first send,
 *     read by read, for one set of data (the sum gate G3's reminders line
 *     is compared with); the route's own count equals the requests it made,
 *     paged reads included; a whole call never passes 40; a paged read that
 *     takes one page more than fits stops the run with call_limit, ended by
 *     the count; and a journey-nudges call with no alert due has room for a
 *     full page (500 due learners, 500 managers) and its first group;
 *   - the counted calls are the calls made: the budget's count equals the
 *     requests the run sent, for a run of sends, a stopped run and an alert;
 *   - under a clock the test sets: no send starts after the window (45 s for
 *     a request, 240 s for a cron call) and none beyond the count; what is
 *     left is reported, with no row;
 *   - the runs of one cron call share one clock and one count;
 *   - the first send of a run goes alone; opening a run costs the same for 50
 *     recipients as for 5;
 *   - pull request B's bulk file carries neither budget.
 *
 * Part (k) of tests/unit/org-membership.test.ts keeps its own cron cases
 * (each named read with no room, the finished attempts' filter); the sums
 * and the boundary are here.
 *
 * Under the stubbed fetch of tests/unit/mail-world.ts. No database, no network.
 *
 * Run:  npx tsx tests/unit/mail-budget.test.ts   (or npm run test:unit)
 */
import { ORG, OTHER_ORG, PLATFORM_ENV, SERVER_ROW_CAP, captureLogs, eq, finish, freshWorld, installStub, logRows, outbound, removeStub, requests, sends, world, type Row } from "./mail-world";
import {
  ADMIN_REQUEST_OWN_CALLS,
  ALERT_CALL_COST,
  CALL_SUM_LIMIT,
  CRON_SEND_WINDOW_MS,
  MAIL_CALL_COSTS,
  REQUEST_SEND_WINDOW_MS,
  SENDS_AT_ONCE,
  cronBudget,
  hasRoom,
  openRun,
  requestBudget,
  sendDueAlert,
  unboundedBudget,
} from "../../lib/notifications/smtp-state";
import { WORKERS_SUBREQUEST_BUDGET } from "../../lib/integrations/webhook-hold";
import { sendMany } from "../../lib/notifications/send";

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `0b000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, email: `person${i + 1}@tenant.stub` }));
const mailTo = (p: { id: string; email: string }) => ({ event: "asset_assignment" as const, to: { user_id: p.id, email: p.email }, context: {} });

async function main() {
  installStub();
  try {
    console.log("\nthe rule (FP2)");
    eq("at most 40 calls: 0.8 of the plan's 50", [WORKERS_SUBREQUEST_BUDGET, CALL_SUM_LIMIT], [50, 40]);
    eq("N is 4 on the free plan", SENDS_AT_ONCE, 4);
    eq("the windows: 45 s for a request, 240 s for a cron call", [REQUEST_SEND_WINDOW_MS, CRON_SEND_WINDOW_MS], [45_000, 240_000]);
    eq("opening a run costs three calls (the settings, the organisation, the state with its count)", MAIL_CALL_COSTS.open, 3);
    eq("an alert costs at most 25 calls: within one call's sum, with room left for other work", [ALERT_CALL_COST, ALERT_CALL_COST <= CALL_SUM_LIMIT], [25, true]);
    eq("a scheduled call's two sums: with an alert, at most 15 calls remain for its own mail", CALL_SUM_LIMIT - ALERT_CALL_COST, 15);

    console.log("\nAN ESTIMATE until gate G3 measures the routes: an administrator's request (rule FP2), from the code's costs and read counts typed by hand");
    {
      // ESTIMATE. The read counts below are typed by hand from reading the
      // routes; no route is run here. Gate G3 measures each route on staging,
      // and its numbers replace these. The scheduled calls are run below.
      // An administrator's request: its own calls, the mail part's reads (a
      // title, the members that count, a team or group, the addresses), the
      // opening of its run, and one first send with its group's tail.
      const mailReads = 1 + 2 + 2 + 1;
      const firstGroup = MAIL_CALL_COSTS.template + MAIL_CALL_COSTS.send + MAIL_CALL_COSTS.logInsert + MAIL_CALL_COSTS.stateWrite + MAIL_CALL_COSTS.alertMark;
      eq("estimate (hand-typed read counts; gate G3 measures the routes): an administrator's request, its own work, its reads and a first mail fit the 40", ADMIN_REQUEST_OWN_CALLS + mailReads + MAIL_CALL_COSTS.open + firstGroup <= CALL_SUM_LIMIT, true);
      eq("from the code's alert cost (the alert itself is run below): with an alert due, the alert alone fits, and what it leaves is what the call's own mail may use", [ALERT_CALL_COST <= CALL_SUM_LIMIT, CALL_SUM_LIMIT - ALERT_CALL_COST], [true, 15]);
    }

    await cronRouteCases();

    console.log("\nthe counted calls are the calls made");
    {
      freshWorld();
      const b = requestBudget();
      const run = await openRun({ organizationId: ORG, budget: b });
      await sendMany(run, people(7), mailTo);
      eq("a run of seven sends: the budget's count equals the requests (open 3, template 1, sends 7, log inserts 3, one state write)", [b.calls, outbound()], [outbound(), 3 + 1 + 7 + 3 + 1]);
      freshWorld({ smtp: () => ({ ok: false, error: "Connection refused" }) });
      const b2 = requestBudget();
      const stopped = await openRun({ organizationId: ORG, budget: b2 });
      await sendMany(stopped, people(9), mailTo);
      eq("a run stopped on a dead SMTP (three sends, their writes and the alert's mark): the count equals the requests", b2.calls, outbound());
      const members = [{ organization_id: ORG, user_id: "s1", role: "super_owner", status: "active" }, { organization_id: ORG, user_id: "a1", role: "admin", status: "active" }];
      freshWorld({ state: { organization_id: ORG, state: "failing", state_changed_at: new Date().toISOString(), failed_recipients: [], last_error_code: "auth", alert_due_at: new Date(Date.now() - 60_000).toISOString() }, members, profiles: { s1: "s1@tenant.stub", a1: "a1@tenant.stub" } });
      const b3 = cronBudget();
      const alert = await sendDueAlert({ baseUrl: "https://lms.stub", env: PLATFORM_ENV, budget: b3 });
      eq("an alert to two administrators: sent, and its count covers its requests and stays within its cost", [alert.kind, b3.calls >= outbound(), b3.calls <= ALERT_CALL_COST], ["sent", true, true]);
      freshWorld();
      const b4 = cronBudget();
      await sendDueAlert({ baseUrl: "https://lms.stub", env: PLATFORM_ENV, budget: b4 });
      eq("a call that finds no alert due pays the one read", [b4.calls, outbound()], [1, 1]);
    }

    console.log("\nthe count");
    {
      freshWorld();
      const b = requestBudget({ spent: 20 });
      const run = await openRun({ organizationId: ORG, budget: b });
      const r = await sendMany(run, people(30), mailTo);
      const sent = r.filter((x) => x.status === "sent").length;
      const left = r.filter((x) => x.errorClass === "left").length;
      eq("a request that spent 20 on its own work: no send beyond its count, the sum stays within 40", [b.calls <= CALL_SUM_LIMIT, outbound() + 20 <= CALL_SUM_LIMIT], [true, true]);
      eq("…it sends some and leaves the rest, reported as left", [sent > 0, left > 0, sent + left], [true, true, 30]);
      eq("…the left ones have no row and were not attempted", [logRows().length, r.filter((x) => x.errorClass === "left").every((x) => x.attempted === false)], [sent, true]);
      eq("…the run reports what it left", run.report.notAttempted.left, left);
    }

    console.log("\nthe clock");
    {
      let t = 0;
      const clock = () => t;
      freshWorld();
      const b = requestBudget({ now: clock });
      const run = await openRun({ organizationId: ORG, budget: b, now: clock });
      const slow = { n: 0 };
      world.smtp = () => { slow.n++; t += 10_000; return { ok: true }; };
      const r = await sendMany(run, people(12), mailTo);
      eq("10 s a send: the sends that start before 45 s go, none starts after it", [r.filter((x) => x.status === "sent").length, r.filter((x) => x.errorClass === "left").length, hasRoom(b, 0)], [5, 7, false]);
      eq("…a request's window is 45 s and a cron call's 240 s", [requestBudget({ now: () => 0 }).windowMs, cronBudget({ now: () => 0 }).windowMs], [45_000, 240_000]);
    }

    console.log("\none cron call: its runs share one clock and one count");
    {
      freshWorld();
      const b = cronBudget();
      const first = await openRun({ organizationId: ORG, budget: b });
      const a = await sendMany(first, people(12), mailTo);
      const afterFirst = b.calls;
      const second = await openRun({ organizationId: OTHER_ORG, budget: b });
      const c = await sendMany(second, people(12), mailTo);
      eq("the second organisation's run draws on what the first left", [afterFirst > 0, b.calls <= CALL_SUM_LIMIT, a.filter((x) => x.status === "sent").length + c.filter((x) => x.status === "sent").length < 24], [true, true, true]);
      eq("…and leaves the rest for the next call", c.some((x) => x.errorClass === "left"), true);
    }

    console.log("\nthe shape and the opening");
    {
      for (const n of [5, 50]) {
        freshWorld();
        const run = await openRun({ organizationId: ORG, budget: unboundedBudget() });
        const before = requests.length;
        eq(`opening a run for ${n} recipients costs three calls`, before, 3);
        await sendMany(run, people(n), mailTo);
        const firstLog = requests.findIndex((q) => q.table === "notification_log");
        eq(`…its first send goes alone (${n})`, requests.slice(0, firstLog).filter((q) => q.path === "/functions/v1/send-smtp").length, 1);
      }
      freshWorld();
      const bulk = await openRun({ organizationId: ORG, budget: unboundedBudget() });
      const r = await sendMany(bulk, people(60), mailTo);
      eq("pull request B's bulk file carries neither budget: sixty sent, none left", [r.filter((x) => x.status === "sent").length, sends().length], [60, 60]);
    }
  } finally {
    removeStub();
  }
  finish();
}

/* -------------------------------------------- the two cron routes, run here */

const CRON_SECRET = "stub-cron-secret-0029";
const COURSE = "c-0029";
const SETTING: Row = {
  course_id: COURSE, enabled: true, cadence_days: 1, cap_days: 30,
  courses: { id: COURSE, title: "Course A", organization_id: ORG, organizations: { name: "Tenant A", slug: "tenant-a", deleted_at: null } },
};
const memberId = (i: number) => `m-${String(i).padStart(5, "0")}`;
const assignment = (type: "user" | "team" | "group", ref: string): Row => ({
  id: `a-${type}-${ref}`, course_id: COURSE, organization_id: ORG, assignee_type: type,
  user_id: type === "user" ? ref : null, team_id: type === "team" ? ref : null, group_id: type === "group" ? ref : null, release_at: null, source: "admin",
});
/**
 * One organisation with `members` active members (every one an address), a
 * course with reminders on, assigned to the first `direct` members by name,
 * and, when asked, to a team and to a static group of two members each, and
 * to a dynamic group whose rule names that team.
 */
function reminderWorld(o: { members: number; direct: number; teamAndGroup?: boolean; dynamicGroup?: boolean; state?: Row[] }) {
  const ids = Array.from({ length: o.members }, (_, i) => memberId(i));
  const rows = ids.slice(0, o.direct).map((u) => assignment("user", u));
  if (o.teamAndGroup) rows.push(assignment("team", "t-0029"), assignment("group", "g-0029"));
  if (o.dynamicGroup) rows.push(assignment("group", "g-dyn"));
  freshWorld({
    members: ids.map((u) => ({ organization_id: ORG, user_id: u, role: "user", status: "active" })),
    profiles: Object.fromEntries(ids.map((u) => [u, `${u}@tenant.stub`])),
    tables: {
      course_reminder_settings: [{ ...SETTING }],
      course_assignments: rows,
      team_members: [memberId(o.members - 1), memberId(o.members - 2)].map((u) => ({ team_id: "t-0029", user_id: u })),
      org_groups: [
        { id: "g-0029", organization_id: ORG, group_type: "static", rules: {}, is_active: true },
        { id: "g-dyn", organization_id: ORG, group_type: "dynamic", rules: { team_ids: ["t-0029"] }, is_active: true },
      ],
      org_group_members: [memberId(o.members - 3), memberId(o.members - 4)].map((u) => ({ group_id: "g-0029", user_id: u })),
      course_attempts: [],
      reminder_state: o.state ?? [],
    },
  });
}
/** `n` reminder_state rows of other people, each reminded an hour ago: they only make the state read longer. */
const stateRowsOf = (n: number): Row[] => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return Array.from({ length: n }, (_, i) => ({ user_id: `x-${String(i).padStart(6, "0")}`, course_id: COURSE, first_assigned_at: at, last_nudge_at: at, nudge_count: 1, stopped: false }));
};
/** The requests a cron call made before its heartbeat: the heartbeat's read and write come after the call's own work. */
const callRequests = () => requests.filter((r) => r.table !== "ops_heartbeats");
/** How many requests went to each table (a function as rpc/<name>, a send as send-smtp), before the first send when asked. */
function perTable(beforeFirstSend: boolean): Record<string, number> {
  const end = beforeFirstSend ? requests.findIndex((r) => r.path === "/functions/v1/send-smtp") : requests.length;
  const out: Record<string, number> = {};
  for (const r of requests.slice(0, end < 0 ? requests.length : end)) {
    const k = r.path === "/functions/v1/send-smtp" ? "send-smtp" : r.table;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
/** The reads of one table (its writes left out). */
const readsOf = (table: string) => requests.filter((r) => r.table === table && r.method === "GET").length;

/**
 * One journey program of the organisation, with `n` learners enrolled and
 * behind, each with a manager of their own; every one an address.
 */
function nudgeWorld(n: number) {
  const START = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
  const VERSION = { days: Array.from({ length: 10 }, (_, i) => ({ day: i + 1, course_id: COURSE, mission_title: `Mission ${i + 1}` })), days_total: 10, count_sundays: true, unlock_mode: "calendar" };
  const learners = Array.from({ length: n }, (_, i) => `l-${String(i).padStart(3, "0")}`);
  const managers = learners.map((u) => `${u}-mgr`);
  freshWorld({
    members: [
      ...learners.map((u, i) => ({ organization_id: ORG, user_id: u, role: "user", status: "active", line_manager_id: managers[i] })),
      ...managers.map((u) => ({ organization_id: ORG, user_id: u, role: "user", status: "active", line_manager_id: null })),
    ],
    profiles: Object.fromEntries([...learners, ...managers].map((u) => [u, `${u}@tenant.stub`])),
    tables: {
      journey_programs: [{
        id: "p-0029", organization_id: ORG, name: "Journey A", is_active: true, nudge_enabled: true, current_version_id: "jv-0029",
        nudge_cooldown_days: 3, reminder_hour: 0, deadline_days: null, escalation_enabled: true, escalation_after_days: 1,
        organizations: { name: "Tenant A", slug: "tenant-a", deleted_at: null },
      }],
      gamification_settings: [],
      journey_enrollments: learners.map((u, i) => ({
        id: `e-${String(i).padStart(3, "0")}`, user_id: u, program_id: "p-0029", status: "active", start_date: START,
        last_nudged_at: null, last_daily_reminder_on: null, journey_versions: VERSION,
      })),
      courses: [],
    },
    rpc: {
      // Nothing credited yet: every learner is behind.
      journey_reminder_counts: (body) => ((body?.p_ids as string[] | undefined) ?? []).map((id) => ({ enrollment_id: id, done: 0, done_today: false, credited: [] })),
    },
  });
}

async function cronRouteCases() {
  process.env.CRON_SECRET = CRON_SECRET;
  const reminders = await import("../../app/api/cron/reminders/route");
  const nudges = await import("../../app/api/cron/journey-nudges/route");
  const realNow = Date.now;
  /** Run a cron route; with `endClockAt`, the call's 240 seconds end when that table is first read. */
  const runCron = async (route: { POST: (r: never) => Promise<Response> }, path: string, endClockAt?: string) => {
    let clock = realNow();
    let ended = false;
    if (endClockAt) world.onRequest = (r) => { if (!ended && r.table === endClockAt) { ended = true; clock += 300_000; } };
    Date.now = () => clock;
    try {
      const { value, lines } = await captureLogs(async () => {
        const res = await route.POST(new Request(`http://lms.stub${path}`, { method: "POST", headers: { "x-cron-secret": CRON_SECRET } }) as never);
        return { status: res.status, body: (await res.json()) as Row };
      });
      const noRoom = lines.map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).filter((l): l is Row => l?.event === "cron_no_room");
      return { ...value, noRoom };
    } finally {
      Date.now = realNow;
    }
  };
  const remind = (endClockAt?: string) => runCron(reminders as never, "/api/cron/reminders", endClockAt);

  console.log("\nthe reminders call (note of 2026-11-21, part 2 (b)): its calls before the first send, read by read, for one set of data");
  {
    // 2,500 members that count (three pages), three learners named, a team
    // and a static group of two each; no finished attempt, no state yet.
    reminderWorld({ members: 2500, direct: 3, teamAndGroup: true });
    const r = await remind();
    // The sum gate G3's reminders line is compared with, read by read.
    const READ_BY_READ: Record<string, number> = {
      course_reminder_settings: 1, // the courses with reminders on: one page
      organizations: 1 + 1, // the members' organisation, then the run's opening
      organization_members: Math.ceil(2500 / SERVER_ROW_CAP), // the members that count: one call for each 1,000 rows
      course_assignments: 1, // one list of 150 courses, one page
      team_members: 1, // one list of 150 teams, one page
      org_groups: 1 + 1, // the route's own read of the groups, then the group reader's
      org_group_members: 1, // the static group's rows, one page
      course_attempts: 1, // the finished attempts, one page
      reminder_state: 1, // the state, one page
      profiles: 1, // one list of 150 addresses
      notification_settings: 1, // the run's opening
      "rpc/tenant_mail_status": 1, // the run's opening
      notification_templates: 1, // the first mail of the event reads its template
    };
    const SUM = Object.values(READ_BY_READ).reduce((a, b) => a + b, 0);
    eq("reminders, 2,500 members, three people, a team and a group: 200, and the call reminds them", [r.status, r.body.ok, Number(r.body.sent) > 0], [200, true, true]);
    eq(`…the calls before the first send, read by read (${SUM} in all)`, sorted(perTable(true)), sorted(READ_BY_READ));
  }

  console.log("\nthe reminders call: the route's own count is the requests it made, paged reads included (rule FP2)");
  {
    // 4,305 members that count: the members' read is six requests (the
    // organisation and five pages). The clock ends at the addresses, so the
    // call stops at the opening of its run and its fixed line carries the
    // count it kept.
    reminderWorld({ members: 4305, direct: 2 });
    const r = await remind("profiles");
    const line = r.noRoom[0];
    eq("reminders, 4,305 members, the clock ended at the addresses: 500, call_limit, one fixed line", [r.status, r.noRoom.length, line?.ended_by], [500, 1, "clock"]);
    eq("…the members' read made one request for the organisation and one for each 1,000 rows", [readsOf("organizations"), readsOf("organization_members")], [1, Math.ceil(4305 / SERVER_ROW_CAP)]);
    eq("…the count in the line equals the requests the call made", line?.calls, callRequests().length);
  }
  {
    // The group readers too: a team, a static group, and a dynamic group whose
    // rule names the team, so the dynamic group reads the members' pages and
    // the team again. Every call each reader makes is in the count.
    reminderWorld({ members: 4305, direct: 2, teamAndGroup: true, dynamicGroup: true });
    const r = await remind("profiles");
    const line = r.noRoom[0];
    eq("reminders, 4,305 members, a team, a static and a dynamic group, the clock ended at the addresses: 500, call_limit, one fixed line",
      [r.status, r.noRoom.length, line?.ended_by], [500, 1, "clock"]);
    eq("…the dynamic group read the members in their pages and its rule's team: two member reads of five pages, two team reads, three group reads",
      [readsOf("organization_members"), readsOf("team_members"), readsOf("org_groups")], [2 * Math.ceil(4305 / SERVER_ROW_CAP), 2, 3]);
    eq("…the count in the line equals the requests the call made, the group readers' included", line?.calls, callRequests().length);
  }
  {
    // A call with more due than fits: it fills its count and leaves the rest.
    reminderWorld({ members: 4305, direct: 60 });
    const r = await remind();
    eq("reminders, 4,305 members and 60 due: the call sends some, leaves the rest, and its requests before the heartbeat never pass 40",
      [r.status, Number(r.body.sent) > 0, Number(r.body.left) > 0, callRequests().length <= CALL_SUM_LIMIT], [200, true, true, true]);
  }

  console.log("\nthe reminders call: a paged read that takes one page more than fits stops the run, ended by the count (note of 2026-11-21, part 2 (a) and (b))");
  {
    // Before the state: the settings, the organisation, one page of members,
    // the assignments and the finished attempts. Every read before the sends
    // keeps back the write that stops reminders past their cap, the opening
    // and a first group; the addresses then take one call more.
    const before = 1 + 1 + 1 + 1 + 1;
    const reserve = 1 + MAIL_CALL_COSTS.open + MAIL_CALL_COSTS.template + MAIL_CALL_COSTS.send + MAIL_CALL_COSTS.logInsert + MAIL_CALL_COSTS.stateWrite + MAIL_CALL_COSTS.alertMark + 1;
    const fit = CALL_SUM_LIMIT - reserve - 1 - before;
    /** State rows that take exactly `pages` requests to read (the last page short). */
    const rowsFor = (pages: number) => (pages - 1) * SERVER_ROW_CAP + SERVER_ROW_CAP / 2;
    reminderWorld({ members: 10, direct: 2, state: stateRowsOf(rowsFor(fit)) });
    const fits = await remind();
    eq(`reminders, the state in ${fit} pages (as many as leave room for the addresses and a first group): 200, the first reminder sent, the other left for the next call`,
      [fits.status, fits.body.ok, readsOf("reminder_state"), Number(fits.body.sent), Number(fits.body.left), fits.noRoom.length], [200, true, fit, 1, 1, 0]);
    reminderWorld({ members: 10, direct: 2, state: stateRowsOf(rowsFor(fit + 2)) });
    const over = await remind();
    eq(`…the state in ${fit + 2} pages, one more than its read has room for: 500, call_limit in the state read, ended by the count, nobody mailed`,
      [over.status, over.body.ok, over.body.stopped_before_send, over.noRoom.length, over.noRoom[0]?.step, over.noRoom[0]?.ended_by, sends().length], [500, false, true, 1, "state_read", "count", 0]);
    eq("…the count in the line equals the requests the call made", over.noRoom[0]?.calls, callRequests().length);
  }

  console.log("\nthe members that count with no room left to read them whole: the organisation or the program is left for the next call (the hand-over note of 2026-11-19, point 3)");
  {
    // The clock ends at the members' organisation read, so the first page is refused.
    reminderWorld({ members: 10, direct: 2 });
    const r = await remind("organizations");
    eq("reminders: a clean run (200, ok), the organisation counted in left_orgs, the count marked incomplete, nobody mailed, no fixed line, no state written",
      [r.status, r.body.ok, r.body.left_orgs, r.body.left_complete, sends().length, r.noRoom.length, requests.filter((q) => q.table === "reminder_state" && q.method === "POST").length],
      [200, true, 1, false, 0, 0, 0]);
  }

  {
    nudgeWorld(2);
    const r = await runCron(nudges as never, "/api/cron/journey-nudges", "organizations");
    eq("journey nudges: a clean run (200, ok), the program counted in left_orgs, the count marked incomplete, no claim taken, nothing sent",
      [r.status, r.body.ok, r.body.left_orgs, r.body.left_complete, requests.filter((q) => q.table === "journey_enrollments" && q.method === "PATCH").length, sends().length],
      [200, true, 1, false, 0, 0]);
  }

  console.log("\nthe journey-nudges call (note of 2026-11-21, part 2 (c)): with no alert due, room for a full page and its first group");
  {
    nudgeWorld(500);
    const r = await runCron(nudges as never, "/api/cron/journey-nudges");
    const lists = requests.filter((q) => q.table === "profiles").map((q) => (q.query.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(","));
    eq("journey nudges, one full page with no alert due (500 due learners, 500 different managers): 200, every profile read in seven lists, and the first group sent",
      [r.status, r.body.ok, lists.length, new Set(lists.flat()).size, sends().length > 0], [200, true, 7, 1000, true]);
    eq("…the members that count (1,000) were read in their pages, and the call's requests before the heartbeat never pass 40",
      [readsOf("organization_members") >= 2, callRequests().length <= CALL_SUM_LIMIT], [true, true]);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
