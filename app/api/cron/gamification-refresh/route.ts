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
