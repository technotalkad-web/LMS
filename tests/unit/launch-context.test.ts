/**
 * Unit tests for lib/attempts/launch-context.ts (ADR 0024 step 22; step 62's
 * row "launch-context.test.ts"; build note N15; twins contract 5.2): the
 * rows phase 1 builds.
 *
 *   (a) the conflict row: both parameters refused before any fact;
 *   (b) a preview or a run: refused until phases 2 and P build those rows;
 *   (c) membership and the course;
 *   (d) the path row: an unassigned ?lp= refused, an inactive path refused,
 *       an unreleased step redirected, the strict lock from the path rule's
 *       done as launch_context returns it, for P only, random mode, the
 *       self-enrol branch for an "Everyone" path;
 *   (e) the journey row: a day admitted when open, credited or resumable; a
 *       numeric day from an old link; a completed enrolment admits review
 *       and resume only; step 23's five cases (a removed day, a swapped
 *       course, a day moved past the calendar ceiling, a completed
 *       enrolment's resume, the swapped day's review); the unlock rule at
 *       `now` in the organisation's timezone;
 *   (f) no product parameter: the Individual row, the self-enrol branch for
 *       an "Everyone" course, and the redirect row (one holder, several,
 *       none with an upcoming assignment, none);
 *   (g) todayStrAt and journeyOpenDayIsOpen.
 *
 * The preview row (phase 2) and the test-run row (phase P) add their cases
 * here when they are built.
 *
 * Run:  npx tsx tests/unit/launch-context.test.ts   (or npm run test:unit)
 */
import {
  journeyOpenDayIsOpen,
  resolveLaunchContext,
  type JourneyFacts,
  type LaunchContextFacts,
  type LaunchDecision,
  type LaunchParams,
  type PathFacts,
} from "../../lib/attempts/launch-context";
import { todayStrAt } from "../../lib/journey/journey";
import type { OrgRole } from "../../lib/auth/require-org-access";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const uid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
const COURSE = uid("cc", 2);
const C1 = uid("cc", 1);
const C3 = uid("cc", 3);
const OTHER = uid("cc", 9);
const PATH = uid("b", 1);
const PATH2 = uid("b", 2);
const ENR = uid("e", 1);
const ENR2 = uid("e", 2);
const DAY3 = uid("d", 3);
const DAY4 = uid("d", 4);
const DAY9 = uid("d", 9);
const ATT = uid("a", 1);
// 2026-06-01 is a Monday; 05:30 in Asia/Kolkata.
const NOW = "2026-06-01T00:00:00Z";

const params = (o: Partial<LaunchParams> = {}): LaunchParams => ({ lp: null, journey: null, day: null, mode: null, run: null, ...o });
function facts(o: Partial<LaunchContextFacts> = {}): LaunchContextFacts {
  return {
    v: 1,
    member: { active: true },
    course: { found: true, is_active: true, visibility: "private", individual: { enrolled: false, upcoming_at: null } },
    path: null,
    journey: null,
    holders: { paths: [], journey_days: [] },
    run: null,
    ...o,
  };
}
type FoundPath = Extract<PathFacts, { found: true }>;
const pathFacts = (o: Partial<FoundPath> = {}): PathFacts => ({
  found: true,
  is_active: true,
  visibility: "private",
  sequence_mode: "strict",
  enrolled: true,
  self_row: false,
  course_step: 2,
  steps: [
    { course_id: C1, step_number: 1, release_at: null, done: true },
    { course_id: COURSE, step_number: 2, release_at: null, done: false },
    { course_id: C3, step_number: 3, release_at: null, done: false },
  ],
  ...o,
});
type FoundJourney = Extract<JourneyFacts, { found: true }>;
const journeyFacts = (o: Partial<FoundJourney> = {}): JourneyFacts => ({
  found: true,
  status: "active",
  program_id: uid("f", 1),
  program_is_active: true,
  start_date: "2026-05-25",
  version_id: uid("f", 2),
  unlock_mode: "calendar",
  count_sundays: false,
  days_total: 30,
  timezone: "Asia/Kolkata",
  day: { id: DAY4, number: 4, in_version: true, removed: false, course_id: COURSE },
  day_credit: null,
  day_open_attempt: null,
  required_days: 10,
  credited_days: 3,
  next_day: 4,
  next_day_id: DAY4,
  resumable_day_ids: [],
  ...o,
});
const resolve = (p: Partial<LaunchParams>, f: LaunchContextFacts | null, o: { role?: OrgRole; now?: string; courseId?: string } = {}): LaunchDecision =>
  resolveLaunchContext({ courseId: o.courseId ?? COURSE, role: o.role ?? "user", params: params(p), facts: f, now: o.now ?? NOW });
