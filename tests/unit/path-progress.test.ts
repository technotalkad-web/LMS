/**
 * Unit tests for lib/paths/progress.ts (ADR 0024 steps 43 and 44; step 62's
 * row "path-progress.test.ts"; build notes N9 to N12, O1-d, O1-i, O1-k;
 * twins contract section 3):
 *
 *   (a) passed_ever against latest_result, with the passed-then-failed-retake
 *       fixture (D14); done, next step, path score; the contract's minimum
 *       path cases (3.5); passed_in_window (the ADR 0024 note of
 *       2026-11-14, O4-b) against passed_by_rule;
 *   (b) the path status in N11's order, a live granted retake first;
 *   (c) the owner's O1 answer (option ii): the four readings of O1-i (a fact
 *       row on a step now pass-required with a standing result that did not
 *       pass; no fact with a rule relaxed; no fact under a pass-required rule
 *       with no pass, the state of rows O1-h (2) left before the owner's O3
 *       answer, whose rule-change trigger now records the fact in SQL; a fact
 *       row and then a granted retake that failed) and the fact rows as a
 *       required input;
 *   (d) pathStepStatus answers what pathProgress answers for the step;
 *   (e) ruling A5 of the ADR's note of 2026-11-14: the older roll-up of the
 *       same name in lib/courses/progress-view.ts is deprecated (a pointer to
 *       step 43), its importers under app/, lib/ and components/ are exactly
 *       the three files of the dated list OLD_PATH_PROGRESS_IMPORTERS, and
 *       no file imports both functions.
 *
 * No database. The SQL twin is asserted on the same readings in the
 * rehearsal (assert-0107-*.sql).
 *
 * Run:  npx tsx tests/unit/path-progress.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { pathProgress, pathStepStatus, type PathAttempt, type PathGrant, type PathProgressInput, type PathStepFact, type PathStepInput } from "../../lib/paths/progress";
import { contextKindOfKey } from "../../lib/scoring/context";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const uid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
const A = (n: number) => uid("a", n);
const G = (n: number) => uid("c", n);
const PATH = uid("b", 1);
const OTHER_PATH = uid("b", 2);
const C1 = uid("cc", 1);
const C2 = uid("cc", 2);
const C3 = uid("cc", 3);
const GONE = uid("cc", 9);
const NOW = "2026-06-01T00:00:00Z";
const P = `path:${PATH}`;
const I = "individual";

type Outcome = "passed" | "failed" | "completed" | "open" | "abandoned";
function row(n: number, course: string, key: string, outcome: Outcome, day: number, o: Partial<PathAttempt> = {}): PathAttempt {
  const d = String(day).padStart(2, "0");
  const done = outcome === "passed" || outcome === "failed" || outcome === "completed";
  return {
    id: A(n),
    course_id: course,
    course_version_id: `${course.slice(0, -4)}ffff`,
    context_kind: contextKindOfKey(key) ?? "individual",
    context_key: key,
    status: outcome === "open" ? "in_progress" : outcome,
    completion_status: done ? "completed" : "in_progress",
    success_status: outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "unknown",
    score: outcome === "passed" ? 0.9 : outcome === "failed" ? 0.4 : outcome === "completed" ? 0.7 : null,
    started_at: `2026-02-${d}T09:00:00Z`,
    completed_at: done ? `2026-02-${d}T09:30:00Z` : null,
    is_revision: false,
    learning_path_id: key.startsWith("path:") ? key.slice(5) : null,
    journey_enrollment_id: null,
    journey_day: null,
    journey_day_id: null,
    journey_version_id: null,
    ...o,
  };
}
const grant = (n: number, course: string, key: string, used: string | null, day: number): PathGrant => ({
  id: G(n),
  course_id: course,
  context_key: key,
  used_attempt_id: used,
  used_at: used ? `2026-02-${String(day).padStart(2, "0")}T10:00:00Z` : null,
  expires_at: null,
  created_at: `2026-02-${String(day).padStart(2, "0")}T08:00:00Z`,
});
const fact = (course: string, rulePassRequired = false, path = PATH): PathStepFact => ({
  path_id: path,
  course_id: course,
  done_at: "2026-03-01T00:00:00Z",
  rule_pass_required: rulePassRequired,
});
const step = (course: string, n: number, passRequired = true, releaseAt: string | null = null): PathStepInput => ({
  course_id: course,
  step_number: n,
  release_at: releaseAt,
  pass_required: passRequired,
});
const ONE = [step(C1, 1)];
const TWO = [step(C1, 1), step(C2, 2)];
const run = (i: Partial<PathProgressInput> & { steps: PathStepInput[] }) =>
  pathProgress({
    pathId: PATH,
    attempts: [],
    grants: [],
    facts: [],
    completion: null,
    terms: { due_at: null, enrolled_at: "2026-01-01T00:00:00Z" },
    now: NOW,
    ...i,
  });
const stepView = (s: ReturnType<typeof run>["steps"][number]) => ({
  passed_ever: s.passed_ever,
  passed_by_rule: s.passed_by_rule,
  done_recorded_at: s.done_recorded_at,
  latest_result: s.latest_result,
  latest_score: s.latest_score,
  done: s.done,
  official_attempt_id: s.official_attempt_id,
  retake_live: s.retake_live,
  failed: s.failed,
  open_attempt: s.open_attempt,
  passed_in_window: s.passed_in_window,
});

console.log("\n(a) passed_ever against latest_result (D14), done, next step, path score");
{
  // Contract 3.5 case 1, D14: pass, grant, failed retake.
  const d14 = run({ steps: ONE, attempts: [row(1, C1, P, "passed", 1), row(2, C1, P, "failed", 3)], grants: [grant(1, C1, P, A(2), 2)] });
  eq("D14: passed earlier, the standing result failed: done, not failed", stepView(d14.steps[0]), {
    passed_ever: true, passed_by_rule: true, done_recorded_at: null, latest_result: "failed", latest_score: 0.4, done: true,
    official_attempt_id: A(2), retake_live: false, failed: false, open_attempt: false, passed_in_window: true,
  });
  eq("…the path: 1 of 1 done, no next step, the score is the standing 0.4, in progress without a completion row", {
    steps_total: d14.steps_total, steps_done: d14.steps_done, next_step: d14.next_step, next_course_id: d14.next_course_id,
    path_score: d14.path_score, completed: d14.completed, status: d14.status, started_at: d14.started_at,
  }, {
    steps_total: 1, steps_done: 1, next_step: null, next_course_id: null, path_score: 0.4, completed: false, status: "in_progress",
    started_at: "2026-02-01T09:00:00Z",
  });

  // passed_in_window (the ADR 0024 note of 2026-11-14, O4-b): some row of
  // the scored window passed, whatever the rule. Under no required pass,
  // passed_by_rule says only that the window is not empty.
  const noRule = (rows: PathAttempt[], grants: PathGrant[] = []) => run({ steps: [step(C1, 1, false)], attempts: rows, grants }).steps[0];
  eq("O4-b: no pass required, failed, never passed: passed_by_rule true, passed_in_window false",
    [noRule([row(1, C1, P, "failed", 1)]).passed_by_rule, noRule([row(1, C1, P, "failed", 1)]).passed_in_window], [true, false]);
  eq("O4-b: no pass required, D14 (passed, then a failed granted retake): passed_in_window true",
    noRule([row(1, C1, P, "passed", 1), row(2, C1, P, "failed", 3)], [grant(1, C1, P, A(2), 2)]).passed_in_window, true);
  eq("O4-b: a pass required: passed_in_window equals passed_by_rule",
    [d14.steps[0].passed_in_window === d14.steps[0].passed_by_rule,
     run({ steps: ONE, attempts: [row(1, C1, P, "failed", 1)] }).steps[0].passed_in_window], [true, false]);
  eq("O4-b: a passed row in another context does not count for the path step",
    noRule([row(1, C1, I, "passed", 1), row(2, C1, P, "failed", 3)]).passed_in_window, false);

  // Case 2: fail, grant, pass.
  const recovered = run({ steps: ONE, attempts: [row(1, C1, P, "failed", 1), row(2, C1, P, "passed", 3)], grants: [grant(1, C1, P, A(2), 2)] });
  eq("fail, grant, pass: passed_ever, latest passed", [recovered.steps[0].passed_ever, recovered.steps[0].latest_result], [true, "passed"]);

  // Case 3: fail with pass_required, no grant.
  const failed = run({ steps: TWO, attempts: [row(1, C1, P, "failed", 1)] });
  eq("fail under pass_required, no grant: failed, not done, the next step is that step",
    [failed.steps[0].failed, failed.steps[0].done, failed.next_step, failed.next_course_id, failed.status], [true, false, 1, C1, "failed"]);

  // Case 4: fail with a live granted retake.
  const live = run({ steps: ONE, attempts: [row(1, C1, P, "failed", 1), row(2, C1, P, "open", 3)], grants: [grant(1, C1, P, A(2), 2)] });
  eq("fail with a live granted retake: not failed, retake_live, open_attempt; the path in progress",
    [live.steps[0].failed, live.steps[0].retake_live, live.steps[0].open_attempt, live.status], [false, true, true, "in_progress"]);

  // Case 5: completed and failed without pass_required.
  const lenient = run({ steps: [step(C1, 1, false)], attempts: [row(1, C1, P, "failed", 1)] });
  eq("failed without pass_required: done by the rule, never failed", [lenient.steps[0].done, lenient.steps[0].failed, lenient.steps[0].latest_result], [true, false, "failed"]);

  // Case 6: learner B, the step completed only individually.
  const onlyIndividual = run({ steps: ONE, attempts: [row(1, C1, I, "passed", 1)] });
  eq("learner B, the step completed only individually: not done in path:P, the path not started",
    [onlyIndividual.steps[0].done, onlyIndividual.steps[0].official_attempt_id, onlyIndividual.status, onlyIndividual.started_at], [false, null, "not_started", null]);

  // Case 7: the ever_passed / passed_ever separator.
  const separator = run({
    steps: ONE,
    attempts: [row(1, C1, P, "passed", 1, { status: "abandoned" }), row(2, C1, P, "failed", 2), row(3, C1, P, "passed", 3)],
  });
  eq("an abandoned pass and a practice pass: passed_ever false (the summary's ever_passed would say true)",
    [separator.steps[0].passed_ever, separator.steps[0].latest_result, separator.steps[0].official_attempt_id, separator.steps[0].failed], [false, "failed", A(2), true]);

  // Case 8: a by-role preview tagged with the path.
  const preview = run({ steps: ONE, attempts: [row(1, C1, "preview", "passed", 1, { learning_path_id: PATH })] });
  eq("a by-role preview tagged with the path: ignored", [preview.steps[0].done, preview.status], [false, "not_started"]);

  // Case 9: the step's own rule (resolved by the reader) decides.
  const completedNoVerdict = [row(1, C1, P, "completed", 1)];
  eq("a step's pass_required true over a course without one: completed without a pass is not done",
    run({ steps: [step(C1, 1, true)], attempts: completedNoVerdict }).steps[0].done, false);
  eq("…pass_required false: done", run({ steps: [step(C1, 1, false)], attempts: completedNoVerdict }).steps[0].done, true);

  // Case 10: a completion row, then a step added later.
  const added = run({ steps: TWO, attempts: [row(1, C1, P, "passed", 1)], completion: { completed_at: "2026-02-02T00:00:00Z" } });
  eq("a completed path with a step added later: completed, status completed, 1 of 2 (section L)",
    [added.completed, added.status, added.steps_done, added.steps_total, added.completed_at, added.next_step], [true, "completed", 1, 2, "2026-02-02T00:00:00Z", 2]);

  // Case 11: every step done, no completion row.
  const noRow = run({ steps: TWO, attempts: [row(1, C1, P, "passed", 1), row(2, C2, P, "passed", 2)] });
  eq("every step done, no completion row: not completed, in progress (N22)", [noRow.completed, noRow.status, noRow.steps_done], [false, "in_progress", 2]);

  // Case 12: a self-enrolled learner has no due date.
  const self = run({ steps: ONE, terms: { due_at: null, enrolled_at: "2026-01-05T00:00:00Z" } });
  eq("a self-enrolment: no due date, never overdue", [self.due_at, self.overdue, self.enrolled_at], [null, false, "2026-01-05T00:00:00Z"]);
  eq("a due date in the past and no completion row: overdue", run({ steps: ONE, terms: { due_at: "2001-01-01T00:00:00Z", enrolled_at: null } }).overdue, true);
  eq("…a due date in the future: not overdue", run({ steps: ONE, terms: { due_at: "2999-01-01T00:00:00Z", enrolled_at: null } }).overdue, false);

  // Case 14: a path attempt on a course that is no longer a step.
  const gone = run({ steps: ONE, attempts: [row(1, GONE, P, "failed", 1)] });
  eq("a path attempt on a course no longer a step: no effect on status, started_at or steps_total",
    [gone.status, gone.started_at, gone.steps_total], ["not_started", null, 1]);

  // Case 16: a reset-only learner.
  const reset = run({ steps: ONE, attempts: [row(1, C1, P, "abandoned", 1), row(2, C1, P, "abandoned", 2)] });
  eq("a reset-only learner: not started, no started_at", [reset.status, reset.started_at], ["not_started", null]);

  // The other columns.
  const scored = run({ steps: [step(C1, 1), step(C2, 2), step(C3, 3)], attempts: [row(1, C1, P, "passed", 1), row(2, C2, P, "completed", 2)] });
  eq("path_score: the mean of the steps' latest scores where a step has one, unrounded", scored.path_score, (0.9 + 0.7) / 2);
  eq("…none scored: null", run({ steps: ONE }).path_score, null);
  eq("next_step and next_course_id: the lowest step not done, whatever the input order",
    (() => { const r = run({ steps: [step(C3, 3), step(C1, 1), step(C2, 2)], attempts: [row(1, C1, P, "passed", 1)] }); return [r.next_step, r.next_course_id, r.steps.map((s) => s.step_number)]; })(),
    [2, C2, [1, 2, 3]]);
  eq("started_at: the earliest path row on a current step, abandoned and revision rows left out",
    run({ steps: TWO, attempts: [row(1, C1, P, "abandoned", 1), row(2, C2, P, "open", 4, { is_revision: true }), row(3, C2, P, "passed", 6), row(4, C1, I, "passed", 2)] }).started_at,
    "2026-02-06T09:00:00Z");
  eq("released: no date, a past date and a future date", run({ steps: [step(C1, 1), step(C2, 2, true, "2001-01-01T00:00:00Z"), step(C3, 3, true, "2999-01-01T00:00:00Z")] }).steps.map((s) => s.released), [true, true, false]);
  eq("ids compare whatever their case", run({ steps: [step(C1.toUpperCase(), 1)], attempts: [row(1, C1, P, "passed", 1)] }).steps[0].done, true);
}

console.log("\n(b) the path status, in N11's order");
{
  // Case 15: one step failed, another passed.
  const mixed = [row(1, C1, P, "failed", 1), row(2, C2, P, "passed", 2)];
  eq("one step failed and one passed, not completed: failed", run({ steps: TWO, attempts: mixed }).status, "failed");
  eq("…with the failed step's granted retake live: in progress",
    run({ steps: TWO, attempts: [...mixed, row(3, C1, P, "open", 4)], grants: [grant(1, C1, P, A(3), 3)] }).status, "in_progress");
  eq("…a live retake on another step while one step is failed: in progress (a live retake comes first)",
    run({ steps: TWO, attempts: [row(1, C1, P, "failed", 1), row(2, C2, P, "passed", 2), row(3, C2, P, "open", 4)], grants: [grant(1, C2, P, A(3), 3)] }).status, "in_progress");

  // N11: a completed path with a live granted retake.
  const completion = { completed_at: "2026-02-03T00:00:00Z" };
  const terms = { due_at: "2001-01-01T00:00:00Z", enrolled_at: null };
  const liveOnCompleted = run({ steps: ONE, attempts: [row(1, C1, P, "passed", 1), row(2, C1, P, "open", 5)], grants: [grant(1, C1, P, A(2), 4)], completion, terms });
  eq("a completed path with a live granted retake: status in progress, completed true, not overdue (N11)",
    [liveOnCompleted.status, liveOnCompleted.completed, liveOnCompleted.overdue], ["in_progress", true, false]);
  const afterRetake = run({ steps: ONE, attempts: [row(1, C1, P, "passed", 1), row(2, C1, P, "failed", 5)], grants: [grant(1, C1, P, A(2), 4)], completion, terms });
  eq("…after the retake fails: completed again; the step still done (D14)", [afterRetake.status, afterRetake.steps[0].done, afterRetake.steps[0].failed], ["completed", true, false]);

  // N9 on the path: an open legacy path retake whose grant reads individual.
  const legacy = run({ steps: ONE, attempts: [row(1, C1, P, "failed", 1), row(2, C1, P, "open", 3)], grants: [grant(1, C1, I, A(2), 2)] });
  eq("an open legacy path retake whose grant reads individual: retake_live, not failed (N9)",
    [legacy.steps[0].retake_live, legacy.steps[0].failed, legacy.status], [true, false, "in_progress"]);
  eq("…a grant of the course that names no row of the path counts for nothing there",
    run({ steps: ONE, attempts: [row(1, C1, P, "failed", 1), row(2, C1, I, "open", 3)], grants: [grant(1, C1, I, A(2), 2)] }).steps[0].retake_live, false);
}

console.log("\n(c) the stored fact (the owner's O1 answer, option ii)");
{
  // O1-i reading 1: a fact row, the step now pass-required, the standing result completed and not passed.
  const factOnly = run({ steps: TWO, attempts: [row(1, C1, P, "completed", 1)], facts: [fact(C1)] });
  eq("a fact row, the step now pass-required, completed without a pass: done by the fact (O1-g (1))", stepView(factOnly.steps[0]), {
    passed_ever: true, passed_by_rule: false, done_recorded_at: "2026-03-01T00:00:00Z", latest_result: "completed", latest_score: 0.7, done: true,
    official_attempt_id: A(1), retake_live: false, failed: false, open_attempt: false, passed_in_window: false,
  });
  eq("…the same rows without the fact read the same standing result (the fact never changes it)",
    (() => { const s = run({ steps: TWO, attempts: [row(1, C1, P, "completed", 1)] }).steps[0]; return [s.latest_result, s.latest_score, s.official_attempt_id, s.done]; })(),
    ["completed", 0.7, A(1), false]);
  eq("…next_step is 2", [factOnly.next_step, factOnly.next_course_id, factOnly.steps_done], [2, C2, 1]);
  const factFailed = run({ steps: TWO, attempts: [row(1, C1, P, "failed", 1)], facts: [fact(C1)] });
  eq("…a failed standing result with a fact: done and never failed; the path is not failed",
    [factFailed.steps[0].done, factFailed.steps[0].failed, factFailed.steps[0].latest_result, factFailed.status], [true, false, "failed", "in_progress"]);

  // O1-i reading 2: no fact, the rule relaxed.
  const relaxed = run({ steps: [step(C1, 1, false)], attempts: [row(1, C1, P, "failed", 1)] });
  eq("no fact, the rule relaxed: done at once by the rule, no fact needed", [relaxed.steps[0].passed_by_rule, relaxed.steps[0].done_recorded_at, relaxed.steps[0].done], [true, null, true]);

  // O1-i reading 3: no fact, the rule pass-required, no pass. Procedurally
  // (relaxed, nothing completed, tightened again) the rule-change trigger of
  // 0107 section 6q now records the fact before the tightening (the owner's
  // O3 answer), so this is a state of rows, not that sequence: the twin
  // judges the rows it is given and writes nothing.
  const limit = run({ steps: ONE, attempts: [row(1, C1, P, "failed", 1)] });
  eq("no fact, the rule pass-required, no pass: not done (a state of rows)", [limit.steps[0].done, limit.steps[0].failed], [false, true]);

  // O1-i reading 4: a fact row, then a granted retake that failed.
  const retakeRows = [row(1, C1, P, "completed", 1), row(2, C1, P, "open", 5)];
  const retakeGrant = [grant(1, C1, P, A(2), 4)];
  const whileLive = run({ steps: TWO, attempts: retakeRows, grants: retakeGrant, facts: [fact(C1)] });
  eq("a fact, then a live granted retake: retake_live, the path in progress (O1-g (11))",
    [whileLive.steps[0].retake_live, whileLive.steps[0].done, whileLive.status], [true, true, "in_progress"]);
  const afterFail = run({ steps: TWO, attempts: [row(1, C1, P, "completed", 1), row(2, C1, P, "failed", 5)], grants: retakeGrant, facts: [fact(C1)] });
  eq("…after it fails: passed_by_rule false, done by the fact, not failed, latest failed; step 2 stays next", {
    ...stepView(afterFail.steps[0]), next_step: afterFail.next_step,
  }, {
    passed_ever: true, passed_by_rule: false, done_recorded_at: "2026-03-01T00:00:00Z", latest_result: "failed", latest_score: 0.4, done: true,
    official_attempt_id: A(2), retake_live: false, failed: false, open_attempt: false, passed_in_window: false, next_step: 2,
  });
  const completedPath = run({ steps: TWO, attempts: [row(1, C1, P, "completed", 1), row(2, C1, P, "failed", 5), row(3, C2, P, "passed", 6)], grants: retakeGrant, facts: [fact(C1)], completion: { completed_at: "2026-02-04T00:00:00Z" } });
  eq("…a stored path completion is unchanged by it", [completedPath.completed, completedPath.status, completedPath.steps_done], [true, "completed", 2]);

  // Facts of another path, or of another course, count for nothing.
  eq("a fact of another path counts for nothing here", run({ steps: ONE, attempts: [row(1, C1, P, "completed", 1)], facts: [fact(C1, false, OTHER_PATH)] }).steps[0].done, false);
  eq("a fact on a course that is no longer a step changes nothing", run({ steps: ONE, facts: [fact(GONE)] }).steps_done, 0);
  eq("a step removed and added again finds its fact (by path and course, O1-g (7))", run({ steps: [step(C1, 5)], facts: [fact(C1)] }).steps[0].done, true);
}

console.log("\n(d) pathStepStatus answers what pathProgress answers for the step");
{
  const attempts = [row(1, C1, P, "passed", 1), row(2, C1, P, "failed", 3), row(3, C2, P, "passed", 4), row(4, C1, I, "passed", 5)];
  const grants = [grant(1, C1, P, A(2), 2)];
  const whole = run({ steps: TWO, attempts, grants, facts: [fact(C2)] });
  for (const s of TWO) {
    const one = pathStepStatus({ pathId: PATH, step: s, attempts, grants, fact: s.course_id === C2 ? fact(C2) : null, now: NOW });
    eq(`step ${s.step_number}: the same answer`, one, whole.steps.find((x) => x.course_id === s.course_id));
  }
  eq("…a fact of another course is not the step's", pathStepStatus({ pathId: PATH, step: step(C1, 1), attempts: [], grants: [], fact: fact(C2), now: NOW }).done_recorded_at, null);
  eq("…rows without a course_id are the caller's in-context read of the step's course (Continue, O1-k)",
    pathStepStatus({ pathId: PATH, step: step(C1, 1), attempts: [row(1, C1, P, "passed", 1)].map(({ course_id: _c, ...r }) => { void _c; return r; }), grants: [], fact: null, now: NOW }).done, true);
}

/**
 * OLD_PATH_PROGRESS_IMPORTERS (2026-11-14, ADR 0024 phase 1; ruling A5 of the
 * ADR's note of that day): every file under app/, lib/ and components/ that
 * imports the older pathProgress of lib/courses/progress-view.ts. The pull
 * request that moves the last of them onto the path views or onto
 * lib/paths/progress.ts with the fact rows (O1-k's "Path Reports, Learners,
 * the CSV" row) removes its files from this list, and the one that empties it
 * deletes the old function. A file is never added.
 */
