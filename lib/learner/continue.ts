/**
 * The continue route's decisions (ADR 0019 step 3), as pure functions: the
 * next step of a Learning Path, whether the module's official result is
 * stored, whether a pass-required course's verdict is still pending, and
 * where the route sends the learner. The page
 * (app/[org]/(learner)/continue/page.tsx) does the reads and the redirect;
 * everything that decides the target lives here, so every branch is
 * unit-tested (tests/unit/continue.test.ts).
 *
 * Deliberately free of next/*, lib/alds/* and Supabase runtime imports so unit
 * tests can load it (the lib/attempts/launch-kind.ts shape). The staff verdict
 * comes in from lib/alds/launch.ts launchModeFor(); the "done" verdict from
 * lib/scoring/policy.ts officialDone().
 */
import { courseStatus, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";

/** The route's wait for a stored result (ADR 0019 decision 2): a deadline this long after its first read starts; the last read starts by it. */
export const CONTINUE_WAIT_MS = 6000;

/** The sleep after each read of the learner's attempts (at most seven reads); the last sleep is cut at the deadline, so slow reads never extend it. */
export const CONTINUE_POLL_MS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uuid shape the route accepts for `lp` and `from`; anything else is refused before any read. */
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID.test(s);
}

/**
 * The course of the step after `fromCourseId` in one path: the row with the
 * smallest `step_number` greater than the `from` row's, whatever the input
 * order and however the numbers are spaced. Null when `from` is the last
 * step, and null when `from` is not a step (the page refuses that case
 * before it gets here).
 */
export function nextStepAfter(
  steps: Array<{ course_id: string; step_number: number }>,
  fromCourseId: string
): string | null {
  const from = steps.find((s) => s.course_id === fromCourseId);
  if (!from) return null;
  let next: { course_id: string; step_number: number } | null = null;
  for (const s of steps) {
    if (s.step_number > from.step_number && (next === null || s.step_number < next.step_number)) next = s;
  }
  return next?.course_id ?? null;
}

/**
 * The module's official result is stored: an official attempt exists and the
 * course does not read "in progress". A completed, passed or failed official
 * attempt is stored (whether it completes the step is officialDone's answer);
 * only an in-progress, abandoned or revision visit's row is not; a live
 * granted retake is not stored until it completes (courseStatus, ADR 0014
 * step 10).
 */
export function resultStored(scoring: ScoringResult, attempts: ScorableAttempt[]): boolean {
  return scoring.officialAttempt !== null && courseStatus(scoring, attempts) !== "in_progress";
}

/**
 * On a pass-required course, the official attempt is completed but its pass
 * or fail is not stored yet. lib/xapi/process-statement.ts writes
 * completion_status = 'completed' for any AU outcome verb and success_status
 * only on `passed` or `failed`, and the statements route processes one
 * statement at a time, so the route can read the row between the two writes.
 * A pass-required course's result is not stored until its verdict is (the
 * lead's ruling of 2026-11-11 on ADR 0019, option (a)): the page keeps waiting
 * while this is true, and at the CONTINUE_WAIT_MS bound it lands on the saving
 * banner, never the failed one. Concluding on the last read was rejected: it
 * could still show a learner who passed "not passed". So a module on a
 * pass-required course that never sends a verdict ends on the saving banner.
 * A course without pass_required never waits here: any stored result is done.
 */
export function verdictPending(scoring: ScoringResult, passRequired: boolean): boolean {
  return passRequired && scoring.officialStatus === "completed";
}

/**
 * The one conclude test (ADR 0019, note of 2026-11-11): the module's official
 * result is stored and, on a pass-required course, its verdict is too. Three
 * callers read it over the same strict reads, so the bar and the continue
 * address never disagree:
 *   - the continue address (app/[org]/(learner)/continue/page.tsx) ends its
 *     wait on it;
 *   - the launch page (courses/[courseId]/launch/page.tsx) renders Continue
 *     ready from the first paint when it is already true;
 *   - the status route (app/api/attempts/[attemptId]/result-stored) answers
 *     `{stored}` with it, which the bar polls while it waits.
 */
export function officialResultStored(scoring: ScoringResult, attempts: ScorableAttempt[], passRequired: boolean): boolean {
  return resultStored(scoring, attempts) && !verdictPending(scoring, passRequired);
}

export type ContinueInput = {
  orgSlug: string;
  pathId: string;
  /** launchModeFor({ role, revision: false }).isPreview: super_owner, admin, data_analyst. */
  isStaff: boolean;
  /**
   * The wait ended without a stored result (nothing stored, or a pass-required
   * course's verdict still pending, verdictPending), or a read failed.
   */
  timedOut: boolean;
  stored: boolean;
  /** officialDone(scoring, passRequired); read only when `stored`. */
  done: boolean;
  next: string | null;
};

/**
 * Where the route sends the learner, in this order (ADR 0019 step 3):
 *   1. staff: the next launch, or the path page's end banner;
 *   2. timed out (nothing stored, or the verdict still pending): the path
 *      page's neutral saving banner;
 *   3. stored and not done (a failed result on a pass-required course): the
 *      path page's failed banner, never the next launch;
 *   4. stored and done: the next launch, or the path page's end banner;
 *   5. otherwise (a state the page never produces): the path page.
 * The launch page keeps its own gates (release dates, the strict lock,
 * assignment) for every next launch.
 */
export function continueTarget(i: ContinueInput): string {
  const path = `/${i.orgSlug}/paths/${i.pathId}`;
  const nextLaunch = (next: string) => `/${i.orgSlug}/courses/${next}/launch?lp=${i.pathId}`;
  if (i.isStaff) return i.next ? nextLaunch(i.next) : `${path}?end=1`;
  if (i.timedOut) return `${path}?saving=1`;
  if (i.stored && !i.done) return `${path}?failed=1`;
  if (i.stored && i.done) return i.next ? nextLaunch(i.next) : `${path}?end=1`;
  return path;
}
