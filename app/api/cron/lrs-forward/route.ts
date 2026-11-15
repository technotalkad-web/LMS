import { NextResponse } from "next/server";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/db/chunked";
import { loadLrsConfig } from "@/lib/lrs/config";
import { forwardStatements, idOf, shuffled } from "@/lib/lrs/forward";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { sweepAll, type OrgSweepResult } from "@/lib/lrs/sweep";
import { isMissingColumn } from "@/lib/scoring/attempt-kind";

/**
 *   POST /api/cron/lrs-forward      header: x-cron-secret: <CRON_SECRET>
 *
 * Durable drainer for the external-LRS outbox. Picks due pending/failed rows,
 * groups them per org, forwards each org's batch to its LRS, and updates status
 * with exponential backoff. Dead-letters after MAX_ATTEMPTS so a permanently
 * broken endpoint doesn't retry forever. Idempotent: statements carry their own
 * ids, so a re-send the LRS already has is a no-op. A Preview's rows are never
 * posted (previewRowIds; ADR 0024 A35) and never deleted here: they are parked
 * (PARK_UNTIL). Preview data is kept until an authorised admin deletes it by
 * hand: the explicit purge of step 80 (purge_preview_data, by attempt_id)
 * deletes a new-kind preview's outbox rows, and the earlier by-role rows are
 * preserved (reading R26). A parked row keeps its status: a dead letter would
 * breach ops health.
 */
const BATCH = 200;
// Retry budget before a row dead-letters. With the 5-minute cron and the backoff
// below (2^n seconds, capped at 1 hour) 36 attempts cover roughly 27 hours of a
// continuous LRS outage; 8 covered about 40 minutes.
const MAX_ATTEMPTS = 36;
/**
 * Where a Preview's outbox row is parked (ADR 0024 A35, P2-3): next_attempt_at
 * this far ahead, a timestamp Postgres timestamptz accepts, takes the row out
 * of every due select and out of the ops health backlog (rows due 15 minutes
 * ago) with its status, attempts and payload unchanged. "Resend all history"
 * sets a parked row that is not pending back to pending and now; the next drain
 * checks it and parks it again. Not exported: a route file exports handlers only.
 */
const PARK_UNTIL = "2999-12-31T00:00:00.000Z";
/** A parked row's last_error: why it is never forwarded. */
const PARK_REASON = "preview: never forwarded (ADR 0024 A35)";

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

type DueRow = {
  id: string;
  organization_id: string;
  statement_id: string;
  payload: unknown;
  attempts: number;
  attempt_id: string | null;
};

/**
 * The rows of a due batch whose attempt is a Preview (ADR 0024 decision A35,
 * step 80; P2-3). The live mirror and the sweep's sources drop previews
 * before they enqueue, but rows queued before that (a staff member's by-role
 * row) can still be due, "Resend all history" sets the org's rows that are
 * not pending back to pending and due now (lib/lrs/sweep.ts: sent, failed and
 * dead-lettered rows, a parked failed row included; a parked pending row
 * stays parked), and the points and journey-day sources can name a preview's
 * attempt. So the drain asks, once per batch, which of the attempts its rows
 * name are previews, and parks their rows (PARK_UNTIL): never posted, and
 * never deleted here. The explicit purge of step 80 (purge_preview_data, by
 * attempt_id) is what deletes a new-kind preview's outbox rows; the by-role
 * rows are preserved (reading R26).
 *
 * Reads `context_kind = 'preview'` only, in slices of 150 ids. Not through
 * readWithContextFilter: its fallback drops the filter, which here would
 * select every attempt. A missing-column error naming context_kind (a
 * database without 0107; isMissingColumn) means no attempt there is a
 * preview: none, today's drain. Any other error, or an answer with neither
 * rows nor an error, answers `{ error }`, and the caller holds every row
 * that names an attempt, so a failed read never lets a preview out. Only the
 * attempts this read finds are previews: an attempt_id with no course_attempts
 * row (the outbox keeps the id without a foreign key, and an attempt goes with
 * its user's or its course version's cascade) is not in the answer, so its row
 * is posted as a real attempt's is.
 */
