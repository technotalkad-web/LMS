/**
 * The budgets of a request and of a cron call (ADR 0029, rules T4, T5, FP2
 * and FP3 of the notes of 2026-11-18; lib/notifications/smtp-state.ts), the
 * run's cases. The routes' sums come with stage 2.
 *   - the rule: at most 40 calls (0.8 of the plan's 50) for a request or a
 *     cron call; an alert's cost and a scheduled call's two sums;
 *   - ESTIMATES, not proof: the sums of an administrator's request and of a
 *     scheduled call add the code's call costs to read counts typed by hand.
 *     They are labelled so until gate G3 measures each route; nothing here
 *     shows that a route makes that many reads;
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
 * Under the stubbed fetch of tests/unit/mail-world.ts. No database, no network.
 *
 * Run:  npx tsx tests/unit/mail-budget.test.ts   (or npm run test:unit)
 */
import { ORG, OTHER_ORG, PLATFORM_ENV, eq, finish, freshWorld, installStub, logRows, outbound, removeStub, requests, sends, world } from "./mail-world";
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

    console.log("\nESTIMATES until gate G3 measures each route: the sums of the kinds of request (rule FP2), from the code's costs and read counts typed by hand");
    {
      // ESTIMATE. The read counts below are typed by hand from reading the
      // routes; no route is run here. Gate G3 measures each route on staging,
      // and its numbers replace these.
      // An administrator's request: its own calls, the mail part's reads (a
      // title, the members that count, a team or group, the addresses), the
      // opening of its run, and one first send with its group's tail.
      const mailReads = 1 + 2 + 2 + 1;
      const firstGroup = MAIL_CALL_COSTS.template + MAIL_CALL_COSTS.send + MAIL_CALL_COSTS.logInsert + MAIL_CALL_COSTS.stateWrite + MAIL_CALL_COSTS.alertMark;
      eq("estimate (hand-typed read counts; gate G3 measures the routes): an administrator's request, its own work, its reads and a first mail fit the 40", ADMIN_REQUEST_OWN_CALLS + mailReads + MAIL_CALL_COSTS.open + firstGroup <= CALL_SUM_LIMIT, true);
      // A scheduled call without an alert: the programs or settings, a time
      // zone, the members that count, the line managers, a page, its counts,
      // its profiles and titles, the opening, and a first claimed mail with
      // its tail and its give-back.
      const cronReads = 1 + 1 + 2 + 1 + 1 + 1 + 1 + 1;
      eq("estimate (hand-typed read counts; gate G3 measures the routes): a scheduled call without an alert, its reads and a first claimed mail fit the 40", cronReads + MAIL_CALL_COSTS.open + 1 + firstGroup + SENDS_AT_ONCE <= CALL_SUM_LIMIT, true);
      eq("estimate (from the code's alert cost; gate G3 measures the call): with an alert due, the alert alone fits, and what it leaves is what the call's own mail may use", [ALERT_CALL_COST <= CALL_SUM_LIMIT, CALL_SUM_LIMIT - ALERT_CALL_COST], [true, 15]);
    }

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

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
