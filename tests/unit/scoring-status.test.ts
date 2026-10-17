/**
 * Unit test for the canonical learner course-status rule (Phase 0a,
 * product decision 1): "failed" = the OFFICIAL attempt failed; practice /
 * revision runs never change the official result; a granted retake becomes
 * the official attempt.
 *
 * Run:  npx tsx tests/unit/scoring-status.test.ts
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import { DEFAULT_POLICY } from "../../lib/scoring/policy";
import {
  computeScoring,
  courseStatus,
  isOfficialFailed,
  isOfficialPassed,
  statusOf,
  countByStatus,
  countsByCourse,
  excludeAbandoned,
  isAbandonedAttempt,
  attemptCounts,
  enrolledStatusSummary,
  userCourseKey,
  type UserCourseStatus,
} from "../../lib/scoring/status";
import { courseProgress } from "../../lib/courses/progress-view";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const at = (id: string, started: string, completed: string | null, cs: string, ss: string, score: number | null) =>
  ({ id, started_at: started, completed_at: completed, completion_status: cs, success_status: ss, score });
const P = DEFAULT_POLICY; // 1 scored attempt, basis first (platform default)

console.log("\nofficial status (decision 1)");
{
  const a = [at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "failed", 0.4)];
  const s = computeScoring(a, P);
  eq("official fail → failed", [courseStatus(s, a), isOfficialFailed(s)], ["failed", true]);
}
{
  const a = [
    at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "passed", 0.9),
    at("a2", "2026-10-02T09:00Z", "2026-10-02T09:30Z", "completed", "failed", 0.3),
  ];
  const s = computeScoring(a, P);
  eq("official pass + practice fail → passed, not failed", [courseStatus(s, a), isOfficialFailed(s), isOfficialPassed(s), s.practiceAttempts], ["passed", false, true, 1]);
}
{
  const a = [
    at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "failed", 0.4),
    at("a2", "2026-10-02T09:00Z", "2026-10-02T09:30Z", "completed", "passed", 0.9),
  ];
  const s = computeScoring(a, P);
  eq("official fail + practice pass → failed, practicePassed noted", [courseStatus(s, a), isOfficialFailed(s), s.practicePassed], ["failed", true, true]);
}
{
  const a = [
    at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "failed", 0.4),
    at("a2", "2026-10-02T09:00Z", "2026-10-02T09:30Z", "completed", "passed", 0.85),
  ];
  const s = computeScoring(a, P, new Set(["a2"]));
  eq("granted retake pass → passed; first score retained", [courseStatus(s, a), isOfficialFailed(s), s.officialAttempt?.id, s.firstScore], ["passed", false, "a2", 0.4]);
}
{
  const a = [at("a1", "2026-10-01T09:00Z", null, "incomplete", "unknown", null)];
  const s = computeScoring(a, P);
  eq("open attempt only → in_progress", [courseStatus(s, a), isOfficialFailed(s)], ["in_progress", false]);
  eq("no attempts → not_started", courseStatus(computeScoring([], P), []), "not_started");
}
{
  const mk = (u: string, c: string, st: UserCourseStatus["status"]): UserCourseStatus => ({ user_id: u, course_id: c, status: st, scoring: computeScoring([], P), attempts: [] });
  const m = new Map<string, UserCourseStatus>();
  for (const v of [mk("u1", "c1", "failed"), mk("u2", "c1", "passed"), mk("u3", "c1", "failed"), mk("u1", "c2", "in_progress")]) m.set(userCourseKey(v.user_id, v.course_id), v);
  eq("statusOf present / absent", [statusOf(m, "u1", "c1"), statusOf(m, "u9", "c1")], ["failed", "not_started"]);
  eq("countByStatus per course", countByStatus(m, "c1"), { not_started: 0, in_progress: 0, completed: 0, passed: 1, failed: 2 });
  eq("countsByCourse one pass", Object.fromEntries(countsByCourse(m)), { c1: { not_started: 0, in_progress: 0, completed: 0, passed: 1, failed: 2 }, c2: { not_started: 0, in_progress: 1, completed: 0, passed: 0, failed: 0 } });
}

console.log("\nabandoned is never official and never in progress (ADR 0004 step 11)");
{
  const ab = (id: string, started: string, progress?: number) => ({
    ...at(id, started, null, "in_progress", "unknown", null),
    status: "abandoned",
    course_version_id: "v1",
    progress_pct: progress ?? null,
  });
  const live = (id: string, started: string, progress?: number) => ({
    ...at(id, started, null, "in_progress", "unknown", null),
    status: "in_progress",
    course_version_id: "v2",
    progress_pct: progress ?? null,
  });

  const onlyReset = [ab("r1", "2026-10-01T09:00Z", 40)];
  eq("abandoned only → not_started", courseStatus(computeScoring(onlyReset, P), onlyReset), "not_started");
  eq("excludeAbandoned drops it", excludeAbandoned(onlyReset).length, 0);
  eq("isAbandonedAttempt", [isAbandonedAttempt(onlyReset[0]), isAbandonedAttempt({ status: "in_progress" }), isAbandonedAttempt({})], [true, false, false]);

  const resetThenRelaunch = [ab("r1", "2026-10-01T09:00Z", 40), live("l1", "2026-10-02T09:00Z", 10)];
  eq("abandoned + new live attempt → in_progress", courseStatus(computeScoring(resetThenRelaunch, P), resetThenRelaunch), "in_progress");

  const passedThenReset = [
    { ...at("p1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "passed", 0.9), status: "passed" },
    ab("r2", "2026-10-03T09:00Z", 20),
  ];
  const sp = computeScoring(passedThenReset, P);
  eq("official pass + later reset → still passed, official unchanged", [courseStatus(sp, passedThenReset), sp.officialAttempt?.id], ["passed", "p1"]);

  // A mislabelled row (completed axes, status abandoned) is never official (R6).
  const mislabelled = [{ ...at("m1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "passed", 0.9), status: "abandoned" }];
  const sm = computeScoring(mislabelled, P);
  eq("abandoned completed row → no official, not_started", [sm.officialAttempt, sm.completedAttempts, courseStatus(sm, mislabelled)], [null, 0, "not_started"]);

  // Rows without a status (callers that do not select it) are unchanged.
  const noStatus = [at("n1", "2026-10-01T09:00Z", null, "in_progress", "unknown", null)];
  eq("no status field → unchanged (in_progress)", courseStatus(computeScoring(noStatus, P), noStatus), "in_progress");
  eq("excludeAbandoned keeps the same array when nothing is abandoned", excludeAbandoned(noStatus) === noStatus, true);

  // progress_pct selection: never from an abandoned attempt.
  eq("progress: abandoned only → not started, no %", (({ started, pct }) => ({ started, pct }))(courseProgress(onlyReset)), { started: false, pct: null });
  const newerReset = [live("l1", "2026-10-01T09:00Z", 30), ab("r1", "2026-10-02T09:00Z", 80)];
  eq("progress: a newer abandoned attempt never supplies the %", courseProgress(newerReset).pct, 30);
}

console.log("\nadmin tables: live attempts + reset suffix (ADR 0004 step 11)");
{
  const rows = [{ status: "in_progress" }, { status: "abandoned" }, { status: "completed" }, { status: "abandoned" }, {}];
  eq("attemptCounts splits live and reset", attemptCounts(rows), { live: 3, reset: 2 });
  eq("attemptCounts on no attempts", attemptCounts([]), { live: 0, reset: 0 });
  eq("attemptCounts without status selected -> all live", attemptCounts([{}, {}]), { live: 2, reset: 0 });
}

console.log("\nenrolment summary: Library card = course Reports tiles");
{
  const mk = (u: string, c: string, st: UserCourseStatus["status"]): UserCourseStatus => ({ user_id: u, course_id: c, status: st, scoring: computeScoring([], P), attempts: [] });
  const m = new Map<string, UserCourseStatus>();
  for (const v of [
    mk("u1", "c1", "passed"),
    mk("u2", "c1", "completed"),
    mk("u3", "c1", "failed"),
    mk("u4", "c1", "in_progress"),
    mk("u5", "c1", "not_started"), // only reset attempts
    mk("u6", "c2", "in_progress"), // another course
    mk("u9", "c1", "in_progress"), // not enrolled
  ]) m.set(userCourseKey(v.user_id, v.course_id), v);
  const enrolled = new Set(["u1", "u2", "u3", "u4", "u5", "u6", "u7"]);
  const s = enrolledStatusSummary(enrolled, m, "c1");
  eq("counts by official status; reset-only, other-course and attemptless learners are not started", s, {
    total: 7, completed: 2, failed: 1, inProgress: 1, notStarted: 3,
  });
  eq("the four status numbers sum to total", s.completed + s.failed + s.inProgress + s.notStarted, s.total);
  eq("nobody enrolled -> all zero", enrolledStatusSummary(new Set(), m, "c1"), { total: 0, completed: 0, failed: 0, inProgress: 0, notStarted: 0 });
}

console.log(`\n==== status: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
