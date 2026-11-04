/**
 * Completion webhook timing for cmi5 and xAPI (ADR 0015 steps 2, 5 and 6):
 * the pure decision the statements route takes after each batch, the sweep
 * that runs as a step of /api/cron/gamification-refresh, and the Attention
 * Center summary of held rows. They live in one file so that the sweep and
 * the provider share one definition of "held".
 *
 * The rule (ADR 0015 step 1). An AU `completed` that carries no result does
 * not fire the CRM `course_completed` message by itself. The message for an
 * official cmi5 or xAPI attempt fires when the attempt is complete and one of
 * three things is true in the request:
 *   - its pass/fail became known or changed in this request;
 *   - the statement that completed it carried `result.success` (plain xAPI's
 *     course-level `passed`/`failed` with `result.completion: true`);
 *   - a `terminated` was processed in this batch while the latch
 *     (`completion_webhook_at`) was strictly null before the request.
 * Otherwise the completion is held: no message, no latch. A later request
 * that meets the rule releases it, or the sweep does once it is
 * WEBHOOK_HOLD_MINUTES old. So a scored module fires within seconds, an
 * unscored cmi5 module at the session's exit, and an unscored plain-xAPI
 * module from the sweep.
 *
 * The re-fire (ADR 0015 step 4). When an attempt becomes passed after a
 * message that said `passed: false` (a fail then a pass, or a pass after a
 * message sent without a result), one second message follows, always
 * `passed: true`, through a compare-and-set on the latch. So at most two
 * messages go out per official attempt; nothing else is re-sent.
 *
 * decideCompletionWebhook applies its rules in this order and no other:
 * (a) not official, or not complete after the request: none; (b) the re-fire;
 * (b') already fired: none; (c) fire; (d) hold. In (c) the latch is tested
 * with `=== null`, never `!x`: `undefined` means the route could not read the
 * column (a database without 0082), and then the `terminated` branch must stay
 * inert, because the fire function falls through to firing when its latch
 * update answers a missing column and would fire on every later `terminated`
 * of an unscored module.
 *
 * The start date. WEBHOOK_HOLD_SWEEP_FROM bounds the sweep and the provider
 * from below: rows completed before it were handled under the old rule and
 * are never touched, whatever their latch (the CRM reconciles them through
 * learner-summary). The rule (ADR 0015 step 5): the UTC date this record's
 * build first reaches staging; one value for both environments; never moved
 * after the build is live anywhere. The placeholder is replaced once,
 * in the last commit before the merge, with the UTC date of the owner's
 * staging deploy, and corrected before the merge if that deploy slips. Until
 * that commit the constant holds the UTC date on which it was first written.
 * A unit test refuses a date in the future, which would hide every held row
 * from the sweep and the provider alike.
 *
 * Why the sweep is type-bound. The SCORM 1.2 commit route never sets the
 * latch, so a sweep without the `manifest_type in (cmi5, xapi)` bound would
 * re-send `course_completed` for every SCORM attempt ever completed.
 *
 * The caps. ADR 0015's 200 fires and 1,000 rows scanned per sweep run, and its
 * 200 counted rows within 1,000 scanned for the provider, are ceilings. Each
 * cap is at most its ceiling, and lower when one run at the ceiling could not
 * finish inside one Workers request's subrequest budget. With classifyCost the
 * subrequests of one classifyAttempt and fireCost those of one
 * fireCompletionWebhookForAttempt (both measured by a unit test under the
 * fetch stub), the rule is:
 *   sweep:    2 + ceil(SWEEP_MAX_SCANNED / HELD_PAGE_SIZE)
 *               + SWEEP_MAX_SCANNED * (classifyCost + 2)
 *               + SWEEP_MAX_FIRES * fireCost        <= 0.8 * WORKERS_SUBREQUEST_BUDGET
 *   provider: ceil(HELD_MAX_SCANNED / HELD_PAGE_SIZE)
 *               + HELD_MAX_SCANNED * (classifyCost + 2) <= 0.5 * WORKERS_SUBREQUEST_BUDGET
 * The 2 is the refresh RPC and the heartbeat; the `+ 2` per row is
 * classifyAttempt's narrower-select fallback on a database without 0103.
 * SWEEP_MAX_FIRES counts fire calls whatever they answer, because a call that
 * loses the latch has already made every subrequest but the POST. The
 * provider runs inside the admin page's request beside the other providers,
 * hence its half share: a bound on the provider, which leaves the page's other
 * subrequests to fit in what remains on their own count. These are the healthy
 * path's costs: postgrest-js retries a GET up to 3 more times on a network
 * error, 503 or 520, after 1, 2 and 4 seconds, and the rule does not count
 * that. A read past the limit fails, so its row is retried by the next run; a
 * latch taken exactly at the limit loses that row's message (the margin covers
 * the healthy path only). A run that stops at its caps leaves every row it did
 * not reach, and every row whose fire answered false before taking the
 * latch, with a null latch, so the next run resumes; the window has a fixed
 * start, so a starved schedule catches up.
 *
 * Why newest first. The selection is keyset-paged on (completed_at, id),
 * newest first. Complete rows that are never official keep a null latch for
 * good; with a scan cap below the population, such rows at the start of the
 * window could otherwise fill every run's scan and hide a held official row
 * behind them. Newest first puts recently held rows at the front. Each
 * request asks for min(pageSize, remaining scan) rows, so while the caps are
 * at or below HELD_PAGE_SIZE the first page is the whole scan and no cursor
 * is ever sent.
 *
 * The provider's summary carries `truncated`: when a bound stopped the scan,
 * `count` is a floor and `oldestCompletedAt` the oldest row seen, and the
 * item's title keeps step 6's shape. At count 0 there is no item, whatever
 * `truncated` says, so held rows behind the bound raise nothing that render.
 *
 * No next/* import and no runtime Supabase import, so unit tests load this
 * file. The fire and classify functions are injected: the cron route and the
 * Attention collector pass fireCompletionWebhookForAttempt and
 * classifyAttempt.
 */
