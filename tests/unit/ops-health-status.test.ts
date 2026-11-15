/**
 * The status rules of GET /api/ops/health (lib/ops/health-status.ts): the
 * owner's decision of 2026-11-14 (ADR 0007, the note of that date on decision
 * 4) that a stale heartbeat of a job scheduled more than once a day reads
 * "warn", not "degraded", up to a ceiling, and that nothing else changes; and
 * the owner's decision of 2026-11-15 (ADR 0024, the note of that date) that an
 * errored last run of a job in the errored-warn list (lrs-forward) reads
 * "warn", and any other job's still reads "ok".
 *
 * Run:  npx tsx tests/unit/ops-health-status.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import { classifyCrons, overallStatus, type CheckStatus } from "../../lib/ops/health-status";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
