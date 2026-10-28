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
 * the package's other versions, grant retakes not excluded, revision visits'
 * rows included (they must close so the next revisit opens on the new
 * version; counted as "revision visits closed"); one-version resets use the
 * per-version route. The update is conditional on the selected id, its
 * version and `status = 'in_progress'`, so a completion, a language-switch
 * reset or another admin's restart that lands first wins and no attempt
 * outside the selection is touched. No audit row (unchanged).
 *
 * ADR 0014 step 8, the re-grant: the grant links of the selected attempts
 * are read as PART of the selection (before the update; a failed read is a
 * selection failure, so a retake is never abandoned without the operation
 * knowing it is one). For each abandoned grant retake a fresh approved
 * grant is inserted (`source 'restart'`, `reissued_from` the superseded
 * grant, `override_confirmed` copied, the default expiry unless the
 * original never expired). On 23505 (the learner has a pending request) that
 * request is approved instead, only when the learner's official result does
 * not stand; when it stands it stays pending for the queue's confirmation
 * box. On a database without 0103 every re-issue fails closed. The learner
 * is notified of each re-issue through the injected notifier.
 *
 * Classification (classifyForceRestart, ADR 0011 step 4, ADR 0014 step 8):
 *   (a) selection failed                    → failed, expected unknown
 *   (b) selection found nothing             → ok, the genuine zero
 *   (c) every selected id was reset         → ok
 *   (d) for each selected id not reset, the re-read decides: a terminal
 *       status (completed, passed, failed, abandoned) is `resolved`; still
 *       in progress, missing, or an unreadable re-read is `unresolved`
 *   (e) nothing unresolved, update ok       → ok
 *   (f) anything unresolved, or the update failed → failed
 *   (g) a retake could not be re-issued for any learner → failed
 *
 * Counts, version ids and the course title only: attempt and user ids never
 * appear in an outcome's public fields, a message or a log line.
 *
 * Pure part first (no next/* import, no runtime Supabase import), then the
 * I/O part. The notifier and the email resolver come in through the args
 * (lib/attempts/requests.ts and lib/users/emails.ts are never imported here).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";
import { DEFAULT_GRANT_EXPIRY_DAYS } from "@/lib/attempts/constants";
import { computeScoring, DEFAULT_POLICY, officialDone, type ScorableAttempt } from "@/lib/scoring/policy";
import { grantSnapshotFor, isMissingColumn, isSchemaMissing } from "@/lib/scoring/attempt-kind";

/**
 * `.in()` lists stay at 150 ids and every read is paged at 1000 rows ordered
 * by id (the lib/db/chunked.ts house rules); the selection pages by keyset,
 * see readSelection.
 */
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
  /** ADR 0014 step 8: grants re-issued for reset retakes (new grants, and pending requests approved). */
  reissued: number;
  /** Reset retakes whose grant could not be re-issued (rule (g)). */
  reissue_failed: number;
  /** Reset retakes whose learner's pending request waits for the queue's confirmation (a standing result). */
  reissue_pending: number;
  /** Revision visits' rows this run closed (ADR 0014 step 8). */
  revision_closed: number;
  message: string;
};

/** What the I/O part returns: the outcome, the ids it reset (never sent to a client) and the token flag. */
export type ForceRestartRun = ForceRestartOutcome & { restartedIds: string[]; tokensExpired: boolean };

/** What a response may carry: the outcome without the attempt ids. */
export type ForceRestartReport = ForceRestartOutcome & { tokensExpired: boolean };

export type SelectedAttempt = { id: string; course_version_id: string; is_revision?: boolean | null };
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
  /** ADR 0014 step 8 (0 when absent): the re-grant's counts. */
  reissued?: number;
  reissueFailed?: number;
  reissuePending?: number;
  revisionClosed?: number;
};

/** The counts a message is written from; the ADR 0014 counts default to 0. */
export type ForceRestartMessageInput = Omit<ForceRestartOutcome, "message" | "reissued" | "reissue_failed" | "reissue_pending" | "revision_closed"> &
  Partial<Pick<ForceRestartOutcome, "reissued" | "reissue_failed" | "reissue_pending" | "revision_closed">>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * ADR 0014 step 8 (kept verbatim): a re-issue failed after a
 * successful reset. The Learners-page label it names arrives with PR 1b.
 */