import type { AttentionItem, AttentionPriority } from "@/lib/attention/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

// ---------------------------------------------------------------- the decision

/** A known result; null stands for the column's 'unknown'. */
export type HoldSuccess = "passed" | "failed" | null;

export type HoldInput = {
  /** The route's officialRun. */
  official: boolean;
  /** The bound row before the batch; `webhookAt` is undefined when the column could not be read. */
  before: { complete: boolean; successStatus: HoldSuccess; webhookAt: string | null | undefined };
  /** The row after the batch. */
  after: { complete: boolean; successStatus: HoldSuccess };
  /** Over the batch's processed elements. */
  batch: { completingStatementCarriedSuccess: boolean; terminated: boolean };
};

export type HoldDecision = "none" | "hold" | "fire" | "refire";

/** "passed" and "failed" as they are; anything else (the column's 'unknown' included) is null. */
export function normalizeSuccess(v: unknown): HoldSuccess {
  return v === "passed" || v === "failed" ? v : null;
}

/** ADR 0015 step 2. The rules run in this order; see the header. */
export function decideCompletionWebhook(input: HoldInput): HoldDecision {
  const { official, before, after, batch } = input;
  // (a)
  if (!official || !after.complete) return "none";
  // (b) became passed after a message that said not passed (step 4)
  if (
    before.complete &&
    before.successStatus !== "passed" &&
    after.successStatus === "passed" &&
    typeof before.webhookAt === "string"
  ) {
    return "refire";
  }
  // (b') already fired
  if (typeof before.webhookAt === "string") return "none";
  // (c) the three triggers; the latch test is strict (see the header)
  if (
    (after.successStatus !== null && after.successStatus !== before.successStatus) ||
    (batch.completingStatementCarriedSuccess && !before.complete) ||
    (batch.terminated && before.webhookAt === null)
  ) {
    return "fire";
  }
  // (d)
  return "hold";
}

