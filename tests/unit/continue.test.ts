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
 * role skips the wait), and the wait's attempts read drops Previews. The real
 * page runs at the end under a stubbed fetch (the precedent of
 * attempt-page-official-sentence.test.ts; next/headers stubbed through
 * Module._load, redirect() caught by its digest, the one-second sleeps made
 * immediate): an admin with a completed Preview beside an in-progress real
 * attempt waits the whole bound and lands on the saving banner, the same
 * rows read for a learner do too, a completed real attempt moves on at the
 * first read, and a database without 0107 reads today's rows after one
 * failed read.
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
    return { reads: taken, target: continueTarget({ orgSlug: "acme", pathId: "p1", timedOut: !isStored, stored: isStored, done: isDone, next }) };
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
  const base: ContinueInput = { orgSlug: "acme", pathId: "p1", timedOut: false, stored: false, done: false, next: "c2" };
  const t = (o: Partial<ContinueInput>) => continueTarget({ ...base, ...o });
  eq("1. timed out → the saving banner", t({ timedOut: true }), "/acme/paths/p1?saving=1");
  eq("1. timed out on the last step → the saving banner", t({ timedOut: true, next: null }), "/acme/paths/p1?saving=1");
  eq("2. stored and not done → the failed banner, even with a next step", t({ stored: true, done: false }), "/acme/paths/p1?failed=1");
  eq("2. stored and not done on the last step → the failed banner", t({ stored: true, done: false, next: null }), "/acme/paths/p1?failed=1");
  eq("3. stored and done with a next step → the next launch", t({ stored: true, done: true }), "/acme/courses/c2/launch?lp=p1");
  eq("3. stored and done without a next step → the end banner", t({ stored: true, done: true, next: null }), "/acme/paths/p1?end=1");
  eq("4. not timed out, nothing stored → the path page", t({}), "/acme/paths/p1");
  eq("no input skips the wait: ContinueInput has no staff field (ADR 0024 step 23)", Object.keys(base).sort(), ["done", "next", "orgSlug", "pathId", "stored", "timedOut"]);
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

/* ---------------- the real page under a stubbed fetch (ADR 0024 P2-5 items 4 and 5b) ---------------- */
type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: URLSearchParams };
const SUPABASE = "http://stub.supabase.test";
const USER = { id: "u1", aud: "authenticated", role: "authenticated", email: "staff@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const PATH = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "33333333-3333-4333-8333-333333333333";
const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_kind does not exist" };

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

type World = { role: string; attempts: Row[]; no0107: boolean };
let world: World = { role: "admin", attempts: [], no0107: false };
let requests: Req[] = [];
const unmatched: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const filtersPreviews = (q: URLSearchParams) => q.get("context_kind") === "neq.preview";

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  requests.push({ method, path: p, select, query: url.searchParams });
  if (p === "/auth/v1/user") return json(USER);
  if (p === "/rest/v1/profiles") return json([{ must_change_password: false }]);
  if (p === "/rest/v1/organizations") return json([{ id: "o1", name: "Acme", slug: "acme", logo_url: null, brand_color: null, brand_font: null, custom_domain: null }]);
  if (p === "/rest/v1/organization_members") return json([{ role: world.role }]);
  if (p === "/rest/v1/learning_paths") return json([{ id: PATH, is_active: true }]);
  if (p === "/rest/v1/learning_path_courses") return json([{ course_id: C1, step_number: 1 }, { course_id: C2, step_number: 2 }]);
  if (p === "/rest/v1/courses") return json([{ pass_required: false }]);
  if (p === "/rest/v1/course_versions") return json([{ id: "v1" }]);
  if (p === "/rest/v1/attempt_requests") return json([]);
  if (p === "/rest/v1/rpc/effective_attempt_policies") return json([]);
  if (p === "/rest/v1/course_attempts") {
    // A database without 0107 answers the filter with 42703; one with it honours `neq.preview`.
    if (filtersPreviews(url.searchParams) && world.no0107) return json(NO_CONTEXT, 400);
    return json(world.attempts.filter((r) => !filtersPreviews(url.searchParams) || r.context_kind !== "preview"));
  }
  unmatched.push(`${method} ${p}`);
  return json([]);
};