const refused = (reason: string) => ({ kind: "refused", reason });
const launchJourney = (admission: string, dayId = DAY4, dayNumber: number | null = 4) => ({
  kind: "launch", selfEnrol: null, context: { kind: "journey", enrollmentId: ENR, dayId, dayNumber, admission },
});

console.log("\n(a) the conflict row");
{
  eq("both ?lp= and ?journey=: refused, with no facts read", resolve({ lp: PATH, journey: ENR, day: DAY4 }, null), refused("context_conflict"));
  eq("…whatever the facts say", resolve({ lp: PATH, journey: ENR }, facts({ path: pathFacts(), journey: journeyFacts() })), refused("context_conflict"));
  eq("…before a preview is looked at", resolve({ lp: PATH, journey: ENR, mode: "preview" }, null), refused("context_conflict"));
  eq("an empty ?lp= is no parameter: no conflict", resolve({ lp: "", journey: ENR, day: DAY4 }, facts({ journey: journeyFacts() })), launchJourney("open"));
  let threw = false;
  try { resolve({}, null); } catch { threw = true; }
  eq("no facts past the conflict row is a caller's error: it throws", threw, true);
}

console.log("\n(b) a preview or a run: refused until phases 2 and P");
{
  for (const role of ["super_owner", "admin", "data_analyst", "user"] as OrgRole[]) {
    eq(`?mode=preview as ${role}: refused, never an official launch`, resolve({ mode: "preview" }, facts({ course: { found: true, is_active: true, visibility: "org_public", individual: { enrolled: true, upcoming_at: null } } }), { role }), refused("preview_not_allowed"));
  }
  eq("a run named without the mode: refused", resolve({ run: uid("f", 7), lp: PATH }, facts({ path: pathFacts() })), refused("preview_not_allowed"));
}

console.log("\n(c) membership and the course");
{
  eq("not an active member: refused", resolve({}, facts({ member: { active: false }, course: { found: true, is_active: true, visibility: "org_public", individual: { enrolled: true, upcoming_at: null } } })), refused("not_member"));
  eq("the course is not in the organisation: refused", resolve({ lp: PATH }, facts({ course: { found: false }, path: pathFacts() })), refused("course_unavailable"));
  eq("an inactive course: refused, whatever the product", resolve({ lp: PATH }, facts({ course: { found: true, is_active: false, visibility: "private", individual: { enrolled: true, upcoming_at: null } }, path: pathFacts() })), refused("course_unavailable"));
}

