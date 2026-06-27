import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Whether a learner may open a course. Allowed when the caller is an org
 * admin/analyst (preview), the course is `org_public`, or the learner is
 * assigned — directly, org-wide, or via a team they're on.
 *
 * This mirrors the dashboard's entitlement resolution (dashboard/page.tsx) and
 * the learning-path detail page (paths/[pathId]/page.tsx) so that "launchable"
 * exactly equals "appears on your dashboard." It closes an IDOR where any org
 * member could open a PRIVATE, UNASSIGNED course just by visiting its URL — the
 * course detail/launch pages previously checked only `organization_id`.
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
}): Promise<boolean> {
  const { supabase, orgId, userId, courseId, isAdmin } = opts;
  if (isAdmin) return true;

  let visibility = opts.visibility;
  if (visibility === undefined) {
    const { data } = await supabase
      .from("courses")
      .select("visibility")
      .eq("id", courseId)
      .maybeSingle();
    visibility = (data as { visibility?: string | null } | null)?.visibility ?? null;
  }
  if (visibility === "org_public") return true;

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
    .select("assignee_type, user_id, team_id")
    .eq("course_id", courseId)
    .eq("organization_id", orgId);
  const assignments = (assignmentRows ?? []) as Array<{
    assignee_type: string;
    user_id: string | null;
    team_id: string | null;
  }>;
  return assignments.some(
    (a) =>
      (a.assignee_type === "user" && a.user_id === userId) ||
      a.assignee_type === "org" ||
      (a.assignee_type === "team" && a.team_id && myTeamIds.includes(a.team_id))
  );
}
