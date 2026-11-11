/**
 * Unit tests for lib/learner/continue.ts (ADR 0019 steps 1-3 and 10): the
 * next step, whether the official result is stored, whether a pass-required
 * course's verdict is still pending (verdictPending, the lead's ruling of
 * 2026-11-11), the page's wait mirrored over a sequence of reads, the branch
 * table of the continue target, the two officialDone readings the page feeds
 * it, the page's staff test (launchModeFor) and the uuid check. The page
 * itself cannot run in a unit test; its wiring is checked by the source scans
 * in tests/unit/launch-bar-copy.test.ts.
 *
 * ADR 0019, note of 2026-11-11 (Continue waits for the stored result):
 * officialResultStored, the one conclude test the continue address, the
 * launch page and the status route share, over every row mix and equal to
 * resultStored && !verdictPending on each; and lib/learner/continue-state.ts,
 * the bar's constants and pure decisions (continueState, shouldPoll over its
 * sixteen inputs, parseStoredAnswer).
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/continue.test.ts   (or npm run test:unit)
 */
import {
  CONTINUE_POLL_MS,
  CONTINUE_WAIT_MS,
  continueTarget,
  isUuid,
  nextStepAfter,
  officialResultStored,
  resultStored,
  verdictPending,
  type ContinueInput,
} from "../../lib/learner/continue";
import {
  CONTINUE_CHECK_DEBOUNCE_MS,
  CONTINUE_MESSAGE_MS,
  CONTINUE_STATUS_POLL_MS,
  CONTINUE_WAITING_MESSAGE,
  continueState,
  parseStoredAnswer,
  shouldPoll,
} from "../../lib/learner/continue-state";
import { computeScoring, DEFAULT_POLICY, officialDone, type ScorableAttempt } from "../../lib/scoring/policy";
import { launchModeFor } from "../../lib/alds/launch";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\nthe wait's bound (decision 2)");
eq("6 s in all, one read a second: reads at 0, 1, … 6 s, so at most seven", [CONTINUE_WAIT_MS, CONTINUE_POLL_MS, Math.floor(CONTINUE_WAIT_MS / CONTINUE_POLL_MS) + 1], [6000, 1000, 7]);

console.log("\nnextStepAfter");
{
  const steps = [
    { course_id: "c1", step_number: 1 },
    { course_id: "c2", step_number: 2 },
    { course_id: "c3", step_number: 3 },
  ];
  eq("a middle step → the next one", nextStepAfter(steps, "c2"), "c3");
  eq("the first step → the second", nextStepAfter(steps, "c1"), "c2");
  eq("the last step → null", nextStepAfter(steps, "c3"), null);
  eq("unsorted input → the smallest step_number above from's", nextStepAfter([steps[2], steps[0], steps[1]], "c1"), "c2");
  eq("from not a step → null, nothing thrown", nextStepAfter(steps, "cX"), null);
  eq("gaps in numbering → the next number that exists", nextStepAfter([{ course_id: "a", step_number: 10 }, { course_id: "b", step_number: 40 }, { course_id: "c", step_number: 25 }], "a"), "c");
  eq("an empty path → null", nextStepAfter([], "c1"), null);
}

