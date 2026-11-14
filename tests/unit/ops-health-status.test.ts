/**
 * The status rules of GET /api/ops/health (lib/ops/health-status.ts): the
 * owner's decision of 2026-11-14 (ADR 0007, the note of that date on decision
 * 4) that a stale heartbeat of a job scheduled more than once a day reads
 * "warn", not "degraded", up to a ceiling, and that nothing else changes.
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
const CADENCE = { "lrs-forward": 30, "journey-nudges": 360, reaper: 26 * 60 };
const WARN_ONLY = ["lrs-forward", "journey-nudges"];
const CEILING = 26 * 60;

function crons(rows: Array<[string, number, string?]>, expectCrons = true) {
  return classifyCrons({
    cadenceMin: CADENCE,
    staleWarnOnly: WARN_ONLY,
    staleDegradedAfterMin: CEILING,
    rows: rows.map(([name, ageMin, st]) => ({ name, last_run_at: ago(ageMin), last_status: st ?? "ok" })),
    nowMs: NOW,
    expectCrons,
  });
}
const fresh: Array<[string, number]> = [["lrs-forward", 3], ["journey-nudges", 30], ["reaper", 60]];
const with_ = (name: string, age: number, st?: string) =>
  fresh.map(([n, a]) => (n === name ? ([n, age, st] as [string, number, string?]) : ([n, a] as [string, number])));

console.log("\nclassifyCrons on production (expectCrons)");
eq("all fresh → ok", crons(fresh).status, "ok");
eq("sub-daily job stale → warn", crons(with_("lrs-forward", 31)).status, "warn");
eq("sub-daily job stale at the ceiling → warn", crons(with_("lrs-forward", CEILING)).status, "warn");
eq("sub-daily job stale past the ceiling → fail", crons(with_("lrs-forward", CEILING + 1)).status, "fail");
eq("hourly job stale 10.5 h (the worst gap measured) → warn", crons(with_("journey-nudges", 630)).status, "warn");
eq("daily job stale → fail", crons(with_("reaper", 26 * 60 + 1)).status, "fail");
eq("sub-daily job never seen → fail", crons(fresh.filter(([n]) => n !== "lrs-forward")).status, "fail");
eq("daily job never seen → fail", crons(fresh.filter(([n]) => n !== "reaper")).status, "fail");
eq(
  "one warn and one fail → fail",
  crons([["lrs-forward", 31], ["journey-nudges", 30], ["reaper", 26 * 60 + 1]]).status,
  "fail"
);
eq("two sub-daily jobs stale → warn", crons([["lrs-forward", 31], ["journey-nudges", 400], ["reaper", 60]]).status, "warn");
eq("last run errored, not stale → ok (unchanged)", crons(with_("reaper", 60, "error")).status, "ok");
eq("its job state reads last-run-errored", crons(with_("reaper", 60, "error")).jobs.reaper.status, "last-run-errored");
eq("a warn job's state still reads stale", crons(with_("lrs-forward", 31)).jobs["lrs-forward"].status, "stale");
eq("a never-seen job's state", crons([]).jobs["lrs-forward"], { status: "never-seen" });
eq("a job not in the cadence map is ignored", crons([...fresh, ["other", 99999]]).status, "ok");

console.log("\nclassifyCrons on staging (expectCrons unset)");
eq("everything stale → ok", crons([["lrs-forward", 99999], ["journey-nudges", 99999], ["reaper", 99999]], false).status, "ok");
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