console.log("\n(d) the path row (?lp=P)");
{
  eq("enrolled, a released step, every earlier step done (strict): path:P", resolve({ lp: PATH }, facts({ path: pathFacts() })), { kind: "launch", selfEnrol: null, context: { kind: "path", pathId: PATH } });
  eq("…an upper-case ?lp= gives the lower-case id", resolve({ lp: PATH.toUpperCase() }, facts({ path: pathFacts() })), { kind: "launch", selfEnrol: null, context: { kind: "path", pathId: PATH } });
  eq("an unassigned ?lp= (a private path, no enrolment): refused", resolve({ lp: PATH }, facts({ path: pathFacts({ enrolled: false }) })), refused("not_enrolled"));
  eq("…an individually entitled learner is still refused on the path", resolve({ lp: PATH }, facts({ course: { found: true, is_active: true, visibility: "org_public", individual: { enrolled: true, upcoming_at: null } }, path: pathFacts({ enrolled: false }) })), refused("not_enrolled"));
  eq("an \"Everyone\" path, not enrolled yet: the launch self-enrols on the path (step 24)", resolve({ lp: PATH }, facts({ path: pathFacts({ enrolled: false, visibility: "org_public" }) })), { kind: "launch", selfEnrol: "path", context: { kind: "path", pathId: PATH } });
  eq("…a self-enrolled learner (the self row recorded) is enrolled: no second self-enrolment", resolve({ lp: PATH }, facts({ path: pathFacts({ enrolled: true, self_row: true, visibility: "org_public" }) })), { kind: "launch", selfEnrol: null, context: { kind: "path", pathId: PATH } });
  eq("an inactive path: refused", resolve({ lp: PATH }, facts({ path: pathFacts({ is_active: false }) })), refused("path_unavailable"));
  eq("a path not found in the organisation: refused", resolve({ lp: PATH }, facts({ path: { found: false } })), refused("path_unavailable"));
  eq("no path facts for a ?lp= launch: refused", resolve({ lp: PATH }, facts()), refused("path_unavailable"));
  eq("a ?lp= that is not a uuid: refused", resolve({ lp: "12" }, facts({ path: pathFacts() })), refused("path_unavailable"));
  eq("the course is not a step of P: refused", resolve({ lp: PATH }, facts({ path: pathFacts({ course_step: null }) })), refused("not_a_step"));
  eq("…a step number naming another course: refused", resolve({ lp: PATH }, facts({ path: pathFacts() }), { courseId: OTHER }), refused("not_a_step"));
  const unreleased = pathFacts({ steps: [
    { course_id: C1, step_number: 1, release_at: null, done: true },
    { course_id: COURSE, step_number: 2, release_at: "2999-01-01T00:00:00Z", done: false },
  ] });
  eq("an unreleased step: the upcoming redirect", resolve({ lp: PATH }, facts({ path: unreleased })), { kind: "redirect", to: "upcoming", pathId: PATH });
  const released = pathFacts({ steps: [
    { course_id: C1, step_number: 1, release_at: null, done: true },
    { course_id: COURSE, step_number: 2, release_at: "2001-01-01T00:00:00Z", done: false },
  ] });
  eq("…a release date in the past: launched", resolve({ lp: PATH }, facts({ path: released })).kind, "launch");
  const locked = pathFacts({ steps: [
    { course_id: C1, step_number: 1, release_at: null, done: false },
    { course_id: COURSE, step_number: 2, release_at: null, done: false },
  ] });
  eq("strict order, an earlier step not done: the locked redirect", resolve({ lp: PATH }, facts({ path: locked })), { kind: "redirect", to: "locked", pathId: PATH });
  eq("…random order: launched", resolve({ lp: PATH }, facts({ path: pathFacts({ ...locked, sequence_mode: "random" } as FoundPath) })).kind, "launch");
  eq("…an unreleased step is told before the lock", resolve({ lp: PATH }, facts({ path: pathFacts({ steps: [
    { course_id: C1, step_number: 1, release_at: null, done: false },
    { course_id: COURSE, step_number: 2, release_at: "2999-01-01T00:00:00Z", done: false },
  ] }) })), { kind: "redirect", to: "upcoming", pathId: PATH });
  eq("…the lock reads done as launch_context returns it (a step done by the path rule, D14 or its stored fact, unlocks)",
    resolve({ lp: PATH }, facts({ path: pathFacts() })).kind, "launch");
  eq("…a later step not done never locks", resolve({ lp: PATH }, facts({ path: pathFacts({ course_step: 1, steps: [
    { course_id: COURSE, step_number: 1, release_at: null, done: false },
    { course_id: C3, step_number: 2, release_at: null, done: false },
  ] }) })).kind, "launch");
  eq("…the lock and the release gate are P's only: another path holding the course is not read", resolve({ lp: PATH }, facts({
    path: pathFacts(), holders: { paths: [{ path_id: PATH2, step_number: 5 }], journey_days: [] },
  })), { kind: "launch", selfEnrol: null, context: { kind: "path", pathId: PATH } });
}

