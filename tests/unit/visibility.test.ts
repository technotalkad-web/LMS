/**
 * Unit test for the manager visibility rule (Phase 4c, addendum §6):
 * rule 1 (content mapping vs the manager's coverage), the re-derivation of
 * a learner's numbers over visible content only (decision 22), and the
 * derive step itself. No DB.
 *
 * Run:  npx tsx tests/unit/visibility.test.ts
 */
import { applyCoverage, isVisible, lensVisible, visibilityFor, type Coverage } from "../../lib/manager/coverage";
import { deriveLearner } from "../../lib/manager/derive";
import type { ContentScopes } from "../../lib/content/scopes";
import type { CourseLine, LearnerInsight } from "../../lib/manager/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const cov = (pairs: Array<[string, string | null]>, enforce = false): Coverage => ({
  pairs: pairs.map(([vertical, department]) => ({ vertical, department })),
  hasVertical: pairs.length > 0,
  enforce,
  label: pairs.map(([v, d]) => (d ? `${v} · ${d}` : `${v} (all)`)).join(", "),
});
const map = (pairs: Array<[string, string | null]>, common = false): ContentScopes => ({ common, pairs: pairs.map(([vertical, department]) => ({ vertical, department })) });
const RETAIL_HLS = cov([["Retail", "Home Loan Sales"]]);

console.log("\nrule 1: mapping vs coverage");
{
  eq("exact pair", isVisible(RETAIL_HLS, map([["Retail", "Home Loan Sales"]])), true);
  eq("case-insensitive", isVisible(RETAIL_HLS, map([["retail", "home loan sales"]])), true);
  eq("whole-vertical mapping is visible to every manager of the vertical", isVisible(RETAIL_HLS, map([["Retail", null]])), true);
  eq("other department of the same vertical → hidden", isVisible(RETAIL_HLS, map([["Retail", "Collections"]])), false);
  eq("other vertical → hidden", isVisible(RETAIL_HLS, map([["Fulfillment", null]])), false);
  eq("common to all → visible", isVisible(RETAIL_HLS, map([], true)), true);
  eq("unmapped → visible while enforcement is off (decision 15)", isVisible(RETAIL_HLS, map([])), true);
  eq("unmapped → hidden once enforced", isVisible(cov([["Retail", "Home Loan Sales"]], true), map([])), false);
  eq("manager with a whole-vertical coverage sees every department of it", isVisible(cov([["Retail", null]]), map([["Retail", "Collections"]])), true);
  eq("manager with no vertical sees only unmapped (transition) and common", [isVisible(cov([]), map([["Retail", null]])), isVisible(cov([]), map([])), isVisible(cov([]), map([], true)), isVisible(cov([], true), map([]))], [false, true, true, false]);
  eq("coverage pairs add up (decision 14)", isVisible(cov([["Retail", "Home Loan Sales"], ["Fulfillment", null]]), map([["Fulfillment", "Ops"]])), true);
  const vis = visibilityFor(RETAIL_HLS, new Map([["course:c1", map([["Retail", null]])], ["journey:j1", map([["Fulfillment", null]])]]));
  eq("visibilityFor by key; unknown ids read as unmapped", [vis("course", "c1"), vis("journey", "j1"), vis("path", "p9")], [true, false, true]);
  eq("lensVisible", [lensVisible(vis, "course:c1"), lensVisible(vis, "journey:j1"), lensVisible(vis, ""), lensVisible(vis, "status:failed")], [true, false, true, true]);
}

const NOW = Date.parse("2026-10-07T10:00:00Z");
const DAYS = (n: number) => new Date(NOW - n * 86400000).toISOString();
const line = (courseId: string, over: Partial<CourseLine> = {}): CourseLine => ({
  courseId, title: courseId, status: "not_started", officialScore: null, attempts: 0, progressPct: null, assignedAt: DAYS(20), dueAt: null, overdue: false,
  startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, openGrant: false, limitReached: false,
  completedAt: null, done: false, isAssigned: true, ...over,
});
const learner = (courses: CourseLine[], extra: Partial<LearnerInsight> = {}): LearnerInsight => {
  const d = deriveLearner({ courses, paths: [], journeys: [], lastActive: DAYS(2), periodDays: 30, nowMs: NOW });
  return {
    userId: "u1", name: "U", email: "u@example.test", avatarUrl: null, designation: null, city: null, branch: null, vertical: "Retail", department: "Home Loan Sales", joined: null,
    lastActive: DAYS(2), journeys: [], courses, paths: [], ...d, ...extra,
  };
};

