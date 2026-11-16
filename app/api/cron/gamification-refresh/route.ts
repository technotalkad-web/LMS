import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { fireCompletionWebhookForAttempt } from "@/lib/integrations/webhook";
import { sweepHeldWebhooks, type SweepResult } from "@/lib/integrations/webhook-hold";
import { classifyAttempt } from "@/lib/scoring/attempt-kind";
import {
  GAMIFICATION_DRAIN_MAX_CALLS,
  completionSweepFailure,
  drainCompletionSweep,
} from "@/lib/ops/completion-sweep";

/**
 *   POST /api/cron/gamification-refresh
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Step 0 (ADR 0024 step 16, the note of 2026-11-16, item 4): the completion
 * sweep's drain, before the refresh, in calls of its own:
 * drainCompletionSweep (lib/ops/completion-sweep.ts) makes up to
 * GAMIFICATION_DRAIN_MAX_CALLS (4) sequential calls of 0112's
 * sweep_completion_side_effects_timed(200, 5000), each its own statement and
 * commit, and stops at 'done', 'busy', an error, two stalled calls in a row
 * or its last call. Its summary goes into the body and the heartbeat as
 * `completion_sweep_drain` (counts and one word, no ids). On a database
 * without 0112 its first call answers PGRST202, which reads "no drain". The
 * refresh below runs in every case.
 *
 * Step 1: refreshes the leaderboard materialized views (mv_leaderboard,
 * mv_team_leaderboard) via public.refresh_gamification_views()
 * (migration 0053). CONCURRENTLY keeps boards queryable during refresh.
 * `total_ms` stays the refresh's time: it is taken after the drain.
 *
 * Step 2 (ADR 0015 step 5): after the refresh, whatever its outcome,
 * sweepHeldWebhooks fires the CRM course_completed message for held official
 * cmi5/xAPI completions older than 15 minutes, up to the per-run caps of
 * lib/integrations/webhook-hold.ts. It is fail-isolated: its outcome goes into
 * the response and the heartbeat as `webhook_sweep` (attempt ids and counts)
 * and never changes `ok`; `total_ms` stays the refresh's time.
 *
 * Scheduled every 15 minutes from .github/workflows/cron.yml — the
 * "live-feeling" cadence the product asked for. Personal XP/streak stats
 * are write-time fresh; only org-wide rankings ride this refresh. The sweep
 * rides the same schedule (no new cron line, no CRON_CADENCE_MIN change), so a
 * held unscored plain-xAPI completion fires 15 to 30 minutes after its
 * completed_at, plus whatever GitHub delays the run by.
 *
 * The completion sweep's error (ruling A4 of the ADR 0024 note of 2026-11-14,
 * restated by the note of 2026-11-16, item 5; completionSweepFailure in
 * lib/ops/completion-sweep.ts): the route answers 500, `ok` false, `error`
 * "completion_sweep: <message>" and the heartbeat reads "error" when a drain
 * call answered an error (not PGRST202), when the refresh answer's
 * completion_sweep entry (0107, step 16: {view: "completion_sweep", ms, rows,
 * error, sweep}, last) carries its own error, when the drain read PGRST202
 * while the refresh answer's `sweep` carries `stopped` (0112 is there and
 * the Data API does not see its function), or when the drain stopped on two
 * consecutive stalled calls (the note's D-S4). Not an error: a call stopped
 * by its box, its limit or 'busy', rows in `failed`, a view entry's error,
 * an answer without the entry (a database without 0107). The refresh's own
 * RPC error keeps today's rule (500, its message). The held-webhook sweep
 * still runs in every case, stays in the body and never decides `ok`.
 */

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function run() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ADR 0024 step 16 (note of 2026-11-16): the drain first, in calls of its own.
  const sweepRun = await drainCompletionSweep(svc, GAMIFICATION_DRAIN_MAX_CALLS);
  const completion_sweep_drain = sweepRun.drain;

  const t0 = Date.now();
  const { data, error } = await svc.rpc("refresh_gamification_views");
  const total_ms = Date.now() - t0;

  // ADR 0015 step 5: no opts, so the exported caps apply.
  let webhook_sweep: SweepResult;
  try {
    webhook_sweep = await sweepHeldWebhooks(svc, {
      fire: fireCompletionWebhookForAttempt,
      classify: classifyAttempt,
    });
  } catch (e) {
    webhook_sweep = {
      scanned: 0,
      fired: [],
      skipped: [],
      unfired: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (error) {
    return { ok: false, total_ms, error: error.message, completion_sweep_drain, webhook_sweep };
  }
  const sweepError = completionSweepFailure(sweepRun, data);
  if (sweepError !== null) {
    return { ok: false, total_ms, views: data, error: `completion_sweep: ${sweepError}`, completion_sweep_drain, webhook_sweep };
  }
  return { ok: true, total_ms, views: data, completion_sweep_drain, webhook_sweep };
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  await recordHeartbeat("gamification-refresh", result, result.ok);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export const GET = POST;
