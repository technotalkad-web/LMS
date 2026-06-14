import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { LearningPathsClient } from "./learning-paths-client";

export const dynamic = "force-dynamic";

export type PathRow = {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  created_at: string;
  duration_minutes: number | null;
  is_active: boolean;
  thumbnail_url: string | null;
  visibility: "private" | "org_public";
  sequence_mode: "strict" | "random";
};

export type PathEnrollee = {
  path_id: string;
  user_id: string;
  email: string;
  completed: number;
  total: number;
  via: ("user" | "team" | "org")[];
};

export type PathCourseRow = {
  path_id: string;
  course_id: string;
  step_number: number;
  title: string;
};

export type PathAssignmentRow = {
  id: string;
  path_id: string;
  assignee_type: "user" | "org" | "team";
  user_id: string | null;
  team_id: string | null;
  due_at: string | null;
  user_email?: string | null;
  team_name?: string | null;
};

export type CourseOption = { id: string; title: string };
export type MemberOption = { user_id: string; email: string; role: string };
export type TeamOption = { id: string; name: string };

export default async function LearningPathsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard`);
  }

  const supabase = await createClient();

  const { data: pathRows } = await supabase
    .from("learning_paths")
    .select(
      "id, name, description, slug, created_at, duration_minutes, is_active, thumbnail_url, visibility, sequence_mode"
    )
    .eq("organization_id", org.id)
    .order("created_at", { ascending: false });
  const paths = (pathRows ?? []) as PathRow[];

  const pathIds = paths.map((p) => p.id);

  const { data: stepRows } = pathIds.length
    ? await supabase
        .from("learning_path_courses")
        .select("path_id, course_id, step_number, courses!inner(title)")
        .in("path_id", pathIds)
        .order("step_number", { ascending: true })
    : { data: [] };

  type StepRaw = {
    path_id: string;
    course_id: string;
    step_number: number;
    courses: { title: string } | { title: string }[];
  };
  const pathCourses: PathCourseRow[] = ((stepRows ?? []) as StepRaw[]).map((s) => {
    const c = Array.isArray(s.courses) ? s.courses[0] : s.courses;
    return {
      path_id: s.path_id,
      course_id: s.course_id,
      step_number: s.step_number,
      title: c?.title ?? "Unknown course",
    };
  });

  const { data: assignmentRows } = pathIds.length
    ? await supabase
        .from("learning_path_assignments")
        .select("id, path_id, assignee_type, user_id, team_id, due_at")
        .in("path_id", pathIds)
    : { data: [] };
  const pathAssignments = (assignmentRows ?? []) as PathAssignmentRow[];

  // Build per-path enrollment list with completion rolled up live from attempts.
  const pathCoursesByPath = new Map<string, string[]>();
  for (const pc of pathCourses) {
    const arr = pathCoursesByPath.get(pc.path_id) ?? [];
    arr.push(pc.course_id);
    pathCoursesByPath.set(pc.path_id, arr);
  }
  const allPathCourseIds = Array.from(
    new Set(pathCourses.map((pc) => pc.course_id))
  );

  // Resolve all (user, path) pairs.
  const { data: teamRowsAll } = await supabase
    .from("team_members")
    .select("team_id, user_id");
  const teamUsersAll = new Map<string, string[]>();
  for (const r of teamRowsAll ?? []) {
    const tid = r.team_id as string;
    const arr = teamUsersAll.get(tid) ?? [];
    arr.push(r.user_id as string);
    teamUsersAll.set(tid, arr);
  }
  const { data: orgMembersAll } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id);
  const orgMemberIds = (orgMembersAll ?? []).map((m) => m.user_id as string);

  type PathPairKey = string; // `${path_id}|${user_id}`
  const viaByPair = new Map<PathPairKey, Set<"user" | "team" | "org">>();
  function addVia(pid: string, uid: string, v: "user" | "team" | "org") {
    const key = `${pid}|${uid}`;
    const s = viaByPair.get(key) ?? new Set<"user" | "team" | "org">();
    s.add(v);
    viaByPair.set(key, s);
  }
  for (const a of pathAssignments) {
    if (a.assignee_type === "user" && a.user_id) addVia(a.path_id, a.user_id, "user");
    else if (a.assignee_type === "team" && a.team_id) {
      for (const uid of teamUsersAll.get(a.team_id) ?? [])
        addVia(a.path_id, uid, "team");
    } else if (a.assignee_type === "org") {
      for (const uid of orgMemberIds) addVia(a.path_id, uid, "org");
    }
  }

  // Pull course_versions + completed attempts for path courses.
  const { data: versionsAll } = allPathCourseIds.length
    ? await supabase
        .from("course_versions")
        .select("id, course_id")
        .in("course_id", allPathCourseIds)
    : { data: [] };
  const verToCourse = new Map<string, string>();
  for (const v of (versionsAll ?? []) as Array<{ id: string; course_id: string }>) {
    verToCourse.set(v.id, v.course_id);
  }
  const allVerIds = Array.from(verToCourse.keys());

  // Distinct user_ids we care about.
  const enrolleeUserIds = Array.from(
    new Set(
      Array.from(viaByPair.keys()).map((k) => k.split("|")[1])
    )
  );

  const { data: attemptsAll } = enrolleeUserIds.length && allVerIds.length
    ? await supabase
        .from("course_attempts")
        .select(
          "user_id, course_version_id, completion_status, success_status"
        )
        .in("user_id", enrolleeUserIds)
        .in("course_version_id", allVerIds)
    : { data: [] };

  const completedByUserCourse = new Set<string>(); // `${user}|${course}`
  for (const a of (attemptsAll ?? []) as Array<{
    user_id: string;
    course_version_id: string;
    completion_status: string;
    success_status: string;
  }>) {
    if (
      a.completion_status === "completed" ||
      a.success_status === "passed"
    ) {
      const cid = verToCourse.get(a.course_version_id);
      if (cid) completedByUserCourse.add(`${a.user_id}|${cid}`);
    }
  }

  // Resolve enrollee emails (re-use the listUsers we run for assignments below).

  // Course picker options (all courses in this org)
  const { data: courseRows } = await supabase
    .from("courses")
    .select("id, title")
    .eq("organization_id", org.id)
    .order("title");
  const courseOptions = (courseRows ?? []) as CourseOption[];

  // Member + team options for assignment.
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", org.id);
  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name")
    .eq("organization_id", org.id);
  const teamOptions = (teamRows ?? []) as TeamOption[];

  // Resolve emails.
  const userIds = new Set<string>();
  for (const m of memberRows ?? []) userIds.add(m.user_id);
  for (const a of pathAssignments) if (a.user_id) userIds.add(a.user_id);
  for (const uid of enrolleeUserIds) userIds.add(uid);
  const emailByUser = new Map<string, string>();
  if (userIds.size > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of data?.users ?? []) {
      if (u.email && userIds.has(u.id)) emailByUser.set(u.id, u.email);
    }
  }
  const memberOptions: MemberOption[] = (memberRows ?? []).map((m) => ({
    user_id: m.user_id,
    email: emailByUser.get(m.user_id) ?? m.user_id.slice(0, 8),
    role: m.role,
  }));
  // Roll up the enrollee list per path.
  const pathEnrollees: PathEnrollee[] = [];
  for (const [key, viaSet] of viaByPair.entries()) {
    const [pid, uid] = key.split("|");
    const courses = pathCoursesByPath.get(pid) ?? [];
    const total = courses.length;
    const completed = courses.filter((cid) =>
      completedByUserCourse.has(`${uid}|${cid}`)
    ).length;
    pathEnrollees.push({
      path_id: pid,
      user_id: uid,
      email: emailByUser.get(uid) ?? uid.slice(0, 8),
      completed,
      total,
      via: Array.from(viaSet),
    });
  }

  const teamNameById = new Map(teamOptions.map((t) => [t.id, t.name]));
  for (const a of pathAssignments) {
    if (a.user_id) a.user_email = emailByUser.get(a.user_id) ?? null;
    if (a.team_id) a.team_name = teamNameById.get(a.team_id) ?? null;
  }

  return (
    <LearningPathsClient
      orgSlug={orgSlug}
      paths={paths}
      pathCourses={pathCourses}
      pathAssignments={pathAssignments}
      pathEnrollees={pathEnrollees}
      courseOptions={courseOptions}
      memberOptions={memberOptions}
      teamOptions={teamOptions}
    />
  );
}
