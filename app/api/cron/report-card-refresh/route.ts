import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { orgsNeedingCache, refreshOrgCache } from "@/lib/manager/cache";

/**
 *   POST /api/cron/report-card-refresh
 *   header: x-cron-secret: <CRON_SECRET env var>
 *
 * Every 15 minutes (.github/workflows/cron.yml): precompute Manager Report
 * Card insights for every active member of each organisation that uses an L3
 * mapping, for all four period windows, into report_card_cache (0093). The L3
 * screen reads these; L1/L2 stay live. Same rules as the live path.
 *
 * Bounded per run: organisations are processed in order (stalest people
 * first inside each) and the run stops at its time budget; the next run
 * continues, so every org converges within a few runs.
 */
const TIME_BUDGET_MS = 50_000;

export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("x-cron-secret") !== expected) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const started = Date.now();
  const orgs = await orgsNeedingCache(svc);
  // Rotate the starting point by the quarter-hour so a long list is not
  // always cut at the same organisation.
  const offset = orgs.length ? Math.floor(Date.now() / (15 * 60 * 1000)) % orgs.length : 0;
  const ordered = [...orgs.slice(offset), ...orgs.slice(0, offset)];
  const deadline = started + TIME_BUDGET_MS;
  const done: Array<{ org: string; learners: number; batches: number; pending: number }> = [];
  const errors: Array<{ org: string; error: string }> = [];
  let skipped = 0;
  for (const org of ordered) {
    if (Date.now() > deadline) { skipped++; continue; }
    try {
      const r = await refreshOrgCache(svc, org, deadline);
      done.push({ org: org.slug, ...r });
    } catch (e) {
      errors.push({ org: org.slug, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const pending = done.reduce((n, d) => n + d.pending, 0);
  const summary = { orgs: orgs.length, refreshed: done.length, skipped, pending, errors: errors.length, ms: Date.now() - started };
  await recordHeartbeat("report-card-refresh", summary, errors.length === 0);
  return NextResponse.json({ ...summary, done, errors });
}
