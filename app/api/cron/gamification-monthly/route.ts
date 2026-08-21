import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";

/**
 *   POST /api/cron/gamification-monthly
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Closes the previous org-local month: writes gamification_recognitions
 * (Learner of the Month, Most Active, Highest Scorer, Most Improved,
 * Longest Streak, Team Top) and mints the monthly badges (top_3,
 * most_improved, learning_champion) via public.gamification_close_month()
 * (migration 0053). Idempotent — the unique (org, period, category, rank)
 * key makes re-runs no-ops, so a failed run can simply be re-fired.
 *
 * Scheduled 00:30 UTC on the 1st (= 06:00 IST) from cron.yml.
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
  const { data, error } = await svc.rpc("gamification_close_month");
  const total_ms = Date.now() - t0;

  if (error) {
    return { ok: false, total_ms, error: error.message };
  }
  return { ok: true, total_ms, orgs: data };
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  await recordHeartbeat("gamification-monthly", result, result.ok);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export const GET = POST;
