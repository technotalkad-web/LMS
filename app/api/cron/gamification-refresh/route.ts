import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";

/**
 *   POST /api/cron/gamification-refresh
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Refreshes the leaderboard materialized views (mv_leaderboard,
 * mv_team_leaderboard) via public.refresh_gamification_views()
 * (migration 0053). CONCURRENTLY keeps boards queryable during refresh.
 *
 * Scheduled every 15 minutes from .github/workflows/cron.yml — the
 * "live-feeling" cadence the product asked for. Personal XP/streak stats
 * are write-time fresh; only org-wide rankings ride this refresh.
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

  if (error) {
    return { ok: false, total_ms, error: error.message };
  }
  return { ok: true, total_ms, views: data };
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
