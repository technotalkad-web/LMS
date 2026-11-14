/**
 * The launch's context decision (ADR 0024 step 22): `resolveLaunchContext()`
 * reads the facts of one `launch_context` call (0107 section 6p, step 18,
 * build note N15) and decides which product a launch belongs to, or where it
 * goes instead. The facts decide nothing; this function is the one decision.
 *
 * Built in phase 1 without its preview rows (section O): the conflict row,
 * the path row, the journey row, the Individual row and the redirect row of
 * step 22. The `?mode=preview` row is phase 2's and the test-run row phase
 * P's; until they are built, a launch that asks for a preview or names a run
 * is refused (`preview_not_allowed`) and never falls through to an official
 * context.
 *
 * Order of the checks:
 *   1. both `?lp=` and `?journey=`: refused, `context_conflict`, before any
 *      fact is read (the page makes no call for it);
 *   2. a preview or a run: refused (above);
 *   3. not an active member: `not_member`; the course not found in the
 *      organisation or inactive: `course_unavailable`;
 *   4. `?lp=P`: P found and active, else `path_unavailable`; a recorded
 *      enrolment, or P is "Everyone in this org" (self-enrolment, step 24),
 *      else `not_enrolled`; the course a step of P, else `not_a_step`; the
 *      step released, else the `upcoming` redirect; in strict order every
 *      earlier step done by the path rule as launch_context reads it from
 *      v_path_step_status, else the `locked` redirect;
 *   5. `?journey=E&day=D` (D a day id, or a number from an old link that the
 *      call resolved through the pinned version): E found, active or
 *      completed, its program active, else `journey_unavailable`; the day
 *      resolved, else `day_not_open`; then, in this order, `resume` (the
 *      day's context holds an open official attempt of this course, whatever
 *      the day's place in the pinned version now, step 93), `review` (the
 *      day's credit names this course: the course the learner completed, even
 *      when a publish swapped the day's course since), and for an active E
 *      only `open` (the day is the lowest uncredited required day, it holds
 *      this course in the pinned version, and the unlock rule opens it at
 *      `now` in the organisation's timezone); a completed E is otherwise
 *      `review_only`; an active E whose day holds this course but is not open
 *      yet goes to the `journey_locked` redirect; anything else is
 *      `day_not_open`;
 *   6. no product parameter: a released direct enrolment launches the
 *      Individual product; an "Everyone in this org" course self-enrols
 *      (step 24); otherwise exactly one holder (a path the learner is on, or
 *      a required day of an active enrolment) redirects into it, several go
 *      to the chooser, and with none an upcoming direct assignment goes to
 *      the `upcoming` redirect, else `not_enrolled`.
 *
 * The refusal reasons are names for tests and logs; the page keeps today's
 * redirects and notices. Ids in a decision are lower case.
 *
 * Pure: no next/* and no Supabase runtime import (the house shape of
 * lib/attempts/launch-kind.ts); `now` is an input, so the journey's "today"
 * is computed with todayStrAt (twins contract A12).
 */
import type { OrgRole } from "@/lib/auth/require-org-access";
import { countedDaysElapsed, DEFAULT_JOURNEY_TZ, todayStrAt } from "@/lib/journey/journey";

export type LaunchParams = {
  lp: string | null;
  journey: string | null;
  /** A day id, or digits from an old link. */
  day: string | null;
  mode: "preview" | null;
  run: string | null;
};

export type CourseFacts =
  | { found: false }
  | {
      found: true;
      is_active: boolean;
      visibility: string;
      individual: { enrolled: boolean; upcoming_at: string | null };
    };

export type PathStepFacts = { course_id: string; step_number: number; release_at: string | null; done: boolean };

export type PathFacts =
  | { found: false }
  | {
      found: true;
      is_active: boolean;
      visibility: string;
      sequence_mode: string | null;
      enrolled: boolean;
      self_row: boolean;
      course_step: number | null;
      /** By step_number. */
      steps: PathStepFacts[];
    };

export type JourneyDayFacts = {
  id: string | null;
  number: number | null;
  in_version: boolean;
  removed: boolean;
  course_id: string | null;
};

