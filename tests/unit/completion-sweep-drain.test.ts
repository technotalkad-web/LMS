/**
 * Unit test for lib/ops/completion-sweep.ts (ADR 0024 step 16, the note of
 * 2026-11-16, items 4 to 6, step S5): the drain of the completion sweep that
 * both cron routes run before their refresh, and the error rule they share.
 * A real supabase-js client runs under a stubbed fetch, so the real POSTs
 * and the real error objects are what is read.
 *
 *   - the drain stops at 'done' and at 'busy', neither an error; it continues
 *     on 'time' and 'limit' up to maxCalls;
 *   - PGRST202 on the first call reads no drain and no error, and red when
 *     the refresh answer's `sweep` carries `stopped` ("drain function not
 *     visible");
 *   - any other error, 57014 included, a thrown fetch and an answer of
 *     another shape stop the drain and read red;
 *   - the stall rule (D-S4): one stalled call is followed by the next call
 *     and is not red; two in a row stop the drain, red with STALL_READS_RED
 *     and green without it; a call that handled a row resets the count; a
 *     stall on the last call is reported in `stalled` and is not red; 0
 *     handled with 0 failed, and 'busy', are never a stall;
 *   - rows in `failed` beside handled rows are not an error;
 *   - each call is one POST of (200, 5000) to the timed function; the
 *     summary carries counts and one word, never an id;
 *   - the refresh entry's own error (completionSweepError) as before, and
 *     the order of the reasons.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/completion-sweep-drain.test.ts   (or npm run test:unit)
 */
import { createClient } from "@supabase/supabase-js";
import {
  DRAIN_BUDGET_MS,
  DRAIN_FUNCTION,
  DRAIN_LIMIT,
  GAMIFICATION_DRAIN_MAX_CALLS,
  REPORT_DRAIN_MAX_CALLS,
  STALL_READS_RED,
  completionSweepError,
  completionSweepFailure,
  drainCompletionSweep,
  isStalled,
  refreshSweepIsTimed,
} from "../../lib/ops/completion-sweep";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const SUPABASE = "http://stub.supabase.test";
type Answer =
  | { body: Record<string, unknown> }
  | { error: { code: string; message: string }; status: number }
  | { throws: string };
type Req = { method: string; path: string; body: string };
let script: Answer[] = [];
let requests: Req[] = [];
const unmatched: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  requests.push({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : "" });
  if (url.pathname === `/rest/v1/rpc/${DRAIN_FUNCTION}`) {
    const a = script.shift();
    if (!a) {
      unmatched.push("a drain call beyond the script");
      return json({ code: "XX000", message: "unscripted" }, 500);
    }
    if ("throws" in a) throw new TypeError(a.throws);
    return "error" in a ? json(a.error, a.status) : json(a.body);
  }
  unmatched.push(`${method} ${url.pathname}`);
  return json([]);
};

/** A call's answer, as 0112's timed sweep writes it (attempt ids in errors, which the summary drops). */
const ans = (stopped: string, handled: number, failed = 0): Answer => ({
  body: {
    candidates: handled + failed,
    handled,
    failed,
    errors: Array.from({ length: Math.min(failed, 5) }, (_, i) => ({ attempt_id: `00000000-0000-4000-8000-00000000000${i}`, sqlstate: "55P03" })),
    stopped,
    ms: stopped === "time" ? 5003 : 120,
  },
});
const NO_FN: Answer = { error: { code: "PGRST202", message: "Could not find the function public.sweep_completion_side_effects_timed(p_budget_ms, p_limit) in the schema cache" }, status: 404 };
const TIMEOUT: Answer = { error: { code: "57014", message: "canceling statement due to statement timeout" }, status: 500 };