// ---------------------------------------------------------------- the constants

/** N of ADR 0015 step 5: a held completion is swept once it is this old. */
export const WEBHOOK_HOLD_MINUTES = 15;

/** ADR 0015 step 6: the Attention Center raises held rows older than this. */
export const WEBHOOK_HOLD_ATTENTION_HOURS = 24;

/** ADR 0015 step 5: the start of the sweep's and the provider's window (see the header). */
export const WEBHOOK_HOLD_SWEEP_FROM = "2026-11-04T00:00:00.000Z";

/**
 * Subrequests one Workers request may make on production's Workers plan,
 * confirmed: the owner answered on 2026-11-04 that the Cloudflare account is on
 * Workers Free, and the plan belongs to the account, so production is on it.
 * Cloudflare's Workers limits page, read on 2026-11-04, documents 50 external
 * subrequests per invocation on Free and a default of 10,000 on Paid. If the
 * account's plan changes, this value is set to the new plan's limit and the
 * caps below are re-derived from the measured costs by the rule in the header.
 */
export const WORKERS_SUBREQUEST_BUDGET = 50;

/**
 * The per-run caps (ADR 0015's ceilings: 200 fires and 1,000 rows scanned per
 * sweep run; 200 counted rows within 1,000 scanned for the provider). The
 * values below satisfy the rule in the header at WORKERS_SUBREQUEST_BUDGET with
 * classifyCost 5 and fireCost 8 (the sweep's sum is 40, exactly 0.8 of the
 * budget; the provider's is 22, under its 25), and they follow the costs the
 * unit test measures.
 */
export const SWEEP_MAX_FIRES = 2;
export const SWEEP_MAX_SCANNED = 3;
export const HELD_MAX_SCANNED = 3;
export const HELD_MAX_COUNT = 200;
export const HELD_PAGE_SIZE = 200;

// ---------------------------------------------------------------- the selection

export type HeldRow = { id: string; completed_at: string };
type HeldCursor = { completed_at: string; id: string };

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
}

/**
 * One page of held candidates, newest first (ADR 0015 steps 5 and 6): complete
 * (completed or passed), not abandoned, latch null, completed in
 * [fromIso, olderThanIso), on a cmi5 or xAPI version (the `!inner` embed lets
 * the type bound filter the parent row). With `after`, the keyset predicate
 * goes in a second `or` parameter, which PostgREST ANDs with the first. Names
 * no 0100 or 0103 column. Any error, a database without 0082 included (the
 * latch column is named), answers no rows and the error.
 */
export async function heldWebhookPage(
  svc: AnyClient,
  opts: {
    /** completed_at < this */
    olderThanIso: string;
    /** The provider's restriction to one organisation. */
    orgId?: string;
    /** The keyset cursor: the last row of the previous page. */
    after?: HeldCursor | null;
    /** Default HELD_PAGE_SIZE. */
    pageSize?: number;
    /** Default WEBHOOK_HOLD_SWEEP_FROM; passed only by the read-only staging probe. */
    fromIso?: string;
  }
): Promise<{ rows: HeldRow[]; error: string | null }> {
  try {
    let q = svc
      .from("course_attempts")
      .select("id, completed_at, course_versions!inner(manifest_type)")
      .or("completion_status.eq.completed,success_status.eq.passed")
      .neq("status", "abandoned")
      .is("completion_webhook_at", null)
      .lt("completed_at", opts.olderThanIso)
      .gte("completed_at", opts.fromIso ?? WEBHOOK_HOLD_SWEEP_FROM)
      .in("course_versions.manifest_type", ["cmi5", "xapi"]);
    if (opts.orgId) q = q.eq("organization_id", opts.orgId);
    const c = opts.after;
    if (c) {
      q = q.or(`completed_at.lt."${c.completed_at}",and(completed_at.eq."${c.completed_at}",id.lt."${c.id}")`);
    }
    const { data, error } = await q
      .order("completed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(opts.pageSize ?? HELD_PAGE_SIZE);
    if (error) return { rows: [], error: errorText(error) };
    const rows = ((data ?? []) as Array<{ id: string; completed_at: string }>).map((r) => ({
      id: r.id,
      completed_at: r.completed_at,
    }));
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: errorText(e) };
  }
}

