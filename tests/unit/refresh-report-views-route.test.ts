/**
 * Unit test for ADR 0024 step 81 ("The refresh route's failure reporting, for
 * the completion sweep"), as the note of 2026-11-16 restates it (items 4 to
 * 6, step S5), on the real route: app/api/cron/refresh-report-views runs for
 * real under a stubbed PostgREST fetch (the precedent of
 * webhook-hold-route.test.ts), so the real answer, status, heartbeat upsert
 * and request count are what is asserted.
 *
 *   (i)   from 0107 the function's answer ends with the sweep's entry,
 *         {view: "completion_sweep", ms, rows, error, sweep} (step 16): with
 *         its error null and a drain that answers 'done' the route answers
 *         200, ok true, `completion_sweep_drain` its summary, and the
 *         heartbeat reads "ok";
 *   (ii)  with its error set the route answers 500, ok false, an `error`
 *         naming the sweep, and the heartbeat reads "error" with the whole
 *         answer as its detail;
 *   (iii) everything else keeps today's behaviour: a view entry's error
 *         (200, ok true), rows that failed inside the sweep with the sweep's
 *         own error null (200: they are counted in sweep.failed and retried
 *         by the next run), an answer without the sweep's entry (a database
 *         without 0107: 200), an RPC error (500, as today), a wrong or
 *         missing secret (401, no RPC, no heartbeat); the body keeps today's
 *         shape (the entries spread under their index keys, ok, total_ms)
 *         plus `completion_sweep_drain`, and carries no Preview data entry;
 *         GET is POST;
 *   (iv)  the drain (the note's items 4 and 5): it runs first, before the
 *         refresh and before total_ms's clock starts; 'time' and 'limit' up
 *         to REPORT_DRAIN_MAX_CALLS, 'busy', and PGRST202 beside a refresh
 *         of 0107 read green; a drain error (57014 included), PGRST202 beside
 *         a refresh whose sweep carries `stopped`, and two stalled calls in a
 *         row (D-S4) read red, and the refresh still runs after a red drain;
 *         the request count, measured, is held to 12.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/refresh-report-views-route.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { REPORT_DRAIN_MAX_CALLS, STALL_READS_RED } from "../../lib/ops/completion-sweep";

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
  if (url.pathname === "/rest/v1/rpc/refresh_report_views") {
    return "error" in answer ? json(answer.error, 500) : json(answer.body);
  }
  if (url.pathname === "/rest/v1/ops_heartbeats") return json([], 201);
  unmatched.push(`${method} ${url.pathname}`);
  return json([]);
};

/** A view entry, as refresh_report_views() writes it. */
const view = (name: string, error: string | null = null) => ({ view: name, ms: 12.5, rows: error ? null : 40, error });
const VIEWS = [
  "mv_course_enrollment_status",
  "mv_path_enrollment_status",
  "mv_course_performance",
  "mv_path_performance",
  "mv_course_interaction_breakdown",
  "mv_course_interaction_top_wrong",
].map((v) => view(v));
/** The sweep's entry of 0107 (step 16): its answer, or null with its own error when it raised. */
const sweepEntry = (error: string | null, sweep: Record<string, unknown> | null = { candidates: 3, handled: 3, failed: 0, errors: [] }) => ({
  view: "completion_sweep",
  ms: 4.2,
  rows: sweep ? (sweep.handled as number) : null,
  error,
  sweep: error ? null : sweep,
});
/** The same entry from 0112's bodies: the six-key answer of the timed sweep. */
const timedEntry = (stopped = "time") => sweepEntry(null, { candidates: 16, handled: 16, failed: 0, errors: [], stopped, ms: 1501 });