console.log("\n(e) the journey row (?journey=E&day=D)");
{
  const j = (o: Partial<FoundJourney> = {}) => facts({ journey: journeyFacts(o) });
  eq("the open day of an active enrolment, holding this course, reached by the calendar: open", resolve({ journey: ENR, day: DAY4 }, j()), launchJourney("open"));
  eq("…an upper-case enrolment id gives the lower-case id", resolve({ journey: ENR.toUpperCase(), day: DAY4.toUpperCase() }, j()), launchJourney("open"));
  eq("a numeric day from an old link, resolved through the pinned version: open", resolve({ journey: ENR, day: "4" }, j()), launchJourney("open"));
  eq("…a number the call resolved to another day: refused", resolve({ journey: ENR, day: "5" }, j()), refused("day_not_open"));
  eq("…a number the pinned version does not hold (no day id): refused", resolve({ journey: ENR, day: "40" }, j({ day: { id: null, number: null, in_version: false, removed: false, course_id: null } })), refused("day_not_open"));
  eq("no day parameter: refused", resolve({ journey: ENR }, j()), refused("day_not_open"));
  eq("a day id that is not the one the facts are for: refused", resolve({ journey: ENR, day: DAY9 }, j()), refused("day_not_open"));
  eq("a day parameter that is neither a uuid nor a number: refused", resolve({ journey: ENR, day: "four" }, j()), refused("day_not_open"));
  eq("the open day not reached by the calendar yet: the journey_locked redirect",
    resolve({ journey: ENR, day: DAY4 }, j({ start_date: "2026-05-30" })), { kind: "redirect", to: "journey_locked", enrollmentId: ENR, dayId: DAY4 });
  eq("a later day than the open one: the journey_locked redirect",
    resolve({ journey: ENR, day: DAY4 }, j({ next_day: 3, next_day_id: DAY3 })), { kind: "redirect", to: "journey_locked", enrollmentId: ENR, dayId: DAY4 });
  eq("a day holding another course (no credit, no open attempt): refused", resolve({ journey: ENR, day: DAY4 }, j({ day: { id: DAY4, number: 4, in_version: true, removed: false, course_id: OTHER } })), refused("day_not_open"));
  eq("a credited day is a review in context", resolve({ journey: ENR, day: DAY4 }, j({ day_credit: { course_id: COURSE, attempt_id: ATT, credit_kind: "attempt", day_number: 4 }, next_day: 5, next_day_id: DAY9 })), launchJourney("review"));
  eq("…a legacy cross-context credit too", resolve({ journey: ENR, day: DAY4 }, j({ day_credit: { course_id: COURSE, attempt_id: null, credit_kind: "legacy_cross_context", day_number: 4 }, next_day: 5, next_day_id: DAY9 })), launchJourney("review"));
  eq("an open official attempt of this course on the day: resume", resolve({ journey: ENR, day: DAY4 }, j({ day_open_attempt: { attempt_id: ATT, course_id: COURSE }, resumable_day_ids: [DAY4] })), launchJourney("resume"));
  eq("…an open attempt of another course on the day is not this launch's resume", resolve({ journey: ENR, day: DAY4 }, j({ day_open_attempt: { attempt_id: ATT, course_id: OTHER } })), launchJourney("open"));

  // Step 23's five cases.
  eq("step 23 (1): a started day that was removed: resume", resolve({ journey: ENR, day: DAY9 }, j({
    day: { id: DAY9, number: null, in_version: false, removed: true, course_id: null }, day_open_attempt: { attempt_id: ATT, course_id: COURSE }, resumable_day_ids: [DAY9],
  })), launchJourney("resume", DAY9, null));
  eq("step 23 (2): a started day whose course a publish swapped: resume of the course started", resolve({ journey: ENR, day: DAY4 }, j({
    day: { id: DAY4, number: 4, in_version: true, removed: false, course_id: OTHER }, day_open_attempt: { attempt_id: ATT, course_id: COURSE },
  })), launchJourney("resume"));
  eq("step 23 (3): a started day moved past the calendar ceiling: resume", resolve({ journey: ENR, day: DAY4 }, j({
    day: { id: DAY4, number: 25, in_version: true, removed: false, course_id: COURSE }, day_open_attempt: { attempt_id: ATT, course_id: COURSE }, next_day: 2, next_day_id: DAY3,
  })), launchJourney("resume", DAY4, 25));
  eq("step 23 (4): a completed enrolment, an attempt open when a publish completed it: resume", resolve({ journey: ENR, day: DAY4 }, j({
    status: "completed", day_open_attempt: { attempt_id: ATT, course_id: COURSE }, next_day: null, next_day_id: null,
  })), launchJourney("resume"));
  const swappedCredited = { day: { id: DAY4, number: 4, in_version: true, removed: false, course_id: OTHER }, day_credit: { course_id: COURSE, attempt_id: ATT, credit_kind: "attempt", day_number: 4 }, next_day: 5, next_day_id: DAY9 };
  eq("step 23 (5): a credited day whose course was swapped: the review opens the credited course", resolve({ journey: ENR, day: DAY4 }, j(swappedCredited)), launchJourney("review"));
  eq("…and the day's new course is not offered to a learner who completed the day", resolve({ journey: ENR, day: DAY4 }, j(swappedCredited), { courseId: OTHER }), refused("day_not_open"));

  eq("a completed enrolment admits review", resolve({ journey: ENR, day: DAY4 }, j({ status: "completed", day_credit: { course_id: COURSE, attempt_id: ATT, credit_kind: "attempt", day_number: 4 }, next_day: null, next_day_id: null })), launchJourney("review"));
  eq("…and never a new official attempt, even on its next required day", resolve({ journey: ENR, day: DAY4 }, j({ status: "completed" })), refused("review_only"));
  eq("a reset enrolment: refused", resolve({ journey: ENR, day: DAY4 }, j({ status: "reset", day_credit: { course_id: COURSE, attempt_id: ATT, credit_kind: "attempt", day_number: 4 } })), refused("journey_unavailable"));
  eq("an enrolment not the learner's or not in the organisation: refused", resolve({ journey: ENR, day: DAY4 }, facts({ journey: { found: false } })), refused("journey_unavailable"));
  eq("no journey facts for a ?journey= launch: refused", resolve({ journey: ENR, day: DAY4 }, facts()), refused("journey_unavailable"));
  eq("an inactive program: refused, a review included", resolve({ journey: ENR, day: DAY4 }, j({ program_is_active: false, day_credit: { course_id: COURSE, attempt_id: ATT, credit_kind: "attempt", day_number: 4 } })), refused("journey_unavailable"));
  eq("a ?journey= that is not a uuid: refused", resolve({ journey: "7", day: DAY4 }, j()), refused("journey_unavailable"));
  eq("progress mode: the open day is open as soon as the journey has started", resolve({ journey: ENR, day: DAY4 }, j({ unlock_mode: "progress", start_date: "2026-05-30", next_day: 4 })), launchJourney("open"));
  eq("…but not before its start date", resolve({ journey: ENR, day: DAY4 }, j({ unlock_mode: "progress", start_date: "2026-06-02" })), { kind: "redirect", to: "journey_locked", enrollmentId: ENR, dayId: DAY4 });
  eq("zero required days: no open day", resolve({ journey: ENR, day: DAY4 }, j({ required_days: 0, credited_days: 0, next_day: null, next_day_id: null })), { kind: "redirect", to: "journey_locked", enrollmentId: ENR, dayId: DAY4 });
  // 2026-05-31T20:00Z is 2026-06-01 in Asia/Kolkata and 2026-05-31 in UTC.
  const lateUtc = "2026-05-31T20:00:00Z";
  const dayOne = { start_date: "2026-06-01", next_day: 1, next_day_id: DAY4, day: { id: DAY4, number: 1, in_version: true, removed: false, course_id: COURSE } };
  eq("the calendar is the organisation's: day 1 open in Asia/Kolkata at 20:00 UTC the evening before", resolve({ journey: ENR, day: DAY4 }, j(dayOne), { now: lateUtc }), launchJourney("open", DAY4, 1));
  eq("…not yet open in UTC", resolve({ journey: ENR, day: DAY4 }, j({ ...dayOne, timezone: "UTC" }), { now: lateUtc }).kind, "redirect");
  eq("…no timezone reads the default (Asia/Kolkata)", resolve({ journey: ENR, day: DAY4 }, j({ ...dayOne, timezone: null }), { now: lateUtc }).kind, "launch");
}