async function previewRowIds(db: SupabaseClient, rows: DueRow[]): Promise<{ ids: Set<string> } | { error: string }> {
  const attemptIds = [...new Set(rows.map((r) => r.attempt_id).filter((id): id is string => !!id))];
  const previews = new Set<string>();
  for (const part of chunk(attemptIds, 150)) {
    const { data, error } = await db.from("course_attempts").select("id").in("id", part).eq("context_kind", "preview");
    if (error) {
      if (isMissingColumn(error, "context_kind")) return { ids: new Set() };
      return { error: error.message || "attempts read failed" };
    }
    if (!data) return { error: "attempts read answered neither rows nor an error" };
    for (const a of data as Array<{ id: string }>) previews.add(a.id);
  }
  return { ids: new Set(rows.filter((r) => r.attempt_id !== null && previews.has(r.attempt_id)).map((r) => r.id)) };
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
    .select("id, organization_id, statement_id, payload, attempts, attempt_id")
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH);

  let rows = (due ?? []) as DueRow[];

  // A Preview is never forwarded (previewRowIds). Its rows leave this run's
  // batch before any post and are parked, never deleted here (preview data is
  // kept until an authorised admin deletes it by hand; reading R26 preserves
  // the by-role rows): next_attempt_at = PARK_UNTIL and PARK_REASON in
  // last_error, status, attempts and payload unchanged, in slices of 150 ids.
  // A failed park write is reported (parkError) and its rows come back due next
  // run, checked again, still never posted. A failed check holds every row that
  // names an attempt for the next run, untouched, as a failed config read does,
  // and lets only the rows that name none go out.
  //
  // Either failure makes the run not-OK (the owner's decision of 2026-11-15;
  // ADR 0024, the note of that date): the body and the heartbeat answer
  // ok: false with a `reason` that names the check and counts rows only (the
  // error text stays in previewCheckError or parkError), so ops health reads
  // warn (ERRORED_WARN in app/api/ops/health/route.ts). The HTTP status stays
  // 200. Every other outcome is OK, as before, a failed due read included.
  const previewCheck: { previewsParked?: number; parkError?: string; held?: number; previewCheckError?: string } = {};
  let notOk: string | undefined;
  if (rows.some((r) => r.attempt_id)) {
    const check = await previewRowIds(db, rows);
    if ("error" in check) {
      const before = rows.length;
      rows = rows.filter((r) => !r.attempt_id);
      previewCheck.held = before - rows.length;
      previewCheck.previewCheckError = check.error;
      notOk = `preview check failed: held ${previewCheck.held}`;
    } else if (check.ids.size > 0) {
      rows = rows.filter((r) => !check.ids.has(r.id));
      let parked = 0;
      for (const part of chunk([...check.ids], 150)) {
        const { error } = await db
          .from("lrs_forward_outbox")
          .update({ next_attempt_at: PARK_UNTIL, last_error: PARK_REASON })
          .in("id", part);
        if (error) previewCheck.parkError ??= error.message || "park write failed";
        else parked += part.length;
      }
      previewCheck.previewsParked = parked;
      if (previewCheck.parkError) notOk = `park write failed: ${check.ids.size - parked} of ${check.ids.size} not parked`;
    }
  }
  const verdict: { ok: boolean; reason?: string } = notOk ? { ok: false, reason: notOk } : { ok: true };

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
    const body = { ...verdict, processed: 0, ...previewCheck, sweep: sweepSummary, ...(dueError ? { dueError: dueError.message } : {}) };
    await recordHeartbeat("lrs-forward", body, verdict.ok);
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
  let unsettled = 0;

  for (const [orgId, orgRows] of byOrg) {
    const cfg = await loadLrsConfig(orgId);
    // Null is a failed read, or no config row, and the two look alike. Neither says
    // forwarding is off, so the rows stay due for the next run.
    if (!cfg) continue;
    if (!cfg.enabled || !cfg.endpoint) {
      // Forwarding turned off (or unconfigured) since enqueue — drop quietly.
      await db.from("lrs_forward_outbox").delete().in("id", orgRows.map((r) => r.id));
      continue;
    }

    // The isolation walk starts at the head of the list. When every row it reaches
    // fails, nothing was accepted and the rows it did not reach count an attempt
    // unposted, so the same rows leading run after run would take the others to
    // dead-letter with them. A batch with a row that has already failed therefore
    // goes in a new order. A first send keeps its order.
    const sendOrder = orgRows.some((r) => r.attempts > 0) ? shuffled(orgRows) : orgRows;

    const res = await forwardStatements(
      {
        endpoint: cfg.endpoint,
        auth_key: cfg.auth_key,
        auth_secret: cfg.auth_secret,
        xapi_version: cfg.xapi_version,
      },
      sendOrder.map((r) => r.payload)
    );

    // Settle every row on its own outcome (the batch's when it was not split),
    // writing GROUPED updates: one per distinct (status, attempts) instead of one
    // per row, because every update is a Worker subrequest and a failed batch of
    // 50 rows used to cost 50 of them.
    const okIds: string[] = [];
    const unsettledIds: string[] = [];
    const groups = new Map<string, { ids: string[]; status: "failed" | "dead"; attempts: number; error: string }>();
    for (const r of orgRows) {
      // results is keyed by the id inside each payload, which can differ from
      // statement_id: the sweep reads statement_id from a uuid column (lower
      // case) and the payload keeps the id as the engine sent it. A row with no
      // outcome is never counted as sent.
      const o = res.results ? res.results[idOf(r.payload)] : res;
      if (o?.ok) {
        okIds.push(r.id);
        continue;
      }
      if (o?.unsettled) {
        unsettledIds.push(r.id);
        continue;
      }
      const attempts = r.attempts + 1;
      const isDead = o?.permanent || attempts >= MAX_ATTEMPTS;
      const key = `${isDead ? "dead" : "failed"}|${attempts}`;
      const g = groups.get(key) ?? { ids: [], status: isDead ? "dead" : "failed", attempts, error: o?.error ?? "forward failed" };
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
    if (unsettledIds.length) {
      // Not reached in this run, and nothing against them: no attempt counted.
      // next_attempt_at = now keeps them due and puts them behind rows already
      // waiting, this org's or another's, as a failed row's backoff would.
      await db
        .from("lrs_forward_outbox")
        .update({ last_error: "not reached in this run: isolation budget exhausted", next_attempt_at: new Date().toISOString() })
        .in("id", unsettledIds);
      unsettled += unsettledIds.length;
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
  const body = { ...verdict, processed: rows.length, sent, failed, dead, unsettled, ...previewCheck, sweep: sweepSummary };
  await recordHeartbeat("lrs-forward", body, verdict.ok);
  return NextResponse.json(body);
}
