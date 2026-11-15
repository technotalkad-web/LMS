import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { isReleased } from "@/lib/learner/release";
import { resolveUserGroupIds } from "@/lib/org/groups";
import {
  computeJourneyState,
  courseDaysOf,
  creditedDaysFor,
  parseVersionDays,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";
import { readJourneyCredits, type JourneyCredits } from "@/lib/journey/credits-read";
import { readWithContextFilter, type ContextFilterState } from "@/lib/scoring/context-read";

export type CourseAccess = {
  allowed: boolean;
  /**
   * When access is denied only because every matching assignment has a future
   * release_at, the earliest such release time — callers should render/redirect
   * "coming soon" instead of "not assigned". Null otherwise.
   */
  upcomingAt: string | null;
  /**
   * The "Everyone" path whose `?lp=` the course page's Start carries
   * (everyonePathStart below): set only when the grant is a released step of
   * an active "Everyone" path the learner has no assignment row on, and
   * nothing else holds the course for a plain Start. Absent or null: a
   * plain Start.
   */
  startPathId?: string | null;
};

/**
 * The "Everyone" path a Start carries in its `?lp=` (ADR 0024 ruling A3).
 * Since P2-6 a Start with no product parameter is decided by the launch's
 * resolver, whose path holders are the paths the learner has an assignment
 * row on (launch_context reads v_path_enrollments_expanded, which has no
 * visibility arm). A learner who reaches a course only through an active
 * "Everyone" (org_public) path with no row of theirs is refused
 * (`not_enrolled`) by a plain Start; with `?lp=` the resolver's path row
 * enrols them first (A3) and then applies the path's release and order.
 *
 * Pure. A path id only when all of these hold; otherwise null and the Start
 * stays plain:
 *   - the course is not "Everyone" itself (a plain Start self-enrols on it,
 *     step 24);
 *   - no direct assignment row reaches the learner, released or not (a
 *     plain Start launches a released one as Individual, and a future-dated
 *     one answers "not yet released"; the dashboard shows that course's own
 *     card as Coming soon);
 *   - no step in `steps` is on a path the learner has an assignment row on
 *     (a plain Start is admitted, or redirected into that path, by the
 *     resolver);
 *   - a released step of an "Everyone" path holds the course.
 * Of several such paths, the lowest path id (launch_context orders its
 * holders by path id), so the dashboard and the course page name the same
 * path whatever order their reads answer in.
 *
 * `steps`: each step of an ACTIVE path of the organisation that holds the
 * course (launch_context's holders keep active paths only).
 *
 * Not read: a day of the learner's active journey that holds the course
 * (launch_context's other holder). Such a learner's plain Start goes into
 * that day; with `?lp=` it goes into the path instead (the course page would
 * need a further read to tell).
 */
export function everyonePathStart(i: {
  /** courses.visibility is org_public. */
  courseIsEveryone: boolean;
  /** A direct assignment row (own, team, org-wide or Custom Group), released or not, reaches the learner. */
  directlyHeld: boolean;
  steps: ReadonlyArray<{
    pathId: string;
    /** learning_paths.visibility is org_public. */
    everyone: boolean;
    /** The learner has an assignment row on the path (own, team, org-wide or Custom Group). */
    enrolled: boolean;
    releaseAt: string | null;
  }>;
  now: number;
}): string | null {
  if (i.courseIsEveryone || i.directlyHeld) return null;
  if (i.steps.some((s) => s.enrolled)) return null;
  let pick: string | null = null;
  for (const s of i.steps) {
    if (!s.everyone || !isReleased(s.releaseAt, i.now)) continue;
    if (pick === null || s.pathId.toLowerCase() < pick.toLowerCase()) pick = s.pathId;
  }
  return pick;
}

/**
 * Whether a learner may open a course. Allowed for a Preview (`preview`: the
 * caller decided it from the mode, never from the role alone), when the course
 * is `org_public`, the learner is
 * assigned — directly, org-wide, or via a team they're on — or the course is a
 * step in a learning path the learner is entitled to (assigned, or an
 * org_public path). Assignment rows and path steps whose release_at is still
 * in the future don't grant access (scheduled-release gate); when that's the
 * ONLY thing matching, `upcomingAt` carries the earliest unlock time so
 * callers can say "coming soon" instead of "not assigned".
 *
 * The learning-path grant matters because assigning a PATH does not create
 * course_assignments rows — without it, every private path chapter 404'd into
 * a "denied" bounce even though the dashboard/path page offered a Launch link.
 *
 * This mirrors the dashboard's entitlement resolution (dashboard/page.tsx) and
 * the learning-path detail page (paths/[pathId]/page.tsx) so that "launchable"
 * equals "appears on your dashboard" (upcoming cards appear but don't launch)
 * — with ONE deliberate exception: Yoddha-journey days (0058) are launchable
 * for enrolled learners but surface only on the /journey page, never as
 * dashboard course cards. Do not "fix" that by removing the journey branch.
 * Its grants are the journey row of ADR 0024 step 22 as step 23 states it
 * for this check (see the branch below): the open day's course, the course
 * on a credit row, and the course of an open official journey attempt.
 * It closes an IDOR where any org member could open a PRIVATE, UNASSIGNED
 * course just by visiting its URL — the course detail/launch pages previously
 * checked only `organization_id`.
 *
 * Since ADR 0024 P2-6 (P2-N5) the launch page decides its own launches
 * through resolveLaunchContext and no longer calls this function; the
 * learner course page is its caller.
 *
 * Pass the caller's RLS-scoped client so visibility matches the dashboard
 * (non-admins can't read pure team-assignment rows — same as the dashboard).
 */
export async function learnerCanAccessCourse(opts: {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
  courseId: string;
  /**
   * A Preview by mode (ADR 0024 step 23, P2-5 item 4): true only when the
   * caller may view reports (canViewReports(role)) and asked for
   * `?mode=preview`. Without the mode every role is a learner and needs an
   * entitlement below. Required, so a caller cannot skip the decision.
   */
  preview: boolean;
  /** Pass `courses.visibility` if already loaded to skip a query. */
  visibility?: string | null;
  /**
   * The caller's own journey credit read (readJourneyCredits, same client)
   * and the enrolment ids it covers, so one render reads the credits once.
   * Used only when it is ok and covers every enrolment the journey branch
   * reads (active or completed, on an active program); otherwise the
   * credits are read here. No caller passes it since P2-6 (the launch page
   * was the one that did).
   */
  journeyCredits?: { ids: ReadonlySet<string>; credits: JourneyCredits };
}): Promise<CourseAccess> {
  const { supabase, orgId, userId, courseId, preview } = opts;
  if (preview) return { allowed: true, upcomingAt: null };

  let visibility = opts.visibility;
  if (visibility === undefined) {
    const { data } = await supabase
      .from("courses")
      .select("visibility")
      .eq("id", courseId)
      .maybeSingle();
    visibility = (data as { visibility?: string | null } | null)?.visibility ?? null;
  }
  if (visibility === "org_public") return { allowed: true, upcomingAt: null };

  // Teams this user is on (scoped to the org).
  const { data: teamRows } = await supabase
    .from("team_members")
    .select("team_id, teams!inner(organization_id)")
    .eq("user_id", userId);
  const myTeamIds = (
    (teamRows ?? []) as Array<{
      team_id: string;
      teams: { organization_id: string } | Array<{ organization_id: string }>;
    }>
  )
    .filter((r) => {
      const t = Array.isArray(r.teams) ? r.teams[0] : r.teams;
      return t?.organization_id === orgId;
    })
    .map((r) => r.team_id);

  // select("*") for deploy safety across the 0069 group_id migration.
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select("*")
    .eq("course_id", courseId)
    .eq("organization_id", orgId);
  const assignments = (assignmentRows ?? []) as Array<{
    assignee_type: string;
    user_id: string | null;
    team_id: string | null;
    group_id?: string | null;
    release_at: string | null;
  }>;

  // Custom Group entitlement (0069): membership resolves LIVE through the
  // shared resolver. Group rules live in admin-only tables, so this one
  // check runs service-role — the decision is still made HERE, org-scoped.
  let myGroupIds: Set<string> | null = null;
  const groupIdsOf = async (): Promise<Set<string>> => {
    if (myGroupIds) return myGroupIds;
    try {
      const svc = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      );
      myGroupIds = await resolveUserGroupIds(svc, orgId, userId);
    } catch {
      myGroupIds = new Set();
    }
    return myGroupIds;
  };
  const hasGroupRows = (rows: Array<{ assignee_type: string }>) =>
    rows.some((a) => a.assignee_type === "group");
  const groups = hasGroupRows(assignments) ? await groupIdsOf() : new Set<string>();

  const mine = assignments.filter(
    (a) =>
      (a.assignee_type === "user" && a.user_id === userId) ||
      a.assignee_type === "org" ||
      (a.assignee_type === "team" && a.team_id && myTeamIds.includes(a.team_id)) ||
      (a.assignee_type === "group" && a.group_id && groups.has(a.group_id))
  );

  const now = Date.now();
  // Future release times of everything that matched but hasn't unlocked yet.
  const pending: string[] = [];
  for (const a of mine) {
    if (isReleased(a.release_at, now)) return { allowed: true, upcomingAt: null };
    if (a.release_at) pending.push(a.release_at);
  }

  // Learning-path entitlement: assigning a path doesn't create course
  // assignments, so a path chapter is reachable purely through its path.
  const { data: stepRows } = await supabase
    .from("learning_path_courses")
    .select(
      "path_id, release_at, learning_paths!inner(id, is_active, visibility, organization_id)"
    )
    .eq("course_id", courseId);
  type StepRow = {
    path_id: string;
    release_at: string | null;
    learning_paths:
      | { id: string; is_active: boolean; visibility: string | null; organization_id: string }
      | Array<{ id: string; is_active: boolean; visibility: string | null; organization_id: string }>;
  };
  const steps = ((stepRows ?? []) as StepRow[])
    .map((s) => ({
      path_id: s.path_id,
      release_at: s.release_at,
      path: Array.isArray(s.learning_paths) ? s.learning_paths[0] : s.learning_paths,
    }))
    .filter((s) => s.path?.is_active !== false && s.path?.organization_id === orgId);

  if (steps.length > 0) {
    const { data: pathAssignRows } = await supabase
      .from("learning_path_assignments")
      .select("*")
      .in(
        "path_id",
        steps.map((s) => s.path_id)
      );
    const pathAssigns = (pathAssignRows ?? []) as Array<{
      path_id: string;
      assignee_type: string;
      user_id: string | null;
      team_id: string | null;
      group_id?: string | null;
    }>;
    const pathGroups = hasGroupRows(pathAssigns) ? await groupIdsOf() : new Set<string>();
    const myPathIds = new Set(
      pathAssigns
        .filter(
          (a) =>
            (a.assignee_type === "user" && a.user_id === userId) ||
            a.assignee_type === "org" ||
            (a.assignee_type === "team" && a.team_id && myTeamIds.includes(a.team_id)) ||
            (a.assignee_type === "group" && a.group_id && pathGroups.has(a.group_id))
        )
        .map((a) => a.path_id)
    );
    // Two passes, the same grant as one: a step is entitled when the learner
    // has a row on its path or the path is "Everyone". First the paths with a
    // row: a released step there grants with a plain Start (the launch's
    // resolver admits it, or redirects into that path).
    for (const s of steps) {
      if (!myPathIds.has(s.path_id)) continue;
      if (isReleased(s.release_at, now)) return { allowed: true, upcomingAt: null };
      if (s.release_at) pending.push(s.release_at);
    }
    // Then the "Everyone" paths with no row of the learner: a released step
    // grants, and the Start carries the path's `?lp=` when nothing else holds
    // the course (everyonePathStart; ruling A3 enrols the learner at the
    // launch). The course is not "Everyone" (returned above); a direct row
    // left here is future-dated, and keeps the Start plain.
    for (const s of steps) {
      if (myPathIds.has(s.path_id) || s.path?.visibility !== "org_public") continue;
      if (isReleased(s.release_at, now)) {
        return {
          allowed: true,
          upcomingAt: null,
          startPathId: everyonePathStart({
            courseIsEveryone: false,
            directlyHeld: mine.length > 0,
            steps: steps.map((x) => ({
              pathId: x.path_id,
              everyone: x.path?.visibility === "org_public",
              enrolled: myPathIds.has(x.path_id),
              releaseAt: x.release_at,
            })),
            now,
          }),
        };
      }
      if (s.release_at) pending.push(s.release_at);
    }
  }

  // Yoddha-journey entitlement (0058; ADR 0024 steps 22, 23 and 93): a
  // course is reachable through a journey enrolment of the learner that is
  // active or completed, on an active program, in three ways, the journey
  // row of step 22 as step 23 states it for this check:
  //   (a) review: a credit row of the enrolment holds the course, whatever
  //       the pinned version holds on that day now and whatever the ceiling
  //       (the course the learner completed; after a publish swapped the
  //       day's course, its review opens the course on the credit row, and
  //       a credited day never offers the new course; section 95's row "A
  //       day's course swapped"). A credit row whose course is null (the
  //       course deleted) grants nothing;
  //   (b) open, an active enrolment only: the open day (the lowest required
  //       day without a credit, when the unlock rule opens it) holds the
  //       course in the pinned version. No other day opens: future days stay
  //       locked even by direct URL (the drip is the whole point), and a
  //       credited day grants only by (a);
  //   (c) resume: the enrolment holds an open official journey attempt of
  //       the course (context_kind 'journey', in progress, not a revision
  //       row), whatever the day's place in the pinned version now: a started
  //       day removed, swapped or moved past the ceiling by a publish, and a
  //       completed enrolment's attempt that was open when a publish
  //       completed it (step 93).
  // A completed enrolment grants (a) and (c) only (step 22: review, and the
  // resume of an attempt that was open when a publish completed it; never a
  // new official attempt). An inactive program grants nothing, a completed
  // enrolment's review included (the owner's O5 answer), as the launch's
  // resolver refuses it (journey_unavailable). Journeys grant no
  // course_assignments rows, mirroring the learning-path grant above. The
  // launch's resolver still decides which admission a `?journey=` launch is.
  const { data: enrRows } = await supabase
    .from("journey_enrollments")
    .select(
      "id, version_id, start_date, status, journey_programs!inner(is_active)"
    )
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .in("status", ["active", "completed"]);
  const enrollments = ((enrRows ?? []) as Array<{
    id: string;
    version_id: string;
    start_date: string;
    status: string;
    journey_programs: { is_active: boolean } | Array<{ is_active: boolean }>;
  }>).filter((e) => {
    const p = Array.isArray(e.journey_programs)
      ? e.journey_programs[0]
      : e.journey_programs;
    // A paused (inactive) program closes the journey to every learner,
    // completed or not (O5): no review, no resume, no open day.
    return p?.is_active !== false;
  });
  if (enrollments.length > 0) {
    // The credits of every enrolment above, in one read by day id (ADR 0024
    // step 45), never a count per enrolment. A failed read grants nothing
    // through a journey: it is never "no credits", which would open the
    // first course day, and no grant of this branch is made on a guess. The
    // caller's own read is used when it covers every enrolment here.
    const given = opts.journeyCredits;
    const credits =
      given && given.credits.ok && enrollments.every((e) => given.ids.has(e.id))
        ? given.credits
        : await readJourneyCredits(
            supabase,
            enrollments.map((e) => ({ id: e.id, version_id: e.version_id }))
          );
    if (!credits.ok) {
      console.warn(JSON.stringify({ event: "journey_credits_unreadable", where: "course_access", code: credits.error?.code ?? null }));
    } else {
      // (a) review: a credit row for the course.
      if (enrollments.some((e) => credits.rowsOf(e.id).some((r) => sameCourse(r.course_id, courseId)))) {
        return { allowed: true, upcomingAt: null };
      }

      // (b) open: an active enrolment whose pinned version holds the course
      // on its open day. Curriculum and rules come from each enrolment's
      // PINNED version.
      const active = enrollments.filter((e) => e.status === "active");
      if (active.length > 0) {
        const { data: verRows } = await supabase
          .from("journey_versions")
          .select("id, days_total, count_sundays, days, unlock_mode")
          .in("id", active.map((e) => e.version_id));
        const versions = new Map(
          ((verRows ?? []) as Array<{
            id: string;
            days_total: number;
            count_sundays: boolean;
            days: unknown;
            unlock_mode?: string | null;
          }>).map((v) => [v.id, v])
        );
        type Version = NonNullable<ReturnType<typeof versions.get>>;
        const holding: Array<{ enr: (typeof active)[number]; v: Version; courseDays: number[] }> = [];
        for (const enr of active) {
          const v = versions.get(enr.version_id);
          if (!v) continue;
          const courseDays = [...parseVersionDays(v.days).values()]
            .filter((d) => d.course_id === courseId)
            .map((d) => d.day);
          if (courseDays.length > 0) holding.push({ enr, v, courseDays });
        }
        if (holding.length > 0) {
          const { data: gsRow } = await supabase
            .from("gamification_settings")
            .select("timezone")
            .eq("organization_id", orgId)
            .maybeSingle();
          const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
          for (const { enr, v, courseDays } of holding) {
            const credited = creditedDaysFor(
              { days: v.days, days_total: v.days_total, day_ids: credits.dayIdsOf(enr.version_id) },
              credits.rowsOf(enr.id)
            );
            const state = computeJourneyState({
              startDate: enr.start_date,
              today: todayStr(tz),
              creditedDays: credited,
              daysTotal: v.days_total,
              countSundays: v.count_sundays === true,
              unlockMode: v.unlock_mode === "progress" ? "progress" : "calendar",
              courseDays: courseDaysOf(v.days, v.days_total),
            });
            // openableDay is the open day while the unlock rule opens it
            // (calendar: reached by the counted days; progress: started), 0
            // otherwise and once every course day is credited. It is never a
            // credited day, so a credited day whose course a publish swapped
            // offers neither course here: its review is (a)'s.
            if (state.openableDay > 0 && courseDays.includes(state.openableDay)) {
              return { allowed: true, upcomingAt: null };
            }
          }
        }
      }

      // (c) resume: a started day, made only when (a) and (b) did not grant.
      if (await holdsOpenJourneyAttempt(supabase, userId, courseId, enrollments.map((e) => e.id))) {
        return { allowed: true, upcomingAt: null };
      }
    }
  }

  if (pending.length === 0) return { allowed: false, upcomingAt: null };
  // Entitled, but everything that matched is scheduled for the future.
  const upcomingAt = pending.sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  )[0];
  return { allowed: false, upcomingAt };
}