console.log("\nresultStored over every row mix");
{
  const row = (id: string, o: Partial<ScorableAttempt> = {}): ScorableAttempt => ({
    id,
    score: null,
    started_at: "2026-11-10T09:00:00Z",
    completed_at: null,
    completion_status: "in_progress",
    success_status: "unknown",
    status: "in_progress",
    ...o,
  });
  const done = (id: string, success: string, score: number | null, at = "2026-11-10T09:30:00Z", o: Partial<ScorableAttempt> = {}) =>
    row(id, { completion_status: "completed", success_status: success, score, completed_at: at, status: "completed", ...o });
  const stored = (rows: ScorableAttempt[], retakes: string[] = []) => resultStored(computeScoring(rows, DEFAULT_POLICY, retakes), rows);

  eq("no rows → false", stored([]), false);
  eq("an in-progress row only → false", stored([row("a")]), false);
  eq("a completed official attempt → true", stored([done("a", "unknown", null)]), true);
  eq("a passed official attempt → true", stored([done("a", "passed", 0.9)]), true);
  eq("a failed official attempt → true (stored; done is officialDone's answer)", stored([done("a", "failed", 0.4)]), true);
  eq("a passed row with no completion_status (house completion rule) → true", stored([row("a", { success_status: "passed", score: 0.8, completed_at: "2026-11-10T09:30:00Z" })]), true);
  eq("abandoned rows only → false", stored([row("a", { status: "abandoned" }), done("b", "passed", 0.9, undefined, { status: "abandoned" })]), false);
  eq("a revision visit's row only (even completed) → false", stored([done("r", "passed", 1, undefined, { is_revision: true })]), false);
  eq("a revision visit's row beside a complete official attempt → true", stored([done("a", "passed", 0.9), row("r", { is_revision: true, started_at: "2026-11-10T10:00:00Z" })]), true);
  eq("a live granted retake beside a completed first attempt → false, through courseStatus", stored([done("a", "failed", 0.4), row("g", { started_at: "2026-11-10T11:00:00Z" })], ["g"]), false);
  eq("…once the granted retake completes → true", stored([done("a", "failed", 0.4), done("g", "passed", 0.8, "2026-11-10T11:30:00Z")], ["g"]), true);
  eq("a second, ungranted in-progress row beside a completed official attempt → true", stored([done("a", "passed", 0.9), row("b", { started_at: "2026-11-10T12:00:00Z" })]), true);

  console.log("\nthe two officialDone readings the page feeds continueTarget");
  const failed = [done("a", "failed", 0.4)];
  const s = computeScoring(failed, DEFAULT_POLICY, []);
  eq("a failed official on a pass_required course → done = false", officialDone(s, true), false);
  eq("a failed official on a course without pass_required → done = true", officialDone(s, false), true);
  const passed = computeScoring([done("a", "passed", 0.9)], DEFAULT_POLICY, []);
  eq("a passed official on a pass_required course → done = true", officialDone(passed, true), true);

  console.log("\nverdictPending: a pass-required course's result is not stored until its verdict is (ruling of 2026-11-11, option (a))");
  const pending = (rows: ScorableAttempt[], passRequired: boolean, retakes: string[] = []) => verdictPending(computeScoring(rows, DEFAULT_POLICY, retakes), passRequired);
  eq("a completed official without a verdict on a pass_required course → true", pending([done("a", "unknown", null)], true), true);
  eq("…the same row on a course without pass_required → false", pending([done("a", "unknown", null)], false), false);
  eq("a passed or a failed official on a pass_required course → false", [pending([done("a", "passed", 0.9)], true), pending([done("a", "failed", 0.4)], true)], [false, false]);
  eq("no official attempt (an in-progress row only) → false", pending([row("a")], true), false);
  eq("a completed granted retake without a verdict beside a failed first attempt → true (the retake is the official)", pending([done("a", "failed", 0.4), done("g", "unknown", null, "2026-11-10T11:30:00Z")], true, ["g"]), true);
  eq("a revision visit's completed row without a verdict beside a passed official → false", pending([done("a", "passed", 0.9), done("r", "unknown", null, "2026-11-10T10:30:00Z", { is_revision: true })], true), false);

  // The page's wait, mirrored over a sequence of reads (the page cannot run
  // here; launch-bar-copy.test.ts pins the page to this exact conclude test):
  // one snapshot of the learner's rows per read, at most seven reads, the last
  // snapshot repeated when fewer are given.
  const maxReads = Math.floor(CONTINUE_WAIT_MS / CONTINUE_POLL_MS) + 1;
  const wait = (reads: ScorableAttempt[][], passRequired: boolean, next: string | null = "c2") => {
    let isStored = false, isDone = false, taken = 0;
    for (let read = 0; read < maxReads; read++) {
      const rows = reads[Math.min(read, reads.length - 1)];
      taken = read + 1;
      const sc = computeScoring(rows, DEFAULT_POLICY, []);
      if (resultStored(sc, rows) && !verdictPending(sc, passRequired)) {
        isStored = true;
        isDone = officialDone(sc, passRequired);
        break;
      }
    }
    return { reads: taken, target: continueTarget({ orgSlug: "acme", pathId: "p1", isStaff: false, timedOut: !isStored, stored: isStored, done: isDone, next }) };
  };
  console.log("\nthe wait over a sequence of reads (the page's loop)");
  eq("pass_required: 'completed' on one read, 'passed' on the next → moves on at the second read",
    wait([[done("a", "unknown", null)], [done("a", "passed", 0.9)]], true), { reads: 2, target: "/acme/courses/c2/launch?lp=p1" });
  eq("pass_required: 'completed' with no verdict by the bound → seven reads, then the saving banner, never failed",
    wait([[done("a", "unknown", null)]], true), { reads: 7, target: "/acme/paths/p1?saving=1" });
  eq("…the same on the last step → the saving banner, not the end banner",
    wait([[done("a", "unknown", null)]], true, null), { reads: 7, target: "/acme/paths/p1?saving=1" });
  eq("pass_required: a real failed verdict on the first read → the failed banner at once",
    wait([[done("a", "failed", 0.4)]], true), { reads: 1, target: "/acme/paths/p1?failed=1" });
  eq("pass_required: 'completed' on one read, 'failed' on the next → the failed banner at the second read",
    wait([[done("a", "unknown", null)], [done("a", "failed", 0.4)]], true), { reads: 2, target: "/acme/paths/p1?failed=1" });
  eq("without pass_required: a completed row with no verdict → moves on at the first read",
    wait([[done("a", "unknown", null)]], false), { reads: 1, target: "/acme/courses/c2/launch?lp=p1" });
  eq("nothing stored by the bound (an in-progress row only) → the saving banner, as before",
    wait([[row("a")]], true), { reads: 7, target: "/acme/paths/p1?saving=1" });
}

