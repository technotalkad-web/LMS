import Link from "next/link";
import { BookOpen, ArrowRight } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { DashboardGrid, type GridCard } from "../dashboard/dashboard-grid";

/**
 * /{org}/courses — All my enrolled courses.
 *
 * Lists every course the learner is enrolled in (direct, team, org-wide,
 * AND courses pulled in via a learning path they're on), with status
 * filtering (All / In progress / Not started / Completed) via the
 * shared DashboardGrid component.
 *
 * History:
 *   - #142 stubbed this as a redirect to /dashboard while the listing
 *     was un-built. Tenants linked here from the nav bar, but they got
 *     bounced and missed the dedicated course-only view.
 *   - #143 (this file) replaces the stub with a real page.
 *
 * Data flow: mirrors the course-card half of dashboard/page.tsx but
 * skips the learning-path tiles, announcements banner, KPIs, and the
 * 48hr deadline callout. Just courses, full list. If we ever need to
 * keep both surfaces in lockstep, extract the GridCard build into
 * lib/learner/enrolled-courses.ts and have both pages call it.
 */

export const dynamic = "force-dynamic";

type Course = {
  id: string;
  title: string;
  description: string | null;
  current_version_id: string | null;
  updated_at: string;
  thumbnail_url: string | null;
  visibility?: "private" | "org_public";
};

type Version = {
  id: string;
  course_id: string;
  version_number: number;
};

type Assignment = {
  id: string;
  course_id: string;
  assignee_type: "user" | "org" | "team";
  user_id: string | null;
  team_id: string | null;
  due_at: string | null;
  assigned_at: string;
};

type Attempt = {
  course_version_id: string;
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  score: number | null;
  started_at: string;
};

