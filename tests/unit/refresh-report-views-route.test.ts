/**
 * Unit test for ADR 0024 step 81 ("The refresh route's failure reporting, for
 * the completion sweep") on the real route: app/api/cron/refresh-report-views
 * runs for real under a stubbed PostgREST fetch (the precedent of
 * webhook-hold-route.test.ts), so the real answer, status and heartbeat upsert
 * are what is asserted.
 *
 *   (i)   from 0107 the function's answer ends with the sweep's entry,
 *         {view: "completion_sweep", ms, rows, error, sweep} (step 16): with
 *         its error null the route answers 200, ok true, and the heartbeat
 *         reads "ok";
 *   (ii)  with its error set the route answers 500, ok false, an `error`
 *         naming the sweep, and the heartbeat reads "error" with the whole
 *         answer as its detail;
 *   (iii) everything else keeps today's behaviour: a view entry's error
 *         (200, ok true), rows that failed inside the sweep with the sweep's
 *         own error null (200: they are counted in sweep.failed and retried
 *         by the next run), an answer without the sweep's entry (a database
 *         without 0107: 200), an RPC error (500, as today), a wrong or
 *         missing secret (401, no RPC, no heartbeat); the body keeps today's
 *         shape (the entries spread under their index keys, ok, total_ms) and
 *         carries no Preview data entry; GET is POST.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/refresh-report-views-route.test.ts   (or npm run test:unit)
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
const unmatched: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  requests.push({ method, path: url.pathname, body });
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

type Body = Record<string, unknown> & { ok: boolean; total_ms: number; error?: string };
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
      return { status: res.status, body, beats, rpcs };
    };
    /** The body's entries, from the index keys of the spread answer, in order. */
    const entries = (b: Body) => Object.keys(b).filter((k) => /^\d+$/.test(k)).sort((x, y) => Number(x) - Number(y)).map((k) => b[k]);

    console.log("\n(i) 0107's answer, the sweep's error null: 200, ok, heartbeat ok");
    {
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("200, ok true, no error key", [r.status, r.body.ok, "error" in r.body], [200, true, false]);
      eq("one RPC call, one heartbeat upsert named refresh-report-views reading ok", [r.rpcs, r.beats.map((b) => [b.name, b.last_status])], [1, [["refresh-report-views", "ok"]]]);
      eq("the body keeps today's shape: every entry under its index key, the sweep's last, then ok and total_ms",
        [entries(r.body).length, (entries(r.body)[6] as { view: string }).view, typeof r.body.total_ms], [7, "completion_sweep", "number"]);
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
    {
      answer = { body: [...VIEWS, sweepEntry(null)] };
      const r = await call();
      eq("no Preview data entry in the answer (nothing deletes it on a schedule, step 81)",
        [Object.keys(r.body).some((k) => /preview/i.test(k)), entries(r.body).some((e) => /preview/i.test(String((e as { view?: string }).view)))], [false, false]);
      const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/refresh-report-views/route.ts"), "utf8");
      eq("the route never names purge_preview_data", src.includes("purge_preview_data"), false);
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
