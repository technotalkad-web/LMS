import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { isReleased } from "@/lib/learner/release";
import { resolveUserGroupIds } from "@/lib/org/groups";
import {
  computeJourneyState,
  courseDaysOf,
  creditCoursesFor,
  creditedDaysFor,
  parseVersionDays,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";
import { readJourneyCredits, type JourneyCredits } from "@/lib/journey/credits-read";

export type CourseAccess = {
  allowed: boolean;
  /**
   * When access is denied only because every matching assignment has a future
   * release_at, the earliest such release time — callers should render/redirect
   * "coming soon" instead of "not assigned". Null otherwise.
   */
  upcomingAt: string | null;
};

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
 * It closes an IDOR where any org member could open a PRIVATE, UNASSIGNED
 * course just by visiting its URL — the course detail/launch pages previously
 * checked only `organization_id`.
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
   * and the enrolment ids it covers, so one render reads the credits once
   * (the launch page's journey block). Used only when it is ok and covers
   * every active enrolment that holds the course; otherwise the credits are
   * read here.
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
    for (const s of steps) {
      const entitled = myPathIds.has(s.path_id) || s.path?.visibility === "org_public";
      if (!entitled) continue;
      if (isReleased(s.release_at, now)) return { allowed: true, upcomingAt: null };
      if (s.release_at) pending.push(s.release_at);
    }
  }

  // Yoddha-journey entitlement (0058): a course scheduled as a journey day
  // is launchable up to the learner's unlocked day (completed days stay
  // reviewable; future days remain locked even by direct URL — the drip is
  // the whole point). Journeys grant no course_assignments rows, mirroring
  // the learning-path grant above.
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
    // A paused program suspends launching (completed alumni keep review).
    return e.status === "completed" || p?.is_active !== false;
  });
  if (enrollments.length > 0) {
    // Curriculum + rules come from each enrollment's PINNED version.
    const { data: verRows } = await supabase
      .from("journey_versions")
      .select("id, days_total, count_sundays, days, unlock_mode")
      .in("id", enrollments.map((e) => e.version_id));
    const versions = new Map(
      ((verRows ?? []) as Array<{
        id: string;
        days_total: number;
        count_sundays: boolean;
        days: unknown;
        unlock_mode?: string | null;
      }>).map((v) => [v.id, v])
    );
    const { data: gsRow } = await supabase
      .from("gamification_settings")
      .select("timezone")
      .eq("organization_id", orgId)
      .maybeSingle();
    const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
    type Version = NonNullable<ReturnType<typeof versions.get>>;
    const holding: Array<{ enr: (typeof enrollments)[number]; v: Version; courseDays: number[] }> = [];
    for (const enr of enrollments) {
      const v = versions.get(enr.version_id);
      if (!v) continue;
      const courseDays = [...parseVersionDays(v.days).values()]
        .filter((d) => d.course_id === courseId)
        .map((d) => d.day);
      if (courseDays.length === 0) continue;
      if (enr.status === "completed") {
        // Yoddha alumni keep review access to their journey modules.
        return { allowed: true, upcomingAt: null };
      }
      holding.push({ enr, v, courseDays });
    }
    if (holding.length > 0) {
      // The credits of every active enrolment that holds the course, in one
      // read by day id (ADR 0024 step 45), never a count per enrolment. A
      // failed read grants nothing through a journey: it is never "no
      // credits", which would open the first course day. The caller's own
      // read is used when it covers every enrolment here.
      const given = opts.journeyCredits;
      const credits =
        given && given.credits.ok && holding.every((h) => given.ids.has(h.enr.id))
          ? given.credits
          : await readJourneyCredits(
              supabase,
              holding.map((h) => ({ id: h.enr.id, version_id: h.enr.version_id }))
            );
      if (!credits.ok) {
        console.warn(JSON.stringify({ event: "journey_credits_unreadable", where: "course_access", code: credits.error?.code ?? null }));
      } else {
        for (const { enr, v, courseDays } of holding) {
          const rows = credits.rowsOf(enr.id);
          const credited = creditedDaysFor(
            { days: v.days, days_total: v.days_total, day_ids: credits.dayIdsOf(enr.version_id) },
            rows
          );
          // The course on each credited day's credit row, matched as above.
          const creditCourse = creditCoursesFor(
            { days: v.days, days_total: v.days_total, day_ids: credits.dayIdsOf(enr.version_id) },
            rows
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
          // Launchable (ADR 0024 step 45): a course day at or below the
          // ceiling, the day the learner may open now; or, above it, a
          // credited day whose credit row holds this course, for review.
          // Progress mode has no calendar ceiling, so it keys off
          // openableDay; calendar keeps the drip ceiling. A re-pin can number
          // a credited day above the open day. There (past the ceiling) the
          // day is granted only for the course on its credit row (step 22's
          // row for `?journey=E&day=`: "the day is credited and this course
          // is the course on its credit row"), so a publish that swapped its
          // course does not offer the new course (section 95's row "A day's
          // course swapped"), and a credit row whose course is null grants
          // nothing. At or below the ceiling the day's current course is
          // granted as before, a credited day whose course a publish swapped
          // included, and a completed enrolment (above) grants every course
          // of its pinned version. Both are the P2-6 gap: step 22's rows for
          // `?journey=E&day=` and for a completed E, and step 23's grant,
          // which also adds a started day past the ceiling and the credit
          // row's own course once the day holds another (granted nowhere
          // today). tests/unit/journey-state.test.ts (f) pins today's
          // behaviour, each case labelled "P2-6 gap (step 22)".
          const ceiling =
            v.unlock_mode === "progress"
              ? state.finished
                ? v.days_total
                : state.openableDay
              : Math.min(state.allowedDay, state.currentDay);
          if (courseDays.some((d) => d <= ceiling || (credited.includes(d) && creditCourse.get(d) === courseId))) {
            return { allowed: true, upcomingAt: null };
          }
        }
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