console.log("\n(f) no product parameter: the Individual row and the redirect row");
{
  const course = (enrolled: boolean, visibility = "private", upcoming: string | null = null) =>
    ({ found: true as const, is_active: true, visibility, individual: { enrolled, upcoming_at: upcoming } });
  eq("a released direct enrolment: individual", resolve({}, facts({ course: course(true) })), { kind: "launch", selfEnrol: null, context: { kind: "individual" } });
  eq("…whatever paths and journeys hold the course", resolve({}, facts({ course: course(true), holders: { paths: [{ path_id: PATH, step_number: 1 }], journey_days: [] } })), { kind: "launch", selfEnrol: null, context: { kind: "individual" } });
  eq("an \"Everyone\" course, not enrolled yet: individual, self-enrolled first (step 24)", resolve({}, facts({ course: course(false, "org_public") })), { kind: "launch", selfEnrol: "course", context: { kind: "individual" } });
  eq("…with a direct assignment not released yet: self-enrolled at once (today's access check reads org_public first)",
    resolve({}, facts({ course: course(false, "org_public", "2999-01-01T00:00:00Z") })), { kind: "launch", selfEnrol: "course", context: { kind: "individual" } });
  eq("not entitled, exactly one path holds the course: into that path", resolve({}, facts({ holders: { paths: [{ path_id: PATH, step_number: 2 }], journey_days: [] } })), { kind: "redirect", to: "path", pathId: PATH });
  eq("not entitled, exactly one journey day holds it: into that day", resolve({}, facts({ holders: { paths: [], journey_days: [{ enrollment_id: ENR, day_id: DAY4, day_number: 4, credited: false }] } })), { kind: "redirect", to: "journey", enrollmentId: ENR, dayId: DAY4 });
  eq("…a credited day counts as a holder too (its review is in context)", resolve({}, facts({ holders: { paths: [], journey_days: [{ enrollment_id: ENR, day_id: DAY4, day_number: 4, credited: true }] } })), { kind: "redirect", to: "journey", enrollmentId: ENR, dayId: DAY4 });
  eq("several holders: the chooser", resolve({}, facts({ holders: { paths: [{ path_id: PATH, step_number: 2 }], journey_days: [{ enrollment_id: ENR2, day_id: DAY4, day_number: 4, credited: false }] } })), { kind: "redirect", to: "chooser" });
  eq("…one course on two days of one enrolment is two holders", resolve({}, facts({ holders: { paths: [], journey_days: [
    { enrollment_id: ENR, day_id: DAY3, day_number: 3, credited: true }, { enrollment_id: ENR, day_id: DAY4, day_number: 4, credited: false },
  ] } })), { kind: "redirect", to: "chooser" });
  eq("no holder, a direct assignment not released yet: the upcoming redirect", resolve({}, facts({ course: course(false, "private", "2999-01-01T00:00:00Z") })), { kind: "redirect", to: "upcoming" });
  eq("…a holder goes before the upcoming notice", resolve({}, facts({ course: course(false, "private", "2999-01-01T00:00:00Z"), holders: { paths: [{ path_id: PATH, step_number: 2 }], journey_days: [] } })), { kind: "redirect", to: "path", pathId: PATH });
  eq("no entitlement and no holder: refused as today", resolve({}, facts()), refused("not_enrolled"));
}