console.log("\ncontinueTarget, in the order of step 3");
{
  const base: ContinueInput = { orgSlug: "acme", pathId: "p1", isStaff: false, timedOut: false, stored: false, done: false, next: "c2" };
  const t = (o: Partial<ContinueInput>) => continueTarget({ ...base, ...o });
  eq("1. staff with a next step → the next launch at once", t({ isStaff: true }), "/acme/courses/c2/launch?lp=p1");
  eq("1. staff on the last step → the end banner", t({ isStaff: true, next: null }), "/acme/paths/p1?end=1");
  eq("1. staff wins over every other input", t({ isStaff: true, timedOut: true, stored: true, done: false }), "/acme/courses/c2/launch?lp=p1");
  eq("2. timed out → the saving banner", t({ timedOut: true }), "/acme/paths/p1?saving=1");
  eq("2. timed out on the last step → the saving banner", t({ timedOut: true, next: null }), "/acme/paths/p1?saving=1");
  eq("3. stored and not done → the failed banner, even with a next step", t({ stored: true, done: false }), "/acme/paths/p1?failed=1");
  eq("3. stored and not done on the last step → the failed banner", t({ stored: true, done: false, next: null }), "/acme/paths/p1?failed=1");
  eq("4. stored and done with a next step → the next launch", t({ stored: true, done: true }), "/acme/courses/c2/launch?lp=p1");
  eq("4. stored and done without a next step → the end banner", t({ stored: true, done: true, next: null }), "/acme/paths/p1?end=1");
  eq("5. not staff, not timed out, nothing stored → the path page", t({}), "/acme/paths/p1");
}

console.log("\nthe page's staff test: launchModeFor's preview verdict (decision 3)");
eq("data_analyst is a preview → no wait", launchModeFor({ role: "data_analyst", revision: false }).isPreview, true);
eq("admin and super_owner are previews → no wait", [launchModeFor({ role: "admin", revision: false }).isPreview, launchModeFor({ role: "super_owner", revision: false }).isPreview], [true, true]);
eq("user is not → the wait", launchModeFor({ role: "user", revision: false }).isPreview, false);

console.log("\nisUuid");
eq("a lower-case uuid", isUuid("0f8fad5b-d9cb-469f-a165-70867728950e"), true);
eq("an upper-case uuid", isUuid("0F8FAD5B-D9CB-469F-A165-70867728950E"), true);
eq("refused: empty, undefined, an array, a short id, a path, a uuid with a suffix", [
  isUuid(""), isUuid(undefined), isUuid(["0f8fad5b-d9cb-469f-a165-70867728950e"]), isUuid("0f8fad5b"),
  isUuid("../dashboard"), isUuid("0f8fad5b-d9cb-469f-a165-70867728950e&x=1"),
], [false, false, false, false, false, false]);