export type JourneyFacts =
  | { found: false }
  | {
      found: true;
      status: string;
      program_id: string;
      program_is_active: boolean;
      /** YYYY-MM-DD */
      start_date: string;
      version_id: string;
      unlock_mode: string | null;
      count_sundays: boolean;
      days_total: number;
      timezone: string | null;
      day: JourneyDayFacts;
      day_credit: { course_id: string; attempt_id: string | null; credit_kind: string; day_number: number | null } | null;
      day_open_attempt: { attempt_id: string; course_id: string } | null;
      required_days: number;
      credited_days: number;
      next_day: number | null;
      next_day_id: string | null;
      resumable_day_ids: string[];
    };

/** launch_context's answer (the frozen key tree of build note N15). */
export type LaunchContextFacts = {
  v: 1;
  member: { active: boolean };
  course: CourseFacts;
  path: PathFacts | null;
  journey: JourneyFacts | null;
  holders: {
    /** By path_id. */
    paths: Array<{ path_id: string; step_number: number }>;
    /** By enrollment_id, then day_number. */
    journey_days: Array<{ enrollment_id: string; day_id: string | null; day_number: number; credited: boolean }>;
  };
  /** Reserved for phase P. */
  run: null;
};

export type ResolveInput = {
  courseId: string;
  /** Read by the preview row, which phase 2 builds. */
  role: OrgRole;
  params: LaunchParams;
  /** launch_context's answer; null only when no call was made, which is the conflict row's case. */
  facts: LaunchContextFacts | null;
  /** ISO */
  now: string;
};

export type JourneyAdmission = "open" | "review" | "resume";

export type LaunchDecision =
  | {
      kind: "launch";
      selfEnrol: null | "course" | "path";
      context:
        | { kind: "individual" }
        | { kind: "path"; pathId: string }
        | { kind: "journey"; enrollmentId: string; dayId: string; dayNumber: number | null; admission: JourneyAdmission }
        | { kind: "preview"; previewKind: "course" | "path_run" | "journey_run"; runId: string | null; dayId: string | null };
    }
  | {
      kind: "redirect";
      to: "path" | "journey" | "chooser" | "locked" | "upcoming" | "journey_locked";
      pathId?: string;
      enrollmentId?: string;
      dayId?: string;
    }
  | {
      kind: "refused";
      reason:
        | "context_conflict"
        | "not_member"
        | "course_unavailable"
        | "not_enrolled"
        | "path_unavailable"
        | "not_a_step"
        | "journey_unavailable"
        | "day_not_open"
        | "review_only"
        | "preview_not_allowed";
    };

