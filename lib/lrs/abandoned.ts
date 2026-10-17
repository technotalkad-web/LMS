import type { SupabaseClient } from "@supabase/supabase-js";
import { derivedStatementsSkip, loadLrsConfig } from "./config";
import { loadAttemptContexts, loadGroupMembership } from "./context";
import { abandonedBuilt, enqueueBuilt, type Built } from "./sweep";

/**
 * Live "abandoned" statement for the tenant LRS, queued at every abandon site
 * (language switch, force-restart replace on both upload paths, the launch
 * page's grant-retake and deactivated-slot closes, the per-version restart of
 * ADR 0008).
 *
 * Why: the sweeper sends "abandoned" only for attempts it reads while they are
 * already abandoned, and its attempts cursor (started_at) only moves forward,
 * so an attempt abandoned after the cursor passed it kept only "launched" and
 * stayed open in the tenant LRS.
 *
 * Same statement as the sweeper (abandonedBuilt: same builder, same uuid5 id,
 * same timestamp), same outbox write (enqueueBuilt: unique on org + statement
 * id, first copy wins), same org gate (derivedStatementsSkip: no forwarding
 * configured → no row). Never posts: the outbox drainer delivers. Fail-soft:
 * resolves on every error, so an LRS problem never fails or undoes an abandon.
 * Only rows whose status is 'abandoned' when read are queued.
 *
 * Batches (force restart, per-version restart, direct-upload replace) are
 * built in slices of SLICE attempts, so no `.in()` list outgrows the URL
 * limit (the context loader turns a failed read into "no rows"), and above
 * GROUPS_BATCH attempts the org's group membership is loaded once, as the
 * sweeper does, so every statement keeps the learner's groups.
 */
const SLICE = 150;
/** loadLearnerDims resolves groups per user only for this many pairs. */
const GROUPS_BATCH = 3;

export async function enqueueAbandonedStatements(svc: SupabaseClient, attemptIds: string[]): Promise<void> {
  try {
    const ids = [...new Set(attemptIds.filter(Boolean))];
    if (ids.length === 0) return;
    type Row = { id: string; organization_id: string; status: string | null; started_at: string | null; last_activity_at: string | null };
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += SLICE) {
      const { data, error } = await svc
        .from("course_attempts")
        .select("id, organization_id, status, started_at, last_activity_at")
        .in("id", ids.slice(i, i + SLICE));
      if (error) {
        console.warn("[lrs] abandoned enqueue skipped: attempts read failed:", error.message);
        return;
      }
      rows.push(...((data ?? []) as Row[]));
    }
    const byOrg = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.status !== "abandoned" || !r.organization_id) continue;
      (byOrg.get(r.organization_id) ?? byOrg.set(r.organization_id, []).get(r.organization_id)!).push(r);
    }
    for (const [orgId, list] of byOrg) {
      try {
        if (derivedStatementsSkip(await loadLrsConfig(orgId, svc))) continue;
        const groups = list.length > GROUPS_BATCH ? await loadGroupMembership(svc, orgId) : undefined;
        for (let i = 0; i < list.length; i += SLICE) {
          const slice = list.slice(i, i + SLICE);
          // One failing slice never drops the others.
          try {
            const ctxs = await loadAttemptContexts(svc, slice.map((r) => r.id), groups);
            if (ctxs.size < slice.length) {
              console.warn(`[lrs] abandoned enqueue: context loaded for ${ctxs.size} of ${slice.length} attempts in org`, orgId);
            }
            const built: Built[] = [];
            for (const r of slice) {
              const ctx = ctxs.get(r.id);
              const b = ctx ? abandonedBuilt(ctx, r) : null;
              if (b) built.push(b);
            }
            await enqueueBuilt(svc, orgId, built);
          } catch (e) {
            console.warn("[lrs] abandoned enqueue failed for a slice in org", orgId, e instanceof Error ? e.message : "");
          }
        }
      } catch (e) {
        console.warn("[lrs] abandoned enqueue failed for org", orgId, e instanceof Error ? e.message : "");
      }
    }
  } catch (e) {
    console.warn("[lrs] abandoned enqueue failed:", e instanceof Error ? e.message : "");
  }
}
