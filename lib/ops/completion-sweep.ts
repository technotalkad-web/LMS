/**
 * The completion sweep's drain and its error rule (ADR 0024 step 16, as the
 * note of 2026-11-16 restates it, items 4 to 6; migration 0112). Both cron
 * routes that refresh views call it before their refresh RPC:
 * app/api/cron/gamification-refresh (every 15 minutes) and
 * app/api/cron/refresh-report-views (daily).
 *
 * Why. From 0107 the two refresh functions ran the completion sweep inside
 * the refresh's own statement. A backlog of a hundred and fifty rows made
 * the statement reach the role's timeout (57014), and a timeout cancel rolls
 * the whole statement back, the handled rows included, so the backlog could
 * never drain through PostgREST. 0112 gives the refresh's sweep a 1.5 s box
 * and adds sweep_completion_side_effects_timed(p_limit, p_budget_ms), which
 * the routes call here in statements of their own, each its own commit.
 *
 * The drain. Up to `maxCalls` sequential calls of
 * sweep_completion_side_effects_timed(200, 5000). It stops at:
 *   - `stopped` 'done' (the queue ended) or 'busy' (another sweeper holds the
 *     key: the other route, staging's nightly refresh or the staging job);
 *     neither is an error, and 'busy' is never a stall;
 *   - an error answer (57014 included: with the box it should not happen,
 *     and if it does it must read red); PGRST202 (no such function: a
 *     database without 0112, production until the sitting) reads "no drain"
 *     and is not an error;
 *   - the second of two consecutive stalled calls; a call is stalled when it
 *     handled 0 rows, failed at least 1 and stopped on 'time' or 'limit'
 *     (failing rows fill the head of the queue, which is oldest first, and
 *     nothing behind them is reached). One stalled call alone is about 5 s of
 *     lock waits on the head rows and is never red; a call that handles a
 *     row resets the count;
 *   - `maxCalls` (4 for the gamification route, 8 for the report route). A
 *     stall on the run's last call is reported in `stalled` and the next run
 *     decides.
 * The routes then run their refresh RPC in every case.
 *
 * The summary, `completion_sweep_drain` in each route's body and heartbeat:
 * {calls, candidates, handled, failed, stalled, stopped, ms}, numbers and one
 * word, never an id (the SQL answer's `errors` hold attempt ids and are
 * dropped here). `stopped` is why the drain ended: 'done', 'busy', 'time' or
 * 'limit' (the last call's own word, when the run used all its calls),
 * 'stalled', 'error', or 'absent' (PGRST202: no drain on this database).
 *
 * The error rule (step 81 for the report route, ruling A4 for the
 * gamification route, both restated by the note's item 5), as
 * completionSweepFailure answers it; the route answers 500, `ok` false,
 * `error` "completion_sweep: <message>" and a heartbeat reading "error" when:
 *   1. a drain call answered an error other than PGRST202;
 *   2. the refresh answer's completion_sweep entry carries its own error;
 *   3. the drain read PGRST202 while the refresh answer's `sweep` carries
 *      `stopped`: 0112 is there and the Data API does not see its function
 *      ("drain function not visible"), which would otherwise read green for
 *      ever;
 *   4. with STALL_READS_RED (the note's D-S4), the drain stopped on two
 *      consecutive stalled calls ("stalled (N failed, 0 handled, 2 calls)").
 * Not an error: a call that stopped on its box, its limit or 'busy'; rows in
 * `failed`; a view entry's error; an answer without the entry (a database
 * without 0107); a PGRST202 drain on a database whose refresh carries no
 * timed sweep.
 *
 * Ruling A4's "each route keeps its own copy, no new file" is replaced by
 * the note's item 6: completionSweepError lives here and both routes import
 * it, because the drain loop has rules that need one test
 * (tests/unit/completion-sweep-drain.test.ts).
 *
 * Subrequests. Each drain call is one POST (`.rpc()`; Next's fetch dedupe
 * only touches GET and HEAD, and route handlers are outside it). The
 * gamification route counts them inside the held-webhook rule's per-row
 * `+ 2` (lib/integrations/webhook-hold.ts, header), which holds while
 * GAMIFICATION_DRAIN_MAX_CALLS is at most 2 x SWEEP_MAX_SCANNED
 * (tests/unit/webhook-hold-route.test.ts pins it).
 *
 * No next/* import and no runtime Supabase import, so unit tests load this
 * file; the client is passed in.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** The function the routes call, 0112's. */
export const DRAIN_FUNCTION = "sweep_completion_side_effects_timed";
/** Rows a call may take, and its box in milliseconds (the note's item 4). */
export const DRAIN_LIMIT = 200;
export const DRAIN_BUDGET_MS = 5000;
/** The calls a run may make: the 15-minute route, and the daily route. */
export const GAMIFICATION_DRAIN_MAX_CALLS = 4;
export const REPORT_DRAIN_MAX_CALLS = 8;
/**
 * The note's D-S4 ("a sweep that stalls twice in a row reads red";
 * recommended yes). It becomes current text only on the owner's answer:
 * with false the helper still stops at the second stalled call and reports
 * it in `completion_sweep_drain`, and the route stays green.
 */
export const STALL_READS_RED = true;

/** PostgREST's code for a function it cannot find in its schema cache. */
const NO_FUNCTION = "PGRST202";