export function reissueFailedMessage(courseTitle: string, restarted: number, failed: number): string {
  return (
    `The new version of ${courseTitle} is published and ${restarted} learners were reset, ` +
    `but a retake could not be re-issued for ${failed} of them. They are listed on the course's Learners page as ` +
    `'retake reset, no grant'; grant each one a retake from Attempt Requests: the bulk grant covers a learner whose ` +
    `official result is not passed; a learner who passed asks again from the course page, and you approve with the confirmation.`
  );
}

/** One text for the API `message`/`error`, the Library banner and the unit test (ADR 0011 step 9). */
export function forceRestartMessage(o: ForceRestartMessageInput, courseTitle = "this course"): string {
  const reissueFailed = o.reissue_failed ?? 0;
  const reissuePending = o.reissue_pending ?? 0;
  const resetFailed = o.status === "failed" && (o.expected === null || o.unresolved > 0 || reissueFailed === 0);
  if (o.status === "failed" && resetFailed) {
    let text: string;
    if (o.expected === null) {
      text = "The new version is published, but the learners in progress could not be read, so none were reset. Use 'Restart learners on this version' on each older version to retry.";
    } else {
      const versions = (o.unresolved_version_ids?.length ?? 0) > 1 ? "versions" : "version";
      text =
        `The new version is published, but resetting ${plural(o.expected, "learner", "learners")} failed. ` +
        `Use 'Restart learners on this version' on the older ${versions} to retry. ` +
        `${o.restarted} ${o.restarted === 1 ? "was" : "were"} reset, ${o.unresolved} could not be.`;
    }
    return reissueFailed > 0 ? `${text} ${reissueFailedMessage(courseTitle, o.restarted, reissueFailed)}` : text;
  }
  // (g) alone: every selected learner was reset, a re-issue failed.
  if (o.status === "failed") return reissueFailedMessage(courseTitle, o.restarted, reissueFailed);
  let text: string;
  if (!o.expected) text = "No learners were in progress.";
  else {
    const reset = `${plural(o.restarted, "learner", "learners")} reset`;
    text = o.resolved > 0 ? `${reset}; ${o.resolved} had already finished or been reset.` : `${reset}.`;
  }
  const revisionClosed = o.revision_closed ?? 0;
  if (revisionClosed > 0) text += ` ${plural(revisionClosed, "revision visit", "revision visits")} closed.`;
  if (reissuePending > 0) {
    text += ` ${plural(reissuePending, "pending request awaits", "pending requests await")} the confirmation in Attempt Requests.`;
  }
  return text;
}

function outcome(o: Omit<ForceRestartOutcome, "message">, courseTitle?: string): ForceRestartOutcome {
  return { ...o, message: forceRestartMessage(o, courseTitle) };
}

/** ADR 0011 step 4, rules (a)–(f), then ADR 0014 step 8 rule (g), in order. */
export function classifyForceRestart(f: ForceRestartFacts, courseTitle?: string): ForceRestartOutcome {
  const regrant = {
    reissued: f.reissued ?? 0,
    reissue_failed: f.reissueFailed ?? 0,
    reissue_pending: f.reissuePending ?? 0,
    revision_closed: f.revisionClosed ?? 0,
  };
  // (a) The selection failed: nothing was updated, nothing is known.
  if (f.selectionError !== null || f.selected === null) {
    return outcome({ status: "failed", expected: null, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: null, ...regrant }, courseTitle);
  }
  const versionOf = new Map<string, string>();
  for (const r of f.selected) versionOf.set(r.id, r.course_version_id);
  const expected = versionOf.size;
  const restartedSet = new Set(f.restartedIds);
  // An id outside the selection cannot come back from an id-bound update; if
  // one does, it was reset all the same: counted, never an error.
  const restarted = restartedSet.size;
  // (g) after (a)-(f): a reset retake whose grant could not be re-issued.
  const g = (status: "ok" | "failed"): "ok" | "failed" => (regrant.reissue_failed > 0 ? "failed" : status);

  // (b) The genuine zero.
  if (expected === 0) {
    return outcome({ status: g("ok"), expected: 0, restarted, resolved: 0, unresolved: 0, unresolved_version_ids: [], ...regrant }, courseTitle);
  }

  const shortfall = [...versionOf.keys()].filter((id) => !restartedSet.has(id));
  const updateFailed = f.updateError !== null;
  // (c) Every selected attempt was reset.
  if (shortfall.length === 0 && !updateFailed) {
    return outcome({ status: g("ok"), expected, restarted, resolved: 0, unresolved: 0, unresolved_version_ids: [], ...regrant }, courseTitle);
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
  return outcome({ status: g(status), expected, restarted, resolved, unresolved, unresolved_version_ids, ...regrant }, courseTitle);
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
    reissued: run.reissued,
    reissue_failed: run.reissue_failed,
    reissue_pending: run.reissue_pending,
    revision_closed: run.revision_closed,
    message: run.message,
    tokensExpired: run.tokensExpired,
  };
}

