import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadLrsConfig } from "@/lib/lrs/config";
import { forwardStatements } from "@/lib/lrs/forward";
import { recordHeartbeat } from "@/lib/ops/heartbeat";

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
const MAX_ATTEMPTS = 8;

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

  const { data: due } = await db
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
  if (rows.length === 0) {
    await recordHeartbeat("lrs-forward", { processed: 0 });
    return NextResponse.json({ ok: true, processed: 0 });
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

    if (res.ok) {
      await db
        .from("lrs_forward_outbox")
        .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
        .in("id", orgRows.map((r) => r.id));
      sent += orgRows.length;
      continue;
    }

    // Failure: per-row attempts++, backoff, dead-letter past the cap or on
    // permanent errors (bad creds / malformed) that won't improve with retry.
    for (const r of orgRows) {
      const attempts = r.attempts + 1;
      const isDead = res.permanent || attempts >= MAX_ATTEMPTS;
      await db
        .from("lrs_forward_outbox")
        .update({
          status: isDead ? "dead" : "failed",
          attempts,
          last_error: res.error ?? "forward failed",
          next_attempt_at: new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString(),
        })
        .eq("id", r.id);
      if (isDead) dead += 1;
      else failed += 1;
    }
  }

  await recordHeartbeat("lrs-forward", { processed: rows.length, sent, failed, dead });
  return NextResponse.json({ ok: true, processed: rows.length, sent, failed, dead });
}
