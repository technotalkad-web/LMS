import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

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

async function run() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const t0 = Date.now();
  const { data, error } = await svc.rpc("refresh_report_views");
  const total_ms = Date.now() - t0;

  if (error) {
    return {
      ok: false,
      total_ms,
      error: error.message,
    };
  }

  return {
    ok: true,
    total_ms,
    ...(data as Record<string, unknown>),
  };
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  return NextResponse.json(result, {
    status: result.ok ? 200 : 500,
  });
}

// Cloudflare Workers cron triggers fire via the worker\'s scheduled
// handler. The same handler shape used by the other /api/cron/*
// routes (POST + GET reusing POST for manual curl convenience) is
// preserved here.
export const GET = POST;
