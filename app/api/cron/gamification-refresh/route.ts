import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { fireCompletionWebhookForAttempt } from "@/lib/integrations/webhook";
import { sweepHeldWebhooks, type SweepResult } from "@/lib/integrations/webhook-hold";
import { classifyAttempt } from "@/lib/scoring/attempt-kind";

/**
 *   POST /api/cron/gamification-refresh
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Step 1: refreshes the leaderboard materialized views (mv_leaderboard,
 * mv_team_leaderboard) via public.refresh_gamification_views()
 * (migration 0053). CONCURRENTLY keeps boards queryable during refresh.
 *
 * Step 2 (ADR 0015 step 5): after the refresh, whatever its outcome,
 * sweepHeldWebhooks fires the CRM course_completed message for held official
 * cmi5/xAPI completions older than 15 minutes, up to the per-run caps of
 * lib/integrations/webhook-hold.ts. It is fail-isolated: its outcome goes into
 * the response and the heartbeat as `webhook_sweep` (attempt ids and counts)
 * and never changes `ok`, which the refresh alone decides; `total_ms` stays the
 * refresh's time.
 *
 * Scheduled every 15 minutes from .github/workflows/cron.yml — the
 * "live-feeling" cadence the product asked for. Personal XP/streak stats
 * are write-time fresh; only org-wide rankings ride this refresh. The sweep
 * rides the same schedule (no new cron line, no CRON_CADENCE_MIN change), so a
 * held unscored plain-xAPI completion fires 15 to 30 minutes after its
 * completed_at, plus whatever GitHub delays the run by.
 *
 * Step 1's answer (ADR 0024 step 16; the note of 2026-11-14, ruling A4): from
 * migration 0107 the function runs the completion sweep first and appends its
 * entry last, {view: "completion_sweep", ms, rows, error, sweep}. This route
 * runs every 15 minutes, so it is the sweep's most frequent caller, and it
 * follows the report route's rule of step 81
 * (app/api/cron/refresh-report-views/route.ts): when that entry carries an
 * error of its own the route answers 500, `ok` false and `error`
 * "completion_sweep: <message>", and the heartbeat reads "error", so the
 * 15-minute job reads red while the sweep of the fail-closed writer is
 * broken. Only the sweep's own error counts: a row that failed inside the
 * sweep (sweep.failed) is retried by the next run, a view entry's error is
 * reported in its entry as before, and an answer without the entry (a
 * database without 0107) keeps today's 200. The held-webhook sweep below
 * still runs in every case, stays in the body and never decides `ok`.
 */

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * The completion sweep's own error from refresh_gamification_views()'s
 * answer, or null (no entry, or its error null). The same rule as
 * completionSweepError in app/api/cron/refresh-report-views/route.ts. Each
 * route keeps its own copy, so that neither route module exports anything
 * but its handlers and no new file is added (ruling A4);
 * tests/unit/gamification-refresh-route.test.ts pins the two copies equal.
 */
function completionSweepError(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    if (entry && typeof entry === "object" && (entry as { view?: unknown }).view === "completion_sweep") {
      const err = (entry as { error?: unknown }).error;
      return err === null || err === undefined ? null : String(err);
    }
  }
  return null;
}

async function run() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

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
    return { ok: false, total_ms, error: error.message, webhook_sweep };
  }
  const sweepError = completionSweepError(data);
  if (sweepError !== null) {
    return { ok: false, total_ms, views: data, error: `completion_sweep: ${sweepError}`, webhook_sweep };
  }
  return { ok: true, total_ms, views: data, webhook_sweep };
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
