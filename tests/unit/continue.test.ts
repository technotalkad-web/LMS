/**
 * Unit tests for lib/learner/continue.ts (ADR 0019 steps 1-3 and 10): the
 * next step, whether the official result is stored, whether a pass-required
 * course's verdict is still pending (verdictPending, the lead's ruling of
 * 2026-11-11), the page's wait mirrored over a sequence of reads, the branch
 * table of the continue target, the two officialDone readings the page feeds
 * it and the uuid check. Its wiring is checked by the source scans in
 * tests/unit/launch-bar-copy.test.ts.
 *
 * ADR 0024 step 23 and P2-5 items 4 and 5b: the staff branch is gone (no
 * role skips the wait). The real page runs at the end under a stubbed fetch
 * (the precedent of attempt-page-official-sentence.test.ts; next/headers
 * stubbed through Module._load, redirect() caught by its digest, the
 * one-second sleeps made immediate): an admin with a completed Preview
 * beside an in-progress real attempt waits the whole bound and lands on the
 * saving banner, the same rows read for a learner do too, a completed real
 * attempt moves on at the first read, and a database without 0107 reads
 * today's rows after one failed read at the first read of the wait (the
 * later reads reuse its decision and its grants: the P2-7 review, F5).
 *
 * ADR 0024 P2-7 (step 27 as build note O1-k makes it exact): the wait reads
 * through readContextResult in the path's context, and the step's done is
 * the path rule's answer (pathStepStatus) on the same rows with the step's
 * resolved rule and its stored fact: (a) a step done by its fact whose
 * granted retake failed goes to the next launch; (b) the same on the last
 * step to ?end=1; (c) the control, no fact and the rule never satisfied, to
 * ?failed=1; (d) a failed facts read never to ?failed=1; D14 (passed, then a
 * failed granted retake) to the next launch with no facts read. The owner's
 * P2-Q1 answer: a stored, done result whose next step's course is inactive
 * goes to the plain path page, a stored, failed one in the same position to
 * ?failed=1. O5-d: a `from` step whose course is inactive, and an inactive
 * path, for a completed and an in-progress learner. The P2-7 review, F1
 * (waitRead, cases (e) to (e7)): a step done by the path rule (its stored
 * fact, or an earlier pass) while its verdict is still pending ends the wait
 * and moves on; with no fact the verdict wait is as before. The page's
 * request counts are pinned at the end.
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
  waitRead,
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
import Module from "node:module";

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

  console.log("\nwaitRead: one read of the wait, classified (the P2-7 review, F1)");
  const classify = (rows: ScorableAttempt[], passRequired: boolean) => waitRead(computeScoring(rows, DEFAULT_POLICY, []), rows, passRequired);
  eq("nothing stored, stored, and stored with the verdict pending", [
    classify([row("a")], true), classify([done("a", "passed", 0.9)], true), classify([done("a", "failed", 0.4)], true),
    classify([done("a", "unknown", null)], true), classify([done("a", "unknown", null)], false),
  ], ["not_stored", "stored", "stored", "verdict_pending", "stored"]);

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
    return { reads: taken, target: continueTarget({ orgSlug: "acme", pathId: "p1", timedOut: !isStored, stored: isStored, done: isDone, next, nextHidden: false }) };
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
  const base: ContinueInput = { orgSlug: "acme", pathId: "p1", timedOut: false, stored: false, done: false, next: "c2", nextHidden: false };
  const t = (o: Partial<ContinueInput>) => continueTarget({ ...base, ...o });
  eq("1. timed out → the saving banner", t({ timedOut: true }), "/acme/paths/p1?saving=1");
  eq("1. timed out on the last step → the saving banner", t({ timedOut: true, next: null }), "/acme/paths/p1?saving=1");
  eq("2. stored and not done → the failed banner, even with a next step", t({ stored: true, done: false }), "/acme/paths/p1?failed=1");
  eq("2. stored and not done on the last step → the failed banner", t({ stored: true, done: false, next: null }), "/acme/paths/p1?failed=1");
  eq("3. stored and done with a next step → the next launch", t({ stored: true, done: true }), "/acme/courses/c2/launch?lp=p1");
  eq("3. stored and done without a next step → the end banner", t({ stored: true, done: true, next: null }), "/acme/paths/p1?end=1");
  eq("4. not timed out, nothing stored → the path page", t({}), "/acme/paths/p1");
  // ADR 0024 P2-7, the owner's P2-Q1 answer: the next step's course is inactive.
  eq("3. stored and done, the next step hidden → the plain path page (not the end banner, nothing skipped)", t({ stored: true, done: true, nextHidden: true }), "/acme/paths/p1");
  eq("2. stored and not done, the next step hidden → still the failed banner", t({ stored: true, done: false, nextHidden: true }), "/acme/paths/p1?failed=1");
  eq("1. timed out, the next step hidden → still the saving banner", t({ timedOut: true, nextHidden: true }), "/acme/paths/p1?saving=1");
  eq("no input skips the wait: ContinueInput has no staff field (ADR 0024 step 23); nextHidden is P2-Q1's (P2-7)", Object.keys(base).sort(), ["done", "next", "nextHidden", "orgSlug", "pathId", "stored", "timedOut"]);
}

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
eq("…0 (a signed-out check's unfollowed redirect, redirect: \"manual\") → null", parseStoredAnswer(0, null), null);

/* ---------------- the real page under a stubbed fetch (ADR 0024 P2-5 items 4 and 5b; P2-7) ---------------- */
type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: URLSearchParams };
const SUPABASE = "http://stub.supabase.test";
const USER = { id: "u1", aud: "authenticated", role: "authenticated", email: "staff@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const PATH = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "33333333-3333-4333-8333-333333333333";
const C3 = "44444444-4444-4444-8444-444444444444";
const KEY = `path:${PATH}`;
const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_kind does not exist" };
const NO_STEP_RULE = { code: "42703", message: "column learning_path_courses.pass_required does not exist" };
const NO_GRANT_KEY = { code: "42703", message: "column attempt_requests.context_key does not exist" };
const NO_FACTS = { code: "PGRST205", message: "Could not find the table 'public.learning_path_step_completions' in the schema cache" };
const BOOM = { code: "XX000", message: "the read failed" };

// The page's only cookie-bound imports (the server client and the impersonation cookie). Everything below them is the real code.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [{ name: "sb-stub-auth-token", value: SESSION }], get: () => undefined, set() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  return load.call(this, request, ...rest);
};