console.log("\n(g) todayStrAt and journeyOpenDayIsOpen");
{
  eq("todayStrAt: the date in the zone at the instant", [todayStrAt("2026-05-31T20:00:00Z", "Asia/Kolkata"), todayStrAt("2026-05-31T20:00:00Z", "UTC")], ["2026-06-01", "2026-05-31"]);
  let threw = false;
  try { todayStrAt("not a date", "UTC"); } catch { threw = true; }
  eq("todayStrAt: an invalid instant throws", threw, true);
  const base = { start_date: "2026-05-25", days_total: 30, count_sundays: false, unlock_mode: "calendar", timezone: "Asia/Kolkata", next_day: 7 };
  // 2026-05-25 (Mon) to 2026-06-01 (Mon): eight days, one Sunday.
  eq("calendar: day 7 open on the seventh counted day (a Sunday skipped)", journeyOpenDayIsOpen(base, NOW), true);
  eq("…day 8 is not", journeyOpenDayIsOpen({ ...base, next_day: 8 }, NOW), false);
  eq("…with Sundays counted, day 8 is", journeyOpenDayIsOpen({ ...base, next_day: 8, count_sundays: true }, NOW), true);
  eq("…capped at days_total", journeyOpenDayIsOpen({ ...base, days_total: 5, next_day: 6 }, NOW), false);
  eq("no next day: never open", journeyOpenDayIsOpen({ ...base, next_day: null }, NOW), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