export default async function CoursesIndexPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);
  const supabase = await createClient();

  // ---- Teams this user is on ----
  const { data: myTeamRows } = await supabase
    .from("team_members")
    .select("team_id, teams!inner(organization_id)")
    .eq("user_id", user.id);
  const myTeamIds = ((myTeamRows ?? []) as Array<{
    team_id: string;
    teams: { organization_id: string } | Array<{ organization_id: string }>;
  }>)
    .filter((r) => {
      const t = Array.isArray(r.teams) ? r.teams[0] : r.teams;
      return t?.organization_id === org.id;
    })
    .map((r) => r.team_id);

  // ---- Direct course assignments ----
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select(
      "id, course_id, assignee_type, user_id, team_id, due_at, assigned_at"
    )
    .eq("organization_id", org.id);
  const assignments = (assignmentRows ?? []) as Assignment[];
  const mine = assignments.filter(
    (a) => a.assignee_type === "user" && a.user_id === user.id
  );
  const mineTeams = assignments.filter(
    (a) =>
      a.assignee_type === "team" &&
      a.team_id &&
      myTeamIds.includes(a.team_id)
  );
  const orgWide = assignments.filter((a) => a.assignee_type === "org");
  const directCourseIds = Array.from(
    new Set([...mine, ...mineTeams, ...orgWide].map((a) => a.course_id))
  );

  // ---- Path assignments → pull in those paths' steps ----
  const { data: pathAssignRows } = await supabase
    .from("learning_path_assignments")
    .select("path_id, assignee_type, user_id, team_id")
    .eq("organization_id", org.id);
  const myPathIds = Array.from(
    new Set(
      ((pathAssignRows ?? []) as Array<{
        path_id: string;
        assignee_type: "user" | "org" | "team";
        user_id: string | null;
        team_id: string | null;
      }>)
        .filter(
          (a) =>
            (a.assignee_type === "user" && a.user_id === user.id) ||
            a.assignee_type === "org" ||
            (a.assignee_type === "team" &&
              a.team_id &&
              myTeamIds.includes(a.team_id))
        )
        .map((a) => a.path_id)
    )
  );

  const { data: stepRows } = myPathIds.length
    ? await supabase
        .from("learning_path_courses")
        .select("path_id, course_id, learning_paths!inner(name, is_active)")
        .in("path_id", myPathIds)
    : { data: [] };
  type StepRaw = {
    path_id: string;
    course_id: string;
    learning_paths:
      | { name: string; is_active: boolean }
      | Array<{ name: string; is_active: boolean }>;
  };
  const activePathSteps = ((stepRows ?? []) as StepRaw[]).filter((s) => {
    const p = Array.isArray(s.learning_paths)
      ? s.learning_paths[0]
      : s.learning_paths;
    return p?.is_active;
  });
  const pathNameByCourseId = new Map<string, string>();
  for (const s of activePathSteps) {
    if (pathNameByCourseId.has(s.course_id)) continue;
    const p = Array.isArray(s.learning_paths)
      ? s.learning_paths[0]
      : s.learning_paths;
    if (p?.name) pathNameByCourseId.set(s.course_id, p.name);
  }
  const pathCourseIds = Array.from(pathNameByCourseId.keys());

  // ---- Org-public courses (#visibility) ----
  // Every member of the org sees these regardless of assignment. We pull
  // them separately and union with the assigned/path-based set. Cards
  // sourced only via org_public are tagged source='org' so the existing
  // UI affordances ("Org-wide") describe them correctly.
  const { data: orgPublicCourseRows } = await supabase
    .from("courses")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .eq("visibility", "org_public");
  const orgPublicCourseIds = ((orgPublicCourseRows ?? []) as Array<{
    id: string;
  }>).map((r) => r.id);

  const allCourseIds = Array.from(
    new Set([...directCourseIds, ...pathCourseIds, ...orgPublicCourseIds])
  );

  // ---- Empty state ----
  if (allCourseIds.length === 0) {
    return <EmptyCourses orgSlug={orgSlug} />;
  }

  // ---- Courses (active only) ----
  const { data: courseRows } = await supabase
    .from("courses")
    .select(
      "id, title, description, current_version_id, updated_at, thumbnail_url, visibility"
    )
    .eq("is_active", true)
    .in("id", allCourseIds);
  const courses = (courseRows ?? []) as Course[];
  const courseById = new Map(courses.map((c) => [c.id, c]));

  // ---- Versions ----
  const { data: versionRows } = await supabase
    .from("course_versions")
    .select("id, course_id, version_number")
    .in("course_id", allCourseIds);
  const versions = (versionRows ?? []) as Version[];
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // ---- Attempts ----
  const versionIds = versions.map((v) => v.id);
  const { data: attemptRows } = versionIds.length
    ? await supabase
        .from("course_attempts")
        .select(
          "course_version_id, completion_status, success_status, score, started_at"
        )
        .eq("user_id", user.id)
        .in("course_version_id", versionIds)
    : { data: [] as Attempt[] };
  const attempts = (attemptRows ?? []) as Attempt[];

  function attemptStatusForCourse(courseId: string): GridCard["status"] {
    const courseAttempts = attempts.filter((a) => {
      const v = versionById.get(a.course_version_id);
      return v?.course_id === courseId;
    });
    if (courseAttempts.length === 0) return "not_started";
    // Sticky completion: once a learner has ever passed or completed a course
    // it stays in the Completed bucket forever. Relaunching opens a fresh
    // in-progress attempt, which must NOT drag the card back to "in progress".
    // Derive from the best terminal outcome across ALL attempts (mirrors the
    // `completedCourseIds` logic). Priority: passed > completed > failed.
    if (courseAttempts.some((a) => a.success_status === "passed")) return "passed";
    if (
      courseAttempts.some(
        (a) => a.completion_status === "completed" && a.success_status !== "failed"
      )
    )
      return "completed";
    if (courseAttempts.some((a) => a.success_status === "failed")) return "failed";
    return "in_progress";
  }
  function bestScoreForCourse(courseId: string): number | null {
    const my = attempts.filter((a) => {
      const v = versionById.get(a.course_version_id);
      return v?.course_id === courseId;
    });
    return my
      .map((a) => a.score)
      .filter((s): s is number => typeof s === "number")
      .reduce<number | null>(
        (best, s) => (best === null || s > best ? s : best),
        null
      );
  }

  // ---- Build cards. User > team > org precedence. ----
  const cards: GridCard[] = [];
  const seen = new Set<string>();
  function pushCard(a: Assignment, source: "user" | "team" | "org") {
    if (seen.has(a.course_id)) return;
    const course = courseById.get(a.course_id);
    if (!course) return;
    cards.push({
      course_id: course.id,
      title: course.title,
      description: course.description,
      source,
      status: attemptStatusForCourse(course.id),
      isRevised: false,
      dueAt: a.due_at,
      bestScore: bestScoreForCourse(course.id),
      pathName: pathNameByCourseId.get(course.id) ?? null,
      thumbnail_url: course.thumbnail_url,
    });
    seen.add(a.course_id);
  }
  for (const a of mine) pushCard(a, "user");
  for (const a of mineTeams) pushCard(a, "team");
  for (const a of orgWide) pushCard(a, "org");
  // Path-only courses (enrolled via a path, no direct course assignment)
  for (const [cid, pathName] of pathNameByCourseId) {
    if (seen.has(cid)) continue;
    const course = courseById.get(cid);
    if (!course) continue;
    cards.push({
      course_id: course.id,
      title: course.title,
      description: course.description,
      source: "user",
      status: attemptStatusForCourse(cid),
      isRevised: false,
      dueAt: null,
      bestScore: bestScoreForCourse(cid),
      pathName,
      thumbnail_url: course.thumbnail_url,
    });
    seen.add(cid);
  }
  // Org-public courses not already pulled in via assignment or path.
  // These show up to every member of the org. Tag source='org' so the
  // existing pill UI labels them as org-wide.
  for (const cid of orgPublicCourseIds) {
    if (seen.has(cid)) continue;
    const course = courseById.get(cid);
    if (!course) continue;
    cards.push({
      course_id: course.id,
      title: course.title,
      description: course.description,
      source: "org",
      status: attemptStatusForCourse(cid),
      isRevised: false,
      dueAt: null,
      bestScore: bestScoreForCourse(cid),
      pathName: null,
      thumbnail_url: course.thumbnail_url,
    });
    seen.add(cid);
  }

  // Sort: in-progress first (with due dates), then not_started, then completed.
  // Within each bucket, due-soon courses bubble up.
  const statusRank: Record<GridCard["status"], number> = {
    in_progress: 0,
    not_started: 1,
    failed: 2,
    completed: 3,
    passed: 4,
  };
  cards.sort((a, b) => {
    const r = statusRank[a.status] - statusRank[b.status];
    if (r !== 0) return r;
    // Within bucket, due-soon first; nulls last
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return ad - bd;
  });

  const totals = {
    all: cards.length,
    inProg: cards.filter((c) => c.status === "in_progress").length,
    done: cards.filter(
      (c) => c.status === "completed" || c.status === "passed"
    ).length,
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            My courses
          </h1>
          <p className="text-muted mt-1 text-sm">
            All {totals.all} {totals.all === 1 ? "course" : "courses"} assigned
            to you{totals.inProg > 0 ? <> · {totals.inProg} in progress</> : null}
            {totals.done > 0 ? <> · {totals.done} completed</> : null}.
          </p>
        </div>
        <Link
          href={`/${orgSlug}/dashboard`}
          className="text-sm text-muted hover:text-ink transition-colors inline-flex items-center gap-1"
        >
          Back to dashboard <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </header>

      <DashboardGrid cards={cards} orgSlug={orgSlug} />
    </div>
  );
}

function EmptyCourses({ orgSlug }: { orgSlug: string }) {
  return (
    <div className="max-w-2xl mx-auto py-16 text-center">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-paper border border-line mb-5">
        <BookOpen className="w-6 h-6 text-muted" aria-hidden="true" />
      </div>
      <h1 className="serif text-3xl mb-2">No courses yet</h1>
      <p className="text-muted text-sm mb-6">
        You don&apos;t have any courses assigned right now. When your admin
        assigns one directly, via your team, or as part of a learning
        path, it&apos;ll show up here.
      </p>
      <Link
        href={`/${orgSlug}/dashboard`}
        className="inline-flex items-center gap-1.5 text-sm text-ink border border-line rounded-md px-4 py-2 hover:bg-paper transition-colors"
      >
        Back to dashboard <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </div>
  );
}
