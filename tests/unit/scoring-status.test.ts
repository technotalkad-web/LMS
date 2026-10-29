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
import { classifyAttempt, GrantReadError, grantSnapshotFor } from "../../lib/scoring/attempt-kind";
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
  eq("canRequestAttempt is unchanged in PR 1a (still officialFailed-gated until step 11)",
    /const canRequestAttempt =\s*!isAdmin &&\s*scoring\.limitReached &&\s*officialFailed &&/.test(src), true);
  eq("the attempts read stays select(\"*\") (is_revision present on a 0103 database, undefined before)",
    /\.from\("course_attempts"\)\s*\/\/[^\n]*\n\s*\.select\("\*"\)/.test(src), true);
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
      for (const op of ["select", "eq", "neq", "in", "is", "not", "order", "limit"]) {
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

classifyCases()
  .then(snapshotCases)
  .catch((e) => {
    fail++;
    console.log("  ✗ classifyAttempt / grantSnapshotFor cases threw:", e);
  })
  .finally(() => {
    console.log(`\n==== status: ${pass} passed, ${fail} failed ====`);
    process.exit(fail === 0 ? 0 : 1);
  });
