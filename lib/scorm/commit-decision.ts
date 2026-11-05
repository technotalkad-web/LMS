/**
 * The SCORM commit route's decisions, as pure functions
 * (tests/unit/scorm-commit-decision.test.ts; the route's own wiring runs in
 * tests/unit/scorm-commit-route.test.ts):
 *
 *   revisionOnly      ADR 0014 step 4, R-5: on a revision visit's row (is_revision)
 *                     the route writes `cmi_data` and `last_activity_at` only and
 *                     skips classification, both RPCs, the milestone, the webhook
 *                     and the emails;
 *   frozen            ADR 0017 step 9: on a `failed` row of a version reading as
 *                     the released KIVO A.1 engine or later, every later commit
 *                     writes `last_activity_at` and the record only, and the route
 *                     goes on with the row's values (frozenCommit below), so both
 *                     RPCs run and neither webhook nor email fires;
 *   stampCompletedAt  on any other row `completed_at` is stamped at the
 *                     change to complete and only then: a mid-way LMSFinish
 *                     (`finished` with an incomplete status) no longer stamps
 *                     it, the completing commit stamps it once, the
 *                     completing session's own final LMSFinish leaves it
 *                     alone, and a row stamped before this release keeps its
 *                     date (no backfill).
 *
 * Deliberately free of next/* and Supabase imports so unit tests can load it.
 */
import { OUTCOME_FINAL_FLOOR, type EngineReadError } from "../courses/engine-version";
import {
  mergeIgnoredResult,
  newIgnoredRecord,
  readIgnoredRecord,
  type IgnoredEntry,
  type IgnoredRecord,
} from "../xapi/ignored-pass";

type Axes = { completion_status?: string | null; success_status?: string | null };

const complete = (a: Axes) => a.completion_status === "completed" || a.success_status === "passed";

export function commitDecision(i: {
  /** The row's values before this commit. */
  current: Axes;
  /** The values about to be written (after the non-downgrade rules). */
  derived: Axes;
  /** The commit's `finished` flag: no longer a reason to stamp completed_at on its own. */
  finished: boolean;
  /** course_attempts.is_revision of the row (undefined before 0103). */
  isRevision: boolean | null | undefined;
  /** The row's completed_at before this commit. */
  alreadyCompletedAt: string | null | undefined;
  now: string;
  /** ADR 0017: the version's verdict is `final`. The route reads it only on a failed row. */
  outcomeFinal?: boolean;
}): { revisionOnly: boolean; frozen?: true; stampCompletedAt: boolean; completedAt: string | null } {
  if (i.isRevision === true) return { revisionOnly: true, stampCompletedAt: false, completedAt: null };
  if (i.outcomeFinal === true && i.current.success_status === "failed") {
    return { revisionOnly: false, frozen: true, stampCompletedAt: false, completedAt: null };
  }
  const nowComplete = complete(i.derived);
  const wasComplete = complete(i.current);
  const stamp = nowComplete && (!wasComplete || !i.alreadyCompletedAt);
  return { revisionOnly: false, stampCompletedAt: stamp, completedAt: stamp ? i.now : null };
}

/** The row's values the frozen commit answers with and the record's `failed` reads. */
type FrozenRow = {
  completion_status?: string | null;
  success_status?: string | null;
  status?: string | null;
  score?: number | null;
  completed_at?: string | null;
  ignored_pass?: unknown;
};

function scormRecord(row: FrozenRow, courseVersionId: string, engineVersion: string | null): IgnoredRecord {
  return (
    readIgnoredRecord(row.ignored_pass) ??
    newIgnoredRecord({
      runtime: "scorm12",
      course_version_id: courseVersionId,
      engine_version: engineVersion,
      floor: OUTCOME_FINAL_FLOOR,
      failed: { at: row.completed_at ?? null, score: row.score ?? null },
    })
  );
}

/** lesson_status as the record keys it: lower case, no key when the dictionary has none. */
const lessonStatusOf = (lessonStatus: string | null | undefined): { lesson_status?: string } => {
  const s = (lessonStatus ?? "").toLowerCase().trim();
  return s ? { lesson_status: s } : {};
};

/**
 * What a frozen commit does (ADR 0017 step 9). The update is `last_activity_at`,
 * plus the merged record when the commit is a candidate: a derived `passed`, or a
 * score other than the row's. Nothing else: no status, completion, success, score,
 * progress, completed_at or cmi_data. A trailing commit with the same status and
 * score is not a candidate. The echo is the row's values, so the runtime shows
 * "saved" and the route's justCompleted and justPassed are false. `event` is the
 * log line's name and verb, null when the commit is not a candidate. A candidate is
 * always logged: a repeat raises `repeats`, and at the cap the record does not change
 * and the line carries `capped`.
 */
export function frozenCommit(i: {
  derivedSuccess: string;
  lessonStatus: string | null | undefined;
  /** deriveScore(cmi), rounded to four decimals. */
  score: number | null;
  row: FrozenRow;
  courseVersionId: string;
  engineVersion: string | null;
  now: string;
}): {
  candidate: boolean;
  update: Record<string, unknown>;
  echo: { completion_status: string | null | undefined; success_status: string | null | undefined; status: string | null | undefined; score: number | null };
  event: ({ event: "pass_ignored" } | { event: "result_ignored"; verb: string }) & { capped?: true } | null;
} {
  const { row } = i;
  const isPass = i.derivedSuccess === "passed";
  const candidate = isPass || (i.score !== null && i.score !== (row.score ?? null));
  const update: Record<string, unknown> = { last_activity_at: i.now };
  const echo = {
    completion_status: row.completion_status,
    success_status: row.success_status,
    status: row.status,
    score: row.score ?? null,
  };
  if (!candidate) return { candidate, update, echo, event: null };

  const status = lessonStatusOf(i.lessonStatus);
  const verb = isPass || i.derivedSuccess === "failed" ? i.derivedSuccess : (status.lesson_status ?? "unknown");
  const entry: IgnoredEntry = { verb, received_at: i.now, score: i.score, same_session: null, ...status };
  const { record, changed, capped } = mergeIgnoredResult(scormRecord(row, i.courseVersionId, i.engineVersion), entry);
  if (changed) update.ignored_pass = record;
  return {
    candidate,
    update,
    echo,
    event: { ...(isPass ? { event: "pass_ignored" as const } : { event: "result_ignored" as const, verb }), ...(capped ? { capped } : {}) },
  };
}

/**
 * ADR 0017 step 6: the one-time upgrade applied on a failed row because the
 * engine version could not be read. The record the same update writes. Never
 * counted. Not for an `older` or `non_kivo` version, which are logged only.
 */
export function appliedCommitRecord(i: {
  lessonStatus: string | null | undefined;
  score: number | null;
  row: FrozenRow;
  courseVersionId: string;
  engineVersion: string | null;
  reason: "unknown" | "unreadable";
  error?: EngineReadError;
  now: string;
}): IgnoredRecord {
  return mergeIgnoredResult(scormRecord(i.row, i.courseVersionId, i.engineVersion), {
    verb: "passed",
    received_at: i.now,
    score: i.score,
    same_session: null,
    ...lessonStatusOf(i.lessonStatus),
    applied: true,
    reason: i.reason,
    ...(i.error ? { error: i.error } : {}),
  }).record;
}
