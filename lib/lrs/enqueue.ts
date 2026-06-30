import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadLrsConfig } from "./config";
import { forwardStatements } from "./forward";
import type { XapiStatement } from "@/lib/xapi/types";

/**
 * Fan-out hook called from the xAPI ingestion route AFTER our own statements
 * are stored. Entirely fail-isolated and non-blocking: it enqueues the
 * statement(s) to the durable outbox and (on Workers) fires an immediate
 * best-effort forward via waitUntil. Any error here is swallowed — it must
 * never affect the learner runtime or our internal LRS copy.
 */
function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function orgForAttempt(attemptId: string): Promise<string | null> {
  const { data } = await svc()
    .from("course_attempts")
    .select("organization_id")
    .eq("id", attemptId)
    .maybeSingle();
  return (data?.organization_id as string | undefined) ?? null;
}

/** Mark a set of (org, statement_id) outbox rows as delivered. */
async function markSent(orgId: string, statementIds: string[]) {
  if (!statementIds.length) return;
  await svc()
    .from("lrs_forward_outbox")
    .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
    .eq("organization_id", orgId)
    .in("statement_id", statementIds)
    .neq("status", "sent");
}

/**
 * Enqueue + (best-effort) immediately forward. Returns silently on any problem.
 */
export async function mirrorToExternalLrs(
  attemptId: string,
  statements: XapiStatement[]
): Promise<void> {
  try {
    const orgId = await orgForAttempt(attemptId);
    if (!orgId) return;

    const cfg = await loadLrsConfig(orgId);
    if (!cfg?.enabled || !cfg.endpoint) return;

    const ids = statements.map((s) => s.id).filter(Boolean) as string[];
    if (!ids.length) return;

    // 1) Durable enqueue (idempotent on (org, statement_id)).
    const rows = statements
      .filter((s) => s.id)
      .map((s) => ({
        organization_id: orgId,
        attempt_id: attemptId,
        statement_id: s.id as string,
        payload: s as unknown as Record<string, unknown>,
        status: "pending" as const,
      }));
    await svc()
      .from("lrs_forward_outbox")
      .upsert(rows, { onConflict: "organization_id,statement_id", ignoreDuplicates: true });

    // 2) Real-time best-effort forward AFTER the response (Workers only). The
    //    cron drainer is the durable safety net for everything else.
    const job = (async () => {
      try {
        const res = await forwardStatements(
          {
            endpoint: cfg.endpoint!,
            auth_key: cfg.auth_key,
            auth_secret: cfg.auth_secret,
            xapi_version: cfg.xapi_version,
          },
          statements
        );
        if (res.ok) {
          await markSent(orgId, ids);
        } else {
          await svc()
            .from("lrs_forward_outbox")
            .update({ last_error: res.error ?? "forward failed" })
            .eq("organization_id", orgId)
            .in("statement_id", ids)
            .neq("status", "sent");
        }
      } catch {
        /* leave pending; cron retries */
      }
    })();

    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const cf = getCloudflareContext();
      cf.ctx.waitUntil(job);
    } catch {
      // No Workers execution context (e.g. local dev) — don't block the
      // response; the cron drainer will deliver. Intentionally not awaited.
      void job;
    }
  } catch {
    /* fully fail-isolated */
  }
}
