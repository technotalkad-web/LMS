import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadLrsConfig } from "@/lib/lrs/config";
import { forwardStatements } from "@/lib/lrs/forward";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { sweepAll, type OrgSweepResult } from "@/lib/lrs/sweep";

/**
 *   POST /api/cron/lrs-forward      header: x-cron-secret: <CRON_SECRET>
 *
 * Durable drainer for the external-LRS outbox. Picks due pending/failed rows,
 * groups them per org, forwards each org's batch to its LRS, and updates status
 * with exponential backoff. Dead-letters after MAX_ATTEMPTS so a permanently
 * broken endpoint doesn't retry forever. Idempotent: statements carry their own
 * ids, so a re-send the LRS already has is a no-op.
 */
const BATCH = 200;
// Retry budget before a row dead-letters. With the 5-minute cron and the backoff
// below (2^n seconds, capped at 1 hour) 36 attempts cover roughly 27 hours of a
// continuous LRS outage; 8 covered about 40 minutes.
const MAX_ATTEMPTS = 36;

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

function backoffSeconds(attempts: number): number {
  return Math.min(Math.pow(2, attempts), 3600); // cap at 1h
}

export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("x-cron-secret") !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = svc();
  const nowIso = new Date().toISOString();

  // Drain FIRST, sweep AFTER. On Cloudflare Workers every database call is a
  // subrequest with a hard per-request budget; the sweeper is the expensive
  // part, so it must never starve the delivery of rows that are already due.
  // Rows the sweep enqueues in this run are picked up by the next run.
  const { data: due, error: dueError } = await db
    .from("lrs_forward_outbox")
    .select("id, organization_id, statement_id, payload, attempts")
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH);

  const rows = (due ?? []) as Array<{
    id: string;
    organization_id: string;
    statement_id: string;
    payload: unknown;
    attempts: number;
  }>;

  // 0078: derive LMS events / (re)enqueue history for every enabled org, sized
  // for the Worker budget: `statements` plus ONE rotating source per run, small
  // chunks. Raise LRS_SWEEP_CHUNK / LRS_SWEEP_ROTATE on a plan with a larger
  // subrequest budget. Fully fail-isolated; errors are reported, not hidden.
  const sweepOpts = {
    chunk: Math.max(10, parseInt(process.env.LRS_SWEEP_CHUNK || "50", 10) || 50),
    rotate: Math.max(0, parseInt(process.env.LRS_SWEEP_ROTATE || "1", 10) || 1),
  };
  const runSweep = async (): Promise<OrgSweepResult[]> => {
    try {
      return await sweepAll(sweepOpts);
    } catch {
      return [];
    }
  };
  const summarize = (sweep: OrgSweepResult[]) =>
    sweep.map((r) => ({
      org: r.orgId,
      ran: r.ran,
      enqueued: r.enqueued,
      caughtUp: r.caughtUp,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      ...(r.errors?.length ? { errors: r.errors } : {}),
    }));

  if (rows.length === 0) {
    const sweepSummary = summarize(await runSweep());
    const body = { ok: true, processed: 0, sweep: sweepSummary, ...(dueError ? { dueError: dueError.message } : {}) };
    await recordHeartbeat("lrs-forward", body);
    return NextResponse.json(body);
  }

  // Group by org so we forward each LRS one batch.
  const byOrg = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byOrg.get(r.organization_id) ?? [];
    arr.push(r);
    byOrg.set(r.organization_id, arr);
  }

  let sent = 0;
  let failed = 0;
  let dead = 0;

  for (const [orgId, orgRows] of byOrg) {
    const cfg = await loadLrsConfig(orgId);
    if (!cfg?.enabled || !cfg.endpoint) {
      // Forwarding turned off (or unconfigured) since enqueue — drop quietly.
      await db.from("lrs_forward_outbox").delete().in("id", orgRows.map((r) => r.id));
      continue;
    }

    const res = await forwardStatements(
      {
        endpoint: cfg.endpoint,
        auth_key: cfg.auth_key,
        auth_secret: cfg.auth_secret,
        xapi_version: cfg.xapi_version,
      },
      orgRows.map((r) => r.payload)
    );

    // Settle every row on its own outcome (the batch's when it was not split),
    // writing GROUPED updates: one per distinct (status, attempts) instead of one
    // per row, because every update is a Worker subrequest and a failed batch of
    // 50 rows used to cost 50 of them.
    const okIds: string[] = [];
    const groups = new Map<string, { ids: string[]; status: "failed" | "dead"; attempts: number; error: string }>();
    for (const r of orgRows) {
      const o = res.results ? res.results[r.statement_id] : res;
      if (!o || o.ok) {
        okIds.push(r.id);
        continue;
      }
      const attempts = r.attempts + 1;
      const isDead = o.permanent || attempts >= MAX_ATTEMPTS;
      const key = `${isDead ? "dead" : "failed"}|${attempts}`;
      const g = groups.get(key) ?? { ids: [], status: isDead ? "dead" : "failed", attempts, error: o.error ?? "forward failed" };
      g.ids.push(r.id);
      groups.set(key, g);
    }
    if (okIds.length) {
      await db
        .from("lrs_forward_outbox")
        .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
        .in("id", okIds);
      sent += okIds.length;
    }
    for (const g of groups.values()) {
      await db
        .from("lrs_forward_outbox")
        .update({
          status: g.status,
          attempts: g.attempts,
          last_error: g.error,
          next_attempt_at: new Date(Date.now() + backoffSeconds(g.attempts) * 1000).toISOString(),
        })
        .in("id", g.ids);
      if (g.status === "dead") dead += g.ids.length;
      else failed += g.ids.length;
    }
  }

  const sweepSummary = summarize(await runSweep());
  const body = { ok: true, processed: rows.length, sent, failed, dead, sweep: sweepSummary };
  await recordHeartbeat("lrs-forward", body);
  return NextResponse.json(body);
}