export type DrainStop = "done" | "busy" | "time" | "limit" | "stalled" | "error" | "absent";

export type CompletionSweepDrain = {
  calls: number;
  candidates: number;
  handled: number;
  failed: number;
  stalled: number;
  stopped: DrainStop;
  ms: number;
};

export type DrainRun = {
  /** The summary the routes put in their body and heartbeat. */
  drain: CompletionSweepDrain;
  /** A drain call's own error (not PGRST202), or null. */
  error: string | null;
  /** Rows failed in the two consecutive stalled calls the run stopped on (0 otherwise). */
  stallFailed: number;
};

type CallAnswer = { candidates: number; handled: number; failed: number; stopped: "done" | "limit" | "time" | "busy" };

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** One call's answer, or null when it is not 0112's shape. */
function readAnswer(data: unknown): CallAnswer | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const candidates = count(d.candidates);
  const handled = count(d.handled);
  const failed = count(d.failed);
  const stopped = d.stopped;
  if (candidates === null || handled === null || failed === null) return null;
  if (stopped !== "done" && stopped !== "limit" && stopped !== "time" && stopped !== "busy") return null;
  return { candidates, handled, failed, stopped };
}

/** A call that handled nothing, failed something, and ran out of box or limit. */
export function isStalled(a: { handled: number; failed: number; stopped: string }): boolean {
  return a.handled === 0 && a.failed >= 1 && (a.stopped === "time" || a.stopped === "limit");
}

/**
 * Up to `maxCalls` sequential calls of the timed sweep, each its own
 * statement; never throws. See the header for when it stops.
 */
export async function drainCompletionSweep(svc: AnyClient, maxCalls: number): Promise<DrainRun> {
  const t0 = Date.now();
  const limit = Math.max(1, Math.floor(maxCalls));
  const drain: CompletionSweepDrain = { calls: 0, candidates: 0, handled: 0, failed: 0, stalled: 0, stopped: "done", ms: 0 };
  let error: string | null = null;
  let stallFailed = 0;
  let inARow = 0;
  let lastFailed = 0;

  for (let i = 0; i < limit; i++) {
    drain.calls++;
    let data: unknown;
    let callError: { code?: unknown; message?: unknown } | null = null;
    try {
      const res = await svc.rpc(DRAIN_FUNCTION, { p_limit: DRAIN_LIMIT, p_budget_ms: DRAIN_BUDGET_MS });
      data = res?.data;
      callError = res?.error ?? null;
    } catch (e) {
      callError = { message: errorText(e) };
    }
    if (callError) {
      if (callError.code === NO_FUNCTION) {
        drain.stopped = "absent";
      } else {
        drain.stopped = "error";
        error = errorText(callError);
      }
      break;
    }
    const a = readAnswer(data);
    if (!a) {
      drain.stopped = "error";
      error = `${DRAIN_FUNCTION} answered an unexpected shape`;
      break;
    }
    drain.candidates += a.candidates;
    drain.handled += a.handled;
    drain.failed += a.failed;
    drain.stopped = a.stopped;
    if (isStalled(a)) {
      drain.stalled++;
      inARow++;
      if (inARow >= 2) {
        stallFailed = lastFailed + a.failed;
        drain.stopped = "stalled";
        break;
      }
      lastFailed = a.failed;
    } else {
      inARow = 0;
      lastFailed = 0;
    }
    if (a.stopped === "done" || a.stopped === "busy") break;
  }
  drain.ms = Date.now() - t0;
  return { drain, error, stallFailed };
}

/**
 * The completion sweep's own error from a refresh function's answer, or null
 * (no entry, or its error null). Only the sweep's error counts: a row that
 * failed inside the sweep (sweep.failed) is retried by the next run, and a
 * view entry's error is reported in its entry.
 */
export function completionSweepError(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    if (entry && typeof entry === "object" && (entry as { view?: unknown }).view === "completion_sweep") {
      const err = (entry as { error?: unknown }).error;
      return err === null || err === undefined ? null : String(err);
    }
  }
  return null;
}

/** Whether the refresh answer's completion_sweep entry carries 0112's answer (its `sweep` has `stopped`). */
export function refreshSweepIsTimed(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  for (const entry of data) {
    if (entry && typeof entry === "object" && (entry as { view?: unknown }).view === "completion_sweep") {
      const sweep = (entry as { sweep?: unknown }).sweep;
      return !!sweep && typeof sweep === "object" && "stopped" in (sweep as Record<string, unknown>);
    }
  }
  return false;
}

/**
 * The note's item 5: the message after "completion_sweep: " when the route
 * must read red, or null. `refreshData` is the refresh RPC's answer (the
 * route reports an RPC error of the refresh itself by today's rule, before
 * this is asked).
 */
export function completionSweepFailure(run: DrainRun, refreshData: unknown, stallReadsRed: boolean = STALL_READS_RED): string | null {
  if (run.error !== null) return run.error;
  const own = completionSweepError(refreshData);
  if (own !== null) return own;
  if (run.drain.stopped === "absent" && refreshSweepIsTimed(refreshData)) return "drain function not visible";
  if (stallReadsRed && run.drain.stopped === "stalled") return `stalled (${run.stallFailed} failed, 0 handled, 2 calls)`;
  return null;
}