console.log("\nofficialResultStored: the one conclude test (ADR 0019, note of 2026-11-11)");
{
  const row = (id: string, o: Partial<ScorableAttempt> = {}): ScorableAttempt => ({
    id,
    score: null,
    started_at: "2026-11-10T09:00:00Z",
    completed_at: null,
    completion_status: "in_progress",
    success_status: "unknown",
    status: "in_progress",
    ...o,
  });
  const done = (id: string, success: string, score: number | null, at = "2026-11-10T09:30:00Z", o: Partial<ScorableAttempt> = {}) =>
    row(id, { completion_status: "completed", success_status: success, score, completed_at: at, status: "completed", ...o });
  const ors = (rows: ScorableAttempt[], passRequired: boolean, retakes: string[] = []) =>
    officialResultStored(computeScoring(rows, DEFAULT_POLICY, retakes), rows, passRequired);

  eq("in progress → false", ors([row("a")], false), false);
  eq("completed, not pass_required → true", ors([done("a", "unknown", null)], false), true);
  eq("completed without a verdict, pass_required → false", ors([done("a", "unknown", null)], true), false);
  eq("passed, pass_required → true", ors([done("a", "passed", 0.9)], true), true);
  eq("failed, pass_required → true (stored, not done)", ors([done("a", "failed", 0.4)], true), true);
  eq("abandoned only → false", ors([row("a", { status: "abandoned" }), done("b", "passed", 0.9, undefined, { status: "abandoned" })], false), false);
  eq("a revision row only → false", ors([done("r", "passed", 1, undefined, { is_revision: true })], false), false);
  eq("a revision row beside a complete official attempt → true", ors([done("a", "passed", 0.9), row("r", { is_revision: true, started_at: "2026-11-10T10:00:00Z" })], true), true);
  eq("a live granted retake beside a completed first attempt → false", ors([done("a", "failed", 0.4), row("g", { started_at: "2026-11-10T11:00:00Z" })], false, ["g"]), false);
  eq("…the same on a pass_required course → false", ors([done("a", "failed", 0.4), row("g", { started_at: "2026-11-10T11:00:00Z" })], true, ["g"]), false);

  // Every mix, both settings: the one function equals the continue page's former two-call test.
  const MIXES: Array<[string, ScorableAttempt[], string[]]> = [
    ["none", [], []],
    ["in progress", [row("a")], []],
    ["completed", [done("a", "unknown", null)], []],
    ["passed", [done("a", "passed", 0.9)], []],
    ["failed", [done("a", "failed", 0.4)], []],
    ["abandoned", [row("a", { status: "abandoned" })], []],
    ["revision only", [done("r", "passed", 1, undefined, { is_revision: true })], []],
    ["revision beside official", [done("a", "passed", 0.9), row("r", { is_revision: true, started_at: "2026-11-10T10:00:00Z" })], []],
    ["live retake", [done("a", "failed", 0.4), row("g", { started_at: "2026-11-10T11:00:00Z" })], ["g"]],
    ["completed retake without a verdict", [done("a", "failed", 0.4), done("g", "unknown", null, "2026-11-10T11:30:00Z")], ["g"]],
    ["passed retake", [done("a", "failed", 0.4), done("g", "passed", 0.8, "2026-11-10T11:30:00Z")], ["g"]],
  ];
  const same = MIXES.flatMap(([name, rows, retakes]) =>
    [false, true].map((pr) => {
      const sc = computeScoring(rows, DEFAULT_POLICY, retakes);
      return officialResultStored(sc, rows, pr) === (resultStored(sc, rows) && !verdictPending(sc, pr)) ? null : `${name}/${pr}`;
    })
  ).filter((x) => x !== null);
  eq("equals resultStored(...) && !verdictPending(...) on every mix, both pass_required settings", same, []);
}

console.log("\nlib/learner/continue-state.ts: the bar's constants and decisions");
eq("the poll interval is 25 s; the message 3 s; the debounce 2 s", [CONTINUE_STATUS_POLL_MS, CONTINUE_MESSAGE_MS, CONTINUE_CHECK_DEBOUNCE_MS], [25_000, 3_000, 2_000]);
eq("the waiting message", CONTINUE_WAITING_MESSAGE, "Finish this module to continue");
eq("continueState: false → waiting, true → ready", [continueState(false), continueState(true)], ["waiting", "ready"]);
{
  const rows: string[] = [];
  for (const hasStatusHref of [false, true])
    for (const ready of [false, true])
      for (const visible of [false, true])
        for (const poll of [false, true]) {
          const got = shouldPoll({ hasStatusHref, ready, visible, poll });
          const want = hasStatusHref && !ready && visible && poll;
          if (got !== want) rows.push(JSON.stringify({ hasStatusHref, ready, visible, poll, got }));
        }
  eq("shouldPoll over its sixteen inputs: only a status address, waiting, visible and a polling runtime", rows, []);
  eq("…the one true case", shouldPoll({ hasStatusHref: true, ready: false, visible: true, poll: true }), true);
  eq("…never once ready, never hidden, never for SCORM, never off a path launch", [
    shouldPoll({ hasStatusHref: true, ready: true, visible: true, poll: true }),
    shouldPoll({ hasStatusHref: true, ready: false, visible: false, poll: true }),
    shouldPoll({ hasStatusHref: true, ready: false, visible: true, poll: false }),
    shouldPoll({ hasStatusHref: false, ready: false, visible: true, poll: true }),
  ], [false, false, false, false]);
}
eq("parseStoredAnswer: 200 {stored:true} → true; 200 {stored:false} → false", [parseStoredAnswer(200, { stored: true }), parseStoredAnswer(200, { stored: false })], [true, false]);
eq("…200 {} → null; 200 \"<html>\" → null (a followed redirect); 200 null → null; 200 [] → null; a string stored → null", [
  parseStoredAnswer(200, {}),
  parseStoredAnswer(200, "<html>"),
  parseStoredAnswer(200, null),
  parseStoredAnswer(200, []),
  parseStoredAnswer(200, { stored: "true" }),
], [null, null, null, null, null]);
eq("…302, 401, 404 and 503 → null, whatever the body", [302, 401, 404, 503].map((s) => parseStoredAnswer(s, { stored: true })), [null, null, null, null]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
