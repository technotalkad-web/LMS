/**
 * The launch's context decision (ADR 0024 step 22): `resolveLaunchContext()`
 * reads the facts of one `launch_context` call (0107 section 6p, step 18,
 * build note N15) and decides which product a launch belongs to, or where it
 * goes instead. The facts decide nothing; this function is the one decision.
 *
 * Built in phase 1 without its preview rows (section O): the conflict row,
 * the path row, the journey row, the Individual row and the redirect row of
 * step 22. Phase 2 (P2-5 item 2) adds the `?mode=preview` row; the test-run
 * row is phase P's, and until it is built a launch that names a run is
 * refused (`preview_not_allowed`) and never falls through to an official
 * context.
 *
 * Order of the checks:
 *   1. both `?lp=` and `?journey=`: refused, `context_conflict`, before any
 *      fact is read (the page makes no call for it);
 *   2. a run: refused (phase P), with or without the mode; `?mode=preview`:
 *      a report-viewing role (canViewReports: super_owner, admin,
 *      data_analyst) launches the `preview` context with the preview kind
 *      `course`, any other role is refused (`preview_not_allowed`). The row
 *      answers before any fact is read, so a preview launch makes no
 *      launch_context call and `facts` may be null (P2-5 item 3b); the page
 *      has already bounded the course to the organisation. A preview opens
 *      the course outside every path and journey: past the conflict row its
 *      `?lp=`, `?journey=` and `day` are not read. The kind and the preview
 *      kind are this result's own fields; the attempt's columns are the
 *      launch page's;
 *   3. not an active member: `not_member`; the course not found in the
 *      organisation or inactive: `course_unavailable`;
 *   4. `?lp=P`: P found and active, else `path_unavailable`; a recorded
 *      enrolment, or P is "Everyone in this org" (self-enrolment, step 24),
 *      else `not_enrolled`; the course a step of P, else `not_a_step`; the
 *      step released, else the `upcoming` redirect; then, for a learner not
 *      enrolled yet on an "Everyone" path, "enrol first" (ruling A3:
 *      v_path_step_status holds enrolled learners only, so the order is read
 *      from the second call, after the page's insert); in strict order every
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
 *      this course in the pinned version, its context holds no open official
 *      attempt of another course, and the unlock rule opens it at `now` in
 *      the organisation's timezone); a completed E is otherwise
 *      `review_only`; for an active E, an uncredited day that holds this
 *      course while its context holds an open official attempt of another
 *      course (the day's course swapped after the learner started it) goes
 *      to the `journey` redirect into the same day on that started course,
 *      whose launch is the `resume` above (step 93: the launch of the day
 *      resumes it and does not open the day's current course beside it);
 *      an active E whose day holds this course but is not open yet goes to
 *      the `journey_locked` redirect; anything else is `day_not_open`;
 *   6. no product parameter: a released direct enrolment launches the
 *      Individual product; an "Everyone in this org" course self-enrols
 *      (step 24); otherwise exactly one holder (a path the learner is on, or
 *      a required day of an active enrolment) redirects into it, several go
 *      to the chooser, and with none an upcoming direct assignment goes to
 *      the `upcoming` redirect, else `not_enrolled`.
 *
 * Inactive content (the owner's O5 answer of 2026-11-14): a course, path or
 * journey program made inactive is closed to every learner, completed or in
 * progress. An inactive course refuses every launch of it in every product
 * (3, before any product row); an inactive path every `?lp=` launch (4); an
 * inactive program every `?journey=` launch, a completed enrolment's review
 * and a resume included (5, before resume, review and open). Review and
 * revision visits are launches too, so none is admitted. launch_context
 * names no holder for an inactive course, path or program, and its facts
 * flip back when the content is made active again: the saved attempts,
 * credits and step facts are never touched, so the same launch is admitted
 * again from them under the rules then in force.
 *
 * The refusal reasons are names for tests and logs; the page keeps today's
 * redirects and notices. Ids in a decision are lower case.
 *
 * Beside the resolver (phase 2, P2-6): refusalWithoutFacts(), the rows that
 * answer before any fact (the page makes no launch_context call for them),
 * and afterSelfEnrol(), the P2-Q2 (i-a) decision after the page's
 * self-enrolment insert and its second launch_context call.
 *
 * Pure: no next/* and no Supabase runtime import (the house shape of
 * lib/attempts/launch-kind.ts); `now` is an input, so the journey's "today"
 * is computed with todayStrAt (twins contract A12).
 */
