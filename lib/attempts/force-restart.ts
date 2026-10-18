/**
 * Forced restart on replace-package (ADR 0011): the one implementation both
 * upload paths call, the multipart `POST .../packages/[packageId]/versions`
 * with `mode = force_restart` and the direct-upload finalize with the same
 * mode. Both publish the new version first; the restart runs after and its
 * outcome is a VALUE, never a throw, so nothing here can undo or hide the
 * publish.
 *
 * The rule: a forced restart reports success only when every in-progress
 * attempt it selected on the package's older versions is, by the database's
 * own answers, no longer in progress. "No learners were in progress" is
 * reported only when the selection read succeeded and found none. A failed
 * read, a failed update, an answer with neither rows nor an error, and any
 * selected attempt still in progress after the run are failures; the
 * routes answer them with a non-2xx status that says the new version is
 * published and points at "Restart learners on this version" (the
 * per-version restart of ADR 0008 A) as the retry.
 *
 * The selection is unchanged from before ADR 0011: in-progress attempts on
 * the package's other versions, grant retakes not excluded; one-version
 * resets use the per-version route. The update is conditional on the
 * selected id, its version and `status = 'in_progress'`, so a completion,
 * a language-switch reset or another admin's restart that lands first wins
 * and no attempt outside the selection is touched. No audit row (unchanged).
 *
 * Classification (classifyForceRestart, ADR 0011 step 4):
 *   (a) selection failed                    → failed, expected unknown
 *   (b) selection found nothing             → ok, the genuine zero
 *   (c) every selected id was reset         → ok
 *   (d) for each selected id not reset, the re-read decides: a terminal
 *       status (completed, passed, failed, abandoned) is `resolved`; still
 *       in progress, missing, or an unreadable re-read is `unresolved`
 *   (e) nothing unresolved, update ok       → ok
 *   (f) anything unresolved, or the update failed → failed
 *
 * Counts and version ids only: attempt and user ids never appear in an
 * outcome's public fields, a message or a log line.
 *
 * Pure part first (no next/* import, no runtime Supabase import), then the
 * I/O part.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";

/** `.in()` lists stay at 150 ids and every read is paged at 1000 rows (the lib/db/chunked.ts house rules). */
export const FORCE_RESTART_CHUNK = 150;
export const FORCE_RESTART_PAGE = 1000;

/** The statuses the 0043 constraint allows besides 'in_progress'. */
const TERMINAL = new Set(["completed", "passed", "failed", "abandoned"]);

export type ForceRestartOutcome = {
  status: "ok" | "failed";
  /** Selected in-progress attempts; null when the selection could not be read. */
  expected: number | null;
  /** Attempts this run set to 'abandoned'. */
  restarted: number;
  /** Selected attempts a legitimate transition closed before this run's update. */
  resolved: number;
  /** Selected attempts still in progress, missing or unconfirmed after the run. */
  unresolved: number;
  /** Distinct versions of the unresolved attempts (sorted); null when the selection failed. */
  unresolved_version_ids: string[] | null;
  message: string;
};

/** What the I/O part returns: the outcome, the ids it reset (never sent to a client) and the token flag. */
export type ForceRestartRun = ForceRestartOutcome & { restartedIds: string[]; tokensExpired: boolean };

/** What a response may carry: the outcome without the attempt ids. */
export type ForceRestartReport = ForceRestartOutcome & { tokensExpired: boolean };

export type SelectedAttempt = { id: string; course_version_id: string };
export type RereadAttempt = { id: string; status: string | null; course_version_id: string | null };

