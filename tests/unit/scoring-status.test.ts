/**
 * Unit test for the canonical learner course-status rule (Phase 0a,
 * product decision 1): "failed" = the OFFICIAL attempt failed; practice /
 * revision runs never change the official result; a granted retake becomes
 * the official attempt.
 *
 * Run:  npx tsx tests/unit/scoring-status.test.ts
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_POLICY, hasLiveGrantedRetake, latestResetRetake, normalizePolicy } from "../../lib/scoring/policy";
import {
  classifyAttempt,
  fetchUnusedGrantsForUsers,
  GrantReadError,
  grantSnapshotFor,
  grantSnapshotForUsers,
  grantSnapshotOf,
  readPagedWithOptionalColumn,
  readWithOptionalColumn,
  type OptionalColumnState,
} from "../../lib/scoring/attempt-kind";
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
  ENROLMENTS_VIEW,
  loadEnrolledCourseStatus,
  officialDone,
  officialStatuses,
  standingVerdictOf,
  userCourseKey,
  type UserCourseStatus,
} from "../../lib/scoring/status";
import { courseProgress, journeyProgress, pathProgress, type ProgressAttemptRow } from "../../lib/courses/progress-view";

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

console.log("\na granted retake blocks a new grant only while it is live (gap 5)");
{
  const g = new Set(["r1"]);
  const row = (status: string, cs = "in_progress", ss = "unknown") => [{ id: "r1", status, completion_status: cs, success_status: ss }];
  eq("in progress -> blocks", hasLiveGrantedRetake(row("in_progress"), g), true);
  eq("reset by a force restart (abandoned) -> never blocks", hasLiveGrantedRetake(row("abandoned"), g), false);
  eq("completed -> does not block", hasLiveGrantedRetake(row("completed", "completed"), g), false);
  eq("status lagging but passed -> does not block", hasLiveGrantedRetake(row("in_progress", "in_progress", "passed"), g), false);
  eq("an in-progress attempt that is not the retake -> does not block", hasLiveGrantedRetake(row("in_progress"), new Set(["other"])), false);
}

/* ------------------------------------------------------------------ ADR 0014 */

console.log("\na revision visit's row is never an attempt (ADR 0014 step 6)");
{
  const off = { ...at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "passed", 0.9), status: "passed" };
  const rev = { ...at("r1", "2026-10-02T09:00Z", null, "in_progress", "unknown", null), status: "in_progress", is_revision: true };
  const revDone = { ...at("r2", "2026-10-03T09:00Z", "2026-10-03T09:30Z", "completed", "failed", 0.2), status: "failed", is_revision: true };
  const pre0103 = { ...at("p1", "2026-10-04T09:00Z", null, "in_progress", "unknown", null), status: "in_progress" };
  eq("excludeAbandoned drops a flagged row", excludeAbandoned([off, rev]).map((a) => a.id), ["a1"]);
  eq("…and keeps an unflagged and a pre-0103 row (is_revision undefined)", excludeAbandoned([off, pre0103]).map((a) => a.id), ["a1", "p1"]);
  eq("…its fast path tests both predicates (flagged only, nothing abandoned)", excludeAbandoned([rev]).length, 0);
  eq("…drops abandoned and flagged together", excludeAbandoned([off, rev, { ...pre0103, status: "abandoned" }]).map((a) => a.id), ["a1"]);
  eq("is_revision false is unflagged", excludeAbandoned([{ ...pre0103, is_revision: false }]).length, 1);
  eq("attemptCounts: a flagged row is neither live nor reset", attemptCounts([off, rev, { ...rev, id: "r3", status: "abandoned" }]), { live: 1, reset: 0 });
  const s = computeScoring([off, rev, revDone], P);
  eq("computeScoring: a completed flagged row is not counted, scored or practice", [s.completedAttempts, s.scoredAttempts, s.practiceAttempts, s.officialAttempt?.id], [1, 1, 0, "a1"]);
  eq("courseStatus: a learner with only a flagged in-progress row is not started", courseStatus(computeScoring([rev], P), [rev]), "not_started");
}

console.log("\nthe policy clamp (ADR 0014 steps 6 and 9, Q1)");
{
  const legacy = normalizePolicy({ max_scored_attempts: 3, official_basis: "best", official_attempt_number: 2, retain_first_attempt: false, after_limit: "block", source: "course", source_id: "c2" });
  eq("a 3 / best / block rule normalises to the default (source kept)", legacy, { ...DEFAULT_POLICY, source: "course", source_id: "c2" });
  eq("nth 2 → official_attempt_number null", normalizePolicy({ official_basis: "nth", official_attempt_number: 2 }).official_attempt_number, null);
  eq("an empty row → the default", normalizePolicy({}), DEFAULT_POLICY);
  eq("an unknown source → default", normalizePolicy({ source: "galaxy" }).source, "default");
  const two = [
    at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "failed", 0.4),
    at("a2", "2026-10-02T09:00Z", "2026-10-02T09:30Z", "completed", "passed", 0.9),
  ];
  const s = computeScoring(two, legacy);
  eq("under the clamped legacy rule: one scored attempt, the first is official", [s.scoredAttempts, s.officialAttempt?.id, s.officialStatus], [1, "a1", "failed"]);
  eq("blocked is always false; practiceMode === limitReached", [s.blocked, s.practiceMode, s.limitReached], [false, true, true]);
  const none = computeScoring([], legacy);
  eq("…also with no attempt", [none.blocked, none.practiceMode === none.limitReached], [false, true]);
}

console.log("\nlatestResetRetake: the course page's reset-retake notice (ADR 0014 step 8)");
{
  const g = new Set(["r1"]);
  const first = { id: "a1", started_at: "2026-10-01T09:00Z", status: "failed", completion_status: "completed", success_status: "failed" };
  const resetRetake = { id: "r1", started_at: "2026-10-05T09:00Z", status: "abandoned", completion_status: "in_progress", success_status: "unknown" };
  const laterRevision = { id: "v1", started_at: "2026-10-06T09:00Z", status: "in_progress", completion_status: "in_progress", success_status: "unknown", is_revision: true };
  eq("newest non-revision row is an abandoned retake → true", latestResetRetake([first, resetRetake], g), true);
  eq("a newer flagged revision row does not hide it", latestResetRetake([first, resetRetake, laterRevision], g), true);
  eq("a live retake → false", latestResetRetake([first, resetRetake, { ...resetRetake, id: "r2", started_at: "2026-10-07T09:00Z", status: "in_progress" }], new Set(["r1", "r2"])), false);
  eq("the newest row is official (not a retake) → false", latestResetRetake([resetRetake, { ...first, id: "a9", started_at: "2026-10-08T09:00Z" }], g), false);
  eq("an empty retakeIds → false", latestResetRetake([first, resetRetake], new Set()), false);
  eq("the retake is in progress (not reset) → false", latestResetRetake([first, { ...resetRetake, status: "in_progress" }], g), false);
  eq("no attempts → false", latestResetRetake([], g), false);
}

console.log("\nstep 10: a live granted retake reads in progress (ADR 0014 step 10)");
{
  const off = { ...at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "passed", 0.85), status: "passed" };
  const live = { ...at("r1", "2026-10-05T09:00Z", null, "in_progress", "unknown", null), status: "in_progress" };
  const g = new Set(["r1"]);
  const s = computeScoring([off, live], P, g);
  eq("retakeIds on the result: the ids it was scored with", [...s.retakeIds], ["r1"]);
  eq("a live retake over a pass → in_progress; the standing result stays official",
    [courseStatus(s, [off, live]), s.officialStatus, s.officialAttempt?.id], ["in_progress", "passed", "a1"]);
  eq("…officialDone unchanged (paths and journeys wait for the retake)", officialDone(s, true), true);
  const finished = { ...live, completed_at: "2026-10-05T09:40Z", completion_status: "completed", success_status: "failed", score: 0.6, status: "failed" };
  const s2 = computeScoring([off, finished], P, g);
  eq("once the retake completes → its own result", [courseStatus(s2, [off, finished]), s2.officialAttempt?.id], ["failed", "r1"]);
  const reset = { ...live, status: "abandoned" };
  eq("a retake reset by a forced restart (abandoned) → the standing result", courseStatus(computeScoring([off, reset], P, g), [off, reset]), "passed");
  eq("without the retake ids (a fail-soft read came back empty) → the standing result for that render",
    courseStatus(computeScoring([off, live], P), [off, live]), "passed");
  const legacy = computeScoring([off, live], P, 1);
  eq("the legacy `extra` number form → an empty retakeIds set", [legacy.retakeIds.size, courseStatus(legacy, [off, live])], [0, "passed"]);
}

