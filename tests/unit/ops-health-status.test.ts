/**
 * The status rules of GET /api/ops/health (lib/ops/health-status.ts): the
 * owner's decision of 2026-11-14 (ADR 0007, the note of that date on decision
 * 4) that a stale heartbeat of a job scheduled more than once a day reads
 * "warn", not "degraded", up to a ceiling, and that nothing else changes; and
 * the owner's decision of 2026-11-15 (ADR 0024, the note of that date) that an
 * errored last run of a job in the errored-warn list (lrs-forward) reads
 * "warn", and any other job's still reads "ok".
 *
 * Email (ADR 0029 section H, decision 5; steps 4 and K):
 *   - platform_email: "fail" (not configured, the log unreadable, the newest
 *     row an auth or quota failure, the two newest both failures, the daily
 *     ceiling) makes the authenticated status "degraded"; one timeout,
 *     unreachable or unknown row, or half the ceiling, is "warn";
 *     suppressed, refused, rejected and not_configured rows never move it;
 *   - the route, under a stubbed fetch: the `email` check ignores
 *     password_reset and magic_link rows and counts the rest; the
 *     unauthenticated answer is { status, ts } computed without the new
 *     check, whatever it reads, and the check is not run for that caller;
 *     with the secret the new check is under email_checks, never under
 *     checks;
 *   - .github/workflows/ops-watch.yml (not changed by ADR 0029) prints only
 *     the status, the time and checks.<name>.status, so it never prints the
 *     new check.
 *
 * ADR 0029 pull request B, the pure rules (stage 1; the route's wiring and
 * the ERRORED_WARN list come with stage 4):
 *   - `mail_recipients` (note of 2026-11-19): warn for 24 hours after a
 *     skipped request's row, ok with none or an older one, unknown when the
 *     heartbeats cannot be read, never fail, and no schedule rule;
 *   - the errored-run rule with the two mail crons in the list it is given
 *     (note of 2026-11-20, part 2): a fresh failed run reads warn on
 *     production only, staleness first, never degraded from a failed run
 *     alone;
 *   - the mail crons' detail: the fixed word list, the builder (numbers and
 *     booleans in the answer, the words only in the heartbeat, an unknown
 *     number left out), the reader that drops everything it does not name,
 *     the carry of the last successful run from four sources, the pending
 *     reminders ("not known", "at least", a timed-out nudge not owed);
 *   - recordHeartbeat's fourth argument: a failed run reads its own row once
 *     and carries the time; a clean run makes no read and writes no time;
 *   - `tenant_smtp` and `mail_jobs`: warn, unknown, never fail.
 *
 * Run:  npx tsx tests/unit/ops-health-status.test.ts   (or npm run test:unit)
 * (No DB, no network.)
 */
import fs from "node:fs";
import path from "node:path";
import {
  CRON_ERROR_WORDS,
  EMAIL_CHECK_IGNORED_EVENTS,
  MAIL_RECIPIENTS_HEARTBEAT,
  MAIL_RECIPIENTS_WARN_HOURS,
  buildMailCronDetail,
  carriedLastOk,
  classifyCrons,
  classifyMailJobs,
  classifyMailRecipients,
  classifyPlatformEmail,
  classifyTenantSmtp,
  lastSuccessfulRun,
  mailCronItems,
  overallStatus,
  owedAfterRun,
  pendingOf,
  readMailCronDetail,
  type CheckStatus,
} from "../../lib/ops/health-status";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
// `daily` is unlisted with a threshold under the ceiling, so the list check is
// what keeps it from reading warn (a daily job given, say, 24 h one day).
const CADENCE = { "lrs-forward": 30, "journey-nudges": 360, reaper: 26 * 60, daily: 24 * 60 };
const WARN_ONLY = ["lrs-forward", "journey-nudges"];
const CEILING = 26 * 60;
const ERRORED_WARN = ["lrs-forward"];

function crons(rows: Array<[string, number, string?]>, expectCrons = true) {
  return classifyCrons({
    cadenceMin: CADENCE,
    staleWarnOnly: WARN_ONLY,
    staleDegradedAfterMin: CEILING,
    erroredWarn: ERRORED_WARN,
    rows: rows.map(([name, ageMin, st]) => ({ name, last_run_at: ago(ageMin), last_status: st ?? "ok" })),
    nowMs: NOW,
    expectCrons,
  });
}
const fresh: Array<[string, number]> = [["lrs-forward", 3], ["journey-nudges", 30], ["reaper", 60], ["daily", 60]];
const with_ = (name: string, age: number, st?: string) =>
  fresh.map(([n, a]) => (n === name ? ([n, age, st] as [string, number, string?]) : ([n, a] as [string, number])));