/** Two course ids name the same course (ids compare in lower case). */
function sameCourse(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a !== "" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether one of `enrollmentIds` holds an open official journey attempt of
 * the course (ADR 0024 steps 23 and 93): the learner's own course_attempts
 * row tagged to the enrolment, in progress, not a revision row, and of the
 * journey context (`context_kind = 'journey'`, 0107), on any version of
 * the course. One read, limit 1, with its own abort signal.
 *
 * Deploy-safe in both orders (docs/ARCHITECTURE.md principle 6), through the
 * one fallback for a context_kind filter (readWithContextFilter, a state of
 * this call only): on a database without 0107 the first answer is a
 * missing-column error naming context_kind, and the same read is made once
 * without that filter. The rows tagged to a journey enrolment are then the
 * journey rows, which is today's reading. Any other error grants nothing
 * from this arm and is logged.
 */
async function holdsOpenJourneyAttempt(
  supabase: SupabaseClient,
  userId: string,
  courseId: string,
  enrollmentIds: string[]
): Promise<boolean> {
  if (enrollmentIds.length === 0) return false;
  const state: ContextFilterState = { applies: null };
  const { data, error } = await readWithContextFilter(state, (apply) => {
    let q = supabase
      .from("course_attempts")
      .select("id, course_versions!inner(course_id)")
      .eq("user_id", userId)
      .eq("course_versions.course_id", courseId)
      .in("journey_enrollment_id", enrollmentIds)
      .eq("status", "in_progress")
      .eq("is_revision", false);
    if (apply) q = q.eq("context_kind", "journey");
    return q.limit(1).abortSignal(new AbortController().signal);
  });
  if (error) {
    console.warn(JSON.stringify({ event: "journey_open_attempt_unreadable", where: "course_access", code: error.code ?? null }));
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