/** One step of the stub's path: its course, number, activity, own rule (0107) and course rule. */
type StepCfg = { course: string; n: number; active?: boolean; stepRule?: boolean | null; courseRule?: boolean };
type World = {
  role: string;
  /** The learner's rows on the `from` course, every context, as a database with 0107 holds them. */
  attempts: Row[];
  grants: Row[];
  facts: Row[];
  factsError: boolean;
  no0107: boolean;
  pathActive: boolean;
  steps: StepCfg[];
};
const STEPS: StepCfg[] = [{ course: C1, n: 1 }, { course: C2, n: 2 }];
const fresh = (): World => ({ role: "admin", attempts: [], grants: [], facts: [], factsError: false, no0107: false, pathActive: true, steps: STEPS });
let world: World = fresh();
let requests: Req[] = [];
const unmatched: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The read is in the path's context: readContextResult's key filter. */
const inContext = (q: URLSearchParams) => q.get("context_key") === `eq.${KEY}`;
const CONTEXT_FIELDS = ["context_kind", "context_key", "journey_day_id", "journey_version_id"];

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  requests.push({ method, path: p, select, query: url.searchParams });
  if (p === "/auth/v1/user") return json(USER);
  if (p === "/rest/v1/profiles") return json([{ must_change_password: false }]);
  if (p === "/rest/v1/organizations") return json([{ id: "o1", name: "Acme", slug: "acme", logo_url: null, brand_color: null, brand_font: null, custom_domain: null, deleted_at: null }]);
  if (p === "/rest/v1/organization_members") return json([{ role: world.role, status: "active" }]);
  if (p === "/rest/v1/learning_paths") return json([{ id: PATH, is_active: world.pathActive }]);
  if (p === "/rest/v1/learning_path_courses") {
    // The step's own rule is a 0107 column, named last after the embed.
    const stepRule = /,pass_required$/.test(select);
    if (stepRule && world.no0107) return json(NO_STEP_RULE, 400);
    return json(world.steps.map((s) => ({
      course_id: s.course,
      step_number: s.n,
      courses: { is_active: s.active !== false, pass_required: s.courseRule === true },
      ...(stepRule ? { pass_required: s.stepRule ?? null } : {}),
    })));
  }
  if (p === "/rest/v1/course_versions") return json([{ id: "v1" }]);
  if (p === "/rest/v1/course_attempts") {
    // A database without 0107 answers a read naming a context column with 42703.
    if (world.no0107 && (CONTEXT_FIELDS.some((c) => select.includes(c)) || url.searchParams.has("context_key"))) return json(NO_CONTEXT, 400);
    const rows = world.attempts.filter((r) => !inContext(url.searchParams) || r.context_key === KEY);
    return json(world.no0107 ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !CONTEXT_FIELDS.includes(k)))) : rows);
  }
  if (p === "/rest/v1/attempt_requests") {
    if (world.no0107 && select.includes("context_key")) return json(NO_GRANT_KEY, 400);
    return json(world.no0107 ? world.grants.map(({ context_key: _k, ...g }) => { void _k; return g; }) : world.grants);
  }
  if (p === "/rest/v1/learning_path_step_completions") {
    if (world.factsError) return json(BOOM, 500);
    if (world.no0107) return json(NO_FACTS, 404);
    return json(world.facts);
  }
  unmatched.push(`${method} ${p}`);
  return json([]);
};