console.log("\ncourseProgress: revision rows and the live retake (ADR 0014 steps 7 and 10)");
{
  const row = (id: string, started: string, cs: string, ss: string, extra: Partial<ProgressAttemptRow> = {}): ProgressAttemptRow => ({
    id, course_version_id: "v1", completion_status: cs, success_status: ss, started_at: started, status: "in_progress", progress_pct: null, ...extra,
  });
  const passed = row("a1", "2026-10-01T09:00Z", "completed", "passed", { status: "passed" });
  const open = row("o1", "2026-10-01T09:00Z", "in_progress", "unknown", { progress_pct: 30 });
  const rev = row("v9", "2026-10-03T09:00Z", "in_progress", "unknown", { is_revision: true, progress_pct: 40 });
  eq("a flagged row never supplies progress (a learner with only a flagged row is not started)", courseProgress([rev]).started, false);
  eq("…nor beside an open official row (the newer flagged row is skipped)", courseProgress([open, rev]).pct, 30);
  const live = row("r1", "2026-10-05T09:00Z", "in_progress", "unknown", { progress_pct: 45 });
  const ids = new Set(["r1"]);
  const withIds = courseProgress([passed, live], undefined, { retakeIds: ids });
  eq("with retakeIds a live retake is the source: done false, the retake's pct", [withIds.done, withIds.pct, withIds.started], [false, 45, true]);
  const without = courseProgress([passed, live]);
  eq("without retakeIds → today's answer (done, 100 %)", [without.done, without.pct], [true, 100]);
  eq("a retake id that completed → done", courseProgress([passed, { ...live, completion_status: "completed", success_status: "passed", status: "passed" }], undefined, { retakeIds: ids }).done, true);
  eq("a reset (abandoned) retake → done (never the source)", courseProgress([passed, { ...live, status: "abandoned" }], undefined, { retakeIds: ids }).done, true);
  eq("an in-progress row whose id is not a retake id → done as today", courseProgress([passed, live], undefined, { retakeIds: new Set(["other"]) }).done, true);
  // The roll-up case: only per-course display calls pass retakeIds.
  const steps = [{ course_id: "c1", title: "One" }, { course_id: "c2", title: "Two" }];
  const roll = pathProgress(steps, new Map([["c1", courseProgress([passed, live])], ["c2", courseProgress([])]]));
  eq("roll-up: without retakeIds pathProgress counts the passed step done", [roll.stepsDone, roll.current?.courseId], [1, "c2"]);
  const j = journeyProgress(3, 5, 4, courseProgress([passed, live]));
  eq("…and journeyProgress takes no partial from it", [j.overallPct, j.currentPct], [60, null]);
  const shown = pathProgress(steps, new Map([["c1", withIds], ["c2", courseProgress([])]]));
  eq("…whereas the per-course display with retakeIds would read the step not done (why roll-ups never get it)", [shown.stepsDone, shown.current?.pct], [0, 45]);
}