console.log("\nderive: numbers from the lines");
{
  const l = learner([
    line("passed", { status: "passed", officialScore: 90, attempts: 1, completedAt: DAYS(3), done: true, passedFirstTime: true }),
    line("failed", { status: "failed", officialScore: 40, attempts: 1, completedAt: DAYS(40), limitReached: true }),
    line("overdue", { dueAt: DAYS(1), overdue: true }),
    line("fresh", { assignedAt: DAYS(1) }),
  ]);
  eq("assigned / completed / completion %", [l.assigned, l.completed, l.completionPct], [4, 1, 25]);
  eq("avg score over courses with a result, first-time passes", [l.avgScore, l.assessmentsWithResult, l.passedFirstTime], [65, 2, 1]);
  eq("period counters from the official completion date (30d: 1 in, 1 in the previous window)", [l.completedInPeriod, l.completedInPrevPeriod, l.passedFirstTimeInPeriod], [1, 1, 1]);
  eq("flags: failed, overdue, not started (20d) — the 1-day-old assignment is not flagged", l.flags.filter((f) => f.kind !== "needs_support").map((f) => `${f.kind}:${f.contentId}`), ["failed:failed", "overdue:overdue", "not_started:overdue"]);
  eq("risk / status (three distinct exception kinds → needs support)", [l.risk >= 2, l.status], [true, "needs_support"]);
}

console.log("\napplyCoverage: numbers over visible content only (decision 22)");
{
  const l = learner([
    line("retail", { status: "passed", officialScore: 90, attempts: 1, completedAt: DAYS(3), done: true, passedFirstTime: true }),
    line("fulfil", { status: "failed", officialScore: 40, attempts: 1, completedAt: DAYS(4), limitReached: true }),
    line("unmapped"),
  ]);
  const scopes = new Map<string, ContentScopes>([["course:retail", map([["Retail", "Home Loan Sales"]])], ["course:fulfil", map([["Fulfillment", null]])]]);
  const r = applyCoverage(l, visibilityFor(RETAIL_HLS, scopes), 30, NOW);
  eq("the Fulfillment course is hidden; unmapped stays (enforce off)", [r.hidden, r.learner.courses.map((c) => c.courseId)], [1, ["retail", "unmapped"]]);
  eq("numbers re-derived: 2 assigned, 1 done → 50%, score 90, no failed flag", [r.learner.assigned, r.learner.completed, r.learner.completionPct, r.learner.avgScore, r.learner.flags.some((f) => f.kind === "failed")], [2, 1, 50, 90, false]);
  eq("status drops from needs_support to watch once the failed module is out of scope", [l.status, r.learner.status], ["needs_support", "watch"]);
  const enforced = applyCoverage(l, visibilityFor(cov([["Retail", "Home Loan Sales"]], true), scopes), 30, NOW);
  eq("enforced: the unmapped course goes too", [enforced.hidden, enforced.learner.courses.map((c) => c.courseId), enforced.learner.completionPct], [2, ["retail"], 100]);
  eq("engagement stays person-level", [r.learner.lastActive === l.lastActive, r.learner.activeLast7d], [true, true]);
  eq("nothing hidden → same object", applyCoverage(l, () => true, 30, NOW).learner === l, true);
  const legacy = { ...l, courses: l.courses.map((c) => { const { done: _d, ...rest } = c; void _d; return rest as CourseLine; }) };
  eq("a pre-4c cached row (no `done`) is returned untouched", applyCoverage(legacy, () => false, 30, NOW).hidden, 0);
  const legacyJourney = { ...l, courses: [], journeys: [{ programId: "j1", name: "J", status: "active" as const, unlockMode: "calendar" as const, day: 2, total: 30, behind: 0, overdueDeadline: false, daysDone: 1, courseDays: 30, nextModule: null, onTrack: true } as unknown as LearnerInsight["journeys"][number]] };
  eq("a pre-4c cached row with journeys only (no daysInPeriod) is returned untouched", applyCoverage(legacyJourney, () => false, 30, NOW).hidden, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
