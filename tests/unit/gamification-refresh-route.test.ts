/**
 * Unit test for the ADR 0024 note of 2026-11-14, ruling A4 ("The
 * gamification refresh route and the sweep's error"), on the real route:
 * app/api/cron/gamification-refresh runs for real under a stubbed PostgREST
 * fetch (the form of refresh-report-views-route.test.ts), so the real answer,
 * status and heartbeat upsert are what is asserted.
 *
 *   (i)   from 0107 refresh_gamification_views()'s answer ends with the
 *         sweep's entry, {view: "completion_sweep", ms, rows, error, sweep}
 *         (step 16): with its error null the route answers 200, ok true,
 *         `views` the whole answer, and the heartbeat reads "ok";
 *   (ii)  with its error set the route answers 500, ok false, an `error`
 *         naming the sweep, `views` still the whole answer, and the heartbeat
 *         reads "error" with the whole body as its detail;
 *   (iii) everything else keeps today's behaviour: a view entry's error
 *         (200), rows that failed inside the sweep with the sweep's own error
 *         null (200: counted in sweep.failed and retried by the next run), an
 *         answer without the sweep's entry (a database without 0107: 200), a
 *         non-array answer (200), an RPC error (500, as today), a wrong or
 *         missing secret (401, no RPC, no heartbeat); GET is POST;
 *   (iv)  the held-webhook sweep (ADR 0015 step 5) runs in every case, after
 *         the refresh and before the heartbeat, stays in the body as
 *         `webhook_sweep`, and never decides `ok`: its own failure leaves a
 *         good refresh at 200 and a failed completion sweep at 500.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/gamification-refresh-route.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const SUPABASE = "http://stub.supabase.test";
const SECRET = "stub-cron-secret";

type Req = { method: string; path: string; body: string };
let requests: Req[] = [];
/** What the stubbed RPC answers next: a body (200) or an error (500). */
let answer: { body: unknown } | { error: { code: string; message: string } } = { body: [] };
/** Whether the held-webhook sweep's read fails (its own error, fail-isolated). */
let heldFails = false;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  requests.push({ method, path: url.pathname, body });
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

type Body = Record<string, unknown> & { ok: boolean; total_ms: number; error?: string; views?: unknown; webhook_sweep?: Record<string, unknown> };
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
      const order = requests.map((r) =>
        r.path.endsWith("/refresh_gamification_views") ? "refresh" : r.path === "/rest/v1/course_attempts" ? "held" : r.path === "/rest/v1/ops_heartbeats" ? "heartbeat" : r.path);
      return { status: res.status, body, beats, rpcs, order };
    };
    const NOTHING_HELD = { scanned: 0, fired: [], skipped: [], unfired: [] };

    console.log("\n(i) 0107's answer, the sweep's error null: 200, ok, heartbeat ok");
    {
      heldFails = false;
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("200, ok true, no error key", [r.status, r.body.ok, "error" in r.body], [200, true, false]);
      eq("views is the whole answer, the sweep's entry last", r.body.views, [...VIEWS, sweepEntry(null)]);
      eq("one RPC call, one heartbeat named gamification-refresh reading ok", [r.rpcs, r.beats.map((b) => [b.name, b.last_status])], [1, [["gamification-refresh", "ok"]]]);
      eq("the body keeps today's keys: ok, total_ms, views, webhook_sweep", Object.keys(r.body).sort(), ["ok", "total_ms", "views", "webhook_sweep"]);
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
      eq("…the held-webhook sweep still ran and is in the body", r.body.webhook_sweep, NOTHING_HELD);
    }
    {
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const wrong = await call("not-the-secret");
      const none = await call(null);
      eq("a wrong or missing secret: 401, no RPC, no heartbeat",
        [wrong.status, wrong.rpcs, wrong.beats.length, none.status, none.rpcs, none.beats.length], [401, 0, 0, 401, 0, 0]);
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
      eq("the refresh, then the held-webhook sweep, then the heartbeat", r.order, ["refresh", "held", "heartbeat"]);
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
    {
      const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/gamification-refresh/route.ts"), "utf8");
      const twin = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/refresh-report-views/route.ts"), "utf8");
      const fn = (s: string) => /function completionSweepError\(data: unknown\): string \| null \{[\s\S]*?\n\}/.exec(s)?.[0] ?? null;
      eq("the route's completionSweepError is the report route's, line for line (one rule in two routes)", fn(src) !== null && fn(src) === fn(twin), true);
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
