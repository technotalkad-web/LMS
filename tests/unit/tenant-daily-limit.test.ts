/**
 * A daily limit for each tenant (ADR 0029, rule FP4 of the note of
 * 2026-11-18; lib/notifications/smtp-state.ts), the run's cases. The
 * readers' and the limit route's cases come with stage 4.
 *   - the numbers: 375 where none is set, or the environment's default; the
 *     reserve a tenth, rounded up, at least 25; routine mail stops at 337 of
 *     375, 1,350 of 1,500, 5 of 30, and never below 0 for a limit under 25;
 *     also for a limit below 250;
 *   - the count is read once for a run, by one call, and carried: sends
 *     already started count;
 *   - other mail stops at the limit less the reserve and a code still goes;
 *     at the limit nothing is attempted and the organisation reads not
 *     ready; the state does not become failing;
 *   - a single mail stopped by the limit writes one failed row with the fixed
 *     error daily_limit; a loop writes none for each person and reports the
 *     count;
 *   - one alert, due from the moment routine mail stops;
 *   - when tenant_mail_status cannot be read, or 0114 is not pasted, no limit
 *     is applied and the send is attempted.
 *
 * Under the stubbed fetch of tests/unit/mail-world.ts. No database, no network.
 *
 * Run:  npx tsx tests/unit/tenant-daily-limit.test.ts   (or npm run test:unit)
 */