const OLD_PATH_PROGRESS_IMPORTERS = {
  since: "2026-11-14",
  until: "the pull request that moves the last of these files onto the path views or lib/paths/progress.ts (ADR 0024 step 43, O1-k)",
  files: [
    "app/[org]/(admin)/analytics/page.tsx",
    "app/[org]/(admin)/learning-paths/page.tsx",
    "app/api/learning-paths/[id]/learners/export/route.ts",
  ],
};

console.log(`\n(e) ruling A5: the old pathProgress (lib/courses/progress-view.ts), pinned since ${OLD_PATH_PROGRESS_IMPORTERS.since}`);
{
  const root = path.resolve(__dirname, "../..");
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const walk = (dir: string, out: string[]): string[] => {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  /** A module specifier as a repository path without its extension, or null for a package. */
  const resolveSpec = (file: string, spec: string): string | null => {
    let p: string;
    if (spec.startsWith("@/")) p = spec.slice(2);
    else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(rel(file)), spec));
    else return null;
    return p.replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
  };
  const OLD = "lib/courses/progress-view";
  const NEW = "lib/paths/progress";
  /** What a file takes from a module: the names of its named imports and re-exports (an alias read by its imported name), and whether it imports the whole module (a namespace or a dynamic import). Comments blanked first. */
  const takes = (file: string, src: string, mod: string): { names: string[]; whole: boolean } => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    const names: string[] = [];
    let whole = false;
    for (const m of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      if (resolveSpec(file, m[2]) !== mod) continue;
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    for (const m of code.matchAll(/\bimport\s+\*\s+as\s+[\w$]+\s+from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bexport\s+\*\s+from\s*["']([^"']+)["']/g)) {
      if (resolveSpec(file, m[1] ?? m[2] ?? m[3]) === mod) whole = true;
    }
    return { names, whole };
  };
  const files = ["app", "lib", "components", "tests"].flatMap((d) => walk(path.join(root, d), []));
  const sources = new Map(files.map((f) => [rel(f), { file: f, src: fs.readFileSync(f, "utf8") }]));
  const takesOld = (f: string) => {
    const t = takes(sources.get(f)!.file, sources.get(f)!.src, OLD);
    return t.whole || t.names.includes("pathProgress");
  };
  const takesNew = (f: string) => {
    const t = takes(sources.get(f)!.file, sources.get(f)!.src, NEW);
    return t.whole || t.names.includes("pathProgress");
  };
  const product = [...sources.keys()].filter((f) => /^(app|lib|components)\//.test(f));
  eq("its importers under app/, lib/ and components/ are exactly the dated list",
    product.filter(takesOld).sort(), [...OLD_PATH_PROGRESS_IMPORTERS.files].sort());
  eq("the dated list holds at most the three files of ruling A5 and no duplicate",
    [OLD_PATH_PROGRESS_IMPORTERS.files.length <= 3, new Set(OLD_PATH_PROGRESS_IMPORTERS.files).size === OLD_PATH_PROGRESS_IMPORTERS.files.length], [true, true]);
  // this file is left out: its control below holds import lines as strings
  eq("no file under app/, lib/, components/ or tests/ imports both pathProgress functions",
    [...sources.keys()].filter((f) => f !== "tests/unit/path-progress.test.ts" && takesOld(f) && takesNew(f)), []);
  const old = sources.get("lib/courses/progress-view.ts")?.src ?? "";
  eq("the old function is marked @deprecated with a pointer to step 43, in the comment right above it",
    /\/\*\*(?:(?!\*\/)[\s\S])*@deprecated ADR 0024 step 43(?:(?!\*\/)[\s\S])*\*\/\s*export function pathProgress\(/.test(old), true);
  // The control: the scan reads an import that spans several lines (the
  // Analytics page's), an alias, a type-only list, a relative path, a
  // namespace import and a dynamic import, and skips a package and a comment.
  const probe = (src: string, at = "app/x/page.tsx") => {
    const t = takes(path.join(root, at), src, OLD);
    return t.whole || t.names.includes("pathProgress");
  };
  eq("control: the scan finds every import form and skips what is not one",
    [
      probe('import {\n  courseProgress,\n  pathProgress,\n  type CourseProgressView,\n} from "@/lib/courses/progress-view";'),
      probe('import { pathProgress as pp } from "@/lib/courses/progress-view";'),
      probe('import { pathProgress } from "../courses/progress-view";', "lib/paths/x.ts"),
      probe('import * as pv from "@/lib/courses/progress-view";'),
      probe('const m = await import("@/lib/courses/progress-view");'),
      probe('import { courseProgress } from "@/lib/courses/progress-view";'),
      probe('import { pathProgress } from "@/lib/paths/progress";'),
      probe('// import { pathProgress } from "@/lib/courses/progress-view";'),
      probe('import { pathProgress } from "progress-view";'),
    ],
    [true, true, true, true, true, false, false, false, false]);
}

// The fact rows are a required input with no default (O1-i): leaving them out
// is a type error, so no caller judges every step by today's rule by accident.
// Checked by tsc (npm run typecheck covers tests/unit); never called.
export function _factsAreRequired(): void {
  // @ts-expect-error facts is required
  pathProgress({ pathId: PATH, steps: ONE, attempts: [], grants: [], completion: null, terms: { due_at: null, enrolled_at: null }, now: NOW });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
