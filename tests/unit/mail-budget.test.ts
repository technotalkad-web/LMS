/**
 * The budgets of a request and of a cron call (ADR 0029, rules T4, T5, FP2
 * and FP3 of the notes of 2026-11-18; lib/notifications/smtp-state.ts), the
 * run's cases. The routes' sums come with stage 2.
 *   - the rule: at most 40 calls (0.8 of the plan's 50) for a request or a
 *     cron call; a cron call keeps two of them for its end (the carry's read
 *     and the heartbeat), so its count's limit is 38; an alert's cost and a
 *     scheduled call's two sums;
 *   - an ESTIMATE, not proof: the sum of an administrator's request adds the
 *     code's call costs to read counts typed by hand. It is labelled so until
 *     gate G3 measures the routes;
 *   - the two cron routes, run here over the stubbed world (ADR 0029, note of
 *     2026-11-21, part 2): the reminders call's calls before its first send,
 *     read by read, for one set of data (the sum gate G3's reminders line
 *     is compared with); the route's own count equals the requests it made,
 *     paged reads included; a whole call, its heartbeat included, never
 *     passes 40, a failed one with its carry read neither; a paged read that
 *     takes one page more than fits stops the run with call_limit, ended by
 *     the count; a call that read nobody's people whole for want of room is
 *     call_limit in members_read, by the clock or by the count, while an
 *     organisation or a program left once another's people were read whole
 *     is a clean run, the reminders' members' read keeping back the reads
 *     after it (note of 2026-11-21 (later), point 4); a program with no
 *     room for its line managers' read is left whole (point 1); each group
 *     of escalations writes its marks before the next group, and a failed
 *     mark is state_write (point 2); and a journey-nudges call with no alert
 *     due has room for a full page (500 due learners, 500 managers) and its
 *     first group;
 *   - the reminders' later reads (note of 2026-11-21 (evening), part 1): a
 *     minimal call with someone due makes exactly the listed reads after its
 *     members, once each; with the member pages at the computed maximum the
 *     call still mails, and one extra page halts it in members_read; when
 *     time runs out at the second organisation's row, it halts in
 *     assignments_read and reads nothing more;
 *   - the addresses are read only for the learners the skip rules leave due:
 *     3,000 members that count with five due, and the call sends;
 *   - the counted calls are the calls made: the budget's count equals the
 *     requests the run sent, for a run of sends, a stopped run, a run of
 *     mail whose text the caller gives (no template is read, none counted)
 *     and an alert;
 *   - under a clock the test sets: no send starts after the window (45 s for
 *     a request, 240 s for a cron call) and none beyond the count; what is
 *     left is reported, with no row;
 *   - the runs of one cron call share one clock and one count;
 *   - the first send of a run goes alone; opening a run costs the same for 50
 *     recipients as for 5;
 *   - pull request B's bulk file carries neither budget;
 *   - the state write that misses (the note of 2026-11-22, part 4): its read
 *     again and its write again are counted as made, and a healthy run's sum
 *     does not move; the public routes' job, each limit claimed before the
 *     send, makes at most 40 calls with the calls before its answer, on the
 *     four paths and on a platform owner's own code and link (over
 *     tests/unit/public-mail-world.ts).
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
  CRON_END_CALLS,
  CRON_SEND_WINDOW_MS,
  MAIL_CALL_COSTS,
  REMINDER_LATER_READS,
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
    eq("a scheduled call keeps two calls for its end (the carry's read and the heartbeat), inside the 40: its count's limit is 38; a request's is 40",
      [CRON_END_CALLS, cronBudget().callLimit, requestBudget().callLimit], [2, CALL_SUM_LIMIT - 2, CALL_SUM_LIMIT]);
    eq("an alert costs at most 25 calls: within one call's sum, with room left for other work", [ALERT_CALL_COST, ALERT_CALL_COST <= cronBudget().callLimit], [25, true]);
    eq("a scheduled call's two sums: with an alert, at most 13 calls remain for its own mail", cronBudget().callLimit - ALERT_CALL_COST, 13);

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
      eq("from the code's alert cost (the alert itself is run below): with an alert due, the alert alone fits a scheduled call, and what it leaves is what the call's own mail may use", [ALERT_CALL_COST <= cronBudget().callLimit, cronBudget().callLimit - ALERT_CALL_COST], [true, 13]);
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
      // Mail whose text the caller gives (broadcasts, ticket and
      // attempt-request mail) reads no template, so none is counted.
      freshWorld();
      const b5 = requestBudget();
      const given = await openRun({ organizationId: ORG, budget: b5 });
      await sendMany(given, people(7), (p) => ({ event: "custom_broadcast" as const, to: { user_id: p.id, email: p.email }, context: {}, override: { subject: "Notice", body_md: "Hello" } }));
      eq("a run of seven mails with their own text: no template read, and the count equals the requests (open 3, sends 7, log inserts 3, one state write)",
        [requests.filter((q) => q.table === "notification_templates").length, b5.calls, outbound()], [0, outbound(), 3 + 7 + 3 + 1]);
      const members = [{ organization_id: ORG, user_id: "s1", role: "super_owner", status: "active" }, { organization_id: ORG, user_id: "a1", role: "admin", status: "active" }];
      freshWorld({ state: { organization_id: ORG, state: "failing", state_changed_at: new Date().toISOString(), failed_recipients: [], last_error_code: "auth", alert_due_at: new Date(Date.now() - 60_000).toISOString() }, members, profiles: { s1: "s1@tenant.stub", a1: "a1@tenant.stub" } });
      const b3 = cronBudget();
      const alert = await sendDueAlert({ baseUrl: "https://lms.stub", env: PLATFORM_ENV, budget: b3 });
      eq("an alert to two administrators: sent, and its count covers its requests and stays within its cost", [alert.kind, b3.calls >= outbound(), b3.calls <= ALERT_CALL_COST], ["sent", true, true]);
      // A state write that misses: its read again and its write again are counted as made.
      freshWorld({ smtp: () => ({ ok: false, error: "Connection refused" }), state: { organization_id: ORG, state: "healthy", state_changed_at: new Date(Date.now() - 72 * 3_600_000).toISOString(), last_success_at: new Date(Date.now() - 3_600_000).toISOString(), last_failure_at: null, failed_recipients: [] } });
      let moved = false;
      world.onRequest = (q) => { if (!moved && q.table === "tenant_smtp_state" && q.method === "PATCH" && world.state) { moved = true; world.state.last_failure_at = new Date(Date.now() - 600_000).toISOString(); } };
      const b6 = requestBudget();
      const missed = await openRun({ organizationId: ORG, budget: b6 });
      await sendMany(missed, people(1), mailTo);
      world.onRequest = null;
      eq("a run whose state write missed once: the count equals the requests (open 3, template 1, send 1, log insert 1, write 1, read again 1, write 1)", [b6.calls, outbound()], [outbound(), 3 + 1 + 1 + 1 + 1 + 1 + 1]);
      freshWorld();
      const b7 = requestBudget();
      const healthy = await openRun({ organizationId: ORG, budget: b7 });
      await sendMany(healthy, people(1), mailTo);
      eq("…a healthy run's sum does not move (open 3, template 1, send 1, log insert 1, one state write)", [b7.calls, outbound()], [3 + 1 + 1 + 1 + 1, 3 + 1 + 1 + 1 + 1]);
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
  await publicJobSums();
  finish();
}

/* ------------------------- the public job, its calls before the answer and after it */

