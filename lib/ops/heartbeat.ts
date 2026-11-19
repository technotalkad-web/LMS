import { createClient as createServiceClient } from "@supabase/supabase-js";
import { carriedLastOk } from "./health-status";

/**
 * Liveness heartbeat for scheduled jobs. Every /api/cron/* route calls
 * recordHeartbeat(<job name>) at the end of a run (including runs that found
 * no work — a quiet period must still read as "alive"). /api/ops/health then
 * flags any job whose last_run_at is older than its expected cadence, and a
 * job of its ERRORED_WARN list whose last run passed ok = false
 * (lib/ops/health-status.ts).
 *
 * Not every row is a job: MAIL_RECIPIENTS_HEARTBEAT (lib/ops/health-status.ts)
 * marks the latest request that skipped its mail because the recipient read
 * failed (ADR 0029). No cadence list names it, so the cron check ignores it;
 * the `mail_recipients` check reads its age.
 *
 * Optional fourth argument (ADR 0029): with { carryLastOk: true } an errored
 * run looks up its previous row first and stores last_ok_at derived from it
 * (carriedLastOk), so the time of the last success survives a streak of
 * failures. A successful run skips that lookup and stores no last_ok_at,
 * since its own last_run_at already answers the question. Only the two mail
 * crons use it.
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

export type HeartbeatOptions = {
  /** Carry the last successful run into a failed run's detail (the two mail crons only). */
  carryLastOk?: boolean;
};

export async function recordHeartbeat(
  name: string,
  detail?: Record<string, unknown>,
  ok: boolean = true,
  options: HeartbeatOptions = {}
): Promise<void> {
  try {
    const db = svc();
    let lastDetail: Record<string, unknown> | null = detail ?? null;
    if (options.carryLastOk) {
      // last_ok_at is this function's to write: a caller's value never passes.
      const own: Record<string, unknown> = { ...(detail ?? {}) };
      delete own.last_ok_at;
      if (!ok) {
        let prev: { last_status: string; last_run_at: string; last_detail: unknown } | null | "unreadable";
        try {
          const { data, error } = await db
            .from("ops_heartbeats")
            .select("last_status, last_run_at, last_detail")
            .eq("name", name)
            .maybeSingle();
          prev = error ? "unreadable" : ((data as typeof prev) ?? null);
        } catch {
          prev = "unreadable";
        }
        const lastOk = carriedLastOk(prev);
        if (lastOk) own.last_ok_at = lastOk;
      }
      lastDetail = own;
    }
    await db
      .from("ops_heartbeats")
      .upsert(
        {
          name,
          last_run_at: new Date().toISOString(),
          last_status: ok ? "ok" : "error",
          last_detail: lastDetail,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "name" }
      );
  } catch {
    /* never let observability break the job being observed */
  }
}