console.log("\nthe learner course page's two ADR 0014 notices (source check; no React rig)");
{
  const src = fs.readFileSync(path.resolve(__dirname, "../../app/[org]/(learner)/courses/[courseId]/page.tsx"), "utf8");
  const notices = (() => {
    const s = src.indexOf("{scoring.officialAttempt && (");
    const e = src.indexOf("{/* Launch CTA */}");
    return s > 0 && e > s ? src.slice(s, e) : "";
  })();
  const cta = src.slice(src.indexOf("{/* Launch CTA */}"));
  eq("searchParams carries retry", /searchParams: Promise<\{ switch\?: string; retry\?: string \}>/.test(src) && /retry: retryParam/.test(src), true);
  eq("the retry notice sits in the notices block, gated by ?retry", /\{retryParam && \([\s\S]*?Could not open the course\. Please try again\./.test(notices), true);
  eq("the reset-retake notice text sits in the notices block, above the CTA row with the request button",
    notices.includes("Your retake was reset when the module was updated. Request another attempt to continue.") &&
      cta.includes("<RequestAttemptButton"), true);
  eq("…gated by latestResetRetake(attempts, retakeIds), no pending request and no live grant",
    /const showResetRetakeNotice =\s*latestResetRetake\(attempts, retakeIds\) && attemptRequestState !== "pending" && !hasUnusedGrant;/.test(src) &&
      /\{showResetRetakeNotice && \(/.test(notices), true);
  eq("the attempts read stays select(\"*\") (is_revision present on a 0103 database, undefined before)",
    /\.from\("course_attempts"\)\s*\/\/[^\n]*\n\s*\.select\("\*"\)/.test(src), true);
}

// PR 1b (ADR 0014 steps 7, 9, 10, 11, 12): the learner course page and the
// request modal. The page authenticates through the cookie-bound server
// client, so its cases are the pure twins (requestDecision, resultStands,
// officialHistory, officialRetakeState: attempt-requests.test.ts and
// official-history.test.ts) plus this source check (the route-test
// reading); spec 61 proves the rendered texts on staging.
console.log("\nthe learner course page (source check; no React rig)");
{
  const raw = fs.readFileSync(path.resolve(__dirname, "../../app/[org]/(learner)/courses/[courseId]/page.tsx"), "utf8");
  // Comments blanked (strings kept), so a comment naming a removed identifier is not code.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const between = (from: string, to: string) => {
    const s = src.indexOf(from);
    const e = s === -1 ? -1 : src.indexOf(to, s + from.length);
    return s === -1 || e === -1 ? "" : src.slice(s, e);
  };
  // (1) the strict grant read, used two ways
  eq("(1) grantSnapshotFor(supabase, user.id, c.id) sits inside a try whose catch sets historyUnavailable",
    /try \{\s*snapshot = await grantSnapshotFor\(supabase, user\.id, c\.id\);\s*\} catch \{\s*historyUnavailable = true;\s*\}/.test(src), true);
  eq("…the only grantSnapshotFor( call is that one, and the fail-soft grantRetakeIdsFor is gone",
    [(src.match(/grantSnapshotFor\(/g) ?? []).length, /\bgrantRetakeIdsFor\b/.test(src)], [1, false]);
  eq("…retakeIds are the snapshot's, or empty for the one-render fallback",
    /const retakeIds: Set<string> = snapshot\?\.retakeIds \?\? new Set<string>\(\);\s*const scoring = computeScoring\(attempts, policy, retakeIds\);/.test(src), true);
  eq("…the chain is officialHistory(attempts, snapshot?.rows ?? []) and officialRetakeState(history)",
    /const history = officialHistory\(attempts, snapshot\?\.rows \?\? \[\]\);\s*const retakeState = officialRetakeState\(history\);/.test(src), true);
  // (5) step 11 (1): one rule for the page and the route
  const canReq = between("const canRequestAttempt =", ";");
  eq("(5) canRequestAttempt names historyUnavailable and calls requestDecision(…) === \"ok\"",
    /!isAdmin &&\s*!historyUnavailable &&\s*requestDecision\(\{ scoring, attempts \}\) === "ok" &&\s*\(attemptRequestState === "none" \|\| attemptRequestState === "rejected"\)/.test(canReq), true);
  eq("…officialFailed is gone (a pass is not a refusal)", /\bofficialFailed\b/.test(src), false);
  eq("…the standing result is resultStands(scoring, passRequired) and reaches the modal",
    /resultStands\(scoring, passRequired\)/.test(src) && /<RequestAttemptButton orgSlug=\{orgSlug\} courseId=\{c\.id\} standingResult=\{standingResult\} \/>/.test(src), true);
  // (4) step 9: dead code removed
  eq("(4) \"Attempt limit reached\", launchBlocked, hasInProgressOfficialRetake and scoring.blocked are gone",
    [/Attempt limit reached/.test(src), /\blaunchBlocked\b/.test(src), /\bhasInProgressOfficialRetake\b/.test(src), /scoring\.blocked/.test(src)], [false, false, false, false]);
  eq("…the pending notice has no blocked clause", /\{attemptRequestState === "pending" && \(/.test(src), true);
  eq("…the pill reads \"Revision\", never \"Review only\"", [/>\s*Revision\s*</.test(src), /Review only/.test(src)], [true, false]);
  // (2) step 10 on the page
  eq("(2) liveRetake = hasLiveGrantedRetake(attempts, scoring.retakeIds)",
    /const liveRetake = hasLiveGrantedRetake\(attempts, scoring\.retakeIds\);/.test(src), true);
  eq("…the Revision pill is guarded by !liveRetake",
    /!hasUnusedGrant && !liveRetake && scoring\.practiceMode && \(\s*<span[^>]*>\s*Revision\s*<\/span>/.test(src), true);
  eq("…the practiceMode notice is guarded by !liveRetake",
    /\{!hasUnusedGrant && !liveRetake && scoring\.practiceMode && \(\s*<p[^>]*>\s*You&apos;ve completed this course\./.test(src), true);
  eq("…the CTA reads \"Resume course\" while the retake runs", /\{liveRetake\s*\?\s*"Resume course"/.test(src), true);
  eq("…isInProgress and the language menu's in-progress list skip revision rows",
    /attempts\.some\(\(a\) => a\.status === "in_progress" && !isRevisionAttempt\(a\) && resumable\(a\)\)/.test(src) &&
      /\.filter\(\(a\) => a\.status === "in_progress" && !isRevisionAttempt\(a\)\)/.test(src), true);
  // (3) the newest-row pick
  eq("(3) attempts[0] is not used; resetByAdmin reads the newest non-revision row",
    [/attempts\[0\]/.test(src), /const latestAttempt = attempts\.find\(\(a\) => !isRevisionAttempt\(a\)\);/.test(src)], [false, true]);
  // (6) "My attempts"
  eq("(6) My attempts lists only non-revision rows and numbers that list",
    /const attemptRows = attempts\.filter\(\(a\) => !isRevisionAttempt\(a\)\);/.test(src) &&
      /attemptRows\.map\(\(a, i\) => \(\s*<AttemptRow[\s\S]*?number=\{attemptRows\.length - i\}/.test(src), true);
  eq("…fetchMyRevisits(svc, user.id, c.id), the service client's only use",
    [/const revisits = await fetchMyRevisits\(svc, user\.id, c\.id\);/.test(src), (src.match(/\bsvc\b/g) ?? []).length], [true, 2]);
  eq("…\"Revisited 1 time\" / \"Revisited N times\", hidden on 0 and on a failed read",
    /\{!revisits\.failed && revisits\.count > 0 && \(/.test(src) && src.includes('revisits.count === 1 ? "Revisited 1 time" : `Revisited ${revisits.count} times`'), true);
  eq("…the row markers come from the chain, none when the history is unavailable",
    /const markers = historyUnavailable \? new Map<string, string\[\]>\(\) : attemptMarkers\(history, retakeState\.current\);/.test(src), true);
  const markerFn = between("function attemptMarkers(", "\nfunction AttemptRow(");
  eq("…the four markers, the reset retake included",
    ["\"Official result\"", "\"Previous official result\"", "`Granted retake · ${RESULT_WORD[e.status]}`", "\"Granted retake · in progress\"", "\"Granted retake, reset by a module update\""].map((t) => markerFn.includes(t)), [true, true, true, true, true]);
  eq("…and the markers line reads \"History unavailable. Please reload.\" when the read failed",
    /\{historyUnavailable && attemptRows\.length > 0 && \(\s*<p[^>]*>\s*History unavailable\. Please reload\./.test(src), true);
  const pill = between("function CompletionPill(", "\nfunction SuccessPill(");
  eq("…an abandoned incomplete row reads \"Closed — not counted\" with the ADR's title",
    [pill.includes("Closed — not counted"), pill.includes('title="This attempt was closed before it finished and does not count"'), pill.includes("Reset — module updated")], [true, true, false]);
  // (7) the "Official result history" block
  const block = between("{showHistoryBlock && (", "{retryParam && (");
  const sectionAt = src.indexOf("{showAttemptsSection && (");
  eq("(7) the history block renders before, and outside, the showAttemptsSection branch",
    block.length > 0 && src.indexOf("{showHistoryBlock && (") < sectionAt && src.indexOf('data-testid="official-result-history"') < sectionAt, true);
  eq("…it contains no <Link (text, not links)", /<Link\b/.test(block), false);
  eq("…it reads \"History unavailable. Please reload.\" and nothing else on a failed read",
    /\{historyUnavailable \? \(\s*<p[^>]*>History unavailable\. Please reload\.<\/p>\s*\) : \(/.test(block), true);
  const linesFn = between("function officialHistoryLines(", "\nfunction grantLine(");
  eq("…its lines render history.reset, the running retake and the superseded entries in the ADR's words",
    [/for \(const r of history\.reset\)/.test(linesFn), linesFn.includes('"Granted retake, reset by a module update"'),
      linesFn.includes("`Replaced by a granted retake${byDate ? ` on ${byDate}` : \"\"}`"), linesFn.includes('"Official result"'),
      linesFn.includes("Official retake in progress"), linesFn.includes("stays in your history until you finish"), /<Link\b/.test(linesFn)],
    [true, true, true, true, true, true, false]);
  eq("…the running retake's X % is courseProgress with the retake ids (a per-course display)",
    /courseProgress\(attempts, undefined, \{ retakeIds: scoring\.retakeIds \}\)\.pct/.test(src), true);
  const grantFn = between("function grantLine(", "\nfunction attemptMarkers(");
  eq("…the grant line names \"your administrator\", never a name or email",
    [grantFn.includes("Granted by your administrator"), /decidedBy|email/.test(grantFn)], [true, false]);
  eq("…the block is absent with no entry and no reset, and shown on a failed read only when the learner has attempts",
    /const showHistoryBlock = historyUnavailable \? attemptRows\.length > 0 : historyLines\.length > 0;/.test(src), true);
}

console.log("\nthe request modal's warning (source check; no React rig)");
{
  const src = fs.readFileSync(path.resolve(__dirname, "../../app/[org]/(learner)/courses/[courseId]/request-attempt-button.tsx"), "utf8");
  eq("the button takes standingResult: { kind: \"passed\" | \"completed\"; scorePct } | null",
    /standingResult\?: \{ kind: "passed" \| "completed"; scorePct: number \| null \} \| null;/.test(src), true);
  const at = src.indexOf("{standingResult && (");
  const text = src.indexOf("Tell your administrator why");
  eq("when set, the warning (learnerWarningLead, then REQUEST_MESSAGES.learner_warning) precedes the modal text",
    at > 0 && text > at && /\{learnerWarningLead\(standingResult\)\}[\s\S]*?\{REQUEST_MESSAGES\.learner_warning\}/.test(src.slice(at, text)), true);
}

/* ---------------- PR 1b: source checks of the reads ---------------- */

const repoRoot = path.resolve(__dirname, "../..");
/** A source with CRLF normalised and line and block comments blanked (strings kept), so a comment naming a call is not a call. */
const codeOf = (rel: string) =>
  fs
    .readFileSync(path.join(repoRoot, rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const LP_FILE = "app/[org]/(admin)/library/[courseId]/learners/page.tsx";
const ORG_REPORTS_FILE = "app/[org]/(admin)/reports/page.tsx";

console.log("\n\"retake reset, no grant\" reads the strict snapshot, never the fail-soft map");
{
  const src = codeOf(LP_FILE);
  eq("the clause, ADR 0014:186's three parts over the snapshot: !historyUnavailable, a reset retake, snapshot.unusedGrant === null, no other live retake id",
    /const resetNoGrant =\s*!historyUnavailable &&\s*history\.reset\.length > 0 &&\s*snapshot\.unusedGrant === null &&\s*!myAttempts\.some\(\(a\) => snapshot\.retakeIds\.has\(a\.id\) && a\.status !== "abandoned"\);/.test(src), true);
  eq("the fail-soft unused-grants reader is not read on the page (its missing pair cannot tell \"none\" from \"not read\")",
    [/fetchUnusedGrantsForUsers/.test(src), /unusedByUser|holdsUnexpired/.test(src)], [false, false]);
  eq("a failed strict read (GrantReadError) sets historyUnavailable, the clause's first part: the label is then absent",
    /try \{\s*snapshots = await grantSnapshotForUsers\(svc, org\.id, \[c\.id\], enrolledUserIds\);\s*\} catch \(e\) \{\s*if \(!\(e instanceof GrantReadError\)\) throw e;[\s\S]{0,120}?historyUnavailable = true;\s*\}/.test(src), true);
  eq("…the snapshot is the strict read's, the empty one only for a pair with no grant",
    /const snapshot = snapshots\.get\(`\$\{uid\}:\$\{c\.id\}`\) \?\? noGrants;/.test(src), true);
  eq("the reset suffix still carries the label", src.includes('reset{r.resetNoGrant ? " (retake reset, no grant)" : ""}'), true);
}
{
  // The clause's grant part on the snapshot itself (grantSnapshotOf, pure):
  // "holds no unexpired unused grant" is exactly unusedGrant === null.
  const NOW = "2026-11-04T10:00:00.000Z";
  const g = (id: string, over: Record<string, unknown> = {}) => ({
    id, used_attempt_id: null, used_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z",
    decided_by: "admin-1", decided_at: "2026-10-01T00:00:00Z", decision_note: null, reason: null, reissued_from: null, ...over,
  });
  const resetGrant = g("g0", { used_attempt_id: "t1", used_at: "2026-10-02T00:00:00Z" });
  eq("only the reset retake's used grant → unusedGrant null (the label shows)", grantSnapshotOf([resetGrant], NOW).unusedGrant, null);
  eq("…plus an unexpired unused re-issued grant → that grant (no label)",
    grantSnapshotOf([resetGrant, g("g1", { reissued_from: "g0", expires_at: "2026-12-01T00:00:00Z" })], NOW).unusedGrant?.id, "g1");
  eq("…plus an unused grant that never expires → that grant (no label)", grantSnapshotOf([resetGrant, g("g2")], NOW).unusedGrant?.id, "g2");
  eq("…plus an expired unused grant → null (the label shows)",
    grantSnapshotOf([resetGrant, g("g3", { expires_at: "2026-10-30T00:00:00Z" })], NOW).unusedGrant, null);
}

console.log("\nthe eight paged attempts reads use readPagedWithOptionalColumn, each keeping its own error rule");
{
  /** Per site: its call (the fallback over ATTEMPT_COLUMNS, the select taking the decided list) and its error rule, unchanged. */
  const SITES: Record<string, Array<[string, RegExp]>> = {
    [ORG_REPORTS_FILE]: [
      ["the call: by organisation, in id order, paged by range, at most 500 pages (fetchAll's 500,000-row ceiling)",
        /const \{ data: attemptRows, error: attemptsErr \} = await readPagedWithOptionalColumn<unknown>\(\s*"is_revision",\s*\(columns, f, t\) => supabase\.from\("course_attempts"\)\.select\(columns\)\.eq\("organization_id", org\.id\)\.order\("id"\)\.range\(f, t\),\s*ATTEMPT_COLUMNS,\s*\{ maxPages: 500 \}\s*\);/],
      ["the error rule: the rows read so far, as fetchAll; only the section that states completeness reads the error (ADR 0017 step 14)", /const attempts = attemptRows as Attempt\[\];[\s\S]*?const notAppliedRows =\s*ignoredErr \|\| attemptsErr\s*\? null/],
    ],
    "lib/scoring/status.ts": [
      // ADR 0024 step 49: the Individual context when 0107 is there, decided
      // once for every chunk as the column list is.
      ["the call: by version chunk, in id order, one decision for every chunk, the Individual filter through individualContextOnly",
        /const decided: OptionalColumnState = \{ columns: null \};\s*const individual: IndividualFilterState = \{ applies: null \};[\s\S]*?for \(let i = 0; i < versionIds\.length; i \+= CHUNK\) \{[\s\S]*?readPagedWithOptionalColumn<unknown>\(\s*"is_revision",\s*individualContextOnly\(individual, \(columns, f, t, only\) => \{\s*const q = client\.from\("course_attempts"\)\.select\(columns\)\.in\("course_version_id", part\)\.order\("id"\)\.range\(f, t\);\s*return only \? q\.eq\("context_kind", "individual"\) : q;\s*\}\),\s*ATTEMPT_COLUMNS,\s*\{ pageSize: PAGE, state: decided \}\s*\);/],
      ["the error rule: logged as `paged` logs it, the chunk keeps the rows read so far",
        /if \(res\.error\) console\.warn\("\[enrolled-status\] attempts read failed:", res\.error\.message \?\? ""\);\s*for \(const a of res\.data as/],
    ],
    "lib/manager/insights.ts": [
      ["the call: by user chunk of 150, in id order, one decision for every chunk",
        /const decided: OptionalColumnState = \{ columns: null \};\s*for \(const part of chunk\(\[\.\.\.new Set\(userIds\.filter\(Boolean\)\)\], 150\)\) \{\s*const res = await readPagedWithOptionalColumn<unknown>\(\s*"is_revision",\s*\(cols, from, to\)[^=]*=>\s*svc\.from\("course_attempts"\)\.select\(cols\)\.in\("user_id", part\)\.eq\("organization_id", orgId\)\.order\("id"\)\.range\(from, to\),\s*ATTEMPT_COLUMNS,\s*\{ state: decided \}\s*\);/],
      ["the error rule: any error throws, as fetchByIds does", /if \(res\.error\) throw new Error\(`course_attempts: \$\{res\.error\.message \?\? ""\}`\);/],
    ],
    "app/api/attempt-requests/bulk/route.ts": [
      ["the call: the course's versions, in id order, an empty answer an error",
        /readPagedWithOptionalColumn<Att>\(\s*"is_revision",\s*\(cols, from, to\) =>\s*s\s*\.from\("course_attempts"\)\s*\.select\(cols\)\s*\.eq\("organization_id", org\.id\)\s*\.in\("course_version_id", verIds\)\s*\.order\("id"\)\s*\.range\(from, to\)[^,]*,\s*ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\);/],
      ["the error rule: 503 before any insert", /if \(attemptsRead\.error\) return unreadable\("attempts"\);/],
    ],
    "app/[org]/(admin)/attempt-requests/page.tsx": [
      ["the call: the requests' versions and learners, in id order, an empty answer an error",
        /readPagedWithOptionalColumn<Row>\(\s*"is_revision",\s*\(cols, from, to\) =>\s*svc\s*\.from\("course_attempts"\)\s*\.select\(cols\)\s*\.in\("course_version_id", verIds\)\s*\.in\("user_id", userIds\)\s*\.order\("id"\)\s*\.range\(from, to\)[^,]*,\s*ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\);/],
      ["the error rule: the rows read so far, and the history unavailable", /if \(attemptsRead\.error\) \{\s*historyUnavailable = true;/],
    ],
    "lib/attempts/grant.ts": [
      ["the call: the named learners on the course's versions, in id order, an empty answer an error",
        /readPagedWithOptionalColumn<Att>\(\s*"is_revision",\s*\(cols, from, to\) =>\s*svc\s*\.from\("course_attempts"\)\s*\.select\(cols\)\s*\.eq\("organization_id", args\.orgId\)\s*\.in\("user_id", ids\)\s*\.in\("course_version_id", verIds\)\s*\.order\("id"\)\s*\.range\(from, to\)[^,]*,\s*ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\);/],
      ["the error rule: every learner failed, nothing inserted", /if \(attemptsRead\.error\) return unreadable\("attempts"\);/],
    ],
    // ADR 0020 (the lead's ruling of 2026-11-11): the enrolled set in chunks
    // of 150 (lib/db/chunked.ts), each paged in id order, never one .in()
    // over the whole set.
    // ADR 0024 step 49: both Individual surfaces add the Individual filter
    // through individualContextOnly, decided once for every chunk.
    [LP_FILE]: [
      ["the call: the enrolled ids by chunk of 150 on the course's versions, in id order, one decision for every chunk, the Individual filter through individualContextOnly",
        /const decided: OptionalColumnState = \{ columns: null \};\s*const individual: IndividualFilterState = \{ applies: null \};\s*for \(const part of chunk\(enrolledUserIds, 150\)\) \{\s*const res = await readPagedWithOptionalColumn<unknown>\(\s*"is_revision",\s*individualContextOnly\(individual, \(columns, from, to, only\)[^=]*=>\s*\{\s*const q = supabase\s*\.from\("course_attempts"\)\s*\.select\(columns\)\s*\.in\("user_id", part\)\s*\.in\("course_version_id", versionIds\)\s*\.order\("id"\)\s*\.range\(from, to\);\s*return only \? q\.eq\("context_kind", "individual"\) : q;\s*\}\),\s*ATTEMPT_COLUMNS,\s*\{ state: decided \}\s*\);/],
      ["the error rule: logged, the rows read so far kept (as the page's other reads)",
        /if \(res\.error\) console\.warn\("\[learners\] attempts read failed:", res\.error\.message \?\? ""\);\s*attemptRows\.push\(\.\.\.res\.data\);/],
    ],
    "app/api/courses/[courseId]/learners/export/route.ts": [
      ["the call: the enrolled ids by chunk of 150 on the course's versions, in id order, one decision for every chunk, the Individual filter through individualContextOnly",
        /const decided: OptionalColumnState = \{ columns: null \};\s*const individual: IndividualFilterState = \{ applies: null \};\s*for \(const part of chunk\(enrolledUserIds, 150\)\) \{\s*const res = await readPagedWithOptionalColumn<unknown>\(\s*"is_revision",\s*individualContextOnly\(individual, \(columns, from, to, only\)[^=]*=>\s*\{\s*const q = supabase\s*\.from\("course_attempts"\)\s*\.select\(columns\)\s*\.in\("user_id", part\)\s*\.in\("course_version_id", versionIds\)\s*\.order\("id"\)\s*\.range\(from, to\);\s*return only \? q\.eq\("context_kind", "individual"\) : q;\s*\}\),\s*ATTEMPT_COLUMNS,\s*\{ state: decided \}\s*\);/],
      ["the error rule: logged, the rows read so far kept (as the page's rule and the CSV's other reads)",
        /if \(res\.error\) console\.warn\("\[learners-export\] attempts read failed:", res\.error\.message \?\? ""\);\s*attemptRows\.push\(\.\.\.res\.data\);/],
    ],
  };
  for (const [file, checks] of Object.entries(SITES)) {
    const src = codeOf(file);
    eq(`${file}: ATTEMPT_COLUMNS names status`, /const ATTEMPT_COLUMNS =\s*"[^"]*\bstatus\b[^"]*";/.test(src), true);
    for (const [what, re] of checks) eq(`${file}: ${what}`, re.test(src), true);
    eq(`${file}: no local copy of the first-page closure (the helper is the one implementation)`, /= used;|= usedColumns;|attemptColumns|\bcolumns = used\b/.test(src), false);
  }
  // The inventory: every caller under app/ and lib/ is one of the eight, and
  // grantSnapshotForUsers (the strict grant read) in the helper's own file.
  const callers: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && /readPagedWithOptionalColumn</.test(codeOf(rel))) callers.push(rel);
    }
  };
  walk("app");
  walk("lib");
  eq("every readPagedWithOptionalColumn caller is listed (the eight, and attempt-kind.ts's grant snapshot)",
    callers.sort(), [...Object.keys(SITES), "lib/scoring/attempt-kind.ts"].sort());
}

console.log("\norg Reports' Recent attempts: a revision row is a \"Review visit\" with no score");
{
  const src = codeOf(ORG_REPORTS_FILE);
  eq("the feed keeps every launch, newest first (no row is dropped)", /const recent = \[\.\.\.attempts\]\s*\.sort\(\(a, b\) => \(b\.started_at > a\.started_at \? 1 : -1\)\)\s*\.slice\(0, 20\);/.test(src), true);
  eq("each row's flag is isRevisionAttempt(a), passed to the pill", /const revision = isRevisionAttempt\(a\);/.test(src) && /<ResultPill\s*completion=\{a\.completion_status\}\s*success=\{a\.success_status\}\s*status=\{a\.status\}\s*revision=\{revision\}\s*\/>/.test(src), true);
  eq("the pill reads \"Review visit\" for it, before Passed / Failed / Completed / Reset / In progress",
    /if \(revision\) \{\s*return <StatusPill tone="neutral">Review visit<\/StatusPill>;\s*\}\s*if \(success === "passed"\) \{/.test(src), true);
  eq("its score cell reads \"-\" (never scored), ahead of both renderings", /\{revision \? \(\s*"-"\s*\) : detailHref \? \(/.test(src), true);
}

console.log("\nstep 10 on the dashboard and course cards: no \"revision only\" while a granted retake runs (source check)");
{
  for (const file of ["app/[org]/(learner)/dashboard/page.tsx", "app/[org]/(learner)/courses/page.tsx"]) {
    const src = codeOf(file);
    eq(`${file}: scoringForCourse guards practiceMode with !hasLiveGrantedRetake(my, scoring.retakeIds)`,
      /function scoringForCourse\(courseId: string\) \{[\s\S]*?const scoring = computeScoring\(my, policy, extraByCourse\.get\(courseId\) \?\? \[\]\);[\s\S]*?practiceMode: scoring\.practiceMode && !hasLiveGrantedRetake\(my, scoring\.retakeIds\),\s*\};\s*\}/.test(src), true);
    eq(`${file}: the card's practiceMode is that guarded value (s.practiceMode), once`, (src.match(/practiceMode: s\.practiceMode,/g) ?? []).length, 1);
    eq(`${file}: no unguarded scoring.practiceMode reaches a card`, (src.match(/practiceMode: scoring\.practiceMode(?! && !hasLiveGrantedRetake\(my, scoring\.retakeIds\))/g) ?? []).length, 0);
  }
  // The guarded value on the same helpers: a pass, then a granted retake running.
  const off = { ...at("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "completed", "passed", 0.85), status: "passed" };
  const live = { ...at("r1", "2026-10-05T09:00Z", null, "in_progress", "unknown", null), status: "in_progress" };
  const s = computeScoring([off, live], P, new Set(["r1"]));
  eq("non-vacuous: the window is used (practiceMode true) while the retake runs; the guard reads false",
    [s.practiceMode, s.practiceMode && !hasLiveGrantedRetake([off, live], s.retakeIds)], [true, false]);
  const sDone = computeScoring([off], P, new Set<string>());
  eq("…and with no retake the card's practiceMode is the window's", sDone.practiceMode && !hasLiveGrantedRetake([off], sDone.retakeIds), true);
}

/* ---------------- classifyAttempt against a recording fake ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
function recordingClient(respond: (q: Query) => { data?: unknown; error?: unknown }) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "range", "abortSignal"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve({ data: null, error: null, ...respond(q) });
      b.maybeSingle = () => settle();
      b.single = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
    rpc() {
      return Promise.resolve({ data: [], error: null });
    },
  };
  return { client: client as never, queries };
}
const selectOf = (q: Query) => String(q.ops.find((o) => o.op === "select")?.args[0] ?? "");
const MISSING = { code: "42703", message: "column course_attempts.is_revision does not exist" };

async function classifyCases() {
  console.log("\nclassifyAttempt (ADR 0014 step 6)");
  const attemptRow = (isRevision?: boolean) => ({
    id: "x", user_id: "u1", organization_id: "o1", course_version_id: "v1",
    course_versions: { course_id: "c1" },
    ...(isRevision === undefined ? {} : { is_revision: isRevision }),
  });
  const run = async (target: string, rows: unknown[], opts: { flagged?: boolean; rejectColumn?: boolean } = {}) => {
    const { client, queries } = recordingClient((q) => {
      const sel = selectOf(q);
      if (opts.rejectColumn && sel.includes("is_revision")) return { data: null, error: MISSING };
      if (q.table === "course_attempts" && q.ops.some((o) => o.op === "maybeSingle" || (o.op === "eq" && o.args[0] === "id"))) {
        return { data: { ...attemptRow(opts.rejectColumn ? undefined : opts.flagged ?? false), id: target } };
      }
      if (q.table === "course_versions") return { data: [{ id: "v1" }] };
      if (q.table === "course_attempts") {
        return { data: opts.rejectColumn ? (rows as Array<Record<string, unknown>>).map(({ is_revision: _drop, ...r }) => (void _drop, r)) : rows };
      }
      if (q.table === "attempt_requests") return { data: [] };
      return { data: [] };
    });
    const kind = await classifyAttempt(client, target);
    return { kind, queries };
  };
  const done = (id: string, started: string, completed: string, ss: string, extra: Record<string, unknown> = {}) => ({
    id, score: 0.8, started_at: started, completed_at: completed, completion_status: "completed", success_status: ss, status: ss, ...extra,
  });

  {
    const { kind, queries } = await run("a1", [done("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "passed", { is_revision: false })]);
    const lists = queries.filter((q) => q.table === "course_attempts" && q.ops.some((o) => o.op === "in"));
    const one = queries.find((q) => q.table === "course_attempts" && q.ops.some((o) => o.op === "eq" && o.args[0] === "id"));
    eq("the attempts-list select names status and is_revision", lists.map((q) => /\bstatus\b/.test(selectOf(q)) && /\bis_revision\b/.test(selectOf(q))), [true]);
    eq("the attempt select names is_revision", /\bis_revision\b/.test(one ? selectOf(one) : ""), true);
    eq("the first completed attempt → official #1", [kind?.official, kind?.attemptNumber], [true, 1]);
  }
  {
    const rows = [
      done("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "passed", { is_revision: false }),
      { id: "r1", score: null, started_at: "2026-10-02T09:00Z", completed_at: null, completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: true },
    ];
    const { kind } = await run("r1", rows, { flagged: true });
    eq("a flagged row answers official: false", kind?.official, false);
    const { kind: legacyDone } = await run("r2", [...rows, done("r2", "2026-10-03T09:00Z", "2026-10-03T09:30Z", "passed", { is_revision: true })], { flagged: true });
    eq("…a completed flagged row too", legacyDone?.official, false);
  }
  {
    // The `!isRevision` gate on its own (the review's low finding, the lead,
    // 2026-10-29): with no other completed, non-abandoned attempt the window
    // has a free slot (limitReached false, no ordinal), so only the gate
    // keeps a flagged in-progress row from answering official: true.
    const flagged = { id: "r1", score: null, started_at: "2026-10-02T09:00Z", completed_at: null, completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: true };
    const { kind: alone } = await run("r1", [flagged], { flagged: true });
    eq("the gate alone: a flagged in-progress row with no other attempt → official: false",
      [alone?.official, alone?.attemptNumber, alone?.scoring.limitReached], [false, null, false]);
    const { kind: f6 } = await run("r1", [done("a0", "2026-09-30T09:00Z", "2026-09-30T09:30Z", "passed", { status: "abandoned", is_revision: false }), flagged], { flagged: true });
    eq("the gate alone: …whose only completed attempt is abandoned (the f6 shape) → official: false",
      [f6?.official, f6?.attemptNumber, f6?.scoring.limitReached], [false, null, false]);
  }
  {
    // An abandoned-but-completed row (0099 count #3 expects none) no longer
    // takes ordinal 1: the real official attempt is #1 again.
    const rows = [
      done("a0", "2026-09-30T09:00Z", "2026-09-30T09:30Z", "failed", { status: "abandoned", is_revision: false }),
      done("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "passed", { is_revision: false }),
    ];
    const { kind } = await run("a1", rows);
    eq("an abandoned-but-completed row leaves the ordinal", [kind?.attemptNumber, kind?.official], [1, true]);
  }
  {
    const rows = [done("a1", "2026-10-01T09:00Z", "2026-10-01T09:30Z", "passed", { is_revision: false })];
    const { kind, queries } = await run("a1", rows, { rejectColumn: true });
    const selects = queries.filter((q) => q.table === "course_attempts").map(selectOf);
    eq("a client rejecting is_revision → each select retried once without it", selects.map((s) => s.includes("is_revision")), [true, false, true, false]);
    eq("…the narrower list select still names status", /\bstatus\b/.test(selects[3] ?? ""), true);
    eq("…today's answer", [kind?.official, kind?.attemptNumber], [true, 1]);
  }
  {
    const { client, queries } = recordingClient((q) =>
      q.table === "course_attempts" ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : { data: [] }
    );
    const kind = await classifyAttempt(client, "a1");
    eq("another error is never retried without the column (no row → null, as today)", [kind, queries.filter((q) => q.table === "course_attempts").length], [null, 1]);
  }
}

async function snapshotCases() {
  console.log("\ngrantSnapshotFor: one strict read of the approved grants (ADR 0014 step 3)");
  const NOW = "2026-10-29T10:00:00.000Z";
  const g = (id: string, over: Record<string, unknown> = {}) => ({
    id, used_attempt_id: null, used_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z",
    decided_by: "admin-1", decided_at: "2026-10-01T00:00:00Z", decision_note: null, reason: null, reissued_from: null, ...over,
  });
  const rows = [
    g("used", { used_attempt_id: "r1", used_at: "2026-10-02T00:00:00Z", created_at: "2026-09-01T00:00:00Z" }),
    g("lapsed", { expires_at: "2026-10-10T00:00:00Z", created_at: "2026-09-02T00:00:00Z" }),
    g("newer", { created_at: "2026-10-05T00:00:00Z" }),
    g("older", { created_at: "2026-10-03T00:00:00Z", expires_at: "2026-11-30T00:00:00Z" }),
  ];
  {
    const { client, queries } = recordingClient(() => ({ data: rows }));
    const snap = await grantSnapshotFor(client, "u1", "c1", NOW);
    const q = queries[0];
    eq("one read: attempt_requests, the user's approved grants on the course",
      [queries.length, q.table, q.ops.filter((o) => o.op === "eq").map((o) => o.args)], [1, "attempt_requests", [["user_id", "u1"], ["course_id", "c1"], ["status", "approved"]]]);
    eq("…the 0083 columns the history needs, and reissued_from", selectOf(q), "id, used_attempt_id, used_at, expires_at, created_at, decided_by, decided_at, decision_note, reason, reissued_from");
    eq("retakeIds = the rows with used_attempt_id", [...snap.retakeIds], ["r1"]);
    eq("unusedGrant = the OLDEST unused, unexpired grant (a lapsed one never counts)", snap.unusedGrant?.id, "older");
    eq("rows kept for later consumers", snap.rows.length, 4);
  }
  {
    const { client, queries } = recordingClient((q) =>
      selectOf(q).includes("reissued_from") ? { data: null, error: { code: "42703", message: "column attempt_requests.reissued_from does not exist" } } : { data: rows.map(({ reissued_from: _r, ...x }) => (void _r, x)) }
    );
    const snap = await grantSnapshotFor(client, "u1", "c1", NOW);
    eq("a database without 0103: re-read without reissued_from (never 'no grants')", [queries.map((q) => selectOf(q).includes("reissued_from")), [...snap.retakeIds], snap.unusedGrant?.id], [[true, false], ["r1"], "older"]);
  }
  {
    const { client } = recordingClient(() => ({ data: null, error: { code: "42P01", message: 'relation "public.attempt_requests" does not exist' } }));
    const snap = await grantSnapshotFor(client, "u1", "c1", NOW);
    eq("a missing table (pre-0083) → no grants", [snap.retakeIds.size, snap.unusedGrant, snap.rows.length], [0, null, 0]);
  }
  for (const [what, answer] of [
    ["a timeout", { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }],
    ["an answer with neither rows nor an error", { data: null, error: null }],
  ] as Array<[string, { data: unknown; error: unknown }]>) {
    const { client } = recordingClient(() => answer);
    let thrown: unknown = null;
    try { await grantSnapshotFor(client, "u1", "c1", NOW); } catch (e) { thrown = e; }
    eq(`${what} → GrantReadError (the launch refuses)`, thrown instanceof GrantReadError, true);
  }
}

/* ---------------- PR 1b: the bulk snapshot, the fallback, the injected grants ---------------- */

const usersOf = (q: Query) => (q.ops.find((o) => o.op === "in" && o.args[0] === "user_id")?.args[1] as string[] | undefined) ?? [];
/** The fake honours the query's user and (when present) course filters. */
const matches = (q: Query, r: { user_id: string; course_id: string }) => {
  const courses = q.ops.find((o) => o.op === "in" && o.args[0] === "course_id")?.args[1] as string[] | undefined;
  return usersOf(q).includes(r.user_id) && (!courses || courses.includes(r.course_id));
};

async function bulkSnapshotCases() {
  console.log("\ngrantSnapshotForUsers: the strict bulk snapshot (ADR 0014 step 3)");
  const NOW = "2026-10-29T10:00:00.000Z";
  const g = (id: string, user: string, course: string, over: Record<string, unknown> = {}) => ({
    id, user_id: user, course_id: course, used_attempt_id: null, used_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z",
    decided_by: "admin-1", decided_at: "2026-10-01T00:00:00Z", decision_note: null, reason: null, reissued_from: null, ...over,
  });
  const rows = [
    g("g1", "u1", "c1", { used_attempt_id: "r1", used_at: "2026-10-02T00:00:00Z" }),
    g("g2", "u1", "c2", { created_at: "2026-10-05T00:00:00Z" }),
    g("g3", "u2", "c1", { used_attempt_id: "r9", used_at: "2026-10-03T00:00:00Z" }),
  ];
  const answer = (list: Array<ReturnType<typeof g>>) => (q: Query) => ({ data: list.filter((r) => matches(q, r)) });
  {
    const { client, queries } = recordingClient(answer(rows));
    const snap = await grantSnapshotForUsers(client, "o1", ["c1", "c2"], ["u1", "u2", "u1", ""], NOW);
    const q = queries[0];
    eq("the ADR's argument order (svc, orgId, courseIds, userIds): one read of the org's approved grants",
      [queries.length, q.table, q.ops.filter((o) => o.op === "eq").map((o) => o.args)], [1, "attempt_requests", [["organization_id", "o1"], ["status", "approved"]]]);
    eq("…the snapshot's columns plus user_id, course_id and reissued_from", selectOf(q),
      "id, used_attempt_id, used_at, expires_at, created_at, decided_by, decided_at, decision_note, reason, user_id, course_id, reissued_from");
    eq("…user ids deduplicated, the course ids in the query", q.ops.filter((o) => o.op === "in").map((o) => o.args), [["user_id", ["u1", "u2"]], ["course_id", ["c1", "c2"]]]);
    eq("keyed `${user_id}:${course_id}`", [...snap.keys()].sort(), ["u1:c1", "u1:c2", "u2:c1"]);
    eq("…each value a snapshot (retake ids, the unused grant)",
      [[...snap.get("u1:c1")!.retakeIds], snap.get("u1:c2")!.unusedGrant?.id, [...snap.get("u2:c1")!.retakeIds]], [["r1"], "g2", ["r9"]]);
  }
  {
    const users = Array.from({ length: 301 }, (_, i) => `u${i}`);
    const { client, queries } = recordingClient(answer(rows));
    const snap = await grantSnapshotForUsers(client, "o1", null, users, NOW);
    eq("301 users → chunks of 300 and 1", queries.map((q) => usersOf(q).length), [300, 1]);
    eq("courseIds null → no course filter (every course of the users)", queries.some((q) => q.ops.some((o) => o.op === "in" && o.args[0] === "course_id")), false);
    eq("…every pair of every chunk", [...snap.keys()].sort(), ["u1:c1", "u1:c2", "u2:c1"]);
  }
  {
    const many = Array.from({ length: 301 }, (_, i) => `c${i}`);
    const { client, queries } = recordingClient(answer([g("x1", "u1", "c5"), g("x2", "u1", "elsewhere")]));
    const snap = await grantSnapshotForUsers(client, "o1", many, ["u1"], NOW);
    eq("301 course ids → no course filter in the query, filtered in memory",
      [queries[0].ops.some((o) => o.op === "in" && o.args[0] === "course_id"), [...snap.keys()]], [false, ["u1:c5"]]);
  }
  {
    const users = ["u1", ...Array.from({ length: 300 }, (_, i) => `z${i}`)];
    const { client, queries } = recordingClient((q) =>
      selectOf(q).includes("reissued_from")
        ? { data: null, error: { code: "42703", message: "column attempt_requests.reissued_from does not exist" } }
        : { data: rows.filter((r) => matches(q, r)).map(({ reissued_from: _r, ...x }) => (void _r, x)) }
    );
    const snap = await grantSnapshotForUsers(client, "o1", ["c1"], users, NOW);
    eq("a database without 0103: re-read without reissued_from; the next chunk reads without it", queries.map((q) => selectOf(q).includes("reissued_from")), [true, false, false]);
    eq("…never 'no grants'", [[...snap.keys()], [...(snap.get("u1:c1")?.retakeIds ?? [])]], [["u1:c1"], ["r1"]]);
  }
  {
    const { client } = recordingClient(() => ({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.attempt_requests' in the schema cache" } }));
    eq("a missing table (schema-missing) → an empty map", (await grantSnapshotForUsers(client, "o1", ["c1"], ["u1"], NOW)).size, 0);
  }
  for (const [what, ans] of [
    ["another error (a timeout)", { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }],
    ["data: null with no error", { data: null, error: null }],
  ] as Array<[string, { data: unknown; error: unknown }]>) {
    const { client } = recordingClient(() => ans);
    let thrown: unknown = null;
    try { await grantSnapshotForUsers(client, "o1", ["c1"], ["u1"], NOW); } catch (e) { thrown = e; }
    eq(`${what} → GrantReadError`, thrown instanceof GrantReadError, true);
  }
  {
    const { client, queries } = recordingClient(answer(rows));
    const a = await grantSnapshotForUsers(client, "o1", [], ["u1"], NOW);
    const b = await grantSnapshotForUsers(client, "o1", ["c1"], [], NOW);
    eq("no course or no user → an empty map and no read", [a.size, b.size, queries.length], [0, 0, 0]);
  }

  console.log("\ngrantSnapshotForUsers: every chunk paged in id order until a short page");
  const rangeOf = (q: Query) => (q.ops.find((o) => o.op === "range")?.args ?? []) as number[];
  const many = Array.from({ length: 1001 }, (_, i) =>
    g(`p${String(i).padStart(4, "0")}`, "u1", "c1", { used_attempt_id: `r${i}`, used_at: "2026-10-02T00:00:00Z" }));
  {
    const { client, queries } = recordingClient((q) => {
      const [from, to] = rangeOf(q);
      return { data: many.slice(from, to + 1) };
    });
    const snap = await grantSnapshotForUsers(client, "o1", ["c1"], ["u1"], NOW);
    eq("1,000 rows then 1: two reads, each ordered by id, ranged 0-999 then 1000-1999",
      queries.map((q) => [q.ops.find((o) => o.op === "order")?.args[0], rangeOf(q)]), [["id", [0, 999]], ["id", [1000, 1999]]]);
    eq("…all 1,001 grants are in the snapshot (none cut at the row cap)",
      [[...snap.values()].reduce((n, s) => n + s.rows.length, 0), snap.get("u1:c1")?.retakeIds.size], [1001, 1001]);
    eq("…the order comes before the range, after every filter", queries.map((q) => q.ops.map((o) => o.op).slice(-2)), [["order", "range"], ["order", "range"]]);
  }
  for (const [what, page2] of [
    ["an error on page 2", { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }],
    ["a page 2 with neither rows nor an error", { data: null, error: null }],
    ["a schema-missing error on page 2 (page 1 answered, so the relation exists)", { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.attempt_requests' in the schema cache" } }],
  ] as Array<[string, { data: unknown; error: unknown }]>) {
    const { client, queries } = recordingClient((q) => (rangeOf(q)[0] === 0 ? { data: many.slice(0, 1000) } : page2));
    let thrown: unknown = null;
    try { await grantSnapshotForUsers(client, "o1", ["c1"], ["u1"], NOW); } catch (e) { thrown = e; }
    eq(`${what} → GrantReadError: the strict read fails, never a partial chain (and is not retried)`, [thrown instanceof GrantReadError, queries.length], [true, 2]);
  }
  {
    // A database without 0103: the first page decides for every page of every chunk.
    const users = ["u1", ...Array.from({ length: 300 }, (_, i) => `z${i}`)];
    const { client, queries } = recordingClient((q) => {
      if (selectOf(q).includes("reissued_from")) return { data: null, error: { code: "42703", message: "column attempt_requests.reissued_from does not exist" } };
      const [from, to] = rangeOf(q);
      return { data: usersOf(q).includes("u1") ? many.slice(from, to + 1).map(({ reissued_from: _r, ...x }) => (void _r, x)) : [] };
    });
    const snap = await grantSnapshotForUsers(client, "o1", ["c1"], users, NOW);
    eq("pre-0103 and paged: page 1 re-read without reissued_from, page 2 and the next chunk read without it",
      queries.map((q) => [selectOf(q).includes("reissued_from"), rangeOf(q)[0]]), [[true, 0], [false, 0], [false, 1000], [false, 0]]);
    eq("…and every row is read", snap.get("u1:c1")?.rows.length, 1001);
  }

  console.log("\nfetchUnusedGrantsForUsers: fail-soft (ADR 0014:186)");
  {
    const { client, queries } = recordingClient(() => ({ data: [{ id: "g2", user_id: "u1", course_id: "c2", expires_at: null }] }));
    const m = await fetchUnusedGrantsForUsers(client, "o1", ["u1"]);
    const q = queries[0];
    eq("the columns and filters (approved, unused, the org)",
      [selectOf(q), q.ops.filter((o) => o.op === "eq" || o.op === "is").map((o) => o.args)],
      ["id, user_id, course_id, expires_at", [["organization_id", "o1"], ["status", "approved"], ["used_at", null]]]);
    eq("keyed by pair", [...m.entries()], [["u1:c2", [{ id: "g2", course_id: "c2", expires_at: null }]]]);
  }
  {
    const users = ["u1", ...Array.from({ length: 300 }, (_, i) => `z${i}`)];
    const { client, queries } = recordingClient((q) =>
      usersOf(q).includes("u1") ? { data: [{ id: "g2", user_id: "u1", course_id: "c2", expires_at: null }] } : { data: null, error: { code: "57014", message: "timeout" } }
    );
    const m = await fetchUnusedGrantsForUsers(client, "o1", users);
    eq("a failed chunk → the pairs read so far, no throw", [queries.length, [...m.keys()]], [2, ["u1:c2"]]);
  }
  {
    const throwing = { from() { throw new Error("down"); } } as never;
    eq("a thrown exception → an empty map, no throw", (await fetchUnusedGrantsForUsers(throwing, "o1", ["u1"])).size, 0);
  }

  console.log("\nreadWithOptionalColumn: the narrower-select fallback, written once");
  {
    const seen: string[] = [];
    const res = await readWithOptionalColumn<number[]>("is_revision", async (c) => {
      seen.push(c);
      return c.includes("is_revision") ? { data: null, error: MISSING } : { data: [1], error: null };
    }, "id, status");
    eq("a missing is_revision → one re-read without it", [seen, res.data], [["id, status, is_revision", "id, status"], [1]]);
  }
  for (const [what, err] of [
    ["another error", { code: "57014", message: "timeout" }],
    ["a 42703 naming another column", { code: "42703", message: "column course_attempts.learning_path_id does not exist" }],
  ] as Array<[string, { code: string; message: string }]>) {
    const seen: string[] = [];
    const res = await readWithOptionalColumn<number[]>("is_revision", async (c) => (seen.push(c), { data: null, error: err }), "id");
    eq(`${what} → returned as is, never retried without the column`, [seen.length, res.error?.code], [1, err.code]);
  }
  {
    const seen: string[] = [];
    const res = await readWithOptionalColumn<number[]>("is_revision", async (c) => (seen.push(c), { data: [7], error: null }), "id");
    eq("a database with the column → one read", [seen, res.data], [["id, is_revision"], [7]]);
  }
}

async function pagedFallbackCases() {
  console.log("\nreadPagedWithOptionalColumn: the paged fallback, written once; the first page decides");
  type PgErr = { code: string; message: string };
  const TIMEOUT: PgErr = { code: "57014", message: "canceling statement due to statement timeout" };
  const FULL = "id, status, is_revision";
  const BASE = "id, status";
  /** A paged source of `total` numbered rows; records each read's [columns, from, to]; `fault` may answer an error. */
  const pager = (total: number, fault: (columns: string, from: number) => PgErr | null = () => null) => {
    const seen: Array<[string, number, number]> = [];
    const read = async (columns: string, from: number, to: number) => {
      seen.push([columns, from, to]);
      const err = fault(columns, from);
      if (err) return { data: null, error: err };
      return { data: Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, i) => from + i), error: null };
    };
    return { seen, read };
  };
  const at0 = (p: ReturnType<typeof pager>) => p.seen.map(([c, from]) => `${c === FULL ? "full" : c === BASE ? "base" : c}@${from}`);
  {
    const p = pager(1001);
    const res = await readPagedWithOptionalColumn<number>("is_revision", p.read, BASE);
    eq("column present: pages of 1,000 until a short page, every page with the column",
      [p.seen, res.data.length, res.error], [[[FULL, 0, 999], [FULL, 1000, 1999]], 1001, null]);
  }
  {
    const p = pager(2001, (c) => (c.includes("is_revision") ? MISSING : null));
    const res = await readPagedWithOptionalColumn<number>("is_revision", p.read, BASE);
    eq("42703 on page 1: page 1 is re-read without the column, and every later page reads without it (never asked again)",
      [at0(p), res.data.length, res.error], [["full@0", "base@0", "base@1000", "base@2000"], 2001, null]);
  }
  {
    const p = pager(2500, (_c, from) => (from === 1000 ? TIMEOUT : null));
    const res = await readPagedWithOptionalColumn<number>("is_revision", p.read, BASE);
    eq("an error on a later page ends the read: the rows read so far and the error, no retry, no narrower read",
      [at0(p), res.data.length, res.error?.code], [["full@0", "full@1000"], 1000, "57014"]);
  }
  {
    const p = pager(2500, (c, from) => (from === 1000 && c.includes("is_revision") ? MISSING : null));
    const res = await readPagedWithOptionalColumn<number>("is_revision", p.read, BASE);
    eq("a missing-column error on a later page: the first page decided, so it is an error like any other (no narrower re-read)",
      [at0(p), res.data.length, res.error?.code], [["full@0", "full@1000"], 1000, "42703"]);
  }
  {
    const state: OptionalColumnState = { columns: null };
    const p = pager(10, (c) => (c.includes("is_revision") ? MISSING : TIMEOUT));
    const res = await readPagedWithOptionalColumn<number>("is_revision", p.read, BASE, { state });
    eq("a first page that fails after its narrower re-read decides nothing: the state stays null, the error returned",
      [at0(p), state.columns, res.data.length, res.error?.code], [["full@0", "base@0"], null, 0, "57014"]);
  }
  {
    const state: OptionalColumnState = { columns: null };
    const a = pager(5, (c) => (c.includes("is_revision") ? MISSING : null));
    await readPagedWithOptionalColumn<number>("is_revision", a.read, BASE, { state });
    const b = pager(5);
    const res = await readPagedWithOptionalColumn<number>("is_revision", b.read, BASE, { state });
    eq("opts.state carries the decision into the next call (a chunked read): the next chunk reads the narrower list at once",
      [at0(a), at0(b), state.columns, res.data.length], [["full@0", "base@0"], ["base@0"], BASE, 5]);
  }
  {
    const nullAt = (target: number) => async (_c: string, from: number, to: number) =>
      from === target ? { data: null, error: null } : { data: Array.from({ length: to - from + 1 }, (_, i) => from + i), error: null };
    const soft = await readPagedWithOptionalColumn<number>("is_revision", nullAt(1000), BASE);
    const strict = await readPagedWithOptionalColumn<number>("is_revision", nullAt(1000), BASE, { nullIsError: true });
    eq("a page with neither rows nor an error: empty by default (the read ends); an empty_answer error with nullIsError",
      [[soft.data.length, soft.error], [strict.data.length, strict.error?.code]], [[1000, null], [1000, "empty_answer"]]);
  }
  {
    const p = pager(10_000);
    const res = await readPagedWithOptionalColumn<number>("is_revision", p.read, BASE, { maxPages: 3 });
    eq("maxPages bounds the pages read (org Reports' ceiling)", [p.seen.length, res.data.length, res.error], [3, 3000, null]);
    const q = pager(25);
    const small = await readPagedWithOptionalColumn<number>("is_revision", q.read, BASE, { pageSize: 10 });
    eq("pageSize sets the range: 0-9, 10-19, 20-29", [q.seen.map(([, f, t]) => [f, t]), small.data.length], [[[0, 9], [10, 19], [20, 29]], 25]);
  }
}

async function statusCases() {
  console.log("\nofficialStatuses: injected grants; standingVerdictOf");
  const rowsFor = [
    { id: "a1", user_id: "u1", course_id: "c1", score: 0.85, started_at: "2026-10-01T09:00Z", completed_at: "2026-10-01T09:30Z", completion_status: "completed", success_status: "passed", status: "passed", is_revision: false },
    { id: "r1", user_id: "u1", course_id: "c1", score: null, started_at: "2026-10-05T09:00Z", completed_at: null, completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: false },
  ];
  {
    const { client, queries } = recordingClient(() => ({ data: [] }));
    const map = await officialStatuses(client, "o1", rowsFor, { grants: new Map([["u1:c1", new Set(["r1"])]]) });
    eq("opts.grants replaces the fail-soft read (no attempt_requests query)", queries.some((q) => q.table === "attempt_requests"), false);
    eq("a live retake over a pass: status in_progress, standingVerdictOf passed", [statusOf(map, "u1", "c1"), standingVerdictOf(map, "u1", "c1")], ["in_progress", "passed"]);
    eq("standingVerdictOf of a pair with no attempt → null", standingVerdictOf(map, "u2", "c1"), null);
  }
  {
    const { client, queries } = recordingClient((q) => (q.table === "attempt_requests" ? { data: [{ user_id: "u1", course_id: "c1", used_attempt_id: "r1" }] } : { data: [] }));
    const map = await officialStatuses(client, "o1", rowsFor);
    eq("without opts the fail-soft read runs, with the same answer", [queries.some((q) => q.table === "attempt_requests"), statusOf(map, "u1", "c1")], [true, "in_progress"]);
  }

  console.log("\nloadEnrolledCourseStatus: is_revision through the fallback, the first page decides");
  {
    const att = (n: number) => ({
      id: `a${String(n).padStart(4, "0")}`, user_id: "u1", status: "in_progress", completion_status: "in_progress", success_status: "unknown",
      score: null, started_at: "2026-10-01T09:00Z", completed_at: null,
    });
    const page1 = Array.from({ length: 1000 }, (_, i) => att(i));
    const page2 = [att(1000)];
    const { client, queries } = recordingClient((q) => {
      if (q.table === "v_course_enrollments_expanded") return { data: [{ user_id: "u1" }] };
      if (q.table === "course_attempts") {
        if (selectOf(q).includes("is_revision")) return { data: null, error: MISSING };
        return { data: (q.ops.find((o) => o.op === "range")?.args[0] ?? 0) === 0 ? page1 : page2 };
      }
      return { data: [] };
    });
    const r = await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
    eq("a database without 0103: the first page re-reads without is_revision, the second page reads the narrower list directly",
      queries.filter((q) => q.table === "course_attempts").map((q) => selectOf(q).includes("is_revision")), [true, false, false]);
    eq("…every row is read", r.officialByUser.get("u1:c1")?.attempts.length, 1001);
  }
  {
    const { client, queries } = recordingClient((q) => {
      if (q.table === "v_course_enrollments_expanded") return { data: [{ user_id: "u1" }, { user_id: "u2" }] };
      if (q.table === "course_attempts") {
        return {
          data: [
            { id: "a1", user_id: "u1", status: "passed", completion_status: "completed", success_status: "passed", score: 0.9, started_at: "2026-10-01T09:00Z", completed_at: "2026-10-01T09:30Z", is_revision: false },
            { id: "v1", user_id: "u2", status: "in_progress", completion_status: "in_progress", success_status: "unknown", score: null, started_at: "2026-10-02T09:00Z", completed_at: null, is_revision: true },
            // a learner the view does not return: their attempt is not counted
            { id: "o1", user_id: "u9", status: "passed", completion_status: "completed", success_status: "passed", score: 0.8, started_at: "2026-10-02T09:00Z", completed_at: "2026-10-02T09:30Z", is_revision: false },
          ],
        };
      }
      return { data: [] };
    });
    const r = await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
    eq("a database with 0103: one select naming is_revision; a learner with only a flagged row is not started",
      [queries.filter((q) => q.table === "course_attempts").map((q) => selectOf(q).includes("is_revision")), r.summary],
      [[true], { total: 2, completed: 1, failed: 0, inProgress: 0, notStarted: 1 }]);
    eq("…an attempt of a learner the view does not return is not counted", [...r.enrolledUserIds].sort(), ["u1", "u2"]);
  }

  console.log("\nloadEnrolledCourseStatus: the enrolled set is the view's (ADR 0020 step 5)");
  {
    const { client, queries } = recordingClient((q) => (q.table === "v_course_enrollments_expanded" ? { data: [{ user_id: "u1" }] } : { data: [] }));
    await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
    const view = queries.filter((q) => q.table === ENROLMENTS_VIEW);
    eq("ENROLMENTS_VIEW names the view", ENROLMENTS_VIEW, "v_course_enrollments_expanded");
    eq("one read of the view: select user_id, eq course_id, order user_id, range 0-999",
      view.map((q) => q.ops.map((o) => [o.op, ...o.args])),
      [[["select", "user_id"], ["eq", "course_id", "c1"], ["order", "user_id"], ["range", 0, 999]]]);
    eq("no assignment, team or member table is read for the enrolled set",
      queries.some((q) => ["course_assignments", "team_members", "organization_members", "learning_path_assignments", "org_groups"].includes(q.table)), false);
  }
  {
    const ids = Array.from({ length: 1001 }, (_, i) => `u${String(i).padStart(4, "0")}`);
    const { client, queries } = recordingClient((q) => {
      if (q.table === "v_course_enrollments_expanded") {
        const [from, to] = (q.ops.find((o) => o.op === "range")?.args ?? [0, 999]) as [number, number];
        return { data: ids.slice(from, to + 1).map((user_id) => ({ user_id })) };
      }
      return { data: [] };
    });
    const r = await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
    eq("1,001 enrolled learners over two pages: ranges 0-999 and 1000-1999, every learner counted",
      [queries.filter((q) => q.table === ENROLMENTS_VIEW).map((q) => q.ops.find((o) => o.op === "range")?.args), r.summary.total, r.summary.notStarted],
      [[[0, 999], [1000, 1999]], 1001, 1001]);
  }
  {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      const { client, queries } = recordingClient((q) =>
        q.table === "v_course_enrollments_expanded" ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : { data: [] });
      const r = await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
      eq("a failed view read: fail-soft, the summary counts what was read (0), no attempts read",
        [r.summary.total, queries.some((q) => q.table === "course_attempts")], [0, false]);
      eq("…and the warning is logged", warned.some((w) => w.startsWith("[enrolled-status] enrolments read failed:") && w.includes("statement timeout")), true);
    } finally {
      console.warn = warn;
    }
  }

  // ADR 0024 step 49: the Individual product's loader takes the Individual
  // context when 0107 is there and today's rows when it is not.
  console.log("\nloadEnrolledCourseStatus: the Individual context when 0107 is there (ADR 0024 step 49)");
  const ctxRow = (id: string, user: string, kind: string, outcome: "passed" | "failed", day: number) => ({
    id, user_id: user, status: outcome, completion_status: "completed", success_status: outcome, score: outcome === "passed" ? 0.9 : 0.3,
    started_at: `2026-10-0${day}T09:00Z`, completed_at: `2026-10-0${day}T09:30Z`, is_revision: false, context_kind: kind,
  });
  // u1 passed first in a path and failed later on the Library; u2 completed
  // the course only in a path; u3 opened it only as a preview.
  const ctxRows = [
    ctxRow("a1", "u1", "path", "passed", 1),
    ctxRow("a2", "u1", "individual", "failed", 2),
    ctxRow("a3", "u2", "path", "passed", 3),
    ctxRow("a4", "u3", "preview", "passed", 4),
  ];
  const MISSING_CTX = { code: "42703", message: "column course_attempts.context_kind does not exist" };
  const filteredBy = (q: Query) => q.ops.filter((o) => o.op === "eq" && o.args[0] === "context_kind").map((o) => o.args[1]);
  const enrolled = { data: [{ user_id: "u1" }, { user_id: "u2" }, { user_id: "u3" }] };
  {
    const { client, queries } = recordingClient((q) => {
      if (q.table === "v_course_enrollments_expanded") return enrolled;
      if (q.table === "course_attempts") {
        const only = filteredBy(q);
        return { data: only.length ? ctxRows.filter((r) => only.includes(r.context_kind)) : ctxRows };
      }
      return { data: [] };
    });
    const r = await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
    const reads = queries.filter((q) => q.table === "course_attempts");
    eq("with 0107: one attempts read, filtered context_kind = individual", reads.map(filteredBy), [["individual"]]);
    eq("…u1's Individual result is the Library fail (the earlier path pass is another product's); u2's path pass and u3's preview count nowhere here",
      [statusOf(r.officialByUser, "u1", "c1"), statusOf(r.officialByUser, "u2", "c1"), statusOf(r.officialByUser, "u3", "c1"), r.summary],
      ["failed", "not_started", "not_started", { total: 3, completed: 0, failed: 1, inProgress: 0, notStarted: 2 }]);
  }
  {
    // A grant consumed before 0107 whose retake old consume_grant tagged with
    // a path (note N9): the grant read returns it, the filtered attempts read
    // does not return its row, and the Individual result is the Library one.
    const rows = [...ctxRows, ctxRow("p9", "u1", "path", "passed", 5)];
    const { client } = recordingClient((q) => {
      if (q.table === "v_course_enrollments_expanded") return enrolled;
      if (q.table === "attempt_requests") return { data: [{ user_id: "u1", course_id: "c1", used_attempt_id: "p9" }] };
      if (q.table === "course_attempts") {
        const only = filteredBy(q);
        return { data: only.length ? rows.filter((r) => only.includes(r.context_kind)) : rows };
      }
      return { data: [] };
    });
    const r = await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
    eq("with 0107, a used grant whose retake is a path row: u1 reads the Library fail, the retake id changes nothing",
      [statusOf(r.officialByUser, "u1", "c1"), r.officialByUser.get("u1:c1")?.scoring.officialAttempt?.id], ["failed", "a2"]);
    // The control: the same grant over every row (no filter) makes the
    // retake official, so the grant read above did reach the scoring.
    const { client: all } = recordingClient((q) => {
      if (q.table === "v_course_enrollments_expanded") return enrolled;
      if (q.table === "attempt_requests") return { data: [{ user_id: "u1", course_id: "c1", used_attempt_id: "p9" }] };
      if (q.table === "course_attempts") return { data: rows };
      return { data: [] };
    });
    const control = await loadEnrolledCourseStatus(all, "o1", "c1", ["v1"]);
    eq("…control: over every row the same grant makes p9 the official attempt",
      [statusOf(control.officialByUser, "u1", "c1"), control.officialByUser.get("u1:c1")?.scoring.officialAttempt?.id], ["passed", "p9"]);
  }
  {
    const versions = Array.from({ length: 151 }, (_, i) => `v${i}`);
    const { client, queries } = recordingClient((q) => {
      if (q.table === "v_course_enrollments_expanded") return enrolled;
      if (q.table === "course_attempts") {
        if (filteredBy(q).length) return { data: null, error: MISSING_CTX };
        const inV = (q.ops.find((o) => o.op === "in")?.args[1] ?? []) as string[];
        return { data: inV.includes("v0") ? ctxRows : [] };
      }
      return { data: [] };
    });
    const r = await loadEnrolledCourseStatus(client, "o1", "c1", versions);
    const reads = queries.filter((q) => q.table === "course_attempts");
    eq("without 0107: the first read's 42703 naming context_kind re-reads it unfiltered; the second version chunk reads unfiltered at once",
      reads.map((q) => [filteredBy(q).length > 0, (q.ops.find((o) => o.op === "in")?.args[1] as string[]).length]), [[true, 150], [false, 150], [false, 1]]);
    eq("…today's reading, every product's row on the course: u1's official attempt is the first (the path pass), u2's path pass counts, the preview too",
      [statusOf(r.officialByUser, "u1", "c1"), statusOf(r.officialByUser, "u2", "c1"), statusOf(r.officialByUser, "u3", "c1")],
      ["passed", "passed", "passed"]);
  }
  {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      const { client, queries } = recordingClient((q) => {
        if (q.table === "v_course_enrollments_expanded") return enrolled;
        if (q.table === "course_attempts") return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        return { data: [] };
      });
      const r = await loadEnrolledCourseStatus(client, "o1", "c1", ["v1"]);
      const reads = queries.filter((q) => q.table === "course_attempts");
      eq("another error: no read without the filter, logged, the summary counts what was read",
        [reads.map(filteredBy), r.summary.notStarted, warned.some((w) => w.startsWith("[enrolled-status] attempts read failed:"))], [[["individual"]], 3, true]);
    } finally {
      console.warn = warn;
    }
  }
}

classifyCases()
  .then(snapshotCases)
  .then(bulkSnapshotCases)
  .then(pagedFallbackCases)
  .then(statusCases)
  .catch((e) => {
    fail++;
    console.log("  ✗ classifyAttempt / grantSnapshotFor / PR 1b cases threw:", e);
  })
  .finally(() => {
    console.log(`\n==== status: ${pass} passed, ${fail} failed ====`);
    process.exit(fail === 0 ? 0 : 1);
  });
