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
  userCourseKey,
  type UserCourseStatus,
} from "../../lib/scoring/status";

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

console.log(`\n==== status: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