/**
 * The public routes' job (the note of 2026-11-22: each limit claimed before
 * the send) on the four paths, and on a platform owner's own code and link
 * on the page with no organisation, over tests/unit/public-mail-world.ts:
 * the calls before the answer and the job's own calls, counted as made, are
 * at most 40 together.
 */
async function publicJobSums() {
  const PW = await import("./public-mail-world");
  PW.install(PW.PLATFORM_ENV);
  try {
    const request = await import("../../app/api/auth/forgot-password/request/route");
    const magic = await import("../../app/api/auth/magic-link/route");
    const LEARNER = { id: "0f100000-0000-4000-8000-000000000001", email: "learner@tenant.stub" };
    const ADMIN = { id: "0f100000-0000-4000-8000-000000000002", email: "admin@tenant.stub" };
    /** A platform owner: in the world's owners, with no membership. */
    const OWNER = { id: "0f100000-0000-4000-8000-000000000003", email: "owner@platform.stub" };
    console.log("\nthe public job: its calls before the answer and after it, together at most 40 (note of 2026-11-22)");
    for (const [label, route, path, who, payload] of [
      ["a tenant reset code", request, "/api/auth/forgot-password/request", LEARNER, { orgSlug: PW.SLUG }],
      ["a tenant sign-in link", magic, "/api/auth/magic-link", LEARNER, { orgSlug: PW.SLUG }],
      ["a platform reset code on the organisation's page", request, "/api/auth/forgot-password/request", ADMIN, { orgSlug: PW.SLUG }],
      ["a platform sign-in link on the organisation's page", magic, "/api/auth/magic-link", ADMIN, { orgSlug: PW.SLUG }],
      ["a platform owner's own reset code on the page with no organisation", request, "/api/auth/forgot-password/request", OWNER, {}],
      ["a platform owner's own sign-in link on the page with no organisation", magic, "/api/auth/magic-link", OWNER, {}],
    ] as const) {
      PW.freshWorld({
        users: [LEARNER, ADMIN, OWNER],
        owners: [OWNER.id],
        members: [
          { organization_id: PW.ORG, user_id: LEARNER.id, role: "user", status: "active" },
          { organization_id: PW.ORG, user_id: ADMIN.id, role: "admin", status: "active" },
        ],
        // A state row whose last delivery is old, so the tenant's send writes it.
        state: { state: "healthy", state_changed_at: new Date(Date.now() - 72 * 3_600_000).toISOString(), last_success_at: new Date(Date.now() - 48 * 3_600_000).toISOString(), last_failure_at: null, failed_recipients: [] },
      });
      const { value } = await PW.captureLogs(async () => {
        const asked = await PW.ask(route, path, { email: who.email, ...payload });
        await PW.runJobs();
        return { before: asked.calls.length, after: PW.requests.length };
      });
      eq(`${label}: ${value.before} calls before the answer and ${value.after} in the job, at most ${CALL_SUM_LIMIT} together, and the mail went`,
        [value.before + value.after <= CALL_SUM_LIMIT, PW.requests.filter((r) => r.path === "/functions/v1/send-smtp").length], [true, 1]);
    }

    // The tenant half of the public job, on its run: the claim, then a send the
    // job's deadline left no time to start (rule T3). The run's count is the
    // requests it made: the send that was not started is not one of them.
    console.log("\na public job whose deadline passed before its send counts exactly the requests it made (the later note of 2026-11-22, part 6)");
    const { claimCredentialMail, sendNotification } = await import("../../lib/notifications/send");
    const { sendTenantSignInLink } = await import("../../lib/auth/auth-email");
    for (const kind of ["password_reset", "magic_link"] as const) {
      PW.freshWorld({ users: [LEARNER], members: [{ organization_id: PW.ORG, user_id: LEARNER.id, role: "user", status: "active" }] });
      const { value } = await PW.captureLogs(async () => {
        const run = await openRun({ organizationId: PW.ORG, budget: requestBudget() });
        const to = { user_id: LEARNER.id, email: LEARNER.email };
        const claim = await claimCredentialMail(run, { event: kind, to }, { link: kind === "magic_link" });
        const noTime = () => 0;
        const r = kind === "magic_link"
          ? await sendTenantSignInLink(run, { userId: LEARNER.id, email: LEARNER.email }, "https://lms.stub/auth/finish?token_hash=t&type=magiclink", { timeLeftMs: noTime })
          : await sendNotification({ organizationId: PW.ORG, event: kind, to, context: { otp_code: "123456", otp_minutes: "10" } }, { run, timeLeftMs: noTime });
        return { claimed: claim.ok, attempted: r.attempted, counted: run.budget.calls, made: PW.requests.length };
      });
      eq(`${kind}: claimed, the send not started, and the run's count equals the requests made (${value.made})`, [value.claimed, value.attempted, value.counted], [true, false, value.made]);
    }
  } finally {
    PW.uninstall();
  }
}