type Drain = { calls: number; candidates: number; handled: number; failed: number; stalled: number; stopped: string; ms: number };
type Body = Record<string, unknown> & { ok: boolean; total_ms: number; error?: string; completion_sweep_drain?: Drain };
type Heartbeat = { name: string; last_status: string; last_detail: Body | null };

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.CRON_SECRET = SECRET;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    const route = await import("../../app/api/cron/refresh-report-views/route");
    const call = async (secret: string | null = SECRET, method: "POST" | "GET" = "POST") => {
      requests = [];
      const handler = method === "POST" ? route.POST : route.GET;
      const res = await handler(new NextRequest("http://lms.test/api/cron/refresh-report-views", {
        method,
        headers: secret ? { "x-cron-secret": secret } : {},
      }));
      const body = (await res.json()) as Body;
      const beats = requests.filter((r) => r.path === "/rest/v1/ops_heartbeats" && r.method === "POST").map((r) => JSON.parse(r.body) as Heartbeat);
      const rpcs = requests.filter((r) => r.path === "/rest/v1/rpc/refresh_report_views").length;
      const drains = requests.filter((r) => r.path === "/rest/v1/rpc/sweep_completion_side_effects_timed").length;
      const order = requests.map((r) =>
        r.path.endsWith("/sweep_completion_side_effects_timed") ? "drain"
          : r.path.endsWith("/refresh_report_views") ? "refresh"
          : r.path === "/rest/v1/ops_heartbeats" ? "heartbeat" : r.path);
      return { status: res.status, body, beats, rpcs, drains, order, count: requests.length };
    };
    /** The body's entries, from the index keys of the spread answer, in order. */
    const entries = (b: Body) => Object.keys(b).filter((k) => /^\d+$/.test(k)).sort((x, y) => Number(x) - Number(y)).map((k) => b[k]);

    console.log("\n(i) 0107's answer, the sweep's error null, the drain 'done': 200, ok, heartbeat ok");
    {
      drainScript = [drainAnswer("done", 2)];
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("200, ok true, no error key", [r.status, r.body.ok, "error" in r.body], [200, true, false]);
      eq("one RPC call, one heartbeat upsert named refresh-report-views reading ok", [r.rpcs, r.beats.map((b) => [b.name, b.last_status])], [1, [["refresh-report-views", "ok"]]]);
      eq("the body keeps today's shape: every entry under its index key, the sweep's last, then ok and total_ms",
        [entries(r.body).length, (entries(r.body)[6] as { view: string }).view, typeof r.body.total_ms], [7, "completion_sweep", "number"]);
      eq("…plus completion_sweep_drain, and no other key",
        Object.keys(r.body).filter((k) => !/^\d+$/.test(k)).sort(), ["completion_sweep_drain", "ok", "total_ms"]);
      const d = r.body.completion_sweep_drain!;
      eq("completion_sweep_drain: one call, its counts, stopped done, no ids",
        [d.calls, d.candidates, d.handled, d.failed, d.stalled, d.stopped, typeof d.ms, Object.keys(d).sort()],
        [1, 2, 2, 0, 0, "done", "number", ["calls", "candidates", "failed", "handled", "ms", "stalled", "stopped"]]);
      eq("the heartbeat's detail is the body", r.beats[0]?.last_detail, r.body);
    }

    console.log("\n(ii) the sweep's entry carries an error: 500, ok false, heartbeat error");
    {
      answer = { body: [...VIEWS, sweepEntry("function public.sweep_completion_side_effects(integer) failed")] };
      const r = await call();
      eq("500, ok false", [r.status, r.body.ok], [500, false]);
      eq("the error names the sweep and carries its message", r.body.error, "completion_sweep: function public.sweep_completion_side_effects(integer) failed");
      eq("the heartbeat reads error, with the whole answer as its detail",
        [r.beats.map((b) => b.last_status), (r.beats[0]?.last_detail ? entries(r.beats[0].last_detail).length : 0), r.beats[0]?.last_detail?.error],
        [["error"], 7, "completion_sweep: function public.sweep_completion_side_effects(integer) failed"]);
      eq("…and the view entries are still in the body", entries(r.body).slice(0, 6).map((e) => (e as { view: string }).view), VIEWS.map((v) => v.view));
    }

    console.log("\n(iii) every other entry keeps today's behaviour");
    {
      answer = { body: [...VIEWS.slice(0, 2), view("mv_course_performance", "could not refresh"), ...VIEWS.slice(3), sweepEntry(null)] };
      const r = await call();
      eq("a view entry's error: 200, ok true, heartbeat ok (today's rule), the error kept in its entry",
        [r.status, r.body.ok, r.beats.map((b) => b.last_status), (entries(r.body)[2] as { error: string }).error], [200, true, ["ok"], "could not refresh"]);
    }
    {
      answer = { body: [...VIEWS, sweepEntry(null, { candidates: 5, handled: 3, failed: 2, errors: [{ attempt_id: "a1", sqlstate: "23505" }, { attempt_id: "a2", sqlstate: "40P01" }] })] };
      const r = await call();
      eq("rows that failed inside the sweep, its own error null: 200, ok true (counted in sweep.failed, retried by the next run)",
        [r.status, r.body.ok, r.beats.map((b) => b.last_status), ((entries(r.body)[6] as { sweep: { failed: number } }).sweep.failed)], [200, true, ["ok"], 2]);
    }
    {
      answer = { body: VIEWS.slice(0, 5) };
      const r = await call();
      eq("an answer without the sweep's entry (a database without 0107): 200, ok true", [r.status, r.body.ok, r.beats.map((b) => b.last_status)], [200, true, ["ok"]]);
    }
    {
      answer = { body: [...VIEWS, { view: "completion_sweep", ms: 1, rows: null, error: null, sweep: null }] };
      const r = await call();
      eq("the sweep's entry with error null and no answer: 200 (only its error counts)", [r.status, r.body.ok], [200, true]);
    }
    {
      answer = { error: { code: "57014", message: "canceling statement due to statement timeout" } };
      const r = await call();
      eq("an RPC error: 500, ok false, its message, heartbeat error (today's rule)",
        [r.status, r.body.ok, r.body.error, r.beats.map((b) => b.last_status)], [500, false, "canceling statement due to statement timeout", ["error"]]);
      eq("…the drain's summary is in the body", r.body.completion_sweep_drain?.stopped, "done");
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
    {
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("no Preview data entry in the answer (nothing deletes it on a schedule, step 81)",
        [Object.keys(r.body).some((k) => /preview/i.test(k)), entries(r.body).some((e) => /preview/i.test(String((e as { view?: string }).view)))], [false, false]);
      const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/refresh-report-views/route.ts"), "utf8");
      eq("the route never names purge_preview_data", src.includes("purge_preview_data"), false);
    }

    console.log("\n(iv) the drain (ADR 0024 note of 2026-11-16, items 4 and 5)");
    {
      drainScript = Array.from({ length: REPORT_DRAIN_MAX_CALLS + 1 }, (_, i) => drainAnswer(i % 2 ? "limit" : "time", 70));
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq(`'time' and 'limit' on every call: ${REPORT_DRAIN_MAX_CALLS} drain calls (REPORT_DRAIN_MAX_CALLS), 200, ok`,
        [r.drains, r.status, r.body.ok, r.body.completion_sweep_drain?.handled], [REPORT_DRAIN_MAX_CALLS, 200, true, 70 * REPORT_DRAIN_MAX_CALLS]);
      eq("…the drain calls, then the refresh, then the heartbeat", r.order, [...Array(REPORT_DRAIN_MAX_CALLS).fill("drain"), "refresh", "heartbeat"]);
      console.log(`  measured: the worst healthy request (${REPORT_DRAIN_MAX_CALLS} drain calls) makes ${r.count} subrequests`);
      eq("the request count, measured, is held to 12", r.count <= 12, true);
      drainScript = [];
    }
    {
      drainScript = [drainAnswer("busy")];
      answer = { body: [...VIEWS, timedEntry("busy")] };
      const r = await call();
      eq("'busy': one drain call, 200, ok", [r.drains, r.status, r.body.ok, r.body.completion_sweep_drain?.stopped], [1, 200, true, "busy"]);
    }
    {
      drainScript = [DRAIN_ABSENT];
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("PGRST202 (a database without 0112) beside 0107's refresh: 200, ok, stopped absent", [r.drains, r.status, r.body.ok, r.body.completion_sweep_drain?.stopped], [1, 200, true, "absent"]);
    }
    {
      drainScript = [DRAIN_ABSENT];
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq("PGRST202 beside a refresh whose sweep carries stopped: 500, red", [r.status, r.body.ok, r.body.error], [500, false, "completion_sweep: drain function not visible"]);
    }
    {
      drainScript = [drainAnswer("time", 30), DRAIN_TIMEOUT];
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq("a drain call answering 57014: 500, red, its message, heartbeat error",
        [r.status, r.body.ok, r.body.error, r.beats.map((b) => b.last_status)], [500, false, "completion_sweep: canceling statement due to statement timeout", ["error"]]);
      eq("…the drain stopped at that call and the refresh still ran", [r.drains, r.rpcs, r.order, entries(r.body).length], [2, 1, ["drain", "drain", "refresh", "heartbeat"], 7]);
    }
    {
      drainScript = [drainAnswer("limit", 0, 200), drainAnswer("time", 0, 7)];
      answer = { body: [...VIEWS, timedEntry("time")] };
      const r = await call();
      eq("two stalled calls in a row: the drain stops at the second", [r.drains, r.body.completion_sweep_drain?.stopped], [2, "stalled"]);
      eq(`…${STALL_READS_RED ? "500, red (D-S4 built as recommended)" : "200 (D-S4 answered no)"}`, [r.status, r.body.error ?? null],
        STALL_READS_RED ? [500, "completion_sweep: stalled (207 failed, 0 handled, 2 calls)"] : [200, null]);
      drainScript = [];
    }
    {
      const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/refresh-report-views/route.ts"), "utf8");
      eq("the drain runs before total_ms's clock starts",
        src.indexOf("drainCompletionSweep(svc") > 0 && src.indexOf("drainCompletionSweep(svc") < src.indexOf("const t0 = Date.now();"), true);
      eq("the route imports the helper and keeps no copy of completionSweepError",
        [/from "@\/lib\/ops\/completion-sweep";/.test(src), /function completionSweepError/.test(src)], [true, false]);
    }
    eq("every request the route made was stubbed", unmatched, []);
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