// ---------------------------------------------------------------- the sweep

export type SweepDeps = {
  /** fireCompletionWebhookForAttempt: true = this call took the latch and dispatched. */
  fire: (attemptId: string, attemptNumber: number | null) => Promise<boolean>;
  /** classifyAttempt. */
  classify: (svc: AnyClient, attemptId: string) => Promise<{ official: boolean; attemptNumber: number | null } | null>;
  now?: () => Date;
};

/** Attempt ids and a count only. */
export type SweepResult = { scanned: number; fired: string[]; skipped: string[]; unfired: string[]; error?: string };

/** Defaults: HELD_PAGE_SIZE, and the sweep's or the provider's caps. `maxFires` means nothing to the provider. */
export type SweepOpts = { pageSize?: number; maxFires?: number; maxScanned?: number };

/**
 * ADR 0015 step 5: fire the held official rows older than WEBHOOK_HOLD_MINUTES.
 * Each request asks for min(pageSize, maxScanned - scanned) rows; the run stops
 * after `maxFires` fire calls (fired plus unfired), after `maxScanned` rows
 * scanned, at a short page, or at a page error (nothing more is fired). Each
 * row is re-classified: official with an attempt number → fire (fired on true,
 * unfired on false or a throw); not official, no classification, a
 * classification that throws, or official with no number → skipped, retried
 * next run. Every selected row is complete and not abandoned, so a sound read
 * numbers it, a grant retake included: official with no number means
 * classifyAttempt's versions or list read failed, and that answer cannot tell a
 * row beyond the scored window from one inside it. One log line per run, ids
 * and counts only.
 */
export async function sweepHeldWebhooks(svc: AnyClient, deps: SweepDeps, opts?: SweepOpts): Promise<SweepResult> {
  const pageSize = opts?.pageSize ?? HELD_PAGE_SIZE;
  const maxFires = opts?.maxFires ?? SWEEP_MAX_FIRES;
  const maxScanned = opts?.maxScanned ?? SWEEP_MAX_SCANNED;
  const now = deps.now ? deps.now() : new Date();
  const olderThanIso = new Date(now.getTime() - WEBHOOK_HOLD_MINUTES * 60_000).toISOString();
  const result: SweepResult = { scanned: 0, fired: [], skipped: [], unfired: [] };
  let calls = 0;
  let after: HeldCursor | null = null;
  while (result.scanned < maxScanned && calls < maxFires) {
    const want = Math.min(pageSize, maxScanned - result.scanned);
    const page = await heldWebhookPage(svc, { olderThanIso, after, pageSize: want });
    if (page.error !== null) {
      result.error = page.error;
      break;
    }
    const rows = page.rows.slice(0, want);
    for (const row of rows) {
      if (calls >= maxFires) break;
      result.scanned++;
      let kind: { official: boolean; attemptNumber: number | null } | null = null;
      try {
        kind = await deps.classify(svc, row.id);
      } catch {
        kind = null;
      }
      if (!kind?.official || kind.attemptNumber === null) {
        result.skipped.push(row.id);
        continue;
      }
      calls++;
      let took = false;
      try {
        took = (await deps.fire(row.id, kind.attemptNumber)) === true;
      } catch {
        took = false;
      }
      (took ? result.fired : result.unfired).push(row.id);
    }
    if (calls >= maxFires || rows.length < want) break;
    const last = rows[rows.length - 1];
    after = { completed_at: last.completed_at, id: last.id };
  }
  console.warn(
    JSON.stringify({
      event: "webhook_sweep",
      scanned: result.scanned,
      fired: result.fired,
      skipped: result.skipped,
      unfired: result.unfired,
    })
  );
  return result;
}