const attempt = (id: string, o: Row = {}): Row => ({
  id, course_version_id: "v1", score: null, started_at: "2026-11-10T09:00:00Z", completed_at: null,
  completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: false,
  context_kind: "path", context_key: KEY, learning_path_id: PATH, journey_enrollment_id: null, journey_day: null, journey_day_id: null, journey_version_id: null, ...o,
});
const finished = (id: string, success: "passed" | "failed" | "unknown", score: number | null, o: Row = {}): Row =>
  attempt(id, { completed_at: "2026-11-10T09:30:00Z", completion_status: "completed", success_status: success, score, status: success === "unknown" ? "completed" : success, ...o });
/** A completed Preview, started BEFORE the real attempt: in one undivided read it would be the official attempt and read as stored. */
const COMPLETED_PREVIEW = finished("pv", "passed", 1, { context_kind: "preview", context_key: "preview", learning_path_id: null, started_at: "2026-11-10T08:00:00Z", completed_at: "2026-11-10T08:20:00Z" });
const REAL_IN_PROGRESS = attempt("real");
const REAL_DONE = finished("real", "passed", 0.9);
/** An approved grant whose retake is the row `used`, in the path's context. */
const grantFor = (used: string): Row => ({ id: "g1", used_attempt_id: used, used_at: "2026-11-11T10:00:00Z", expires_at: null, created_at: "2026-11-11T08:00:00Z", context_key: KEY });
const factOn = (course: string): Row => ({ path_id: PATH, course_id: course, done_at: "2026-11-10T10:00:00Z", rule_pass_required: false });