console.log("\nclassifyCrons on production (expectCrons)");
eq("all fresh → ok", crons(fresh).status, "ok");
eq("sub-daily job stale → warn", crons(with_("lrs-forward", 31)).status, "warn");
eq("sub-daily job stale at the ceiling → warn", crons(with_("lrs-forward", CEILING)).status, "warn");
eq("sub-daily job stale past the ceiling → fail", crons(with_("lrs-forward", CEILING + 1)).status, "fail");
eq("hourly job stale 10.5 h (the worst gap measured) → warn", crons(with_("journey-nudges", 630)).status, "warn");
eq("daily job stale → fail", crons(with_("reaper", 26 * 60 + 1)).status, "fail");
eq("unlisted job stale under the ceiling → fail, not warn", crons(with_("daily", 25 * 60)).status, "fail");
eq("sub-daily job never seen → fail", crons(fresh.filter(([n]) => n !== "lrs-forward")).status, "fail");
eq("daily job never seen → fail", crons(fresh.filter(([n]) => n !== "reaper")).status, "fail");
eq(
  "one warn and one fail → fail",
  crons([["lrs-forward", 31], ["journey-nudges", 30], ["reaper", 26 * 60 + 1], ["daily", 60]]).status,
  "fail"
);
eq(
  "two sub-daily jobs stale → warn",
  crons([["lrs-forward", 31], ["journey-nudges", 400], ["reaper", 60], ["daily", 60]]).status,
  "warn"
);
eq("last run errored, not stale → ok (unchanged)", crons(with_("reaper", 60, "error")).status, "ok");
eq("its job state reads last-run-errored", crons(with_("reaper", 60, "error")).jobs.reaper.status, "last-run-errored");
eq("a warn job's state still reads stale", crons(with_("lrs-forward", 31)).jobs["lrs-forward"].status, "stale");
eq("a never-seen job's state", crons([]).jobs["lrs-forward"], { status: "never-seen" });
eq("a job not in the cadence map is ignored", crons([...fresh, ["other", 99999]]).status, "ok");

console.log("\nclassifyCrons: an errored last run of a listed job (lrs-forward; owner, 2026-11-15)");
eq("lrs-forward's last run errored, not stale → warn", crons(with_("lrs-forward", 3, "error")).status, "warn");
eq("…its job state reads last-run-errored", crons(with_("lrs-forward", 3, "error")).jobs["lrs-forward"].status, "last-run-errored");
eq("…overall status warn, not degraded", overallStatus({ db: "ok", storage: "ok", crons: crons(with_("lrs-forward", 3, "error")).status, lrsOutbox: "ok", email: "ok" }), "warn");
eq("lrs-forward's last run ok → ok", crons(with_("lrs-forward", 3, "ok")).status, "ok");
eq("lrs-forward errored and stale under the ceiling → warn (the stale rule)", crons(with_("lrs-forward", 31, "error")).status, "warn");
eq("…its job state reads stale", crons(with_("lrs-forward", 31, "error")).jobs["lrs-forward"].status, "stale");
eq("lrs-forward errored and stale past the ceiling → fail (never downgraded)", crons(with_("lrs-forward", CEILING + 1, "error")).status, "fail");
eq("lrs-forward errored, and a daily job stale → fail", crons([["lrs-forward", 3, "error"], ["journey-nudges", 30], ["reaper", 26 * 60 + 1], ["daily", 60]]).status, "fail");
eq("an unlisted sub-daily job errored, not stale → ok (unchanged)", crons(with_("journey-nudges", 30, "error")).status, "ok");
eq("lrs-forward errored on staging (expectCrons unset) → ok", crons(with_("lrs-forward", 3, "error"), false).status, "ok");
eq(
  "with an empty list, lrs-forward errored → ok (today's rule)",
  classifyCrons({ cadenceMin: CADENCE, staleWarnOnly: WARN_ONLY, staleDegradedAfterMin: CEILING, erroredWarn: [], rows: [{ name: "lrs-forward", last_run_at: ago(3), last_status: "error" }, ...fresh.filter(([n]) => n !== "lrs-forward").map(([name, a]) => ({ name, last_run_at: ago(a), last_status: "ok" }))], nowMs: NOW, expectCrons: true }).status,
  "ok"
);

console.log("\nclassifyCrons on staging (expectCrons unset)");
eq(
  "everything stale → ok",
  crons([["lrs-forward", 99999], ["journey-nudges", 99999], ["reaper", 99999], ["daily", 99999]], false).status,
  "ok"
);
eq("nothing seen → ok", crons([], false).status, "ok");

console.log("\noverallStatus");
const base: Record<"db" | "storage" | "crons" | "lrsOutbox" | "email", CheckStatus> = {
  db: "ok", storage: "ok", crons: "ok", lrsOutbox: "ok", email: "ok",
};
const o = (p: Partial<typeof base>) => overallStatus({ ...base, ...p });
eq("all ok → ok", o({}), "ok");
eq("crons warn → warn", o({ crons: "warn" }), "warn");
eq("lrs outbox warn → warn", o({ lrsOutbox: "warn" }), "warn");
eq("email warn → warn", o({ email: "warn" }), "warn");
eq("crons fail → degraded", o({ crons: "fail" }), "degraded");
eq("storage fail → degraded", o({ storage: "fail" }), "degraded");
eq("crons warn + storage fail → degraded", o({ crons: "warn", storage: "fail" }), "degraded");
eq("db fail → down, whatever else", o({ db: "fail", crons: "fail", email: "warn" }), "down");
eq("crons unknown (no table) → ok", o({ crons: "unknown" }), "ok");
eq("lrs outbox fail is not a status input (unchanged)", o({ lrsOutbox: "fail" }), "ok");

