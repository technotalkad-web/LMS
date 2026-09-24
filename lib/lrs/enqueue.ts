import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadLrsConfig, statementProfileOf } from "./config";
import { forwardStatements } from "./forward";
import { enrichStatement } from "./enrich";
import { loadAttemptContexts } from "./context";
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

/** Enriched copies (profile 'ambak-v1'), or the raw statements for 'raw' or
 *  whenever context/enrichment fails. Exported for the backfill job. */
export async function enrichForOutbox(
  attemptId: string,
  statements: XapiStatement[],
  profile: "ambak-v1" | "raw"
): Promise<XapiStatement[]> {
  if (profile === "raw") return statements;
  try {
    const ctx = (await loadAttemptContexts(svc(), [attemptId])).get(attemptId);
    if (!ctx) return statements;
    return statements.map((s) => {
      try {
        return enrichStatement(s, ctx);
      } catch {
        return s;
      }
    });
  } catch {
    return statements;
  }
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

    // 0078: the external copy carries the analytics profile (stable ids,
    // learner/content/path/journey dimensions). Our own xapi_statements row
    // stays the raw engine statement. Enrichment failing for any reason
    // falls back to the raw statement — the LRS never misses an event.
    const outbound = await enrichForOutbox(attemptId, statements, statementProfileOf(cfg));

    // 1) Durable enqueue (idempotent on (org, statement_id)).
    const rows = outbound
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
          outbound
        );
        if (res.results) {
          // Split delivery after a 409: mark only the accepted ids as sent; the
          // rest stay pending with the error for the cron drainer to retry.
          const okIds = ids.filter((id) => res.results![id]?.ok !== false);
          const badIds = ids.filter((id) => res.results![id]?.ok === false);
          await markSent(orgId, okIds);
          if (badIds.length) {
            await svc()
              .from("lrs_forward_outbox")
              .update({ last_error: res.error ?? "forward failed" })
              .eq("organization_id", orgId)
              .in("statement_id", badIds)
              .neq("status", "sent");
          }
        } else if (res.ok) {
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