import { canViewReports } from "@/lib/auth/permissions";
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
  /** Read by the preview row (P2-5 item 2). */
  role: OrgRole;
  params: LaunchParams;
  /**
   * launch_context's answer; null only when no call was made: the conflict
   * row's case, and a `?mode=preview` launch's, whose row needs no fact.
   */
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
      /**
       * A `journey` redirect from the journey row only: the course started on
       * that day (its open official attempt), relaunched in place of the
       * day's current course (steps 22 and 93). Absent on a holder redirect,
       * which relaunches the same course.
       */
      courseId?: string;
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

export type Refusal = Extract<LaunchDecision, { kind: "refused" }>["reason"];

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

/**
 * The rows that refuse before any fact is read (rows 1 and 2's run): both
 * product parameters (`context_conflict`), and a run, with or without the
 * mode (`preview_not_allowed`, phase P). The launch page calls this before
 * its course read and its launch_context call, so neither row costs a
 * request; resolveLaunchContext() answers the same from the same rule. Null
 * when neither row applies.
 */
export function refusalWithoutFacts(params: Pick<LaunchParams, "lp" | "journey" | "run">): Refusal | null {
  if (param(params.lp) !== null && param(params.journey) !== null) return "context_conflict";
  if (param(params.run) !== null) return "preview_not_allowed";
  return null;
}