console.log("\noverallStatus with platform_email (ADR 0029 section H)");
const op = (p: Partial<Parameters<typeof overallStatus>[0]>) => overallStatus({ ...base, ...p });
eq("platform_email fail → degraded", op({ platformEmail: "fail" }), "degraded");
eq("platform_email warn → warn", op({ platformEmail: "warn" }), "warn");
eq("platform_email ok → ok", op({ platformEmail: "ok" }), "ok");
eq("platform_email unknown → ok", op({ platformEmail: "unknown" }), "ok");
eq("db fail → down, whatever platform_email reads", op({ db: "fail", platformEmail: "fail" }), "down");
eq("without platform_email (the unauthenticated status): the rules of before", [op({}), op({ email: "warn" }), op({ crons: "fail" })], ["ok", "warn", "degraded"]);

console.log("\nclassifyPlatformEmail (ADR 0029 section H)");
{
  const P = (over: Partial<Parameters<typeof classifyPlatformEmail>[0]>) =>
    classifyPlatformEmail({ configured: true, logReadable: true, newest: [], sent24h: 0, ceiling: 375, ...over });
  const row = (status: string, error_code: string | null = null) => ({ status, error_code });
  eq("configured, no rows → ok", P({}), { status: "ok", reasons: [] });
  eq("not configured → fail (read from the variables, before any send)", P({ configured: false }), { status: "fail", reasons: ["not_configured"] });
  eq("the log unreadable → fail", P({ logReadable: false }), { status: "fail", reasons: ["log_unreadable"] });
  eq("newest sent → ok", P({ newest: [row("sent"), row("failed", "auth")] }).status, "ok");
  eq("one timeout row → warn (that mail may still have arrived)", P({ newest: [row("failed", "timeout"), row("sent")] }), { status: "warn", reasons: ["last_failed"] });
  eq("one unreachable row → warn", P({ newest: [row("failed", "unreachable")] }).status, "warn");
  eq("one unknown row → warn", P({ newest: [row("failed", "unknown")] }).status, "warn");
  eq("one auth row → fail", P({ newest: [row("failed", "auth"), row("sent")] }), { status: "fail", reasons: ["sender_dead"] });
  eq("one quota row → fail", P({ newest: [row("failed", "quota")] }).status, "fail");
  eq("two failures in a row → fail", P({ newest: [row("failed", "timeout"), row("failed", "unknown")] }), { status: "fail", reasons: ["two_failures"] });
  eq("no time window: an old auth failure with nothing after it still fails", P({ newest: [row("failed", "auth")] }).status, "fail");
  eq("a delivered test after the failures clears it", P({ newest: [row("sent"), row("failed", "auth")] }).status, "ok");
  for (const [label, r] of [["suppressed", row("suppressed", "test_domain")], ["refused (account)", row("refused", "account_limit")], ["refused (ceiling)", row("refused", "ceiling")], ["rejected", row("failed", "rejected")], ["not_configured", row("failed", "not_configured")]] as const) {
    eq(`a ${label} row never moves it (newest, above a sent row)`, P({ newest: [r, r, row("sent")] }).status, "ok");
    eq(`…nor above a timeout row (still the one-row warn)`, P({ newest: [r, row("failed", "timeout"), row("sent")] }).status, "warn");
  }
  eq("at the ceiling → fail", P({ sent24h: 375 }), { status: "fail", reasons: ["at_ceiling"] });
  eq("half the ceiling → warn", P({ sent24h: 188 }), { status: "warn", reasons: ["half_ceiling"] });
  eq("under half → ok", P({ sent24h: 187 }).status, "ok");
  eq("the ceiling given is used", P({ sent24h: 1000, ceiling: 1500 }).status, "warn");
}

console.log("\nmail_recipients: a request's skip reads warn for 24 hours (ADR 0029, note of 2026-11-19)");
{
  const skip = (ageMin: number) => [{ name: MAIL_RECIPIENTS_HEARTBEAT, last_run_at: ago(ageMin) }];
  const mr = (rows: Parameters<typeof classifyMailRecipients>[0]["rows"]) => classifyMailRecipients({ rows, nowMs: NOW }).status;
  eq("the row's name and its 24 hours", [MAIL_RECIPIENTS_HEARTBEAT, MAIL_RECIPIENTS_WARN_HOURS], ["mail-recipients-unreadable", 24]);
  eq("no row → ok", mr([{ name: "reminders", last_run_at: ago(5) }]), "ok");
  eq("a row 23 hours old → warn", mr(skip(23 * 60)), "warn");
  eq("a row 25 hours old → ok (it clears by age alone)", mr(skip(25 * 60)), "ok");
  eq("the heartbeats cannot be read → unknown", mr("unreadable"), "unknown");
  eq("never fail, whatever the row says", [mr(skip(0)), mr([{ name: MAIL_RECIPIENTS_HEARTBEAT, last_run_at: "garbage" }])], ["warn", "ok"]);
  eq("…the time of the last skip is given", classifyMailRecipients({ rows: skip(60), nowMs: NOW }).last_skip_at, ago(60));
  eq("it is not a schedule rule: no expectCrons input, and the row is in no cadence map", crons([...fresh, [MAIL_RECIPIENTS_HEARTBEAT, 5, "error"]]).jobs[MAIL_RECIPIENTS_HEARTBEAT], undefined);
}

