import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 * Liveness heartbeat for scheduled jobs. Every /api/cron/* route calls
 * recordHeartbeat(<job name>) at the end of a run (including runs that found
 * no work — a quiet period must still read as "alive"). /api/ops/health then
 * flags any job whose last_run_at is older than its expected cadence.
 *
 * Fully fail-isolated: a missing table (migration 0050 not applied yet) or a
 * transient DB error must never break the cron itself — same contract as
 * mirrorToExternalLrs.
 */
function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function recordHeartbeat(
  name: string,
  detail?: Record<string, unknown>,
  ok: boolean = true
): Promise<void> {
  try {
    await svc()
      .from("ops_heartbeats")
      .upsert(
        {
          name,
          last_run_at: new Date().toISOString(),
          last_status: ok ? "ok" : "error",
          last_detail: detail ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "name" }
      );
  } catch {
    /* never let observability break the job being observed */
  }
}
