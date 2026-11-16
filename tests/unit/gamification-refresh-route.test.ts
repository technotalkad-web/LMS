/**
 * Unit test for the ADR 0024 note of 2026-11-14, ruling A4 ("The
 * gamification refresh route and the sweep's error"), as the note of
 * 2026-11-16 restates it (items 4 to 6, step S5), on the real route:
 * app/api/cron/gamification-refresh runs for real under a stubbed PostgREST
 * fetch (the form of refresh-report-views-route.test.ts), so the real answer,
 * status, heartbeat upsert and request count are what is asserted.
 *
 *   (i)   from 0107 refresh_gamification_views()'s answer ends with the
 *         sweep's entry, {view: "completion_sweep", ms, rows, error, sweep}
 *         (step 16): with its error null and a drain that answers 'done' the
 *         route answers 200, ok true, `views` the whole answer,
 *         `completion_sweep_drain` its summary, and the heartbeat reads "ok";
 *   (ii)  with the entry's error set the route answers 500, ok false, an
 *         `error` naming the sweep, `views` still the whole answer, and the
 *         heartbeat reads "error" with the whole body as its detail;
 *   (iii) everything else keeps today's behaviour: a view entry's error
 *         (200), rows that failed inside the sweep with the sweep's own error
 *         null (200: counted in sweep.failed and retried by the next run), an
 *         answer without the sweep's entry (a database without 0107: 200), a
 *         non-array answer (200), an RPC error (500, as today), a wrong or
 *         missing secret (401, no RPC, no heartbeat); GET is POST;
 *   (iv)  the held-webhook sweep (ADR 0015 step 5) runs in every case, after
 *         the refresh and before the heartbeat, stays in the body as
 *         `webhook_sweep`, and never decides `ok`;
 *   (v)   the drain (the note's items 4 and 5): it runs first, before the
 *         refresh and before total_ms's clock starts; 'done', 'busy', 'time'
 *         and 'limit' up to GAMIFICATION_DRAIN_MAX_CALLS, failed rows, and
 *         PGRST202 beside a refresh of 0107 read green; a drain error (57014
 *         included), PGRST202 beside a refresh whose sweep carries `stopped`,
 *         and two stalled calls in a row (D-S4) read red, and the refresh and
 *         the held-webhook sweep still run after a red drain; the route
 *         imports the helper and keeps no copy of the rule; the request
 *         count, measured, is held to 40.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/gamification-refresh-route.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GAMIFICATION_DRAIN_MAX_CALLS, STALL_READS_RED } from "../../lib/ops/completion-sweep";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const SUPABASE = "http://stub.supabase.test";
const SECRET = "stub-cron-secret";

type Req = { method: string; path: string; body: string };
let requests: Req[] = [];
/** What the stubbed refresh RPC answers next: a body (200) or an error (500). */
let answer: { body: unknown } | { error: { code: string; message: string } } = { body: [] };
/** Whether the held-webhook sweep's read fails (its own error, fail-isolated). */
let heldFails = false;
/** What the drain calls answer, in order; when the list runs out, 'done' with nothing. */
type DrainAnswer = { body: Record<string, unknown> } | { error: { code: string; message: string }; status: number };
let drainScript: DrainAnswer[] = [];
const unmatched: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const drainAnswer = (stopped: string, handled = 0, failed = 0): DrainAnswer => ({
  body: { candidates: handled + failed, handled, failed, errors: [], stopped, ms: stopped === "time" ? 5002 : 40 },
});
const DRAIN_ABSENT: DrainAnswer = { error: { code: "PGRST202", message: "Could not find the function public.sweep_completion_side_effects_timed(p_budget_ms, p_limit) in the schema cache" }, status: 404 };
const DRAIN_TIMEOUT: DrainAnswer = { error: { code: "57014", message: "canceling statement due to statement timeout" }, status: 500 };

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  requests.push({ method, path: url.pathname, body });
  if (url.pathname === "/rest/v1/rpc/sweep_completion_side_effects_timed" && method === "POST") {
    const a = drainScript.shift() ?? drainAnswer("done");
    return "error" in a ? json(a.error, a.status) : json(a.body);
  }
  if (url.pathname === "/rest/v1/rpc/refresh_gamification_views") {
    return "error" in answer ? json(answer.error, 500) : json(answer.body);
  }
  // the held-webhook sweep's page read: nothing held, or its own error
  if (url.pathname === "/rest/v1/course_attempts" && method === "GET") {
    return heldFails ? json({ code: "57014", message: "canceling statement due to statement timeout" }, 500) : json([]);
  }
  if (url.pathname === "/rest/v1/ops_heartbeats") return json([], 201);
  unmatched.push(`${method} ${url.pathname}`);
  return json([]);
};