console.log("\nthe errored-run rule with the two mail crons in the list it is given (note of 2026-11-20, part 2)");
{
  const MAIL_CADENCE = { "lrs-forward": 30, "journey-nudges": 360, reminders: 26 * 60 };
  const LIST = ["lrs-forward", "reminders", "journey-nudges"];
  const rows = (over: Record<string, [number, string]>) =>
    Object.keys(MAIL_CADENCE).map((name) => ({ name, last_run_at: ago(over[name]?.[0] ?? 3), last_status: over[name]?.[1] ?? "ok" }));
  const mc = (over: Record<string, [number, string]>, expectCrons = true) =>
    classifyCrons({ cadenceMin: MAIL_CADENCE, staleWarnOnly: ["lrs-forward", "journey-nudges"], staleDegradedAfterMin: CEILING, erroredWarn: LIST, rows: rows(over), nowMs: NOW, expectCrons });
  eq("a fresh failed run of reminders → warn", mc({ reminders: [60, "error"] }).status, "warn");
  eq("a fresh failed run of journey-nudges → warn", mc({ "journey-nudges": [30, "error"] }).status, "warn");
  eq("crons not expected (staging): ok, and the job's state still says its last run failed", [mc({ reminders: [60, "error"] }, false).status, mc({ reminders: [60, "error"] }, false).jobs.reminders.status], ["ok", "last-run-errored"]);
  eq("a stale reminders reads fail by the staleness rule, whatever its last result", [mc({ reminders: [26 * 60 + 1, "error"] }).status, mc({ reminders: [26 * 60 + 1, "ok"] }).status], ["fail", "fail"]);
  eq("the overall status: warn, never degraded from a failed run alone", overallStatus({ db: "ok", storage: "ok", crons: mc({ reminders: [60, "error"], "journey-nudges": [30, "error"] }).status, lrsOutbox: "ok", email: "ok" }), "warn");
  eq("…with or without the secret's checks", overallStatus({ db: "ok", storage: "ok", crons: mc({ reminders: [60, "error"] }).status, lrsOutbox: "ok", email: "ok", platformEmail: "ok" }), "warn");
  eq("a clean next run clears it", mc({ reminders: [1, "ok"] }).status, "ok");
}