// ---------------------------------------------------------------- the provider

type HeldSummary = { count: number; oldestCompletedAt: string | null; truncated: boolean; error: string | null };

/**
 * ADR 0015 step 6: the held official rows of one organisation older than
 * WEBHOOK_HOLD_ATTENTION_HOURS. Pages the shared selection newest first, each
 * request asking for min(pageSize, maxScanned - scanned) rows, keeps the rows
 * classify answers official for with an attempt number (the sweep's rule), and
 * counts up to HELD_MAX_COUNT of them within `maxScanned` rows scanned.
 * `truncated` is true when either bound
 * stopped the scan (the count is then a floor). Any error answers count 0,
 * not truncated, and the error.
 */
export async function heldWebhookSummary(
  svc: AnyClient,
  orgId: string,
  deps: { classify: SweepDeps["classify"]; now?: () => Date },
  opts?: SweepOpts
): Promise<HeldSummary> {
  const pageSize = opts?.pageSize ?? HELD_PAGE_SIZE;
  const maxScanned = opts?.maxScanned ?? HELD_MAX_SCANNED;
  const now = deps.now ? deps.now() : new Date();
  const olderThanIso = new Date(now.getTime() - WEBHOOK_HOLD_ATTENTION_HOURS * 3_600_000).toISOString();
  let scanned = 0;
  let count = 0;
  let oldest: string | null = null;
  let after: HeldCursor | null = null;
  try {
    for (;;) {
      if (count >= HELD_MAX_COUNT || scanned >= maxScanned) {
        return { count, oldestCompletedAt: oldest, truncated: true, error: null };
      }
      const want = Math.min(pageSize, maxScanned - scanned);
      const page = await heldWebhookPage(svc, { olderThanIso, orgId, after, pageSize: want });
      if (page.error !== null) return { count: 0, oldestCompletedAt: null, truncated: false, error: page.error };
      const rows = page.rows.slice(0, want);
      let i = 0;
      for (; i < rows.length && count < HELD_MAX_COUNT; i++) {
        const row = rows[i];
        scanned++;
        const kind = await deps.classify(svc, row.id);
        if (kind?.official && kind.attemptNumber !== null) {
          count++;
          if (oldest === null || Date.parse(row.completed_at) < Date.parse(oldest)) oldest = row.completed_at;
        }
      }
      // The count bound stopped the scan inside this page.
      if (i < rows.length) return { count, oldestCompletedAt: oldest, truncated: true, error: null };
      // A short page: the population ended.
      if (rows.length < want) return { count, oldestCompletedAt: oldest, truncated: false, error: null };
      const last = rows[rows.length - 1];
      after = { completed_at: last.completed_at, id: last.id };
    }
  } catch (e) {
    return { count: 0, oldestCompletedAt: null, truncated: false, error: errorText(e) };
  }
}

/** The one Attention item for a summary, in the shape of collect.ts's overdue item; null when nothing is held. */
export function heldWebhookItem(args: {
  count: number;
  oldestCompletedAt: string | null;
  orgSlug: string;
  priority: AttentionPriority;
}): AttentionItem | null {
  const { count, oldestCompletedAt, orgSlug, priority } = args;
  if (count <= 0) return null;
  return {
    // The count in the key, so the item re-surfaces when the population changes after a dismissal.
    key: `held-webhooks:all:${count}`,
    type: "held-webhooks",
    priority,
    title: `${count} completion webhook${count === 1 ? "" : "s"} held`,
    who: null,
    context: "cmi5/xAPI completions whose CRM webhook has not fired after 24 hours",
    occurredAt: oldestCompletedAt ?? new Date().toISOString(),
    actionLabel: "Review learners",
    href: `/${orgSlug}/reports`,
    inline: null,
    dismissible: true,
  };
}