/* -------------------------------------------- the two cron routes, run here */

const CRON_SECRET = "stub-cron-secret-0029";
const COURSE = "c-0029";
const SETTING: Row = {
  course_id: COURSE, enabled: true, cadence_days: 1, cap_days: 30,
  courses: { id: COURSE, title: "Course A", organization_id: ORG, organizations: { name: "Tenant A", slug: "tenant-a", deleted_at: null } },
};
const memberId = (i: number) => `m-${String(i).padStart(5, "0")}`;
const assignment = (type: "user" | "team" | "group" | "org", ref: string): Row => ({
  id: `a-${type}-${ref}`, course_id: COURSE, organization_id: ORG, assignee_type: type,
  user_id: type === "user" ? ref : null, team_id: type === "team" ? ref : null, group_id: type === "group" ? ref : null, release_at: null, source: "admin",
});
/**
 * One organisation with `members` active members (every one an address), a
 * course with reminders on, assigned to the first `direct` members by name,
 * and, when asked, to a team and to a static group of two members each, and
 * to a dynamic group whose rule names that team. With `second`, another
 * organisation with a course of its own (after the first in the settings'
 * order) and the same number of members, or `secondMembers` when given, the
 * first `direct` of them named.
 */
function reminderWorld(o: { members: number; direct: number; teamAndGroup?: boolean; dynamicGroup?: boolean; orgWide?: boolean; state?: Row[]; second?: boolean; secondMembers?: number }) {
  const ids = Array.from({ length: o.members }, (_, i) => memberId(i));
  const rows = ids.slice(0, o.direct).map((u) => assignment("user", u));
  if (o.orgWide) rows.push(assignment("org", ORG));
  if (o.teamAndGroup) rows.push(assignment("team", "t-0029"), assignment("group", "g-0029"));
  if (o.dynamicGroup) rows.push(assignment("group", "g-dyn"));
  const otherIds = o.second ? Array.from({ length: o.secondMembers ?? o.members }, (_, i) => `${memberId(i)}-b`) : [];
  const SECOND_COURSE = "c-0030";
  if (o.second) {
    rows.push(...otherIds.slice(0, o.direct).map((u) => ({ ...assignment("user", u), id: `a-user-${u}`, course_id: SECOND_COURSE, organization_id: OTHER_ORG })));
  }
  freshWorld({
    otherOrgs: o.second ? [{ id: OTHER_ORG, name: "Tenant B", slug: "tenant-b", deleted_at: null }] : [],
    members: [
      ...ids.map((u) => ({ organization_id: ORG, user_id: u, role: "user", status: "active" })),
      ...otherIds.map((u) => ({ organization_id: OTHER_ORG, user_id: u, role: "user", status: "active" })),
    ],
    profiles: Object.fromEntries([...ids, ...otherIds].map((u) => [u, `${u}@tenant.stub`])),
    tables: {
      course_reminder_settings: [
        { ...SETTING },
        ...(o.second
          ? [{ ...SETTING, course_id: SECOND_COURSE, courses: { id: SECOND_COURSE, title: "Course B", organization_id: OTHER_ORG, organizations: { name: "Tenant B", slug: "tenant-b", deleted_at: null } } }]
          : []),
      ],
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
/** `ids`, each reminded an hour ago (inside a cadence of one day, within the cap): no reminder is due for them. */
const remindedAnHourAgo = (ids: readonly string[]): Row[] => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return ids.map((u) => ({ user_id: u, course_id: COURSE, first_assigned_at: at, last_nudge_at: at, nudge_count: 1, stopped: false }));
};
/** The table each of the reminders' later reads asks (REMINDER_LATER_READS), by the route's word for its step. */
const TABLE_OF_LATER_READ: Record<string, string> = { assignments_read: "course_assignments", progress_read: "course_attempts", state_read: "reminder_state", profiles_read: "profiles" };

/**
 * One journey program of the organisation, with `n` learners enrolled and
 * behind, each with a manager of their own; every one an address. With
 * `second`, a second program of `n` learners of its own, in the same
 * organisation or in another. With `escalationOnly`, every learner has done
 * every mission released so far but is past the journey's deadline: no
 * reminder is due, and each raises an escalation to their manager.
 */
function nudgeWorld(n: number, o: { second?: "same_org" | "other_org"; escalationOnly?: boolean } = {}) {
  const START = new Date(Date.now() - (o.escalationOnly ? 5 : 8) * 86_400_000).toISOString().slice(0, 10);
  const VERSION = { days: Array.from({ length: 10 }, (_, i) => ({ day: i + 1, course_id: COURSE, mission_title: `Mission ${i + 1}` })), days_total: 10, count_sundays: true, unlock_mode: "calendar" };
  const programs = [{ id: "p-0029", org: ORG, prefix: "l" }, ...(o.second ? [{ id: "p-0030", org: o.second === "same_org" ? ORG : OTHER_ORG, prefix: "k" }] : [])];
  const people = programs.map((pr) => {
    const learners = Array.from({ length: n }, (_, i) => `${pr.prefix}-${String(i).padStart(3, "0")}`);
    return { ...pr, learners, managers: learners.map((u) => `${u}-mgr`) };
  });
  freshWorld({
    otherOrgs: [{ id: OTHER_ORG, name: "Tenant B", slug: "tenant-b", deleted_at: null }],
    members: people.flatMap((pr) => [
      ...pr.learners.map((u, i) => ({ organization_id: pr.org, user_id: u, role: "user", status: "active", line_manager_id: pr.managers[i] })),
      ...pr.managers.map((u) => ({ organization_id: pr.org, user_id: u, role: "user", status: "active", line_manager_id: null })),
    ]),
    profiles: Object.fromEntries(people.flatMap((pr) => [...pr.learners, ...pr.managers]).map((u) => [u, `${u}@tenant.stub`])),
    tables: {
      journey_programs: people.map((pr) => ({
        id: pr.id, organization_id: pr.org, name: `Journey ${pr.id}`, is_active: true, nudge_enabled: true, current_version_id: "jv-0029",
        nudge_cooldown_days: 3, reminder_hour: 0, deadline_days: o.escalationOnly ? 2 : null, escalation_enabled: true, escalation_after_days: 1,
        organizations: pr.org === ORG ? { name: "Tenant A", slug: "tenant-a", deleted_at: null } : { name: "Tenant B", slug: "tenant-b", deleted_at: null },
      })),
      gamification_settings: [],
      journey_enrollments: people.flatMap((pr) => pr.learners.map((u, i) => ({
        id: `e-${pr.prefix}${String(i).padStart(3, "0")}`, user_id: u, program_id: pr.id, status: "active", start_date: START,
        last_nudged_at: null, last_daily_reminder_on: null, journey_versions: VERSION,
      }))),
      courses: [],
    },
    rpc: {
      // Nothing credited yet, so every learner is behind; or, with
      // escalationOnly, the first seven days credited.
      journey_reminder_counts: (body) => ((body?.p_ids as string[] | undefined) ?? []).map((id) => ({ enrollment_id: id, done: 0, done_today: false, credited: o.escalationOnly ? [1, 2, 3, 4, 5, 6, 7] : [] })),
    },
  });
}
/** The enrolments a request to journey_enrollments names (`id=eq.x` or `id=in.(x,y)`). */
const idsOf = (q: URLSearchParams) => (q.get("id") ?? "").replace(/^eq\./, "").replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean);
/** The escalation marks the call wrote: one entry for each write, with its enrolments. */
const marksWritten = () => requests.filter((q) => q.table === "journey_enrollments" && q.method === "PATCH" && "last_nudged_at" in ((q.body as Row) ?? {}));

async function cronRouteCases() {
  process.env.CRON_SECRET = CRON_SECRET;
  const reminders = await import("../../app/api/cron/reminders/route");
  const nudges = await import("../../app/api/cron/journey-nudges/route");
  const realNow = Date.now;
  /**
   * Run a cron route; with `endClockAt`, the call's 240 seconds end when that
   * table is first read, or at the first request the predicate names. The
   * stub sees a request once its gate let it through, so the read refused is
   * the one after it.
   */
  const runCron = async (route: { POST: (r: never) => Promise<Response> }, path: string, endClockAt?: string | ((r: (typeof requests)[number]) => boolean)) => {
    let clock = realNow();
    let ended = false;
    const at = typeof endClockAt === "string" ? (r: (typeof requests)[number]) => r.table === endClockAt : endClockAt;
    if (at) world.onRequest = (r) => { if (!ended && at(r)) { ended = true; clock += 300_000; } };
    Date.now = () => clock;
    try {
      const { value, lines } = await captureLogs(async () => {
        const res = await route.POST(new Request(`http://lms.stub${path}`, { method: "POST", headers: { "x-cron-secret": CRON_SECRET } }) as never);
        return { status: res.status, body: (await res.json()) as Row };
      });
      const noRoom = lines.map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).filter((l): l is Row => l?.event === "cron_no_room");
      const beat = requests.filter((q) => q.table === "ops_heartbeats" && q.method === "POST").map((q) => q.body as Row)[0];
      return { ...value, noRoom, beat, detail: (beat?.last_detail ?? {}) as Row };
    } finally {
      Date.now = realNow;
    }
  };
  const remind = (endClockAt?: string | ((r: (typeof requests)[number]) => boolean)) => runCron(reminders as never, "/api/cron/reminders", endClockAt);
  const nudge = (endClockAt?: string | ((r: (typeof requests)[number]) => boolean)) => runCron(nudges as never, "/api/cron/journey-nudges", endClockAt);
  /** The n-th request (from 1) to a table, for a clock that ends there. */
  const nth = (table: string, n: number) => {
    let seen = 0;
    return (r: (typeof requests)[number]) => r.table === table && ++seen === n;
  };
  /** The keys a run left out because it did not count them ("not known"). */
  const UNKNOWN_WHEN_STOPPED = ["due", "sent", "failed", "left", "left_complete"];
  const absent = (body: Row) => UNKNOWN_WHEN_STOPPED.filter((k) => !(k in body));

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
    eq("…the reminders' later reads are lines of this sum", REMINDER_LATER_READS.map((w) => TABLE_OF_LATER_READ[w]).filter((t) => t in READ_BY_READ).length, REMINDER_LATER_READS.length);
  }

  console.log("\nthe reminders' later reads (note of 2026-11-21 (evening), part 1): one list, the reads the call makes after its members");
  {
    // A minimal call with someone due: a single tenant with ten members (one
    // page), two of them assigned by name, and no teams or groups.
    reminderWorld({ members: 10, direct: 2 });
    const r = await remind();
    const lastMembers = requests.map((q) => q.table).lastIndexOf("organization_members");
    const opening = requests.findIndex((q, k) => k > lastMembers && ["notification_settings", "organizations", "rpc/tenant_mail_status"].includes(q.table));
    const wordOf = Object.fromEntries(Object.entries(TABLE_OF_LATER_READ).map(([w, t]) => [t, w]));
    const between = requests.slice(lastMembers + 1, opening).map((q) => wordOf[q.table] ?? `a read the list does not hold: ${q.table}`);
    eq("a minimal call with two learners due answers 200 and mails them", [r.status, r.body.ok, Number(r.body.sent) > 0], [200, true, true]);
    eq("…after the members and before the run opens it makes the listed reads, once each, and no other request", [...between].sort(), [...REMINDER_LATER_READS].sort());
  }
  {
    // The boundary, from the constants: the call's count, less the settings'
    // one call, the members' organisation read, the list, and what every
    // read keeps back for the sends (the write that stops reminders past
    // their cap, an opening and a first group).
    const reserve = 1 + MAIL_CALL_COSTS.open + MAIL_CALL_COSTS.template + MAIL_CALL_COSTS.send + MAIL_CALL_COSTS.logInsert + MAIL_CALL_COSTS.stateWrite + MAIL_CALL_COSTS.alertMark + 1;
    const most = cronBudget().callLimit - 1 - 1 - REMINDER_LATER_READS.length - reserve;
    /** Members that take exactly `pages` requests to read (the last page short). */
    const membersFor = (pages: number) => (pages - 1) * SERVER_ROW_CAP + SERVER_ROW_CAP / 2;
    reminderWorld({ members: membersFor(most), direct: 2 });
    const fits = await remind();
    eq(`members in ${most} pages (the computed maximum): 200, a reminder mailed, all pages read, 40 requests or fewer`,
      [fits.status, fits.body.ok, Number(fits.body.sent) >= 1, readsOf("organization_members"), requests.length <= CALL_SUM_LIMIT], [200, true, true, most, true]);
    reminderWorld({ members: membersFor(most + 1), direct: 2 });
    const over = await remind();
    eq(`…members in ${most + 1} pages: halted in members_read by the count (500), one organisation left, no mail`,
      [over.status, over.noRoom.length, over.noRoom[0]?.step, over.noRoom[0]?.ended_by, over.body.left_orgs, sends().length], [500, 1, "members_read", "count", 1, 0]);
  }
  {
    // Time instead of count: two tenants; the first is read in full, and the
    // call's time is used up just as the second tenant's row is read, so
    // neither its member page nor any later read gets room.
    reminderWorld({ members: 10, direct: 2, second: true });
    const r = await remind(nth("organizations", 2));
    const line = r.noRoom[0];
    eq("time used up at the second tenant's row: 500, before any send, one call_limit and one cron_no_room line naming assignments_read and the clock",
      [r.status, r.body.ok, r.body.stopped_before_send, (r.detail.errors as Row | undefined)?.call_limit, r.noRoom.length, line?.step, line?.ended_by], [500, false, true, 1, 1, "assignments_read", "clock"]);
    eq("…left_orgs 1, the five counts left out, no request for the assignments, nobody mailed, no state written",
      [r.body.left_orgs, absent(r.body), readsOf("course_assignments"), sends().length, requests.filter((q) => (q.table === "reminder_state" || q.table === "tenant_smtp_state") && q.method !== "GET").length],
      [1, UNKNOWN_WHEN_STOPPED, 0, 0, 0]);
    eq("…the count in the line equals the requests the call made", line?.calls, callRequests().length);
  }

  console.log("\nthe reminders call reads addresses only for the learners still due");
  {
    // An organisation-wide assignment over 3,000 members that count; all but
    // five were reminded an hour ago, inside the cadence, so five are due.
    const ids = Array.from({ length: 3000 }, (_, i) => memberId(i));
    reminderWorld({ members: 3000, direct: 0, orgWide: true, state: remindedAnHourAgo(ids.slice(5)) });
    const r = await remind();
    const lists = requests.filter((q) => q.table === "profiles").map((q) => (q.query.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").sort());
    eq("3,000 members that count, five due: 200, the five reminded, and only their addresses read, in one list",
      [r.status, r.body.ok, Number(r.body.due), Number(r.body.sent), lists], [200, true, 5, 5, [ids.slice(0, 5).sort()]]);
    eq("…its requests, the heartbeat's included, never pass 40", requests.length <= CALL_SUM_LIMIT, true);
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
    eq("reminders, 4,305 members and 60 due: the call sends some, leaves the rest, and its requests, the heartbeat's included, never pass 40",
      [r.status, Number(r.body.sent) > 0, Number(r.body.left) > 0, requests.length <= CALL_SUM_LIMIT], [200, true, true, true]);
  }

  console.log("\na scheduled call keeps its two end calls inside the 40 (note of 2026-11-21 (later), point 5)");
  {
    // The same full call, with every write of the reminders' state refused:
    // a failed run that spent its count, then read its own heartbeat row
    // (the carry) and wrote it.
    reminderWorld({ members: 4305, direct: 60 });
    world.writeFails = ["reminder_state"];
    world.heartbeat = { last_status: "ok", last_run_at: "2026-11-20T06:00:00.000Z", last_detail: { v: 1 } };
    const r = await remind();
    const beats = requests.filter((q) => q.table === "ops_heartbeats").map((q) => q.method);
    eq("a failed run that filled its count (the state writes refused): 500, state_write, the carry read and the heartbeat written",
      [r.status, (r.detail.errors as Row | undefined)?.state_write !== undefined, beats, r.detail.last_ok_at], [500, true, ["GET", "POST"], "2026-11-20T06:00:00.000Z"]);
    eq("…every request of the call, the two end calls included, is at most 40, and the call's own are at most 38",
      [requests.length <= CALL_SUM_LIMIT, callRequests().length <= CALL_SUM_LIMIT - CRON_END_CALLS], [true, true]);
  }

  console.log("\nthe reminders call: a paged read that takes one page more than fits stops the run, ended by the count (note of 2026-11-21, part 2 (a) and (b))");
  {
    // Before the state: the settings, the organisation, one page of members,
    // the assignments and the finished attempts. Every read before the sends
    // keeps back the write that stops reminders past their cap, the opening
    // and a first group; the addresses then take one call more.
    const before = 1 + 1 + 1 + 1 + 1;
    const reserve = 1 + MAIL_CALL_COSTS.open + MAIL_CALL_COSTS.template + MAIL_CALL_COSTS.send + MAIL_CALL_COSTS.logInsert + MAIL_CALL_COSTS.stateWrite + MAIL_CALL_COSTS.alertMark + 1;
    const fit = cronBudget().callLimit - reserve - 1 - before;
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

  console.log("\nnobody's people read whole for want of room: the job's own failed step (note of 2026-11-21 (later), point 4)");
  {
    // One organisation; the clock ends at its members' organisation read, so
    // the first page is refused and no organisation's members are read.
    reminderWorld({ members: 10, direct: 2 });
    const r = await remind("organizations");
    eq("reminders, one organisation, the clock ended at its first read: 500, call_limit, stopped before any send, one fixed line in members_read, ended by the clock",
      [r.status, r.body.ok, r.body.stopped_before_send, (r.detail.errors as Row | undefined)?.call_limit, r.noRoom.length, r.noRoom[0]?.step, r.noRoom[0]?.ended_by], [500, false, true, 1, 1, "members_read", "clock"]);
    eq("…left_orgs written, the counts it never made left out (\"not known\"), nobody mailed, no state written",
      [r.body.left_orgs, absent(r.body), sends().length, requests.filter((q) => q.table === "reminder_state" && q.method === "POST").length], [1, UNKNOWN_WHEN_STOPPED, 0, 0]);
  }
  {
    // The same by the count: one organisation whose members take more pages
    // than the call has room for (26,000 members, 26 pages).
    reminderWorld({ members: 26_000, direct: 2 });
    const r = await remind();
    eq("reminders, one organisation of 26,000 members: 500, call_limit, one fixed line in members_read, ended by the count, nobody mailed",
      [r.status, r.body.stopped_before_send, r.noRoom.length, r.noRoom[0]?.step, r.noRoom[0]?.ended_by, r.body.left_orgs, sends().length], [500, true, 1, "members_read", "count", 1, 0]);
    eq("…the count in the line equals the requests the call made", r.noRoom[0]?.calls, callRequests().length);
  }
  {
    // Its twin: two organisations, the first read whole (10 members) and the
    // second left at its members' read, by the count (26,000 members, more
    // pages than the call has room for). The members' read keeps back the
    // reads after it, so the call reads on and reminds the first
    // organisation's learners: a clean run.
    reminderWorld({ members: 10, direct: 2, second: true, secondMembers: 26_000 });
    const r = await remind();
    eq("reminders, two organisations, the first read whole and the second left at its members' read: a clean run (200, ok), left_orgs 1, the count marked incomplete, no fixed line",
      [r.status, r.body.ok, r.body.left_orgs, r.body.left_complete, r.noRoom.length], [200, true, 1, false, 0]);
    eq("…the first organisation's learners reminded, nobody of the second; its requests, the heartbeat's included, never pass 40",
      [sends().length > 0, sends().every((s) => !String(s.to).includes("-b@")), requests.length <= CALL_SUM_LIMIT], [true, true, true]);
  }
  {
    // Journey nudges, one program; the clock ends at its members'
    // organisation read, and no alert was due.
    nudgeWorld(2);
    const r = await nudge("organizations");
    eq("journey nudges, one program, the clock ended at its first read: 500, call_limit, stopped before any send, one fixed line in members_read",
      [r.status, r.body.ok, r.body.stopped_before_send, (r.detail.errors as Row | undefined)?.call_limit, r.noRoom.length, r.noRoom[0]?.job, r.noRoom[0]?.step, r.noRoom[0]?.ended_by],
      [500, false, true, 1, 1, "journey-nudges", "members_read", "clock"]);
    eq("…left_orgs written, the counts it never made left out, no claim taken, nothing sent",
      [r.body.left_orgs, absent(r.body), requests.filter((q) => q.table === "journey_enrollments" && q.method === "PATCH").length, sends().length], [1, UNKNOWN_WHEN_STOPPED, 0, 0]);
  }
  {
    // Its twin: two programs in two organisations, the first read whole and
    // mailed; the clock ends at the second's time zone, so its members'
    // read is refused. Nothing is read after a left program.
    nudgeWorld(2, { second: "other_org" });
    const r = await nudge(nth("gamification_settings", 2));
    const second = requests.filter((q) => q.table === "journey_enrollments" && q.method === "PATCH" && idsOf(q.query).some((id) => id.startsWith("e-k")));
    eq("journey nudges, two programs, the second left at its members' read: a clean run (200, ok), left_orgs 1, the count marked incomplete, no fixed line",
      [r.status, r.body.ok, r.body.left_orgs, r.body.left_complete, r.noRoom.length], [200, true, 1, false, 0]);
    eq("…the first program mailed, the second neither claimed nor mailed", [sends().some((s) => String(s.to).startsWith("l-")), second.length, sends().some((s) => String(s.to).startsWith("k-"))], [true, 0, false]);
  }

  console.log("\njourney nudges: no room for the line managers' read leaves the program whole (note of 2026-11-21 (later), point 1)");
  {
    // Two programs of one organisation, escalation on: its members are read
    // once, for the first program. The clock ends at the second's time zone,
    // so its line managers' read is refused.
    nudgeWorld(2, { second: "same_org" });
    const r = await nudge(nth("gamification_settings", 2));
    const second = requests.filter((q) => q.table === "journey_enrollments" && q.method === "PATCH" && idsOf(q.query).some((id) => id.startsWith("e-k")));
    eq("the second program with no room for its managers' pages: 200, left_orgs 1, the count marked incomplete, no fixed line",
      [r.status, r.body.ok, r.body.left_orgs, r.body.left_complete, r.noRoom.length], [200, true, 1, false, 0]);
    eq("…the first program read and mailed; the second neither claimed nor mailed", [sends().some((s) => String(s.to).startsWith("l-")), second.length, sends().some((s) => String(s.to).startsWith("k-"))], [true, 0, false]);
  }

  console.log("\njourney nudges: each group of escalations writes its marks (note of 2026-11-21 (later), point 2)");
  {
    // Thirty learners past the deadline with nothing pending: thirty
    // escalations and no reminder, more than the call has room for.
    nudgeWorld(30, { escalationOnly: true });
    const r = await nudge();
    const enrolmentOf = (to: string) => `e-l${to.slice(2, 5)}`;
    const sentTo = sends().map((s) => String(s.to));
    const marked = marksWritten().flatMap((q) => idsOf(q.query));
    // Walk the requests: a send that follows a mark (or none) opens a group,
    // and every escalation sent before it must be marked by then.
    const pending = new Set<string>();
    let lastWasMark = true;
    const openAtGroup: number[] = [];
    for (const q of requests) {
      if (q.path === "/functions/v1/send-smtp") {
        if (lastWasMark) openAtGroup.push(pending.size);
        lastWasMark = false;
        pending.add(enrolmentOf(String((q.body as Row).to)));
      } else if (q.table === "journey_enrollments" && q.method === "PATCH" && "last_nudged_at" in ((q.body as Row) ?? {})) {
        for (const id of idsOf(q.query)) pending.delete(id);
        lastWasMark = true;
      }
    }
    eq(`thirty escalations, ${sentTo.length} sent: every one sent to a manager, some left for the next call`, [sentTo.length > 1, sentTo.length < 30, sentTo.every((t) => t.includes("-mgr@"))], [true, true, true]);
    eq("…each sent escalation has its mark, written before the next group starts; none sent is unmarked at the end",
      [openAtGroup.length > 1, openAtGroup.every((n) => n === 0), pending.size], [true, true, 0]);
    eq("…the marks are exactly the escalations sent: one left has no mark", [...marked].sort(), sentTo.map(enrolmentOf).sort());
    eq("…a clean run: 200, ok, escalated counts the sent, the count marked incomplete, no fixed line",
      [r.status, r.body.ok, r.body.escalated, r.body.left_complete, r.noRoom.length], [200, true, sentTo.length, false, 0]);
  }
  {
    // The same call with every mark refused by the database.
    nudgeWorld(30, { escalationOnly: true });
    world.writeFails = ["journey_enrollments"];
    world.heartbeat = { last_status: "ok", last_run_at: "2026-11-21T09:00:00.000Z", last_detail: { v: 1 } };
    const r = await nudge();
    eq("a mark whose write fails: 500, state_write in the heartbeat, not stopped before a send, the counts written, the last success carried",
      [r.status, r.body.ok, r.beat?.last_status, Number((r.detail.errors as Row | undefined)?.state_write) > 0, r.body.stopped_before_send, ["due", "sent", "left"].every((k) => k in r.body), r.detail.last_ok_at],
      [500, false, "error", true, false, true, "2026-11-21T09:00:00.000Z"]);
    eq("…the failed run reads its row for the carry and writes its heartbeat: every request of the call, the two end calls included, at most 40, and the call's own at most 38",
      [requests.filter((q) => q.table === "ops_heartbeats").map((q) => q.method), requests.length <= CALL_SUM_LIMIT, callRequests().length <= CALL_SUM_LIMIT - CRON_END_CALLS], [["GET", "POST"], true, true]);
  }

  console.log("\nthe journey-nudges call (note of 2026-11-21, part 2 (c)): with no alert due, room for a full page and its first group");
  {
    nudgeWorld(500);
    const r = await runCron(nudges as never, "/api/cron/journey-nudges");
    const lists = requests.filter((q) => q.table === "profiles").map((q) => (q.query.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(","));
    eq("journey nudges, one full page with no alert due (500 due learners, 500 different managers): 200, every profile read in seven lists, and the first group sent",
      [r.status, r.body.ok, lists.length, new Set(lists.flat()).size, sends().length > 0], [200, true, 7, 1000, true]);
    eq("…the members that count (1,000) were read in their pages, and the call's requests, the heartbeat's included, never pass 40",
      [readsOf("organization_members") >= 2, requests.length <= CALL_SUM_LIMIT], [true, true]);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