/** A refresh answer: 0107's entry (four-key sweep), 0112's (six keys), or none. */
const refresh = (kind: "0107" | "0112" | "none", entryError: string | null = null) => {
  const views = [{ view: "mv_leaderboard", ms: 5, rows: 3, error: null }];
  if (kind === "none") return views;
  const sweep = kind === "0107"
    ? { candidates: 0, handled: 0, failed: 0, errors: [] }
    : { candidates: 0, handled: 0, failed: 0, errors: [], stopped: "done", ms: 1 };
  return [...views, { view: "completion_sweep", ms: 1, rows: entryError ? null : 0, error: entryError, sweep: entryError ? null : sweep }];
};

async function main() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const svc = createClient(SUPABASE, "stub-service-key", { auth: { persistSession: false } });
  const drain = async (answers: Answer[], maxCalls = GAMIFICATION_DRAIN_MAX_CALLS) => {
    script = [...answers];
    requests = [];
    const run = await drainCompletionSweep(svc, maxCalls);
    return { run, d: run.drain, left: script.length };
  };
  try {
    console.log("\nthe constants");
    eq("the gamification route makes at most 4 calls, the report route 8", [GAMIFICATION_DRAIN_MAX_CALLS, REPORT_DRAIN_MAX_CALLS], [4, 8]);
    eq("each call: 200 rows, a 5000 ms box, the timed function", [DRAIN_LIMIT, DRAIN_BUDGET_MS, DRAIN_FUNCTION], [200, 5000, "sweep_completion_side_effects_timed"]);
    eq("D-S4 built as recommended (yes), behind one switch", STALL_READS_RED, true);

    console.log("\nstops at 'done' and 'busy', neither an error");
    {
      const { run, d, left } = await drain([ans("done", 7), ans("done", 0)]);
      eq("'done' on the first call: one call, its counts, stopped done", [d.calls, d.candidates, d.handled, d.failed, d.stalled, d.stopped, left], [1, 7, 7, 0, 0, "done", 1]);
      eq("…not an error, with 0112's refresh answer", [run.error, completionSweepFailure(run, refresh("0112"))], [null, null]);
      eq("each call is one POST of p_limit 200 and p_budget_ms 5000 to the timed function",
        requests.map((r) => [r.method, r.path, JSON.parse(r.body)]),
        [["POST", `/rest/v1/rpc/${DRAIN_FUNCTION}`, { p_limit: 200, p_budget_ms: 5000 }]]);
      eq("the summary: counts and one word, no ids", [Object.keys(d).sort(), JSON.stringify(d).includes("attempt_id"), typeof d.ms], [["calls", "candidates", "failed", "handled", "ms", "stalled", "stopped"], false, "number"]);
    }
    {
      const { run, d, left } = await drain([ans("time", 50), ans("busy", 0), ans("done", 3)]);
      eq("'busy' after a 'time': two calls, stopped busy", [d.calls, d.handled, d.stopped, left], [2, 50, "busy", 1]);
      eq("…not an error and not a stall", [completionSweepFailure(run, refresh("0112")), d.stalled], [null, 0]);
    }
    {
      const { run, d } = await drain([ans("busy", 0)]);
      eq("'busy' on the first call with 0 handled: one call, not an error", [d.calls, d.stopped, completionSweepFailure(run, refresh("0112"))], [1, "busy", null]);
    }

    console.log("\ncontinues on 'time' and 'limit' up to maxCalls");
    {
      const { run, d, left } = await drain([ans("time", 60), ans("limit", 200), ans("time", 55), ans("time", 52), ans("done", 1)]);
      eq("four calls (the gamification route's maxCalls), the fifth never made", [d.calls, left, requests.length], [4, 1, 4]);
      eq("the sums, and the last call's word", [d.candidates, d.handled, d.failed, d.stopped], [367, 367, 0, "time"]);
      eq("…green", completionSweepFailure(run, refresh("0112")), null);
    }
    {
      const answers = Array.from({ length: 9 }, () => ans("limit", 200));
      const { d, left } = await drain(answers, REPORT_DRAIN_MAX_CALLS);
      eq("the report route's maxCalls: eight calls, stopped limit", [d.calls, d.handled, d.stopped, left], [8, 1600, "limit", 1]);
    }

    console.log("\nPGRST202: no drain, green, unless the refresh answer carries 0112's sweep");
    {
      const { run, d, left } = await drain([NO_FN, ans("done", 1)]);
      eq("one call, stopped absent, no error", [d.calls, d.stopped, run.error, left], [1, "absent", null, 1]);
      eq("…green with 0107's refresh answer (production between 0107 and 0112, staging before S3)", completionSweepFailure(run, refresh("0107")), null);
      eq("…green with an answer without the entry (a database without 0107: production today)", completionSweepFailure(run, refresh("none")), null);
      eq("…green with a non-array answer", completionSweepFailure(run, { mv_leaderboard: "refreshed" }), null);
      eq("…red when the refresh's sweep carries stopped: 0112 is there, the Data API does not see its function",
        completionSweepFailure(run, refresh("0112")), "drain function not visible");
      eq("refreshSweepIsTimed reads stopped in the entry's sweep only", [refreshSweepIsTimed(refresh("0112")), refreshSweepIsTimed(refresh("0107")), refreshSweepIsTimed(refresh("none")), refreshSweepIsTimed(refresh("0112", "boom"))], [true, false, false, false]);
    }

    console.log("\nany other error stops the drain and reads red");
    {
      const { run, d, left } = await drain([TIMEOUT, ans("done", 1)]);
      eq("57014: one call, stopped error, its message", [d.calls, d.stopped, run.error, left], [1, "error", "canceling statement due to statement timeout", 1]);
      eq("…red, whatever the refresh answered", [completionSweepFailure(run, refresh("0112")), completionSweepFailure(run, refresh("none"))],
        ["canceling statement due to statement timeout", "canceling statement due to statement timeout"]);
    }
    {
      const { run, d } = await drain([ans("time", 40), { error: { code: "42501", message: "permission denied for function sweep_completion_side_effects_timed" }, status: 403 }]);
      eq("an error on the second call: two calls, the first's counts kept, red", [d.calls, d.handled, d.stopped, completionSweepFailure(run, refresh("0112"))],
        [2, 40, "error", "permission denied for function sweep_completion_side_effects_timed"]);
    }
    {
      const { run, d } = await drain([{ throws: "fetch failed" }]);
      eq("a fetch that throws: stopped error, red", [d.calls, d.stopped, typeof run.error === "string" && run.error.length > 0, completionSweepFailure(run, refresh("0112")) !== null], [1, "error", true, true]);
    }
    {
      const { run, d } = await drain([{ body: { candidates: 1, handled: 1, failed: 0, errors: [] } }]);
      eq("an answer without stopped (not 0112's shape): stopped error, red", [d.stopped, completionSweepFailure(run, refresh("0112"))], ["error", "sweep_completion_side_effects_timed answered an unexpected shape"]);
    }

    console.log("\nthe stall rule (D-S4)");
    eq("isStalled: 0 handled, failed, time or limit", [isStalled({ handled: 0, failed: 5, stopped: "time" }), isStalled({ handled: 0, failed: 1, stopped: "limit" })], [true, true]);
    eq("…never with a handled row, with 0 failed, on done or on busy",
      [isStalled({ handled: 1, failed: 5, stopped: "time" }), isStalled({ handled: 0, failed: 0, stopped: "time" }), isStalled({ handled: 0, failed: 5, stopped: "done" }), isStalled({ handled: 0, failed: 0, stopped: "busy" })],
      [false, false, false, false]);
    {
      const { run, d, left } = await drain([ans("time", 0, 5), ans("time", 30), ans("done", 2)]);
      eq("one stalled call is followed by the next call", [d.calls, d.stalled, d.stopped, left], [3, 1, "done", 0]);
      eq("…and is not red", completionSweepFailure(run, refresh("0112")), null);
    }
    {
      const { run, d, left } = await drain([ans("time", 0, 5), ans("time", 0, 4), ans("done", 9)]);
      eq("two stalled calls in a row stop the drain", [d.calls, d.stalled, d.stopped, d.failed, left], [2, 2, "stalled", 9, 1]);
      eq("…red with STALL_READS_RED: the failed rows of the two calls", completionSweepFailure(run, refresh("0112"), true), "stalled (9 failed, 0 handled, 2 calls)");
      eq("…green without it (the owner's no), still stopped and reported", [completionSweepFailure(run, refresh("0112"), false), d.stopped], [null, "stalled"]);
      eq("…the default reads the switch", completionSweepFailure(run, refresh("0112")), STALL_READS_RED ? "stalled (9 failed, 0 handled, 2 calls)" : null);
    }
    {
      const { d } = await drain([ans("limit", 0, 200), ans("time", 0, 3)]);
      eq("a 'limit' stall then a 'time' stall: two in a row", [d.calls, d.stopped], [2, "stalled"]);
    }
    {
      const { run, d, left } = await drain([ans("time", 0, 5), ans("time", 1, 4), ans("time", 0, 5), ans("time", 20)]);
      eq("a stalled call, then a call that handled a row, then a stalled call: the count resets", [d.calls, d.stalled, d.stopped, left], [4, 2, "time", 0]);
      eq("…not red", completionSweepFailure(run, refresh("0112")), null);
    }
    {
      const { run, d } = await drain([ans("time", 10), ans("time", 10), ans("time", 10), ans("time", 0, 5)]);
      eq("a stall on the last call: reported in stalled, the run ends on its word", [d.calls, d.stalled, d.stopped], [4, 1, "time"]);
      eq("…not red (the next run decides)", completionSweepFailure(run, refresh("0112")), null);
    }
    {
      const { run, d } = await drain([ans("time", 0, 0), ans("time", 0, 0), ans("done", 0, 0)]);
      eq("0 handled with 0 failed is never a stall", [d.calls, d.stalled, d.stopped, completionSweepFailure(run, refresh("0112"))], [3, 0, "done", null]);
    }

    console.log("\nfailed rows beside handled rows are not an error");
    {
      const { run, d } = await drain([ans("time", 40, 3), ans("done", 10, 2)]);
      eq("two calls, the failed rows counted, green", [d.calls, d.handled, d.failed, d.stalled, completionSweepFailure(run, refresh("0112"))], [2, 50, 5, 0, null]);
    }

    console.log("\nthe refresh entry's own error, and the order of the reasons");
    {
      const { run } = await drain([ans("done", 1)]);
      eq("completionSweepError: the entry's error, or null", [completionSweepError(refresh("0112", "boom")), completionSweepError(refresh("0112")), completionSweepError(refresh("none")), completionSweepError({ a: 1 })], ["boom", null, null, null]);
      eq("the entry's own error reads red after a good drain", completionSweepFailure(run, refresh("0112", "boom")), "boom");
      eq("a view entry's error is not the sweep's", completionSweepFailure(run, [{ view: "mv_leaderboard", ms: 1, rows: null, error: "could not refresh" }, ...refresh("0112").slice(1)]), null);
    }
    {
      const { run } = await drain([TIMEOUT]);
      eq("a drain error is named before the entry's own error", completionSweepFailure(run, refresh("0112", "boom")), "canceling statement due to statement timeout");
    }
    {
      const { run } = await drain([NO_FN]);
      eq("the entry's own error is named before 'not visible'", completionSweepFailure(run, [...refresh("0112").slice(0, 1), { view: "completion_sweep", ms: 1, rows: null, error: "boom", sweep: { stopped: "time" } }]), "boom");
    }
    {
      const { d } = await drain([ans("done", 1)], 0);
      eq("maxCalls below 1 still makes one call", d.calls, 1);
    }
    eq("every request was one the stub knows", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