console.log("\nthe mail crons' detail: words, builder, reader, carry, pending");
{
  eq("the fixed word list", [...CRON_ERROR_WORDS], ["config_read", "members_read", "assignments_read", "progress_read", "state_read", "state_write", "profiles_read", "mail_status_read", "log_write", "alert", "call_limit", "unknown"]);
  const clean = buildMailCronDetail({ errors: {}, unreadableOrgs: 0, stoppedBeforeSend: false, due: 12, sent: 9, failed: 1, left: 2, leftComplete: true, leftDailyLimit: 0, leftOrgs: 0, no0114: false }, { courses: 3 });
  eq("a clean run: ok, v 1, no failed steps, the route's own counts kept in the answer", [clean.ok, clean.answer.v, clean.answer.failed_steps, clean.answer.courses], [true, 1, 0, 3]);
  eq("…the answer holds numbers and booleans only", Object.values(clean.answer).every((v) => typeof v === "number" || typeof v === "boolean"), true);
  eq("…a clean heartbeat has no errors and no time; the route's own counts are not in it", ["errors" in clean.heartbeat, "last_ok_at" in clean.heartbeat, "courses" in clean.heartbeat], [false, false, false]);
  const failed = buildMailCronDetail({ errors: { state_read: 1, members_read: 2, alert: 0 }, unreadableOrgs: 2, stoppedBeforeSend: true, no0114: false });
  eq("a failed run: not ok, failed_steps counts the words, the words only in the heartbeat", [failed.ok, failed.answer.failed_steps, "errors" in failed.answer, failed.heartbeat.errors], [false, 3, false, { members_read: 2, state_read: 1 }]);
  eq("…a number not known is left out, never 0", ["due" in failed.answer, "left" in failed.answer, "sent" in failed.heartbeat], [false, false, false]);
  eq("…unreadable organisations alone make the run not ok", buildMailCronDetail({ errors: {}, unreadableOrgs: 1, stoppedBeforeSend: false, no0114: false }).ok, false);
  eq("…no_0114 is a clean run that says so", [buildMailCronDetail({ errors: {}, unreadableOrgs: 0, stoppedBeforeSend: false, no0114: true }).ok, buildMailCronDetail({ errors: {}, unreadableOrgs: 0, stoppedBeforeSend: false, no0114: true }).answer.no_0114], [true, true]);
  eq("…extra values that are not counts or booleans are not answered", Object.keys(buildMailCronDetail({ errors: {}, unreadableOrgs: 0, stoppedBeforeSend: false, no0114: false }, { orgs: "acme" as never, n: -1, ok2: true }).answer).filter((k) => ["orgs", "n", "ok2"].includes(k)), ["ok2"]);

  const hostile = {
    v: 1, sent: 3, left: -2, due: "7", failed_steps: 1.5, unreadable_orgs: 1,
    orgs: ["acme", "beta"], error: "duplicate key for person@tenant.stub", note: "free text",
    errors: { members_read: 2, made_up: 1, alert: -1, state_read: "3" },
    left_complete: "false", no_0114: false, last_ok_at: "2026-11-19T06:00:00Z",
  };
  const read = readMailCronDetail(hostile);
  eq("the reader lets through named keys with whole non-negative numbers, listed words and a time", read, { known: true, unreadable_orgs: 1, sent: 3, no_0114: false, errors: { members_read: 2 }, last_ok_at: "2026-11-19T06:00:00.000Z" });
  eq("…a list of slugs, free text with an address, an unknown key, an unlisted word, a negative number and text for a number are all dropped", JSON.stringify(read).match(/acme|person@|free text|made_up|-2|"7"/g), null);
  eq("…a time that does not parse is dropped", readMailCronDetail({ v: 1, last_ok_at: "yesterday, after lunch" }).last_ok_at, undefined);
  eq("a row without v reads not known", [readMailCronDetail({ sent: 3 }).known, readMailCronDetail(null).known, readMailCronDetail("text").known, readMailCronDetail([1]).known], [false, false, false, false]);
  const olderErrorRow = { last_status: "error", last_run_at: ago(10), last_detail: { ok: false, orgs: ["acme"], error: "database message" } };
  const items = mailCronItems(olderErrorRow);
  eq("an errored row without v: not known three times (last successful run, failure details, pending)", [items.lastOk, items.details, items.pending], [null, null, { kind: "not_known" }]);
  for (const [label, detail] of [["no detail", null], ["a detail without v", { courses: 3, sent: 2 }]] as const) {
    const ok = mailCronItems({ last_status: "ok", last_run_at: ago(10), last_detail: detail });
    eq(`an ok row with ${label}: not known three times (its ok is not evidence of a success)`, [ok.lastOk, ok.details, ok.pending], [null, null, { kind: "not_known" }]);
  }

  eq("carry: an ok row gives its own time", carriedLastOk({ last_status: "ok", last_run_at: ago(60), last_detail: null }), ago(60));
  eq("carry: a failed row with last_ok_at gives that time", carriedLastOk({ last_status: "error", last_run_at: ago(5), last_detail: { v: 1, last_ok_at: ago(90) } }), ago(90));
  eq("carry: a failed row from older code gives not known", carriedLastOk({ last_status: "error", last_run_at: ago(5), last_detail: { ok: false } }), null);
  eq("carry: no row, or a row that could not be read, gives not known", [carriedLastOk(null), carriedLastOk("unreadable")], [null, null]);
  eq("the last successful run as shown: the row's own time while ok, the carried one while error", [lastSuccessfulRun({ last_status: "ok", last_run_at: ago(1), last_detail: { v: 1 } }), lastSuccessfulRun({ last_status: "error", last_run_at: ago(1), last_detail: { v: 1, last_ok_at: ago(100) } }), lastSuccessfulRun(null)], [ago(1), ago(100), null]);

  eq("pending: a number that was left out reads not known, never 0", [pendingOf({ known: true }), pendingOf({ known: false, left: 4 })], [{ kind: "not_known" }, { kind: "not_known" }]);
  eq("pending: an incomplete count reads at least n", pendingOf({ known: true, left: 4, left_complete: false }), { kind: "at_least", n: 4 });
  eq("pending: a complete count reads n, 0 included", [pendingOf({ known: true, left: 0, left_complete: true }), pendingOf({ known: true, left: 3 })], [{ kind: "exact", n: 0 }, { kind: "exact", n: 3 }]);
  eq("owed: a timed-out nudge keeps its claim and is not owed; another failure is", owedAfterRun("journey-nudges", { notStarted: 2, failedClasses: ["timeout", "unreachable", "auth", "timeout"] }), 4);
  eq("owed: a tried reminder counts as reminded whatever its result", owedAfterRun("reminders", { notStarted: 2, failedClasses: ["unreachable", "auth"] }), 2);
}

console.log("\ntenant_smtp and mail_jobs (never fail)");
{
  const o = (reading: "not_configured" | "configured" | "healthy" | "failing", hasMembers = true, routineStopped = false) => ({ reading, hasMembers, routineStopped });
  eq("every organisation ready → ok", classifyTenantSmtp([o("healthy"), o("configured")]).status, "ok");
  eq("one failing with members → warn", classifyTenantSmtp([o("healthy"), o("failing")]).status, "warn");
  eq("one not configured with members → warn", classifyTenantSmtp([o("not_configured")]).status, "warn");
  eq("…without members it does not count", classifyTenantSmtp([o("not_configured", false), o("failing", false)]).status, "ok");
  eq("routine mail stopped by the daily limit → warn", classifyTenantSmtp([o("healthy", true, true)]).status, "warn");
  eq("cannot be read, or no 0114 → unknown", [classifyTenantSmtp("unreadable").status, classifyTenantSmtp("missing").status], ["unknown", "unknown"]);
  eq("…the counts by reading", classifyTenantSmtp([o("healthy"), o("failing"), o("failing", true, true)]).counts, { not_configured: 0, configured: 0, healthy: 1, failing: 2, routine_stopped: 1 });
  eq("mail_jobs: none lost → ok", classifyMailJobs([{ started: 20, finished: 20 }, { started: 10, finished: 10 }]).status, "ok");
  eq("mail_jobs: 3 lost over the two days → warn", classifyMailJobs([{ started: 20, finished: 18 }, { started: 10, finished: 9 }]), { status: "warn", started: 30, lost: 3 });
  eq("mail_jobs: 2 lost of 49 → ok (fewer than 50 started, fewer than 3 lost)", classifyMailJobs([{ started: 49, finished: 47 }]).status, "ok");
  eq("mail_jobs: exactly 2 in 100 is not above it → ok (1 of 50, 2 of 100)", [classifyMailJobs([{ started: 50, finished: 49 }]).status, classifyMailJobs([{ started: 100, finished: 98 }]).status], ["ok", "ok"]);
  eq("mail_jobs: above 2 in 100 once 50 have started → warn, under 3 lost (2 of 60)", classifyMailJobs([{ started: 60, finished: 58 }]).status, "warn");
  eq("mail_jobs: cannot be read, or no 0114 → unknown", [classifyMailJobs("unreadable").status, classifyMailJobs("missing").status], ["unknown", "unknown"]);
}