/** The launch's context decision (ADR 0024 step 22; the order is in the header). */
export function resolveLaunchContext(i: ResolveInput): LaunchDecision {
  const lp = param(i.params.lp);
  const journey = param(i.params.journey);
  const day = param(i.params.day);

  // 1. Both product parameters: refused, no checks. 2. A run is phase P's:
  //    refused, with or without the mode, so it never becomes an official
  //    launch (refusalWithoutFacts, the page's own pre-check).
  const early = refusalWithoutFacts(i.params);
  if (early !== null) return refused(early);

  // 2. The preview row: `?mode=preview` is a report-viewing role's course
  //    preview (step 22's preview row), decided before any fact: no
  //    launch_context call is made for it.
  if (i.params.mode === "preview") {
    if (!canViewReports(i.role)) return refused("preview_not_allowed");
    return { kind: "launch", selfEnrol: null, context: { kind: "preview", previewKind: "course", runId: null, dayId: null } };
  }

  const facts = i.facts;
  if (facts === null) throw new TypeError("resolveLaunchContext: launch_context's facts are required past the conflict row");
  if (facts.v !== 1) throw new TypeError("resolveLaunchContext: an unknown launch_context answer version");

  // 3. Membership and the course. An inactive course is refused here, before
  //    any product row, so no product reviews, resumes or opens it (O5).
  if (!facts.member.active) return refused("not_member");
  const course = facts.course;
  if (!course.found || !course.is_active) return refused("course_unavailable");

  // 4. The path row.
  if (lp !== null) {
    if (!UUID.test(lp)) return refused("path_unavailable");
    const pathId = lp.toLowerCase();
    const p = facts.path;
    // An inactive path refuses every launch, a done step's review and an
    // open step's resume included (the owner's O5 answer).
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
    // A3: an "Everyone" path learner with no enrolment row reads every
    // earlier step as not done (v_path_step_status holds enrolled learners
    // only), so "enrol first", before the strict order is read. The page
    // inserts the self row, calls launch_context once more and resolves
    // again; that second answer applies the order. A course that is no step
    // of P, or a step not released yet, is answered above and enrols nobody.
    if (selfEnrol !== null) return { kind: "launch", selfEnrol, context: { kind: "path", pathId } };
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
    // An inactive program refuses every launch, a completed enrolment's
    // review and a resume included (step 22; the owner's O5 answer).
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
    // A day whose context holds an open official attempt of another course
    // (the day's course swapped after the learner started it): the launch of
    // that day resumes the started attempt and never opens the day's current
    // course beside it (steps 22 and 93; section 95's row "A day's course
    // swapped", R13). The day's own link names its current course, so the
    // launch goes into the same day on the started course, whose launch
    // answers `resume` above (launch_context orders the attempt of p_course
    // first), so it cannot loop. Never on a credited day: its review is the
    // credit row's course.
    const started = j.day_open_attempt?.course_id ?? null;
    if (holdsCourse && !j.day_credit && started !== null && UUID.test(started)) {
      return { kind: "redirect", to: "journey", enrollmentId, dayId, courseId: started.toLowerCase() };
    }
    // A credited day whose course a publish swapped is reviewed on the
    // credit row's course; its new course is not offered (step 22).
    if (!holdsCourse || j.day_credit || j.day_open_attempt) return refused("day_not_open");
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

/**
 * What the page's self-enrolment insert (step 24) answered: a new row; a
 * 23505, read as "already enrolled" (a self row or an admin's direct row of
 * the learner exists); any other error.
 */
export type SelfEnrolInsert = "inserted" | "already_enrolled" | "failed";

export type SelfEnrolOutcome =
  /** Act on the second decision as on any first one: a launch (never a further self-enrolment), a redirect or a refusal. */
  | { kind: "go_on"; decision: LaunchDecision }
  /** P2-Q2 (i-a): the learner's own direct assignment is not released yet: today's `/dashboard?upcoming=<course>`, no attempt written. */
  | { kind: "upcoming" }
  /** The retry notice, no attempt written. */
  | { kind: "retry"; reason: string };

/**
 * After the self-enrolment insert and the second launch_context call (step
 * 24; ruling A3; P2-Q2, option (i-a)). Pure: the page passes the insert's
 * answer and the resolver's second decision (null when no second call was
 * made, which is the case after a failed insert).
 *
 *   - any other insert error: the retry notice, nothing more written (the
 *     page makes no second call);
 *   - the second decision launches with no self-enrolment (the insert made
 *     the learner enrolled, or a 23505 met a concurrent Start's row): go on;
 *   - a 23505, then `selfEnrol: "course"` again: the row that answered
 *     23505 is the learner's own direct assignment, not released yet (a
 *     team, org-wide or group date never holds an "Everyone" course back):
 *     `upcoming`, and the insert is never tried again. Course only;
 *   - any other second self-enrolment (a path's, or a course's after an
 *     insert that succeeded): the retry notice, never a loop of inserts;
 *   - a redirect or a refusal (A3's second answer may be the strict lock):
 *     go on, so the page sends it to its notice.
 */
export function afterSelfEnrol(i: {
  selfEnrol: "course" | "path";
  insert: SelfEnrolInsert;
  second: LaunchDecision | null;
}): SelfEnrolOutcome {
  if (i.insert === "failed") return { kind: "retry", reason: `self_enrol_${i.selfEnrol}_insert_failed` };
  if (i.second === null) return { kind: "retry", reason: "self_enrol_no_second_answer" };
  if (i.second.kind === "launch" && i.second.selfEnrol !== null) {
    if (i.insert === "already_enrolled" && i.selfEnrol === "course" && i.second.selfEnrol === "course") return { kind: "upcoming" };
    return { kind: "retry", reason: `self_enrol_${i.second.selfEnrol}_not_recorded` };
  }
  return { kind: "go_on", decision: i.second };
}