/**
 * The multipart replace route's answer for `mode = force_restart` (ADR 0011
 * step 5). Success keeps every field the route answered before and adds
 * `expected`, `resolved` and `message`; a failure is a 500 that says the new
 * version is published and names the per-version restart as the retry
 * (`retry` is the route to run for each of `unresolved_version_ids`). The
 * ADR 0014 re-grant counts are added only when there is something to say.
 */
export function forceRestartReplaceAnswer(args: {
  courseId: string;
  packageId: string;
  versionId: string;
  versionNumber: number;
  report: ForceRestartReport;
}): { status: 200 | 500; body: Record<string, unknown> } {
  const { courseId, packageId, versionId, versionNumber, report: r } = args;
  const regrant = {
    ...(r.reissued ? { reissued: r.reissued } : {}),
    ...(r.reissue_failed ? { reissue_failed: r.reissue_failed } : {}),
    ...(r.reissue_pending ? { reissue_pending: r.reissue_pending } : {}),
    ...(r.revision_closed ? { revision_closed: r.revision_closed } : {}),
  };
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
        ...regrant,
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
      ...regrant,
      retry: `/api/courses/${courseId}/packages/${packageId}/versions/<versionId>/restart`,
    },
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** A read or update that failed: where, and the PostgREST code (no message: it may quote row values). */
class StepError extends Error {
  constructor(readonly step: "versions" | "selection" | "links" | "update" | "reread", readonly code: string) {
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

  // Keyset pages (id > the last id seen), not offsets: an attempt that
  // leaves 'in_progress' while the pages are read (a completion, another
  // reset) would shift every later row one place back under offset paging
  // and the next page would skip one: that learner is never selected, and
  // the run would report ok. A cursor never skips a row that stays in
  // progress while the pages are read. `is_revision` (0103) only counts the
  // revision visits closed; it is dropped on a database without it.
  let columns = "id, course_version_id, is_revision";
  const byId = new Map<string, SelectedAttempt>();
  for (const part of chunks(older, FORCE_RESTART_CHUNK)) {
    let after: string | null = null;
    for (;;) {
      let q = svc
        .from("course_attempts")
        .select(columns)
        .in("course_version_id", part)
        .eq("status", "in_progress");
      if (after !== null) q = q.gt("id", after);
      const { data, error } = await q.order("id").limit(FORCE_RESTART_PAGE);
      if (error && columns.includes("is_revision") && isMissingColumn(error, "is_revision")) {
        columns = "id, course_version_id";
        continue;
      }
      if (error) throw new StepError("selection", codeOf(error));
      if (data == null) throw new StepError("selection", "empty_answer");
      const page = data as unknown as SelectedAttempt[];
      for (const r of page) byId.set(r.id, r);
      if (page.length < FORCE_RESTART_PAGE) break;
      after = page[page.length - 1].id;
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** An approved grant whose retake is one of the selected attempts. */
type GrantLink = {
  id: string;
  user_id: string;
  course_id: string;
  used_attempt_id: string;
  expires_at: string | null;
  override_confirmed?: boolean | null;
  attempts_used?: number | null;
};
type GrantLinks = {
  byAttempt: Map<string, GrantLink>;
  /** False on a database without 0103: every re-issue then fails closed. */
  withOverride: boolean;
  /** False on a database without 0085: the re-issue carries no attempts_used. */
  withAttemptsUsed: boolean;
};

const LINK_COLUMNS = "id, user_id, course_id, used_attempt_id, expires_at";

/**
 * The grant links of the selected attempts, read as part of the selection
 * (ADR 0014 step 8): one read per chunk of 150 selected ids. A
 * missing `override_confirmed` (pre-0103) or `attempts_used` (pre-0085)
 * re-reads without it; a missing table (pre-0083) has no grants; any other
 * error or an empty answer is a selection failure (rule (a)), so nothing is
 * reset.
 */
async function readGrantLinks(svc: SupabaseClient, selected: SelectedAttempt[]): Promise<GrantLinks> {
  let optional = ["override_confirmed", "attempts_used"];
  const byAttempt = new Map<string, GrantLink>();
  for (const part of chunks(selected.map((r) => r.id), FORCE_RESTART_CHUNK)) {
    for (;;) {
      const { data, error } = await svc
        .from("attempt_requests")
        .select([LINK_COLUMNS, ...optional].join(", "))
        .eq("status", "approved")
        .in("used_attempt_id", part);
      if (error) {
        const drop = optional.find((c) => isMissingColumn(error, c));
        if (drop) {
          optional = optional.filter((c) => c !== drop);
          continue;
        }
        const code = codeOf(error);
        if (code === "42P01" || code === "PGRST205") return { byAttempt, withOverride: false, withAttemptsUsed: false };
        throw new StepError("links", code);
      }
      if (data == null) throw new StepError("links", "empty_answer");
      for (const r of data as unknown as GrantLink[]) if (r.used_attempt_id) byAttempt.set(r.used_attempt_id, r);
      break;
    }
  }
  return { byAttempt, withOverride: optional.includes("override_confirmed"), withAttemptsUsed: optional.includes("attempts_used") };
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

/** The learner notifier and the email resolver (lib/attempts/requests.ts, lib/users/emails.ts), injected by the callers. */
export type ForceRestartNotify = {
  decision: (
    svc: SupabaseClient,
    args: {
      orgId: string;
      orgName: string;
      orgSlug: string;
      origin: string;
      courseId: string;
      courseTitle: string;
      learner: { id: string; email: string };
      approved: boolean;
      note?: string | null;
      expiresAt?: string | null;
    }
  ) => Promise<void>;
  emails: (svc: SupabaseClient, userIds: Iterable<string>) => Promise<Map<string, string>>;
};

export type ForceRestartArgs = {
  packageId: string;
  newVersionId: string;
  /** The new version's number, for the re-issued grant's note. */
  versionNumber: number;
  /** The admin who replaced the package: the re-issued grant's decided_by. */
  admin: { id: string };
  org: { id: string; name: string; slug: string };
  /** The request origin, for the learner's email link ("" leaves the link out). */
  origin: string;
  course: { id: string; title: string };
  notify: ForceRestartNotify;
};

type Regrant = { reissued: number; reissueFailed: number; reissuePending: number; notices: Array<{ userId: string; note: string; expiresAt: string | null }> };

const ATTEMPT_RESULT_COLUMNS = "id, status, completion_status, success_status, score, started_at, completed_at";

/**
 * The 23505 path (ADR 0014 step 8): the learner has a pending request. Approve
 * it only when their official result does not stand, decided from
 * error-checked reads (an unreadable result counts as standing: the request
 * stays pending and the failure names the queue).
 */
async function approvePendingRequest(
  svc: SupabaseClient,
  args: ForceRestartArgs,
  link: GrantLink,
  note: string,
  expiresAt: string | null
): Promise<"approved" | "pending" | "failed"> {
  try {
    const { data: vers, error: versErr } = await svc.from("course_versions").select("id").eq("course_id", link.course_id);
    if (versErr || vers == null) return "failed";
    const verIds = (vers as Array<{ id: string }>).map((v) => v.id);
    let attempts: ScorableAttempt[] = [];
    if (verIds.length > 0) {
      const read = (columns: string) =>
        svc.from("course_attempts").select(columns).eq("user_id", link.user_id).in("course_version_id", verIds);
      let { data: rows, error: rowsErr } = await read(`${ATTEMPT_RESULT_COLUMNS}, is_revision`);
      if (rowsErr && isMissingColumn(rowsErr, "is_revision")) ({ data: rows, error: rowsErr } = await read(ATTEMPT_RESULT_COLUMNS));
      if (rowsErr || rows == null) return "failed";
      attempts = rows as unknown as ScorableAttempt[];
    }
    const snapshot = await grantSnapshotFor(svc, link.user_id, link.course_id);
    const { data: courseRow, error: courseErr } = await svc.from("courses").select("pass_required").eq("id", link.course_id).maybeSingle();
    if (courseErr || !courseRow) return "failed";
    const passRequired = (courseRow as { pass_required?: boolean | null }).pass_required === true;
    // The clamp makes every policy the default (ADR 0014 step 6).
    const scoring = computeScoring(attempts, DEFAULT_POLICY, snapshot.retakeIds);
    const stands = officialDone(scoring, passRequired) && scoring.officialStatus !== "failed";
    if (stands) return "pending";
    const { data: approved, error: apErr } = await svc
      .from("attempt_requests")
      .update({
        status: "approved",
        decided_by: args.admin.id,
        decided_at: new Date().toISOString(),
        decision_note: note,
        expires_at: expiresAt,
        reissued_from: link.id,
      })
      .eq("user_id", link.user_id)
      .eq("course_id", link.course_id)
      .eq("status", "pending")
      .select("id");
    if (apErr || !approved || (approved as unknown[]).length === 0) return "failed";
    return "approved";
  } catch {
    // grantSnapshotFor's GrantReadError, or a throwing client.
    return "failed";
  }
}

/**
 * The re-grant (ADR 0014 step 8): for each reset attempt that was a grant
 * retake, a fresh approved grant (the grant.ts insert shape, degrading
 * `source` to `bulk` on 23514 and dropping `attempts_used` on a database
 * without it), or the 23505 path. On a database without 0103 nothing is
 * inserted and every re-issue fails closed (an approved grant without its
 * link and marker would misread a post-pass re-issue once 0103 lands).
 */
async function reissueGrants(svc: SupabaseClient, args: ForceRestartArgs, resetIds: string[], links: GrantLinks): Promise<Regrant> {
  const out: Regrant = { reissued: 0, reissueFailed: 0, reissuePending: 0, notices: [] };
  const note = `re-issued by forced restart of version ${args.versionNumber}`;
  for (const id of resetIds) {
    const link = links.byAttempt.get(id);
    if (!link) continue;
    const expiresAt =
      link.expires_at === null ? null : new Date(Date.now() + DEFAULT_GRANT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    if (!links.withOverride) {
      out.reissueFailed++;
      console.warn(`[force-restart] package ${args.packageId}: re-issue skipped (schema_missing)`);
      continue;
    }
    let row: Record<string, unknown> = {
      organization_id: args.org.id,
      course_id: link.course_id,
      user_id: link.user_id,
      status: "approved",
      source: "restart",
      decided_by: args.admin.id,
      decided_at: new Date().toISOString(),
      decision_note: note,
      reissued_from: link.id,
      override_confirmed: link.override_confirmed === true,
      expires_at: expiresAt,
      ...(links.withAttemptsUsed ? { attempts_used: link.attempts_used ?? null } : {}),
    };
    let { error } = await svc.from("attempt_requests").insert(row);
    for (let i = 0; error && i < 2; i++) {
      const code = codeOf(error);
      const msg = (error as { message?: string }).message ?? "";
      if (code === "23514" && row.source !== "bulk") row = { ...row, source: "bulk" };
      else if ((code === "42703" || code === "PGRST204") && msg.includes("attempts_used") && "attempts_used" in row) {
        const { attempts_used: _dropped, ...rest } = row;
        void _dropped;
        row = rest;
      } else break;
      ({ error } = await svc.from("attempt_requests").insert(row));
    }
    if (!error) {
      out.reissued++;
      out.notices.push({ userId: link.user_id, note, expiresAt });
      continue;
    }
    const code = codeOf(error);
    if (code === "23505") {
      const r = await approvePendingRequest(svc, args, link, note, expiresAt);
      if (r === "approved") {
        out.reissued++;
        out.notices.push({ userId: link.user_id, note, expiresAt });
      } else if (r === "pending") out.reissuePending++;
      else out.reissueFailed++;
      continue;
    }
    out.reissueFailed++;
    console.warn(
      `[force-restart] package ${args.packageId}: re-issue failed (${isSchemaMissing(error as { code?: string; message?: string }) ? "schema_missing" : code})`
    );
  }
  return out;
}

/** The learner's email for each re-issued grant; fail-soft, never changes the outcome. */
async function notifyReissued(svc: SupabaseClient, args: ForceRestartArgs, notices: Regrant["notices"]): Promise<void> {
  if (notices.length === 0) return;
  try {
    const emails = await args.notify.emails(svc, notices.map((n) => n.userId));
    for (const n of notices) {
      try {
        await args.notify.decision(svc, {
          orgId: args.org.id,
          orgName: args.org.name,
          orgSlug: args.org.slug,
          origin: args.origin,
          courseId: args.course.id,
          courseTitle: args.course.title,
          learner: { id: n.userId, email: emails.get(n.userId) ?? "" },
          approved: true,
          note: n.note,
          expiresAt: n.expiresAt,
        });
      } catch {
        // A mail hiccup never changes a forced restart's outcome.
      }
    }
  } catch {
    console.warn(`[force-restart] package ${args.packageId}: re-issue notifications not sent`);
  }
}

/** R1–R3, the token/LRS follow-ups and the re-grant; fills `facts`, answers whether the token expiry held. */
async function runSteps(
  svc: SupabaseClient,
  args: ForceRestartArgs,
  facts: ForceRestartFacts
): Promise<boolean> {
  let links: GrantLinks;
  try {
    const selected = await readSelection(svc, args.packageId, args.newVersionId);
    // The grant links are part of the selection: a failed read resets nothing.
    links = selected.length > 0 ? await readGrantLinks(svc, selected) : { byAttempt: new Map(), withOverride: true, withAttemptsUsed: true };
    facts.selected = selected;
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
  const flagged = new Set(facts.selected.filter((r) => r.is_revision === true).map((r) => r.id));
  facts.revisionClosed = [...restartedSet].filter((id) => flagged.has(id)).length;

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
  // ADR 0014 step 8: re-issue the grants of the reset retakes.
  const regrant = await reissueGrants(svc, args, restartedIds, links);
  facts.reissued = regrant.reissued;
  facts.reissueFailed = regrant.reissueFailed;
  facts.reissuePending = regrant.reissuePending;
  await notifyReissued(svc, args, regrant.notices);
  return tokensExpired;
}

/**
 * Abandon the in-progress attempts on the package's older versions, after
 * the new version is published, and re-issue the grants of the reset
 * retakes (ADR 0014 step 8). Never throws: every failure, an unexpected
 * exception included, comes back as a `failed` outcome, so a caller that
 * has published can always answer "published, reset failed". `svc` must be
 * the service client (the attempts belong to other users; the write-sites
 * unit test pins both callers).
 */
export async function forceRestartOlderVersions(
  svc: SupabaseClient,
  args: ForceRestartArgs
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

  const result = classifyForceRestart(facts, args.course.title);
  if (result.status === "failed") {
    const cause =
      facts.selectionError ?? facts.updateError ?? facts.rereadError ?? (result.unresolved > 0 ? "attempts still in progress" : "re-issue failed");
    console.error(
      `[force-restart] package ${args.packageId}, new version ${args.newVersionId}: reset failed (${cause}); ` +
        `expected ${result.expected ?? "unknown"}, restarted ${result.restarted}, resolved ${result.resolved}, ` +
        `unresolved ${result.unresolved}, versions ${JSON.stringify(result.unresolved_version_ids)}, ` +
        `reissued ${result.reissued}, reissue_failed ${result.reissue_failed}, reissue_pending ${result.reissue_pending}`
    );
  }
  return { ...result, restartedIds: [...new Set(facts.restartedIds)].sort(), tokensExpired };
}
