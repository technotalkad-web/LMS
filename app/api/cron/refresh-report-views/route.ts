import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import {
  REPORT_DRAIN_MAX_CALLS,
  completionSweepFailure,
  drainCompletionSweep,
} from "@/lib/ops/completion-sweep";

/**
 *   POST /api/cron/refresh-report-views
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Refreshes the five materialized views that back the analytics &
 * reporting surfaces (#175). Runs nightly at 03:30 UTC via the
 * Cloudflare cron trigger configured in wrangler.toml.
 *
 * Implementation delegates to the database function
 * public.refresh_report_views() (defined in migration 0031) which
 * issues REFRESH MATERIALIZED VIEW CONCURRENTLY for each view and
 * returns a per-view runtime + rowcount payload. CONCURRENTLY keeps
 * the views queryable during refresh — admins staring at the reports
 * page during 03:30 UTC see no blank screen.
 *
 * Manual trigger (admin debug): hit this endpoint with the CRON_SECRET
 * header any time. Useful when you\'ve just imported test data and
 * want the views updated immediately instead of waiting for the cron.
 *
 * Closes #176. See docs/roadmap/analytics-and-reporting.md §5 Phase 2a.
 */

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/*
 * ADR 0024 step 81, with step 16, as the note of 2026-11-16 restates them
 * (items 4 and 5; lib/ops/completion-sweep.ts). Before the refresh the route
 * drains the completion sweep in calls of its own: up to
 * REPORT_DRAIN_MAX_CALLS (8) sequential calls of 0112's
 * sweep_completion_side_effects_timed(200, 5000), each its own statement and
 * commit; the daily backstop of the 15-minute gamification route. Its
 * summary is `completion_sweep_drain` in the body and the heartbeat (counts
 * and one word, no ids); a database without 0112 answers PGRST202, "no
 * drain". The refresh runs in every case; `total_ms` stays its time.
 *
 * From 0107 the function also runs the sweep itself (with a 1.5 s box from
 * 0112) and appends its entry last, {view: "completion_sweep", ms, rows,
 * error, sweep}. The sweep is the only retry of the fail-closed completion
 * writer, so a sweep that failed must not pass unseen: the route answers
 * 500 and the heartbeat reads "error" when a drain call answered an error,
 * when that entry carries its own error, when the drain read PGRST202 while
 * the entry's sweep carries `stopped` (0112 is there and the Data API does
 * not see its function), or when the drain stopped on two consecutive
 * stalled calls (the note's D-S4). A row that failed inside the sweep is
 * counted in `failed` and retried by the next run; it is not an error of the
 * refresh. Every other entry keeps today's behaviour (a view's error is
 * reported in its entry and the route answers 200), and a database without
 * 0107 has no such entry. The answer has no entry for Preview data: nothing
 * deletes it on a schedule (step 81).
 */
async function run() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ADR 0024 step 16 (note of 2026-11-16): the drain first, in calls of its own.
  const sweepRun = await drainCompletionSweep(svc, REPORT_DRAIN_MAX_CALLS);
  const completion_sweep_drain = sweepRun.drain;

  const t0 = Date.now();
  const { data, error } = await svc.rpc("refresh_report_views");
  const total_ms = Date.now() - t0;

  if (error) {
    return {
      ok: false,
      total_ms,
      error: error.message,
      completion_sweep_drain,
    };
  }

  const sweepError = completionSweepFailure(sweepRun, data);
  return {
    ok: sweepError === null,
    total_ms,
    ...(data as Record<string, unknown>),
    completion_sweep_drain,
    ...(sweepError === null ? {} : { error: `completion_sweep: ${sweepError}` }),
  };
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  await recordHeartbeat("refresh-report-views", result, result.ok);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 500,
  });
}

// Cloudflare Workers cron triggers fire via the worker\'s scheduled
// handler. The same handler shape used by the other /api/cron/*
// routes (POST + GET reusing POST for manual curl convenience) is
// preserved here.
export const GET = POST;
