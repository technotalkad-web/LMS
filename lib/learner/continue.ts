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
 * tests can load it (the lib/attempts/launch-kind.ts shape). The "done"
 * verdict comes in from the path rule: the per-step answer of pathProgress()
 * (lib/paths/progress.ts pathStepStatus) for the step the learner came from,
 * fed with the rows of the wait's own read in the path's context, the step's
 * resolved rule and its stored fact (ADR 0024 step 27 as build note O1-k
 * makes it exact), never contextResult's `done`, officialDone or
 * computeScoring. There is no staff branch (ADR 0024 step 23, P2-5 item 4):
 * every caller of the address waits for a stored result, and a Preview never
 * reaches it (it carries no `?lp=`).
 */
import { courseStatus, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";
import type { ContextAttempt, ContextGrant } from "@/lib/scoring/context";
import { pathStepStatus, type PathStepFact, type PathStepInput } from "@/lib/paths/progress";

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
 *
 * One exception, on a Learning Path step (ADR 0024 P2-7, review finding F1):
 * a step that the path rule already makes done (an earlier pass, D14, or the
 * step's stored fact, O1) is done whatever verdict comes, so no verdict can
 * show a learner who passed "not passed" there. The continue address and the
 * status route end the wait on such a step (waitRead "verdict_pending", then
 * pathStepDone); otherwise a module that reports completion only would hold
 * a step done by its fact on the saving banner for ever.
 */
export function verdictPending(scoring: ScoringResult, passRequired: boolean): boolean {
  return passRequired && scoring.officialStatus === "completed";
}

/**
 * One read of the wait, classified: nothing stored yet (`not_stored`), the
 * result stored with its verdict where the rule needs one (`stored`,
 * officialResultStored), or stored while a pass-required step's verdict is
 * still pending (`verdict_pending`). The continue address and the status
 * route read it, so they never disagree; on `verdict_pending` both ask
 * pathStepDone whether the path step is done already (F1 above).
 */
export type WaitRead = "not_stored" | "stored" | "verdict_pending";

export function waitRead(scoring: ScoringResult, attempts: ScorableAttempt[], passRequired: boolean): WaitRead {
  if (!resultStored(scoring, attempts)) return "not_stored";
  return verdictPending(scoring, passRequired) ? "verdict_pending" : "stored";
}

/**
 * A path step's done on one read (ADR 0024 step 27 as build note O1-k makes
 * it exact): the path rule's per-step answer (pathStepStatus) on that read's
 * rows and grants under the step's resolved rule, never contextResult's
 * `done`; then, only when the rule alone does not make the step done, with
 * the step's stored fact. `loadFacts` is readPathStepFacts for the path (the
 * continue address makes it read at most once per request); a failed facts
 * read answers `{ok: false}`, never "not done", so the caller takes its
 * read-error exit.
 */
export async function pathStepDone(i: {
  pathId: string;
  step: PathStepInput;
  attempts: ContextAttempt[];
  grants: ContextGrant[];
  now: string;
  loadFacts: () => Promise<{ ok: true; facts: PathStepFact[] } | { ok: false }>;
}): Promise<{ ok: true; done: boolean } | { ok: false }> {
  const read = (fact: PathStepFact | null) =>
    pathStepStatus({ pathId: i.pathId, step: i.step, attempts: i.attempts, grants: i.grants, fact, now: i.now });
  const byRule = read(null);
  if (byRule.passed_by_rule) return { ok: true, done: byRule.done };
  const f = await i.loadFacts();
  if (!f.ok) return { ok: false };
  const course = i.step.course_id.toLowerCase();
  const path = i.pathId.toLowerCase();
  const fact = f.facts.find((x) => x.course_id.toLowerCase() === course && x.path_id.toLowerCase() === path) ?? null;
  return { ok: true, done: fact ? read(fact).done : byRule.done };
}

/**
 * The one conclude test (ADR 0019, note of 2026-11-11): the module's official
 * result is stored and, on a pass-required course, its verdict is too. Three
 * callers read it over the same strict reads, so the bar and the continue
 * address never disagree:
 *   - the continue address (app/[org]/(learner)/continue/page.tsx) ends its
 *     wait on it (as waitRead's `stored`);
 *   - the launch page (courses/[courseId]/launch/page.tsx) renders Continue
 *     ready from the first paint when it is already true;
 *   - the status route (app/api/attempts/[attemptId]/result-stored) answers
 *     `{stored}` with it (as waitRead's `stored`), which the bar polls while
 *     it waits.
 * Since ADR 0024 P2-7 the continue address and the status route read in the
 * attempt's own context (readContextResult) and pass its rows; the launch
 * page passes its context's rows (P2-6). Those two also end the wait on a
 * path step done by the path rule while its verdict is pending
 * (verdictPending's exception); the launch page's first paint does not, so
 * there the bar starts waiting and its next check of the route answers.
 */
export function officialResultStored(scoring: ScoringResult, attempts: ScorableAttempt[], passRequired: boolean): boolean {
  return resultStored(scoring, attempts) && !verdictPending(scoring, passRequired);
}

export type ContinueInput = {
  orgSlug: string;
  pathId: string;
  /**
   * The wait ended without a stored result (nothing stored, or a pass-required
   * course's verdict still pending, verdictPending), or a read failed.
   */
  timedOut: boolean;
  stored: boolean;
  /**
   * The step is done by the path rule (pathStepStatus's `done`, which is
   * `passed_ever`: an earlier pass, D14, and a stored fact count); read only
   * when `stored`.
   */
  done: boolean;
  /** The next step's course in path order (nextStepAfter), whatever its activity. */
  next: string | null;
  /**
   * The next step's course is inactive, so the path page leaves the step out
   * (the owner's P2-Q1 answer): a stored, done result goes to the plain path
   * page, never to that step, never on past it and never to `?end=1`.
   */
  nextHidden: boolean;
};

/**
 * Where the route sends the learner, in this order (ADR 0019 step 3; its
 * staff row, which skipped the wait, is gone with ADR 0024 step 23):
 *   1. timed out (nothing stored, or the verdict still pending): the path
 *      page's neutral saving banner;
 *   2. stored and not done (a failed result on a pass-required step that was
 *      never passed and holds no stored fact): the path page's failed
 *      banner, never the next launch;
 *   3. stored and done: the next launch; the plain path page when the next
 *      step's course is inactive (P2-Q1, nothing skipped); or, on the last
 *      step, the path page's end banner;
 *   4. otherwise (a state the page never produces): the path page.
 * The launch page keeps its own gates (release dates, the strict lock,
 * assignment) for every next launch.
 */
export function continueTarget(i: ContinueInput): string {
  const path = `/${i.orgSlug}/paths/${i.pathId}`;
  const nextLaunch = (next: string) => `/${i.orgSlug}/courses/${next}/launch?lp=${i.pathId}`;
  if (i.timedOut) return `${path}?saving=1`;
  if (i.stored && !i.done) return `${path}?failed=1`;
  if (i.stored && i.done) {
    if (i.next === null) return `${path}?end=1`;
    return i.nextHidden ? path : nextLaunch(i.next);
  }
  return path;
}