async function realPage() {
  console.log("\nthe real continue page under a stubbed fetch (ADR 0024 P2-5 items 4 and 5b; P2-7)");
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  const realWarn = console.warn;
  const realError = console.error;
  globalThis.fetch = stub as typeof fetch;
  // The wait's one-second sleeps, made immediate: the reads and their count are what is asserted.
  globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as unknown as typeof setTimeout;
  let logs: string[] = [];
  console.warn = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.error = () => {};
  try {
    const page = (await import("../../app/[org]/(learner)/continue/page")).default;
    const run = async (w: Partial<World>, from = C1) => {
      world = { ...fresh(), ...w };
      requests = [];
      logs = [];
      let target: string | null = null;
      try {
        await page({ params: Promise.resolve({ org: "acme" }), searchParams: Promise.resolve({ lp: PATH, from }) });
      } catch (e) {
        const digest = (e as { digest?: unknown }).digest;
        if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) throw e;
        target = digest.split(";").slice(2, -2).join(";");
      }
      const reads = requests.filter((q) => q.path === "/rest/v1/course_attempts");
      return {
        target,
        reads: reads.length,
        inContext: reads.map((q) => inContext(q.query)),
        factReads: requests.filter((q) => q.path === "/rest/v1/learning_path_step_completions").length,
        all: requests.length,
        events: logs.filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as Row).event),
      };
    };
    const PATH_PAGE = `/acme/paths/${PATH}`;
    const SAVING = `${PATH_PAGE}?saving=1`;
    const FAILED = `${PATH_PAGE}?failed=1`;
    const END = `${PATH_PAGE}?end=1`;
    const NEXT = `/acme/courses/${C2}/launch?lp=${PATH}`;

    console.log("\n…P2-5: no staff shortcut, and a Preview never reads as the stored result");
    const admin = await run({ role: "admin", attempts: [COMPLETED_PREVIEW, REAL_IN_PROGRESS] });
    eq("an admin with a completed Preview beside an in-progress real attempt: no staff shortcut, the whole wait, then the saving banner",
      [admin.target, admin.reads, admin.events], [SAVING, 7, ["continue_timeout"]]);
    eq("…every read of the wait is in the path's context (readContextResult), so the Preview is another context's row", admin.inContext, Array(7).fill(true));
    for (const role of ["super_owner", "data_analyst", "user"]) {
      const r = await run({ role, attempts: [COMPLETED_PREVIEW, REAL_IN_PROGRESS] });
      eq(`…the same rows for ${role}: the same answer (the role decides nothing here)`, [r.target, r.reads], [SAVING, 7]);
    }
    const doneRun = await run({ role: "admin", attempts: [COMPLETED_PREVIEW, REAL_DONE] });
    eq("the admin's real attempt completed beside the Preview: the next launch at the first read, with no facts read (done by the rule)",
      [doneRun.target, doneRun.reads, doneRun.factReads], [NEXT, 1, 0]);
    const noPreview = await run({ role: "admin", attempts: [REAL_IN_PROGRESS] });
    eq("an admin with only an in-progress real attempt waits like any learner", [noPreview.target, noPreview.reads], [SAVING, 7]);
    const individual = await run({ attempts: [finished("lib", "passed", 0.9, { context_kind: "individual", context_key: "individual", learning_path_id: null })] });
    eq("a completed Individual attempt of the course never answers for the path step: the saving banner", individual.target, SAVING);

    console.log("\n…without 0107 (readContextResult's own fallback: today's undivided read)");
    const old = await run({ no0107: true, attempts: [REAL_DONE] });
    eq("the first attempts read answers 42703 and is made once more without the context; today's rows move on", [old.target, old.inContext], [NEXT, [true, false]]);
    const oldWait = await run({ no0107: true, attempts: [REAL_IN_PROGRESS] });
    eq("…only the first read of the wait makes its failed read; the later six reuse its decision (the P2-7 review, F5), then the saving banner",
      [oldWait.target, oldWait.inContext], [SAVING, [true, false, ...Array(6).fill(false)]]);
    eq("…and its grants: one grants read in the whole wait", requests.filter((q) => q.path === "/rest/v1/attempt_requests").length, 1);
    const oldRule = await run({ no0107: true, steps: [{ course: C1, n: 1, courseRule: true }, { course: C2, n: 2 }], attempts: [finished("real", "failed", 0.4)] });
    eq("…the step read falls back without the step's own rule, and the course's rule decides (a failed result on a pass-required course)", [oldRule.target, oldRule.factReads], [FAILED, 1]);
    const oldVerdict = await run({ no0107: true, steps: [{ course: C1, n: 1, courseRule: true }, { course: C2, n: 2 }], attempts: [finished("real", "unknown", null)] });
    eq("…a verdict that never comes on a pass-required course: the facts read once (no table: no fact), the whole wait (8 attempts reads, the first failed), the saving banner",
      [oldVerdict.target, oldVerdict.reads, oldVerdict.factReads], [SAVING, 8, 1]);

    console.log("\n…O1-k: the step's done is the path rule's answer (cases (a) to (d))");
    // Step 1 is pass-required by its own rule (a 0107 column) over a course without one; the learner
    // completed it without a pass while no pass was required, so a fact holds it; a granted retake then failed.
    const tightened: StepCfg[] = [{ course: C1, n: 1, stepRule: true }, { course: C2, n: 2 }];
    const factRows = [finished("a1", "unknown", 0.7), finished("a2", "failed", 0.4, { started_at: "2026-11-11T09:00:00Z", completed_at: "2026-11-11T09:30:00Z" })];
    const a = await run({ steps: tightened, attempts: factRows, grants: [grantFor("a2")], facts: [factOn(C1)] });
    eq("(a) a step done by its fact whose granted retake failed goes to the next launch; the fact is read once, after the stored result",
      [a.target, a.reads, a.factReads], [NEXT, 1, 1]);
    const b = await run({ steps: [{ course: C1, n: 1 }, { course: C2, n: 2, stepRule: true }], attempts: factRows, grants: [grantFor("a2")], facts: [factOn(C2)] }, C2);
    eq("(b) the same on the last step goes to ?end=1", [b.target, b.factReads], [END, 1]);
    const c = await run({ steps: tightened, attempts: factRows, grants: [grantFor("a2")], facts: [] });
    eq("(c) the control, no fact and the rule never satisfied: ?failed=1", [c.target, c.factReads, c.events], [FAILED, 1, ["continue_not_done"]]);
    const d = await run({ steps: tightened, attempts: factRows, grants: [grantFor("a2")], factsError: true });
    eq("(d) a failed facts read takes the read-error exit, never ?failed=1", [d.target, d.events], [SAVING, ["continue_read_error"]]);
    const otherFact = await run({ steps: tightened, attempts: factRows, grants: [grantFor("a2")], facts: [factOn(C2)] });
    eq("…a fact of another step does not count for this one", otherFact.target, FAILED);
    const d14 = await run({
      steps: tightened,
      attempts: [finished("a1", "passed", 0.9), finished("a2", "failed", 0.4, { started_at: "2026-11-11T09:00:00Z", completed_at: "2026-11-11T09:30:00Z" })],
      grants: [grantFor("a2")],
    });
    eq("D14: passed earlier, then a failed granted retake: the next launch, with no facts read (done by the rule on the same rows)",
      [d14.target, d14.factReads], [NEXT, 0]);
    const live = await run({ steps: tightened, attempts: [finished("a1", "passed", 0.9), attempt("a2", { started_at: "2026-11-11T09:00:00Z" })], grants: [grantFor("a2")] });
    eq("…while that retake is live the result is not stored: the saving banner", [live.target, live.reads], [SAVING, 7]);
    const verdict = await run({ steps: tightened, attempts: [finished("a1", "unknown", null)] });
    eq("the step's own rule decides the verdict wait: completed without a verdict on a pass-required step waits the bound; its fact read once finds none",
      [verdict.target, verdict.reads, verdict.factReads], [SAVING, 7, 1]);

    console.log("\n…the P2-7 review, F1: a step done by the path rule while its verdict is pending ends the wait");
    // One official row, completed with no pass or fail (SCORM 1.2 "completed", a cmi5 AU that sends
    // only completed); the step was done under a rule that needed no pass, its fact was recorded, and
    // then its rule was tightened.
    const onlyCompleted = [finished("a1", "unknown", null)];
    const f1 = await run({ steps: tightened, attempts: onlyCompleted, facts: [factOn(C1)] });
    eq("(e) the step's own rule tightened after it was done: the next launch after one read, the fact read once",
      [f1.target, f1.reads, f1.factReads, f1.events], [NEXT, 1, 1, []]);
    const f1Course = await run({ steps: [{ course: C1, n: 1, courseRule: true }, { course: C2, n: 2 }], attempts: onlyCompleted, facts: [factOn(C1)] });
    eq("(e2) the course's rule tightened (the step has none of its own): the same", [f1Course.target, f1Course.reads, f1Course.factReads], [NEXT, 1, 1]);
    const f1Last = await run({ steps: [{ course: C1, n: 1 }, { course: C2, n: 2, stepRule: true }], attempts: onlyCompleted, facts: [factOn(C2)] }, C2);
    eq("(e3) the same on the last step: ?end=1", [f1Last.target, f1Last.reads], [END, 1]);
    const f1Other = await run({ steps: tightened, attempts: onlyCompleted, facts: [factOn(C2)] });
    eq("(e4) the control, a fact of another step only: the whole wait, the fact read once, then the saving banner",
      [f1Other.target, f1Other.reads, f1Other.factReads], [SAVING, 7, 1]);
    const f1Err = await run({ steps: tightened, attempts: onlyCompleted, factsError: true });
    eq("(e5) the facts read fails while the verdict is pending: the read-error exit at once", [f1Err.target, f1Err.reads, f1Err.events], [SAVING, 1, ["continue_read_error"]]);
    const f1d14 = await run({
      steps: tightened,
      attempts: [finished("a1", "passed", 0.9), finished("a2", "unknown", null, { started_at: "2026-11-11T09:00:00Z", completed_at: "2026-11-11T09:30:00Z" })],
      grants: [grantFor("a2")],
    });
    eq("(e6) D14, passed earlier and a granted retake completed with its verdict pending: the next launch after one read, no facts read",
      [f1d14.target, f1d14.reads, f1d14.factReads], [NEXT, 1, 0]);
    const f1Late = await run({ steps: tightened, attempts: onlyCompleted, facts: [] });
    eq("(e7) no fact: the verdict wait as before (the saving banner after the bound)", [f1Late.target, f1Late.reads], [SAVING, 7]);

    console.log("\n…P2-Q1 and O5-d: Continue never targets a hidden step or inactive content");
    const hiddenNext: StepCfg[] = [{ course: C1, n: 1 }, { course: C2, n: 2, active: false }, { course: C3, n: 3 }];
    const hn = await run({ steps: hiddenNext, attempts: [REAL_DONE] });
    eq("a stored, done result whose next step's course is inactive goes to the plain path page (not ?end=1, nothing skipped)", hn.target, PATH_PAGE);
    const hnFail = await run({ steps: [{ course: C1, n: 1, courseRule: true }, { course: C2, n: 2, active: false }], attempts: [finished("real", "failed", 0.4)] });
    eq("…a stored, failed result in the same position still goes to ?failed=1", hnFail.target, FAILED);
    const hnWait = await run({ steps: hiddenNext, attempts: [REAL_IN_PROGRESS] });
    eq("…and a wait that times out still goes to ?saving=1", hnWait.target, SAVING);
    for (const [who, rows] of [["a completed learner", [REAL_DONE]], ["an in-progress learner", [REAL_IN_PROGRESS]]] as Array<[string, Row[]]>) {
      const inactiveCourse = await run({ steps: [{ course: C1, n: 1, active: false }, { course: C2, n: 2 }], attempts: rows });
      eq(`O5-d, the step's course inactive, ${who}: the plain path page at once, no attempts read`,
        [inactiveCourse.target, inactiveCourse.reads, inactiveCourse.events], [PATH_PAGE, 0, ["continue_inactive"]]);
      const inactivePath = await run({ pathActive: false, attempts: rows });
      eq(`O5-d, the path inactive, ${who}: the dashboard, no step or attempts read`,
        [inactivePath.target, inactivePath.reads, requests.some((q) => q.path === "/rest/v1/learning_path_courses")], ["/acme/dashboard", 0, false]);
    }

    console.log("\n…the request count of one Continue, in the page (requireOrgAccess included; no layout, no middleware)");
    // requireOrgAccess 4, the path 1, the steps 1, the versions 1, then the first read of the wait
    // (the attempts and the grants, readContextResult), each later read the attempts only (F5), and
    // the facts read when the rule alone does not decide, at most once.
    eq("with 0107: a result stored at the first read 9; a wait to the bound 15 (7 attempts reads, 1 grants read); a stored result that needs its fact read 10",
      [doneRun.all, admin.all, a.all], [9, 15, 10]);
    eq("…a verdict that never comes 16 (the fact read once); a step done by its fact while the verdict is pending 10",
      [verdict.all, f1.all], [16, 10]);
    // The step read and the first attempts read fall back once; the grants read follows that decision.
    eq("without 0107: a result stored at the first read 11; a wait to the bound 17 (one failed read, 7 attempts reads, 1 grants read); a verdict that never comes 18 (the facts read once)",
      [old.all, oldWait.all, oldVerdict.all], [11, 17, 18]);
    eq("the stub answered every request the page made", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
    console.warn = realWarn;
    console.error = realError;
  }
}

realPage()
  .catch((e) => {
    fail++;
    console.log(`  ✗ the real page threw: ${e instanceof Error ? e.stack : String(e)}`);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  });