type Refusal = Extract<LaunchDecision, { kind: "refused" }>["reason"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^[0-9]{1,6}$/;

const refused = (reason: Refusal): LaunchDecision => ({ kind: "refused", reason });

/** A launch parameter: trimmed, and an empty one is absent (`?lp=` reads as no `lp`). */
function param(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function afterNow(iso: string | null, now: string): boolean {
  if (iso === null) return false;
  const t = Date.parse(iso);
  const n = Date.parse(now);
  return Number.isFinite(t) && Number.isFinite(n) && t > n;
}

/**
 * Is the journey's open day open at `now`? The open day is the lowest
 * uncredited required day (launch_context's next_day). Calendar mode: the
 * counted days since the start reach it (catch-up allowed, never ahead).
 * Progress mode: the journey has started. The rule of
 * lib/journey/journey.ts computeJourneyState, read on the day ids' credit
 * state rather than a row count.
 */
export function journeyOpenDayIsOpen(
  j: Pick<
    Extract<JourneyFacts, { found: true }>,
    "start_date" | "days_total" | "count_sundays" | "unlock_mode" | "timezone" | "next_day"
  >,
  now: string
): boolean {
  if (j.next_day === null) return false;
  const today = todayStrAt(now, j.timezone || DEFAULT_JOURNEY_TZ);
  const allowedDay = Math.min(j.days_total, countedDaysElapsed(j.start_date, today, j.count_sundays === true));
  return j.unlock_mode === "progress" ? allowedDay >= 1 : j.next_day <= allowedDay;
}

/** The launch's context decision (ADR 0024 step 22; the order is in the header). */
export function resolveLaunchContext(i: ResolveInput): LaunchDecision {
  const lp = param(i.params.lp);
  const journey = param(i.params.journey);
  const day = param(i.params.day);

  // 1. Both product parameters: refused, no checks.
  if (lp !== null && journey !== null) return refused("context_conflict");

  // 2. The preview rows are phases 2 and P; until then a preview never
  //    becomes an official launch.
  if (i.params.mode === "preview" || param(i.params.run) !== null) return refused("preview_not_allowed");

  const facts = i.facts;
  if (facts === null) throw new TypeError("resolveLaunchContext: launch_context's facts are required past the conflict row");
  if (facts.v !== 1) throw new TypeError("resolveLaunchContext: an unknown launch_context answer version");

  // 3. Membership and the course.
  if (!facts.member.active) return refused("not_member");
  const course = facts.course;
  if (!course.found || !course.is_active) return refused("course_unavailable");

  // 4. The path row.
  if (lp !== null) {
    if (!UUID.test(lp)) return refused("path_unavailable");
    const pathId = lp.toLowerCase();
    const p = facts.path;
    if (!p || !p.found || !p.is_active) return refused("path_unavailable");
    let selfEnrol: null | "path" = null;
    if (!p.enrolled) {
      if (p.visibility !== "org_public") return refused("not_enrolled");
      selfEnrol = "path";
    }
    if (p.course_step === null) return refused("not_a_step");
    const step = p.steps.find((s) => s.step_number === p.course_step && sameId(s.course_id, i.courseId));
    if (!step) return refused("not_a_step");
    if (afterNow(step.release_at, i.now)) return { kind: "redirect", to: "upcoming", pathId };
    if (p.sequence_mode !== "random" && p.steps.some((s) => s.step_number < step.step_number && !s.done)) {
      return { kind: "redirect", to: "locked", pathId };
    }
    return { kind: "launch", selfEnrol, context: { kind: "path", pathId } };
  }

  // 5. The journey row.
  if (journey !== null) {
    if (!UUID.test(journey)) return refused("journey_unavailable");
    const enrollmentId = journey.toLowerCase();
    const j = facts.journey;
    if (!j || !j.found) return refused("journey_unavailable");
    if (j.status !== "active" && j.status !== "completed") return refused("journey_unavailable");
    if (!j.program_is_active) return refused("journey_unavailable");

    // The day: by its id, or an old link's number the call resolved.
    if (day === null || j.day.id === null) return refused("day_not_open");
    if (UUID.test(day)) {
      if (!sameId(day, j.day.id)) return refused("day_not_open");
    } else if (DIGITS.test(day)) {
      if (j.day.number !== Number(day)) return refused("day_not_open");
    } else {
      return refused("day_not_open");
    }
    const dayId = j.day.id.toLowerCase();
    const launch = (admission: JourneyAdmission): LaunchDecision => ({
      kind: "launch",
      selfEnrol: null,
      context: { kind: "journey", enrollmentId, dayId, dayNumber: j.day.number, admission },
    });

    if (j.day_open_attempt && sameId(j.day_open_attempt.course_id, i.courseId)) return launch("resume");
    if (j.day_credit && sameId(j.day_credit.course_id, i.courseId)) return launch("review");
    if (j.status !== "active") return refused("review_only");

    const holdsCourse = j.day.in_version && !j.day.removed && sameId(j.day.course_id, i.courseId);
    // A credited day whose course a publish swapped is reviewed on the
    // credit row's course; its new course is not offered (step 22).
    if (!holdsCourse || j.day_credit) return refused("day_not_open");
    if (sameId(j.next_day_id, dayId) && journeyOpenDayIsOpen(j, i.now)) return launch("open");
    return { kind: "redirect", to: "journey_locked", enrollmentId, dayId };
  }

  // 6. No product parameter: the Individual row, then the redirect row.
  if (course.individual.enrolled) return { kind: "launch", selfEnrol: null, context: { kind: "individual" } };
  if (course.visibility === "org_public") return { kind: "launch", selfEnrol: "course", context: { kind: "individual" } };

  const holders: LaunchDecision[] = [
    ...facts.holders.paths.map((h): LaunchDecision => ({ kind: "redirect", to: "path", pathId: h.path_id.toLowerCase() })),
    ...facts.holders.journey_days.map(
      (h): LaunchDecision => ({
        kind: "redirect",
        to: "journey",
        enrollmentId: h.enrollment_id.toLowerCase(),
        ...(h.day_id ? { dayId: h.day_id.toLowerCase() } : {}),
      })
    ),
  ];
  if (holders.length === 1) return holders[0];
  if (holders.length > 1) return { kind: "redirect", to: "chooser" };
  if (course.individual.upcoming_at !== null) return { kind: "redirect", to: "upcoming" };
  return refused("not_enrolled");
}
