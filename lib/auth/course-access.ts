import type { SupabaseClient } from "@supabase/supabase-js";
import { isReleased } from "@/lib/learner/release";
import {
  computeJourneyState,
  courseDaysOf,
  parseVersionDays,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";

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
 * Whether a learner may open a course. Allowed when the caller is an org
 * admin/analyst (preview), the course is `org_public`, the learner is
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
  isAdmin: boolean;
  /** Pass `courses.visibility` if already loaded to skip a query. */
  visibility?: string | null;
}): Promise<CourseAccess> {
  const { supabase, orgId, userId, courseId, isAdmin } = opts;
  if (isAdmin) return { allowed: true, upcomingAt: null };

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

  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select("assignee_type, user_id, team_id, release_at")
    .eq("course_id", courseId)
    .eq("organization_id", orgId);
  const assignments = (assignmentRows ?? []) as Array<{
    assignee_type: string;
    user_id: string | null;
    team_id: string | null;
    release_at: string | null;
  }>;

  const mine = assignments.filter(
    (a) =>
      (a.assignee_type === "user" && a.user_id === userId) ||
      a.assignee_type === "org" ||
      (a.assignee_type === "team" && a.team_id && myTeamIds.includes(a.team_id))
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
      .select("path_id, assignee_type, user_id, team_id")
      .in(
        "path_id",
        steps.map((s) => s.path_id)
      );
    const myPathIds = new Set(
      ((pathAssignRows ?? []) as Array<{
        path_id: string;
        assignee_type: "user" | "org" | "team";
        user_id: string | null;
        team_id: string | null;
      }>)
        .filter(
          (a) =>
            (a.assignee_type === "user" && a.user_id === userId) ||
            a.assignee_type === "org" ||
            (a.assignee_type === "team" && a.team_id && myTeamIds.includes(a.team_id))
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
      .select("id, days_total, count_sundays, days")
      .in("id", enrollments.map((e) => e.version_id));
    const versions = new Map(
      ((verRows ?? []) as Array<{
        id: string;
        days_total: number;
        count_sundays: boolean;
        days: unknown;
      }>).map((v) => [v.id, v])
    );
    const { data: gsRow } = await supabase
      .from("gamification_settings")
      .select("timezone")
      .eq("organization_id", orgId)
      .maybeSingle();
    const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
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
      const { count } = await supabase
        .from("journey_day_progress")
        .select("id", { count: "exact", head: true })
        .eq("enrollment_id", enr.id);
      const state = computeJourneyState({
        startDate: enr.start_date,
        today: todayStr(tz),
        completedCount: count ?? 0,
        daysTotal: v.days_total,
        countSundays: v.count_sundays === true,
        courseDays: courseDaysOf(v.days, v.days_total),
      });
      if (courseDays.some((d) => d <= Math.min(state.allowedDay, state.currentDay))) {
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