export type ForceRestartFacts = {
  /** R1/R2 failed (an error, an empty answer, or a versions list without the new version). */
  selectionError: string | null;
  /** The selected in-progress attempts; null when the selection failed. */
  selected: SelectedAttempt[] | null;
  /** The update failed (an error or an empty answer); the run stopped there. */
  updateError: string | null;
  /** Ids the update answered with, in the order they came back. */
  restartedIds: string[];
  /** R3 failed; every shortfall id is then unresolved. */
  rereadError: string | null;
  /** The re-read rows of the shortfall ids; null when R3 did not run or failed. */
  reread: RereadAttempt[] | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One text for the API `message`/`error`, the Library banner and the unit test (ADR 0011 step 9). */
export function forceRestartMessage(o: Omit<ForceRestartOutcome, "message">): string {
  if (o.status === "failed") {
    if (o.expected === null) {
      return "The new version is published, but the learners in progress could not be read, so none were reset. Use 'Restart learners on this version' on each older version to retry.";
    }
    const versions = (o.unresolved_version_ids?.length ?? 0) > 1 ? "versions" : "version";
    return (
      `The new version is published, but resetting ${plural(o.expected, "learner", "learners")} failed. ` +
      `Use 'Restart learners on this version' on the older ${versions} to retry. ` +
      `${o.restarted} ${o.restarted === 1 ? "was" : "were"} reset, ${o.unresolved} could not be.`
    );
  }
  if (!o.expected) return "No learners were in progress.";
  const reset = `${plural(o.restarted, "learner", "learners")} reset`;
  return o.resolved > 0 ? `${reset}; ${o.resolved} had already finished or been reset.` : `${reset}.`;
}

function outcome(o: Omit<ForceRestartOutcome, "message">): ForceRestartOutcome {
  return { ...o, message: forceRestartMessage(o) };
}

/** ADR 0011 step 4, rules (a)–(f), in order. */
export function classifyForceRestart(f: ForceRestartFacts): ForceRestartOutcome {
  // (a) The selection failed: nothing was updated, nothing is known.
  if (f.selectionError !== null || f.selected === null) {
    return outcome({ status: "failed", expected: null, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: null });
  }
  const versionOf = new Map<string, string>();
  for (const r of f.selected) versionOf.set(r.id, r.course_version_id);
  const expected = versionOf.size;
  const restartedSet = new Set(f.restartedIds);
  // An id outside the selection cannot come back from an id-bound update; if
  // one does, it was reset all the same: counted, never an error.
  const restarted = restartedSet.size;

  // (b) The genuine zero.
  if (expected === 0) {
    return outcome({ status: "ok", expected: 0, restarted, resolved: 0, unresolved: 0, unresolved_version_ids: [] });
  }

  const shortfall = [...versionOf.keys()].filter((id) => !restartedSet.has(id));
  const updateFailed = f.updateError !== null;
  // (c) Every selected attempt was reset.
  if (shortfall.length === 0 && !updateFailed) {
    return outcome({ status: "ok", expected, restarted, resolved: 0, unresolved: 0, unresolved_version_ids: [] });
  }

  // (d) The re-read decides each shortfall id; anything it cannot confirm is unresolved.
  const reread = f.rereadError === null && f.reread !== null ? new Map(f.reread.map((r) => [r.id, r])) : null;
  let resolved = 0;
  const unresolvedVersions = new Set<string>();
  let unresolved = 0;
  for (const id of shortfall) {
    const row = reread?.get(id);
    if (row && row.status && TERMINAL.has(row.status)) {
      resolved++;
    } else {
      unresolved++;
      unresolvedVersions.add(versionOf.get(id)!);
    }
  }
  const unresolved_version_ids = [...unresolvedVersions].sort();
  // (e) / (f)
  const status = unresolved === 0 && !updateFailed ? "ok" : "failed";
  return outcome({ status, expected, restarted, resolved, unresolved, unresolved_version_ids });
}

/** The outcome without the attempt ids, for a response body or a FinalizeResult. */
export function forceRestartReport(run: ForceRestartRun): ForceRestartReport {
  return {
    status: run.status,
    expected: run.expected,
    restarted: run.restarted,
    resolved: run.resolved,
    unresolved: run.unresolved,
    unresolved_version_ids: run.unresolved_version_ids,
    message: run.message,
    tokensExpired: run.tokensExpired,
  };
}

/**
 * The multipart replace route's answer for `mode = force_restart` (ADR 0011
 * step 5). Success keeps every field the route answered before and adds
 * `expected`, `resolved` and `message`; a failure is a 500 that says the new
 * version is published and names the per-version restart as the retry
 * (`retry` is the route to run for each of `unresolved_version_ids`).
 */
export function forceRestartReplaceAnswer(args: {
  courseId: string;
  packageId: string;
  versionId: string;
  versionNumber: number;
  report: ForceRestartReport;
}): { status: 200 | 500; body: Record<string, unknown> } {
  const { courseId, packageId, versionId, versionNumber, report: r } = args;
  if (r.status === "ok") {
    return {
      status: 200,
      body: {
        ok: true,
        version_id: versionId,
        version_number: versionNumber,
        mode: "force_restart",
        restarted: r.restarted,
        expected: r.expected,
        resolved: r.resolved,
        message: r.message,
        ...(r.tokensExpired ? {} : { tokens_expired: false }),
      },
    };
  }
  return {
    status: 500,
    body: {
      error: r.message,
      published: true,
      version_id: versionId,
      version_number: versionNumber,
      mode: "force_restart",
      restart: "failed",
      expected: r.expected,
      restarted: r.restarted,
      resolved: r.resolved,
      unresolved: r.unresolved,
      unresolved_version_ids: r.unresolved_version_ids,
      retry: `/api/courses/${courseId}/packages/${packageId}/versions/<versionId>/restart`,
    },
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** A read or update that failed: where, and the PostgREST code (no message: it may quote row values). */
class StepError extends Error {
  constructor(readonly step: "versions" | "selection" | "update" | "reread", readonly code: string) {
    super(`${step}: ${code}`);
    this.name = "StepError";
  }
}

const codeOf = (error: unknown): string =>
  String((error as { code?: unknown } | null)?.code ?? "") || "error";

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** R1 + R2: the package's other versions, then their in-progress attempts. */
async function readSelection(
  svc: SupabaseClient,
  packageId: string,
  newVersionId: string
): Promise<SelectedAttempt[]> {
  const { data: vers, error: verErr } = await svc
    .from("course_versions")
    .select("id")
    .eq("package_id", packageId);
  if (verErr) throw new StepError("versions", codeOf(verErr));
  if (vers == null) throw new StepError("versions", "empty_answer");
  const ids = (vers as Array<{ id: string }>).map((r) => r.id);
  // The version just published belongs to this package: a list without it
  // is a wrong or truncated read, never "no older versions".
  if (!ids.includes(newVersionId)) throw new StepError("versions", "new_version_missing");
  const older = [...new Set(ids.filter((id) => id !== newVersionId))].sort();

  const byId = new Map<string, SelectedAttempt>();
  for (const part of chunks(older, FORCE_RESTART_CHUNK)) {
    for (let from = 0; ; from += FORCE_RESTART_PAGE) {
      const { data, error } = await svc
        .from("course_attempts")
        .select("id, course_version_id")
        .in("course_version_id", part)
        .eq("status", "in_progress")
        .order("id")
        .range(from, from + FORCE_RESTART_PAGE - 1);
      if (error) throw new StepError("selection", codeOf(error));
      if (data == null) throw new StepError("selection", "empty_answer");
      const page = data as SelectedAttempt[];
      for (const r of page) byId.set(r.id, r);
      if (page.length < FORCE_RESTART_PAGE) break;
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** U: the conditional update, 150 ids at a time; stops at the first failure. */
async function abandonSelected(
  svc: SupabaseClient,
  selected: SelectedAttempt[],
  restartedIds: string[]
): Promise<void> {
  for (const part of chunks(selected, FORCE_RESTART_CHUNK)) {
    const ids = part.map((r) => r.id);
    const versionIds = [...new Set(part.map((r) => r.course_version_id))].sort();
    const { data, error } = await svc
      .from("course_attempts")
      .update({ status: "abandoned" })
      .in("id", ids)
      .in("course_version_id", versionIds)
      .eq("status", "in_progress")
      .select("id");
    if (error) throw new StepError("update", codeOf(error));
    if (data == null) throw new StepError("update", "empty_answer");
    restartedIds.push(...(data as Array<{ id: string }>).map((r) => r.id));
  }
}

/** R3: what became of the selected ids the update did not reset. */
async function rereadShortfall(svc: SupabaseClient, ids: string[]): Promise<RereadAttempt[]> {
  const out: RereadAttempt[] = [];
  for (const part of chunks(ids, FORCE_RESTART_CHUNK)) {
    const { data, error } = await svc
      .from("course_attempts")
      .select("id, status, course_version_id")
      .in("id", part);
    if (error) throw new StepError("reread", codeOf(error));
    if (data == null) throw new StepError("reread", "empty_answer");
    out.push(...(data as RereadAttempt[]));
  }
  return out;
}

const stepOf = (e: unknown) => (e instanceof StepError ? e.message : `unexpected: ${e instanceof Error ? e.name : typeof e}`);

/** R1–R3 and the token/LRS follow-ups; fills `facts`, answers whether the token expiry held. */
async function runSteps(
  svc: SupabaseClient,
  args: { packageId: string; newVersionId: string },
  facts: ForceRestartFacts
): Promise<boolean> {
  try {
    facts.selected = await readSelection(svc, args.packageId, args.newVersionId);
  } catch (e) {
    facts.selectionError = stepOf(e);
    return true;
  }
  if (facts.selected.length === 0) return true;

  try {
    await abandonSelected(svc, facts.selected, facts.restartedIds);
  } catch (e) {
    facts.updateError = stepOf(e);
  }
  const restartedSet = new Set(facts.restartedIds);
  const shortfall = facts.selected.map((r) => r.id).filter((id) => !restartedSet.has(id));
  if (shortfall.length > 0 || facts.updateError !== null) {
    try {
      facts.reread = await rereadShortfall(svc, shortfall);
    } catch (e) {
      facts.rereadError = stepOf(e);
    }
  }
  const selectedIds = new Set(facts.selected.map((r) => r.id));
  const extra = [...restartedSet].filter((id) => !selectedIds.has(id)).length;
  if (extra > 0) {
    console.warn(`[force-restart] package ${args.packageId}: ${extra} reset attempt(s) were not in the selection`);
  }

  const restartedIds = [...restartedSet].sort();
  if (restartedIds.length === 0) return true;
  // ALDS step 0 (P4): an abandoned attempt's launch tokens die with it.
  // Informational on failure, never a failure of the restart.
  let tokensExpired = true;
  try {
    if (await expireLaunchTokens(svc, restartedIds)) tokensExpired = false;
  } catch {
    tokensExpired = false;
  }
  if (!tokensExpired) {
    console.warn(`[force-restart] package ${args.packageId}: token expiry failed for ${restartedIds.length} attempt(s)`);
  }
  // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
  try {
    await enqueueAbandonedStatements(svc, restartedIds);
  } catch {
    // It resolves on every error already; belt and braces.
  }
  return tokensExpired;
}

/**
 * Abandon the in-progress attempts on the package's older versions, after
 * the new version is published. Never throws: every failure, an unexpected
 * exception included, comes back as a `failed` outcome, so a caller that
 * has published can always answer "published, reset failed". `svc` must be
 * the service client (the attempts belong to other users; the write-sites
 * unit test pins both callers).
 */
export async function forceRestartOlderVersions(
  svc: SupabaseClient,
  args: { packageId: string; newVersionId: string }
): Promise<ForceRestartRun> {
  const facts: ForceRestartFacts = {
    selectionError: null,
    selected: null,
    updateError: null,
    restartedIds: [],
    rereadError: null,
    reread: null,
  };
  let tokensExpired = true;
  try {
    tokensExpired = await runSteps(svc, args, facts);
  } catch (e) {
    // Not one of the checked answers: whatever stage was running failed.
    if (facts.selected === null) facts.selectionError ??= stepOf(e);
    else facts.updateError ??= stepOf(e);
  }

  const result = classifyForceRestart(facts);
  if (result.status === "failed") {
    const cause = facts.selectionError ?? facts.updateError ?? facts.rereadError ?? "attempts still in progress";
    console.error(
      `[force-restart] package ${args.packageId}, new version ${args.newVersionId}: reset failed (${cause}); ` +
        `expected ${result.expected ?? "unknown"}, restarted ${result.restarted}, resolved ${result.resolved}, ` +
        `unresolved ${result.unresolved}, versions ${JSON.stringify(result.unresolved_version_ids)}`
    );
  }
  return { ...result, restartedIds: [...new Set(facts.restartedIds)].sort(), tokensExpired };
}