const attempt = (id: string, o: Row = {}): Row => ({
  id, score: null, started_at: "2026-11-10T09:00:00Z", completed_at: null,
  completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: false, ...o,
});
/** A completed Preview, started BEFORE the real attempt: unfiltered, it would be the official attempt and read as stored. */
const COMPLETED_PREVIEW = attempt("pv", { context_kind: "preview", started_at: "2026-11-10T08:00:00Z", completed_at: "2026-11-10T08:20:00Z", completion_status: "completed", success_status: "passed", score: 1, status: "completed" });
const REAL_IN_PROGRESS = attempt("real", { context_kind: "path" });
const REAL_DONE = attempt("real", { context_kind: "path", completed_at: "2026-11-10T09:30:00Z", completion_status: "completed", success_status: "passed", score: 0.9, status: "completed" });

async function realPage() {
  console.log("\nthe real continue page under a stubbed fetch (ADR 0024 P2-5 items 4 and 5b)");
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
    const run = async (w: Partial<World>) => {
      world = { role: "admin", attempts: [], no0107: false, ...w };
      requests = [];
      logs = [];
      let target: string | null = null;
      try {
        await page({ params: Promise.resolve({ org: "acme" }), searchParams: Promise.resolve({ lp: PATH, from: C1 }) });
      } catch (e) {
        const digest = (e as { digest?: unknown }).digest;
        if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) throw e;
        target = digest.split(";").slice(2, -2).join(";");
      }
      const reads = requests.filter((q) => q.path === "/rest/v1/course_attempts");
      return {
        target,
        reads: reads.length,
        filtered: reads.map((q) => filtersPreviews(q.query)),
        events: logs.filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as Row).event),
      };
    };
    const SAVING = `/acme/paths/${PATH}?saving=1`;
    const NEXT = `/acme/courses/${C2}/launch?lp=${PATH}`;

    const admin = await run({ role: "admin", attempts: [COMPLETED_PREVIEW, REAL_IN_PROGRESS] });
    eq("an admin with a completed Preview beside an in-progress real attempt: no staff shortcut, the whole wait, then the saving banner",
      [admin.target, admin.reads, admin.events], [SAVING, 7, ["continue_timeout"]]);
    eq("…every read of the wait drops Previews", admin.filtered, Array(7).fill(true));
    for (const role of ["super_owner", "data_analyst", "user"]) {
      const r = await run({ role, attempts: [COMPLETED_PREVIEW, REAL_IN_PROGRESS] });
      eq(`…the same rows for ${role}: the same answer (the role decides nothing here)`, [r.target, r.reads], [SAVING, 7]);
    }
    const doneRun = await run({ role: "admin", attempts: [COMPLETED_PREVIEW, REAL_DONE] });
    eq("the admin's real attempt completed beside the Preview: the next launch at the first read", [doneRun.target, doneRun.reads], [NEXT, 1]);
    const noPreview = await run({ role: "admin", attempts: [REAL_IN_PROGRESS] });
    eq("an admin with only an in-progress real attempt waits like any learner", [noPreview.target, noPreview.reads], [SAVING, 7]);

    const old = await run({ role: "admin", no0107: true, attempts: [attempt("real", { completed_at: "2026-11-10T09:30:00Z", completion_status: "completed", success_status: "passed", score: 0.9, status: "completed" })] });
    eq("without 0107: the first read answers 42703 and is made once more without the filter; today's rows move on", [old.target, old.filtered], [NEXT, [true, false]]);
    const oldWait = await run({ role: "admin", no0107: true, attempts: [attempt("real")] });
    eq("…and one decision serves the whole wait: one failed read, then seven unfiltered reads", [oldWait.target, oldWait.filtered], [SAVING, [true, ...Array(7).fill(false)]]);
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