/** A view entry, as refresh_gamification_views() writes it. */
const view = (name: string, error: string | null = null) => ({ view: name, ms: 8.5, rows: error ? null : 25, error });
const VIEWS = ["mv_leaderboard", "mv_learner_metrics"].map((v) => view(v));
/** The sweep's entry of 0107 (step 16): its answer, or null with its own error when it raised. */
const sweepEntry = (error: string | null, sweep: Record<string, unknown> | null = { candidates: 2, handled: 2, failed: 0, errors: [] }) => ({
  view: "completion_sweep",
  ms: 3.1,
  rows: sweep ? (sweep.handled as number) : null,
  error,
  sweep: error ? null : sweep,
});
/** The same entry from 0112's bodies: the six-key answer of the timed sweep. */
const timedEntry = (stopped = "time") => sweepEntry(null, { candidates: 18, handled: 18, failed: 0, errors: [], stopped, ms: 1503 });

type Drain = { calls: number; candidates: number; handled: number; failed: number; stalled: number; stopped: string; ms: number };
type Body = Record<string, unknown> & { ok: boolean; total_ms: number; error?: string; views?: unknown; webhook_sweep?: Record<string, unknown>; completion_sweep_drain?: Drain };
type Heartbeat = { name: string; last_status: string; last_detail: Body | null };

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.CRON_SECRET = SECRET;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  globalThis.fetch = stub as typeof fetch;
  // the held-webhook sweep logs one line per run; kept off the test's output
  console.warn = () => {};
  try {
    const route = await import("../../app/api/cron/gamification-refresh/route");
    const call = async (secret: string | null = SECRET, method: "POST" | "GET" = "POST") => {
      requests = [];
      const handler = method === "POST" ? route.POST : route.GET;
      const res = await handler(new NextRequest("http://lms.test/api/cron/gamification-refresh", {
        method,
        headers: secret ? { "x-cron-secret": secret } : {},
      }));
      const body = (await res.json()) as Body;
      const beats = requests.filter((r) => r.path === "/rest/v1/ops_heartbeats" && r.method === "POST").map((r) => JSON.parse(r.body) as Heartbeat);
      const rpcs = requests.filter((r) => r.path === "/rest/v1/rpc/refresh_gamification_views").length;
      const drains = requests.filter((r) => r.path === "/rest/v1/rpc/sweep_completion_side_effects_timed").length;
      const order = requests.map((r) =>
        r.path.endsWith("/sweep_completion_side_effects_timed") ? "drain"
          : r.path.endsWith("/refresh_gamification_views") ? "refresh"
          : r.path === "/rest/v1/course_attempts" ? "held"
          : r.path === "/rest/v1/ops_heartbeats" ? "heartbeat" : r.path);
      return { status: res.status, body, beats, rpcs, drains, order, count: requests.length };
    };
    const NOTHING_HELD = { scanned: 0, fired: [], skipped: [], unfired: [] };

    console.log("\n(i) 0107's answer, the sweep's error null, the drain 'done': 200, ok, heartbeat ok");
    {
      heldFails = false;
      drainScript = [drainAnswer("done", 3)];
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("200, ok true, no error key", [r.status, r.body.ok, "error" in r.body], [200, true, false]);
      eq("views is the whole answer, the sweep's entry last", r.body.views, [...VIEWS, sweepEntry(null)]);
      eq("one RPC call, one heartbeat named gamification-refresh reading ok", [r.rpcs, r.beats.map((b) => [b.name, b.last_status])], [1, [["gamification-refresh", "ok"]]]);
      eq("the body's keys: ok, total_ms, views, completion_sweep_drain, webhook_sweep", Object.keys(r.body).sort(), ["completion_sweep_drain", "ok", "total_ms", "views", "webhook_sweep"]);
      const d = r.body.completion_sweep_drain!;
      eq("completion_sweep_drain: one call, its counts, stopped done, no ids",
        [d.calls, d.candidates, d.handled, d.failed, d.stalled, d.stopped, typeof d.ms, Object.keys(d).sort()],
        [1, 3, 3, 0, 0, "done", "number", ["calls", "candidates", "failed", "handled", "ms", "stalled", "stopped"]]);
      eq("the heartbeat's detail is the body", r.beats[0]?.last_detail, r.body);
    }

    console.log("\n(ii) the sweep's entry carries an error: 500, ok false, heartbeat error");
    {
      heldFails = false;
      answer = { body: [...VIEWS, sweepEntry("function public.sweep_completion_side_effects(integer) failed")] };
      const r = await call();
      eq("500, ok false", [r.status, r.body.ok], [500, false]);
      eq("the error names the sweep and carries its message", r.body.error, "completion_sweep: function public.sweep_completion_side_effects(integer) failed");
      eq("views is still the whole answer", r.body.views, [...VIEWS, sweepEntry("function public.sweep_completion_side_effects(integer) failed")]);
      eq("the heartbeat reads error, with the whole body as its detail",
        [r.beats.map((b) => b.last_status), r.beats[0]?.last_detail?.error, r.beats[0]?.last_detail?.views],
        [["error"], "completion_sweep: function public.sweep_completion_side_effects(integer) failed", r.body.views]);
      eq("…and the held-webhook sweep still ran and is in the body", r.body.webhook_sweep, NOTHING_HELD);
    }

    console.log("\n(iii) everything else keeps today's behaviour");
    {
      answer = { body: [view("mv_leaderboard", "could not refresh"), VIEWS[1], sweepEntry(null)] };
      const r = await call();
      eq("a view entry's error: 200, ok true, heartbeat ok, the error kept in its entry",
        [r.status, r.body.ok, r.beats.map((b) => b.last_status), (r.body.views as Array<{ error: string | null }>)[0].error], [200, true, ["ok"], "could not refresh"]);
    }
    {
      answer = { body: [...VIEWS, sweepEntry(null, { candidates: 4, handled: 2, failed: 2, errors: [{ attempt_id: "a1", sqlstate: "23505" }, { attempt_id: "a2", sqlstate: "40P01" }] })] };
      const r = await call();
      eq("rows that failed inside the sweep, its own error null: 200, ok true (counted in sweep.failed, retried by the next run)",
        [r.status, r.body.ok, r.beats.map((b) => b.last_status), (r.body.views as Array<{ sweep?: { failed: number } }>)[2].sweep?.failed], [200, true, ["ok"], 2]);
    }
    {
      answer = { body: VIEWS };
      const r = await call();
      eq("an answer without the sweep's entry (a database without 0107): 200, ok true", [r.status, r.body.ok, r.beats.map((b) => b.last_status)], [200, true, ["ok"]]);
    }
    {
      answer = { body: [...VIEWS, { view: "completion_sweep", ms: 1, rows: null, error: null, sweep: null }] };
      const r = await call();
      eq("the sweep's entry with error null and no answer: 200 (only its error counts)", [r.status, r.body.ok], [200, true]);
    }
    {
      answer = { body: { mv_leaderboard: "refreshed" } };
      const r = await call();
      eq("a non-array answer: 200, ok true, views as answered", [r.status, r.body.ok, r.body.views], [200, true, { mv_leaderboard: "refreshed" }]);
    }
    {
      answer = { error: { code: "57014", message: "canceling statement due to statement timeout" } };
      const r = await call();
      eq("an RPC error: 500, ok false, its message, heartbeat error (today's rule)",
        [r.status, r.body.ok, r.body.error, r.beats.map((b) => b.last_status)], [500, false, "canceling statement due to statement timeout", ["error"]]);
      eq("…the held-webhook sweep still ran and is in the body, and so is the drain's summary", [r.body.webhook_sweep, r.body.completion_sweep_drain?.stopped], [NOTHING_HELD, "done"]);
    }
    {
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const wrong = await call("not-the-secret");
      const none = await call(null);
      eq("a wrong or missing secret: 401, no RPC, no drain, no heartbeat",
        [wrong.status, wrong.rpcs, wrong.drains, wrong.beats.length, none.status, none.rpcs, none.drains, none.beats.length], [401, 0, 0, 0, 401, 0, 0, 0]);
    }
    {
      answer = { body: [...VIEWS, sweepEntry("boom")] };
      const r = await call(SECRET, "GET");
      eq("GET is POST: the same 500 for a failed sweep", [route.GET === route.POST, r.status, r.body.ok], [true, 500, false]);
    }

    console.log("\n(iv) the held-webhook sweep runs in every case and never decides ok");
    {
      heldFails = false;
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("the drain, then the refresh, then the held-webhook sweep, then the heartbeat", r.order, ["drain", "refresh", "held", "heartbeat"]);
    }
    {
      heldFails = true;
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("its own error with a good refresh: 200, ok true, the error in webhook_sweep",
        [r.status, r.body.ok, typeof r.body.webhook_sweep?.error, r.beats.map((b) => b.last_status)], [200, true, "string", ["ok"]]);
    }
    {
      heldFails = true;
      answer = { body: [...VIEWS, sweepEntry("boom")] };
      const r = await call();
      eq("its own error with a failed completion sweep: 500, the completion sweep's error, webhook_sweep still in the body",
        [r.status, r.body.ok, r.body.error, typeof r.body.webhook_sweep?.error], [500, false, "completion_sweep: boom", "string"]);
      heldFails = false;
    }

    console.log("\n(v) the drain (ADR 0024 note of 2026-11-16, items 4 and 5)");
    {
      drainScript = [drainAnswer("time", 60), drainAnswer("busy")];
      answer = { body: [...VIEWS, timedEntry("busy")] };
      const r = await call();
      eq("'time' then 'busy': two drain calls, 200, ok, stopped busy", [r.drains, r.status, r.body.ok, r.body.completion_sweep_drain?.stopped, r.body.completion_sweep_drain?.handled], [2, 200, true, "busy", 60]);
    }
    {
      drainScript = Array.from({ length: GAMIFICATION_DRAIN_MAX_CALLS + 1 }, (_, i) => drainAnswer(i % 2 ? "limit" : "time", 50));
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq(`'time' and 'limit' on every call: ${GAMIFICATION_DRAIN_MAX_CALLS} drain calls (GAMIFICATION_DRAIN_MAX_CALLS), 200, ok`,
        [r.drains, r.status, r.body.ok, r.body.completion_sweep_drain?.calls, r.body.completion_sweep_drain?.handled], [GAMIFICATION_DRAIN_MAX_CALLS, 200, true, GAMIFICATION_DRAIN_MAX_CALLS, 50 * GAMIFICATION_DRAIN_MAX_CALLS]);
      eq("…then the refresh, the held-webhook sweep and the heartbeat, once each",
        r.order, [...Array(GAMIFICATION_DRAIN_MAX_CALLS).fill("drain"), "refresh", "held", "heartbeat"]);
      console.log(`  measured: the worst healthy request (${GAMIFICATION_DRAIN_MAX_CALLS} drain calls, nothing held) makes ${r.count} subrequests`);
      eq("the request count, measured, is held to 40 (the held-webhook rule's 0.8 of the Workers budget)", r.count <= 40, true);
      drainScript = [];
    }
    {
      drainScript = [drainAnswer("time", 40, 3), drainAnswer("done", 5, 1)];
      answer = { body: [...VIEWS, timedEntry("done")] };
      const r = await call();
      eq("failed rows beside handled rows: 200, ok, counted", [r.status, r.body.ok, r.body.completion_sweep_drain?.failed], [200, true, 4]);
    }
    {
      drainScript = [DRAIN_ABSENT];
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("PGRST202 (a database without 0112) beside 0107's refresh: one drain call, 200, ok, stopped absent",
        [r.drains, r.status, r.body.ok, r.body.completion_sweep_drain?.stopped], [1, 200, true, "absent"]);
      drainScript = [DRAIN_ABSENT];
      answer = { body: VIEWS };
      const r2 = await call();
      eq("PGRST202 beside an answer without the entry (production today): 200, ok", [r2.status, r2.body.ok], [200, true]);
    }
    {
      drainScript = [DRAIN_ABSENT];
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq("PGRST202 beside a refresh whose sweep carries stopped (0112 there, its function not visible): 500, red",
        [r.status, r.body.ok, r.body.error, r.beats.map((b) => b.last_status)], [500, false, "completion_sweep: drain function not visible", ["error"]]);
    }
    {
      drainScript = [DRAIN_TIMEOUT];
      heldFails = false;
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq("a drain call answering 57014: 500, red, its message", [r.status, r.body.ok, r.body.error, r.beats.map((b) => b.last_status)],
        [500, false, "completion_sweep: canceling statement due to statement timeout", ["error"]]);
      eq("…the drain stopped at that call; the refresh and the held-webhook sweep still ran", [r.drains, r.rpcs, r.order, r.body.webhook_sweep, r.body.views],
        [1, 1, ["drain", "refresh", "held", "heartbeat"], NOTHING_HELD, [...VIEWS, timedEntry("time")]]);
    }
    {
      drainScript = [drainAnswer("time", 0, 5), drainAnswer("time", 0, 5), drainAnswer("done", 9)];
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq("two stalled calls in a row: the drain stops at the second", [r.drains, r.body.completion_sweep_drain?.stopped, r.body.completion_sweep_drain?.stalled], [2, "stalled", 2]);
      eq(`…${STALL_READS_RED ? "500, red (D-S4 built as recommended)" : "200 (D-S4 answered no)"}`,
        [r.status, r.body.ok, r.body.error ?? null],
        STALL_READS_RED ? [500, false, "completion_sweep: stalled (10 failed, 0 handled, 2 calls)"] : [200, true, null]);
      drainScript = [];
    }
    {
      drainScript = [drainAnswer("time", 0, 5), drainAnswer("done", 4)];
      answer = { body: [...VIEWS, timedEntry("done")] };
      const r = await call();
      eq("one stalled call, then a call that handles rows: 200, ok, stalled 1", [r.status, r.body.ok, r.body.completion_sweep_drain?.stalled, r.drains], [200, true, 1, 2]);
    }
    {
      const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/gamification-refresh/route.ts"), "utf8");
      const twin = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/refresh-report-views/route.ts"), "utf8");
      const imports = (s: string) => /from "@\/lib\/ops\/completion-sweep";/.test(s) && /\bcompletionSweepFailure\(sweepRun, data\)/.test(s) && /\bdrainCompletionSweep\(svc, /.test(s);
      eq("both routes import the helper and call its drain and its rule (one rule, one file: the note's item 6)", [imports(src), imports(twin)], [true, true]);
      eq("neither route keeps its own copy of completionSweepError", [/function completionSweepError/.test(src), /function completionSweepError/.test(twin)], [false, false]);
      eq("the drain runs before total_ms's clock starts, and the held-webhook sweep after it stops",
        src.indexOf("drainCompletionSweep(svc") > 0 && src.indexOf("drainCompletionSweep(svc") < src.indexOf("const t0 = Date.now();")
          && src.indexOf("const total_ms = Date.now() - t0;") < src.indexOf("sweepHeldWebhooks(svc"), true);
      eq("the route never names purge_preview_data", src.includes("purge_preview_data"), false);
    }
    eq("every request the route made was stubbed", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
