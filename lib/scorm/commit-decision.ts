/**
 * The SCORM commit route's two ADR 0014 step 4 decisions, as a pure function
 * (the route authenticates through the cookie-bound server client and cannot
 * run in a unit test; tests/unit/scorm-commit-decision.test.ts):
 *
 *   revisionOnly      R-5: on a revision visit's row (is_revision) the route
 *                     writes `cmi_data` and `last_activity_at` only and skips
 *                     classification, both RPCs, the milestone, the webhook
 *                     and the emails;
 *   stampCompletedAt  on a non-revision row `completed_at` is stamped at the
 *                     change to complete and only then: a mid-way LMSFinish
 *                     (`finished` with an incomplete status) no longer stamps
 *                     it, the completing commit stamps it once, the
 *                     completing session's own final LMSFinish leaves it
 *                     alone, and a row stamped before this release keeps its
 *                     date (no backfill).
 *
 * Deliberately free of next/* and Supabase imports so unit tests can load it.
 */

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
}): { revisionOnly: boolean; stampCompletedAt: boolean; completedAt: string | null } {
  if (i.isRevision === true) return { revisionOnly: true, stampCompletedAt: false, completedAt: null };
  const nowComplete = complete(i.derived);
  const wasComplete = complete(i.current);
  const stamp = nowComplete && (!wasComplete || !i.alreadyCompletedAt);
  return { revisionOnly: false, stampCompletedAt: stamp, completedAt: stamp ? i.now : null };
}