/* ---------------- recordHeartbeat's fourth argument ---------------- */

async function heartbeatCarryTests() {
  console.log("\nrecordHeartbeat: the carry of the last successful run (note of 2026-11-20, part 2, point 6)");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  let prev: unknown = null;
  let readFails = false;
  let calls: Array<{ method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (url.pathname !== "/rest/v1/ops_heartbeats") throw new Error(`stub: unexpected ${url.pathname}`);
    if (method === "GET") return readFails ? jsonRes({ code: "XX000", message: "stub" }, 500) : jsonRes(prev ? [prev] : []);
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  try {
    const { recordHeartbeat } = await import("../../lib/ops/heartbeat");
    const written = () => (calls.find((c) => c.method === "POST")?.body ?? {}) as { last_status?: string; last_detail?: Record<string, unknown> };
    const run = async (ok: boolean, detail: Record<string, unknown> = { v: 1, failed_steps: ok ? 0 : 1 }) => { calls = []; await recordHeartbeat("reminders", detail, ok, { carryLastOk: true }); return written(); };
    prev = { last_status: "ok", last_run_at: ago(60), last_detail: { v: 1 } };
    const a = await run(false);
    eq("a failed run reads its own row once, then writes; the previous ok run's time is carried", [calls.map((c) => c.method), a.last_status, a.last_detail?.last_ok_at], [["GET", "POST"], "error", new Date(Date.parse(ago(60))).toISOString()]);
    prev = { last_status: "error", last_run_at: ago(5), last_detail: { v: 1, last_ok_at: ago(600) } };
    eq("…after another failure, the carried time is kept", (await run(false)).last_detail?.last_ok_at, new Date(Date.parse(ago(600))).toISOString());
    prev = { last_status: "error", last_run_at: ago(5), last_detail: { ok: false } };
    eq("…a failed row from older code: no time written (not known)", "last_ok_at" in ((await run(false)).last_detail ?? {}), false);
    prev = null;
    eq("…no row: no time written", "last_ok_at" in ((await run(false)).last_detail ?? {}), false);
    readFails = true;
    const u = await run(false);
    eq("…the read fails: no time written, and the heartbeat is still written", ["last_ok_at" in (u.last_detail ?? {}), u.last_status], [false, "error"]);
    readFails = false;
    prev = { last_status: "ok", last_run_at: ago(60), last_detail: null };
    const c = await run(true, { v: 1, failed_steps: 0, last_ok_at: ago(9999) });
    eq("a clean run makes no read and writes no last_ok_at (a caller's value never passes)", [calls.map((x) => x.method), "last_ok_at" in (c.last_detail ?? {})], [["POST"], false]);
    calls = [];
    await recordHeartbeat("lrs-forward", { anything: 1 }, false);
    eq("without the fourth argument (every other job): no read, the detail as given", [calls.map((x) => x.method), written().last_detail], [["POST"], { anything: 1 }]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------------- the route, under a stubbed fetch ---------------- */

type LogRow = Record<string, string | null>;
let notificationRows: LogRow[] = [];
let platformRows: LogRow[] = [];
let platformTableMissing = false;
let requests: Array<{ method: string; path: string; query: URLSearchParams }> = [];

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function evalOp(val: string | null | undefined, opv: string): boolean {
  if (opv.startsWith("eq.")) return String(val) === opv.slice(3);
  if (opv.startsWith("gte.")) return String(val) >= opv.slice(4);
  if (opv.startsWith("lte.")) return String(val) <= opv.slice(4);
  if (opv.startsWith("in.(")) return opv.slice(4, -1).split(",").includes(String(val));
  if (opv.startsWith("not.in.(")) return !opv.slice(8, -1).split(",").includes(String(val));
  throw new Error(`stub: operator not understood: ${opv}`);
}
function evalCond(r: LogRow, c: string): boolean {
  if (c.startsWith("and(")) return splitTop(c.slice(4, -1)).every((x) => evalCond(r, x));
  if (c.startsWith("or(")) return splitTop(c.slice(3, -1)).some((x) => evalCond(r, x));
  const i = c.indexOf(".");
  return evalOp(r[c.slice(0, i)], c.slice(i + 1));
}
function matches(r: LogRow, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    if (k === "or") { if (!splitTop(v.slice(1, -1)).some((c) => evalCond(r, c))) return false; continue; }
    if (!evalOp(r[k], v)) return false;
  }
  return true;
}
const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const countRes = (n: number) => new Response(null, { status: 200, headers: { "content-range": `*/${n}` } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  requests.push({ method, path: url.pathname, query: url.searchParams });
  const p = url.pathname;
  if (p === "/storage/v1/bucket") return jsonRes([]);
  if (p === "/rest/v1/organizations") return countRes(1);
  if (p === "/rest/v1/ops_heartbeats") return jsonRes([]);
  if (p === "/rest/v1/lrs_forward_outbox") return countRes(0);
  if (p === "/rest/v1/notification_log" && method === "HEAD") return countRes(notificationRows.filter((r) => matches(r, url.searchParams)).length);
  if (p === "/rest/v1/platform_email_log") {
    if (platformTableMissing) return jsonRes({ code: "PGRST205", message: "Could not find the table" }, 404);
    const found = platformRows.filter((r) => matches(r, url.searchParams));
    if (method === "HEAD") return countRes(found.length);
    const sorted = url.searchParams.get("order") === "sent_at.desc" ? found.sort((a, b) => (String(a.sent_at) < String(b.sent_at) ? 1 : -1)) : found;
    return jsonRes(sorted.slice(0, Number(url.searchParams.get("limit") ?? "1000")));
  }
  throw new Error(`stub: unexpected ${method} ${p}`);
};

const SECRET = "stub-cron-secret-0029";
const PLATFORM_ENV: Record<string, string> = {
  PLATFORM_SMTP_HOST: "smtp.platform.stub",
  PLATFORM_SMTP_PORT: "465",
  PLATFORM_SMTP_USER: "mailbox-user-0029",
  PLATFORM_SMTP_PASSWORD: "stub-app-password-0029",
  PLATFORM_SMTP_FROM: "LMS Platform <mailbox-from-0029>",
  PLATFORM_EMAIL_ALLOW_DOMAINS: "*",
};
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function routeTests() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.CRON_SECRET = SECRET;
  delete process.env.OPS_EXPECT_CRONS;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    const route = await import("../../app/api/ops/health/route");
    const call = async (authed: boolean) => {
      requests = [];
      const res = await route.GET(new Request("http://lms.test/api/ops/health", { headers: authed ? { "x-cron-secret": SECRET } : {} }));
      return { http: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const configure = (on: boolean) => { for (const [k, v] of Object.entries(PLATFORM_ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } };
    const fresh = () => { notificationRows = []; platformRows = []; platformTableMissing = false; };
    const platformStatus = (b: Record<string, unknown>) => ((b.email_checks as Record<string, { status: string }>)?.platform_email?.status);

    console.log("\nthe route: the unauthenticated answer and email_checks");
    {
      fresh(); configure(false);
      const pub = await call(false);
      eq("unauthenticated: exactly { status, ts }", Object.keys(pub.body).sort(), ["status", "ts"]);
      eq("…ok while the platform sender is not configured (computed without it)", [pub.http, pub.body.status], [200, "ok"]);
      eq("…and the platform check is not run for that caller", requests.filter((r) => r.path === "/rest/v1/platform_email_log").length, 0);
      const full = await call(true);
      eq("with the secret: degraded while the sender is not configured", full.body.status, "degraded");
      eq("…checks holds exactly the five checks of before", Object.keys(full.body.checks as object).sort(), ["crons", "db", "email", "lrs_outbox", "storage"]);
      eq("…email_checks holds platform_email, and nothing of it is under checks", [Object.keys(full.body.email_checks as object), JSON.stringify(full.body.checks).includes("platform")], [["platform_email"], false]);
      const pe = (full.body.email_checks as Record<string, { status: string; detail: { missing: string[]; configured: boolean } }>).platform_email;
      eq("…platform_email reads fail, names the missing variables and holds no value", [pe.status, pe.detail.configured, pe.detail.missing.length], ["fail", false, 6]);
      configure(true);
      const withValues = JSON.stringify((await call(true)).body);
      eq("…configured: no setting's value in the answer", Object.values(PLATFORM_ENV).filter((v) => v !== "*" && v !== "465" && withValues.includes(v)), []);
    }

    console.log("\nthe route: platform_email states, and the unauthenticated status never moves");
    {
      const states: Array<[string, () => void, string, string]> = [
        ["configured, newest sent", () => { configure(true); platformRows = [{ sent_at: minutesAgo(5), status: "sent", error_code: null }]; }, "ok", "ok"],
        ["configured, one timeout", () => { configure(true); platformRows = [{ sent_at: minutesAgo(1), status: "failed", error_code: "timeout" }, { sent_at: minutesAgo(5), status: "sent", error_code: null }]; }, "warn", "warn"],
        ["configured, an auth failure", () => { configure(true); platformRows = [{ sent_at: minutesAgo(1), status: "failed", error_code: "auth" }]; }, "fail", "degraded"],
        ["configured, two failures", () => { configure(true); platformRows = [{ sent_at: minutesAgo(1), status: "failed", error_code: "unknown" }, { sent_at: minutesAgo(2), status: "failed", error_code: "unreachable" }]; }, "fail", "degraded"],
        ["configured, suppressed and rejected rows only above a sent one", () => { configure(true); platformRows = [{ sent_at: minutesAgo(1), status: "suppressed", error_code: "test_domain" }, { sent_at: minutesAgo(2), status: "failed", error_code: "rejected" }, { sent_at: minutesAgo(3), status: "refused", error_code: "ceiling" }, { sent_at: minutesAgo(9), status: "sent", error_code: null }]; }, "ok", "ok"],
        ["configured, the log not there (0113 not pasted)", () => { configure(true); platformTableMissing = true; }, "fail", "degraded"],
        ["not configured", () => { configure(false); }, "fail", "degraded"],
      ];
      const publicStatuses: string[] = [];
      for (const [label, arrange, check, overall] of states) {
        fresh(); arrange();
        const full = await call(true);
        eq(`${label}: platform_email ${check}, overall ${overall}`, [platformStatus(full.body), full.body.status], [check, overall]);
        publicStatuses.push(String((await call(false)).body.status));
      }
      eq("the unauthenticated status is the same in every state", [...new Set(publicStatuses)], ["ok"]);
    }

    console.log("\nthe route: the email check ignores password_reset and magic_link");
    {
      fresh(); configure(true);
      platformRows = [{ sent_at: minutesAgo(5), status: "sent", error_code: null }];
      for (let i = 0; i < 10; i++) {
        notificationRows.push({ event_type: i % 2 ? "password_reset" : "magic_link", status: "failed", sent_at: minutesAgo(10 + i) });
      }
      const pub = await call(false);
      const full = await call(true);
      const email = (full.body.checks as Record<string, { status: string; detail: { failed_24h: number } }>).email;
      eq("ten failed reset codes and sign-in links: the email check reads ok, failed_24h 0", [email.status, email.detail.failed_24h], ["ok", 0]);
      eq("…and the unauthenticated status stays ok", pub.body.status, "ok");
      const logReads = requests.filter((r) => r.path === "/rest/v1/notification_log");
      eq("…both notification_log counts carry the exclusion", logReads.map((r) => r.query.get("event_type")), [`not.in.(${EMAIL_CHECK_IGNORED_EVENTS.join(",")})`, `not.in.(${EMAIL_CHECK_IGNORED_EVENTS.join(",")})`]);
      for (let i = 0; i < 6; i++) notificationRows.push({ event_type: "asset_assignment", status: "failed", sent_at: minutesAgo(20 + i) });
      const after = await call(true);
      eq("six failed assignment mails: warn, as before (every other event is counted)", [(after.body.checks as Record<string, { status: string }>).email.status, after.body.status, (await call(false)).body.status], ["warn", "warn", "warn"]);
      notificationRows = notificationRows.map((r) => (r.event_type === "asset_assignment" ? { ...r, sent_at: minutesAgo(25 * 60) } : r));
      eq("…older than 24 hours: ok", (await call(false)).body.status, "ok");
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(PLATFORM_ENV)) delete process.env[k];
  }
}

/* ---------------- what the watchdog prints ---------------- */

function opsWatchTests() {
  console.log("\n.github/workflows/ops-watch.yml prints only the status, the time and checks.<name>.status");
  const file = path.resolve(__dirname, "../../.github/workflows/ops-watch.yml");
  const src = fs.readFileSync(file, "utf8");
  const filters = [...src.matchAll(/jq (?:-r )?'([^']+)' \/tmp\/health\.json/g)].map((m) => m[1]);
  const PRINT = "{status, ts, checks: (.checks // {} | map_values({status}))}";
  eq(`non-vacuous: the probe and the digest each read and print the body (${filters.length} jq filters)`, filters.length, 4);
  eq("every jq filter is the status read or the one print filter", [...new Set(filters)].sort(), ['.status // "unreachable"', PRINT].sort());
  eq("the print filter appears twice (the step summary and the digest)", filters.filter((f) => f === PRINT).length, 2);
  const mentions = (src.match(/\/tmp\/health\.json/g) ?? []).length;
  const writes = (src.match(/(?:-o|>) \/tmp\/health\.json/g) ?? []).length;
  eq("no other read of the body: every mention of the file is a write or one of those jq filters, and nothing uploads it", [mentions - writes, /upload-artifact/.test(src)], [filters.length, false]);
  eq("the workflow never names the new checks", /email_checks|platform_email|tenant_smtp/.test(src), false);
  // The print filter applied to an authenticated body.
  const body = {
    status: "degraded", ts: "2026-11-17T00:00:00Z", expect_crons: true,
    checks: { db: { status: "ok", latency_ms: 3 }, email: { status: "ok", detail: { failed_24h: 0 } } },
    email_checks: { platform_email: { status: "fail", detail: { missing: ["PLATFORM_SMTP_PASSWORD"] } } },
  };
  const printed = { status: body.status, ts: body.ts, checks: Object.fromEntries(Object.entries(body.checks).map(([k, v]) => [k, { status: v.status }])) };
  eq("…so a body with email_checks prints no word of them", [JSON.stringify(printed).includes("platform"), Object.keys(printed)], [false, ["status", "ts", "checks"]]);
}

routeTests()
  .then(() => heartbeatCarryTests())
  .then(() => {
    opsWatchTests();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
    process.exit(1);
  });