import { ORG, eq, finish, freshWorld, installStub, logRows, removeStub, sends, stateWrites, statusCalls, world } from "./mail-world";
import {
  DAILY_LIMIT_RESERVE_MIN,
  DEFAULT_TENANT_DAILY_LIMIT,
  RESERVE_EVENTS,
  dailyLimitAllows,
  drawsOnReserve,
  openRun,
  runReady,
  tenantDailyLimit,
} from "../../lib/notifications/smtp-state";
import { sendMany, sendNotification, type SendArgs } from "../../lib/notifications/send";

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `0b000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, email: `person${i + 1}@tenant.stub` }));
const routine = (p: { id: string; email: string }) => ({ event: "asset_reminder" as const, to: { user_id: p.id, email: p.email }, context: {} });
const code = (p: { id: string; email: string }) => ({ event: "password_reset" as const, to: { user_id: p.id, email: p.email }, context: { otp_code: "123456", otp_minutes: "10" } });
const one = (event: SendArgs["event"]): SendArgs => ({ organizationId: ORG, event, to: { user_id: people(1)[0].id, email: people(1)[0].email }, context: {} });

async function main() {
  installStub();
  try {
    console.log("\nthe numbers");
    eq("375 where none is set", [DEFAULT_TENANT_DAILY_LIMIT, tenantDailyLimit(null, {})], [375, { limit: 375, reserve: 38, routineStop: 337 }]);
    eq("1,500 (the production tenant): routine mail stops at 1,350", tenantDailyLimit(1500, {}), { limit: 1500, reserve: 150, routineStop: 1350 });
    eq("30 (spec 79's): the reserve is at least 25, so routine mail stops at 5", tenantDailyLimit(30, {}), { limit: 30, reserve: DAILY_LIMIT_RESERVE_MIN, routineStop: 5 });
    eq("a limit below 250 keeps the 25 (200: stops at 175)", tenantDailyLimit(200, {}), { limit: 200, reserve: 25, routineStop: 175 });
    eq("under 25 routine mail never goes, and the line is never below 0", tenantDailyLimit(10, {}), { limit: 10, reserve: 25, routineStop: 0 });
    eq("TENANT_EMAIL_DEFAULT_DAILY_LIMIT sets the default for an environment", tenantDailyLimit(null, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "1000" }), { limit: 1000, reserve: 100, routineStop: 900 });
    eq("…a stored number wins over it", tenantDailyLimit(60, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "1000" }).limit, 60);
    eq("…a value that is not a whole number from 1 to 100,000 is ignored", [tenantDailyLimit(null, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "0" }).limit, tenantDailyLimit(null, { TENANT_EMAIL_DEFAULT_DAILY_LIMIT: "lots" }).limit, tenantDailyLimit(0, {}).limit], [375, 375, 375]);
    eq("the reserve is for reset codes, sign-in links and welcome mail", [...RESERVE_EVENTS].sort(), ["account_creation", "account_invite", "magic_link", "password_reset"]);
    eq("…routine mail does not draw on it", ["asset_reminder", "custom_broadcast", "asset_completion", "journey_nudge"].map((e) => drawsOnReserve(e as SendArgs["event"])), [false, false, false, false]);
    const L = tenantDailyLimit(375, {});
    eq("at 336 a routine mail fits, at 337 it does not; a code fits to 374", [dailyLimitAllows(336, L, "asset_reminder"), dailyLimitAllows(337, L, "asset_reminder"), dailyLimitAllows(374, L, "password_reset"), dailyLimitAllows(375, L, "password_reset")], [true, false, true, false]);

    console.log("\nthe run reads the count once and carries it");
    {
      freshWorld({ sent24h: 335 });
      const run = await openRun({ organizationId: ORG });
      const r = await sendMany(run, people(6), routine);
      eq("335 sent of 375: two routine mails go, the four others stop at the line", [r.map((x) => x.status === "sent" ? "sent" : x.errorClass).join(","), sends().length], ["sent,sent,daily_limit,daily_limit,daily_limit,daily_limit", 2]);
      eq("…one call for the count, for the whole run", statusCalls().length, 1);
      eq("…a loop writes no row for a person the limit stopped (the count is reported)", [logRows().length, run.report.notAttempted.daily_limit], [2, 4]);
      eq("…the run says routine mail stopped, and an alert is due from that moment", [run.report.routineStopped, run.report.alertMarked, typeof world.state?.alert_due_at], [true, true, "string"]);
      const codes = await sendMany(run, people(3), code);
      eq("…a reset code still goes, on the same run (337 of 375)", codes.map((x) => x.status), ["sent", "sent", "sent"]);
      eq("…the state does not become failing (the deliveries keep it healthy)", [world.state?.state ?? null, stateWrites().some((w) => (w.body as Record<string, unknown>).state === "failing")], ["healthy", false]);
      freshWorld({ sent24h: 336 });
      const tight = await openRun({ organizationId: ORG });
      const g = await sendMany(tight, people(6), routine);
      eq("one routine mail of room and a group of four ready: sends already started count, so one goes", [g.filter((x) => x.status === "sent").length, sends().length], [1, 1]);
    }

    console.log("\nat the limit");
    {
      freshWorld({ sent24h: 375 });
      const run = await openRun({ organizationId: ORG });
      eq("375 of 375: the organisation reads not ready", runReady(run), false);
      const c = await sendNotification(one("password_reset"), { run });
      eq("…even a reset code is not attempted", [c.status, c.errorClass, c.attempted, sends().length], ["failed", "daily_limit", false, 0]);
      eq("…a single mail writes one failed row with the fixed error daily_limit", logRows().map((x) => [x.status, x.error]), [["failed", "daily_limit"]]);
      freshWorld({ sent24h: 374 });
      eq("374 of 375: ready", runReady(await openRun({ organizationId: ORG })), true);
      freshWorld({ sent24h: 20, state: { organization_id: ORG, state: null, state_changed_at: new Date().toISOString(), failed_recipients: [], daily_limit: 30 } });
      const small = await openRun({ organizationId: ORG });
      const s = await sendMany(small, people(3), routine);
      eq("a stored limit of 30 at 20 sent: routine mail has stopped (its line is 5)", s.map((x) => x.errorClass), ["daily_limit", "daily_limit", "daily_limit"]);
      eq("…a code still goes up to 29", (await sendNotification(one("password_reset"), { run: small })).status, "sent");
    }

    console.log("\nwhen the count cannot be read, no limit is applied");
    {
      freshWorld({ status: "missing", sent24h: 100_000 });
      const missing = await openRun({ organizationId: ORG });
      const m = await sendMany(missing, people(3), routine);
      eq("0114 not pasted: no limit, every send attempted, ready", [missing.limit, m.map((x) => x.status).join(","), runReady(missing)], [null, "sent,sent,sent", true]);
      freshWorld({ status: "fail", sent24h: 100_000 });
      const failed = await openRun({ organizationId: ORG });
      const f = await sendMany(failed, people(3), routine);
      eq("the call fails: no limit, every send attempted, the failed read counted", [failed.limit, f.map((x) => x.status).join(","), failed.errors], [null, "sent,sent,sent", { mail_status_read: 1 }]);
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
