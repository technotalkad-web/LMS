import Link from "next/link";
import {
  BookOpen,
  AlertTriangle,
  AlertCircle,
  PlayCircle,
  CheckCircle2,
  Lock,
  ShieldAlert,
} from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import {
  AnnouncementsBanner,
  type Announcement,
} from "../_components/announcements-banner";
import { DashboardGrid, type GridCard } from "./dashboard-grid";

type Course = {
  id: string;
  title: string;
  description: string | null;
  current_version_id: string | null;
  updated_at: string;
  thumbnail_url: string | null;
};

type Version = {
  id: string;
  course_id: string;
  version_number: number;
  manifest_type: "scorm12" | "cmi5";
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
  id: string;
  course_version_id: string;
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  score: number | null;
  started_at: string;
  completed_at: string | null;
};

type PathStepView = {
  course_id: string;
  title: string;
  step_number: number;
  state: "completed" | "current" | "locked";
};

type PathSummary = {
  id: string;
  name: string;
  description: string | null;
  dueAt: string | null;
  thumbnail_url: string | null;
  steps: PathStepView[];
};

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ locked?: string; denied?: string }>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  const { user, org, role } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();

  // 0) Teams this user is on.
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

  // 0.5) Announcements.
  const { data: annRows } = await supabase
    .from("org_announcements")
    .select("id, title, body, tone")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(5);
  const announcements = (annRows ?? []) as Announcement[];

  // 1) Course assignments.
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

  // 2) Learning path assignments.
  const { data: pathAssignRows } = await supabase
    .from("learning_path_assignments")
    .select("id, path_id, due_at, assignee_type, user_id, team_id")
    .eq("organization_id", org.id);
  const allPathAssigns = (pathAssignRows ?? []) as Array<{
    id: string;
    path_id: string;
    due_at: string | null;
    assignee_type: "user" | "org" | "team";
    user_id: string | null;
    team_id: string | null;
  }>;
  const myPathAssigns = allPathAssigns.filter(
    (a) =>
      (a.assignee_type === "user" && a.user_id === user.id) ||
      a.assignee_type === "org" ||
      (a.assignee_type === "team" &&
        a.team_id &&
        myTeamIds.includes(a.team_id))
  );

  const prec: Record<"user" | "team" | "org", number> = {
    user: 3,
    team: 2,
    org: 1,
  };
  const pathSrcRank = new Map<string, number>();
  const pathDueAt = new Map<string, string | null>();
  for (const a of myPathAssigns) {
    const rank = prec[a.assignee_type];
    if ((pathSrcRank.get(a.path_id) ?? 0) < rank) {
      pathSrcRank.set(a.path_id, rank);
      pathDueAt.set(a.path_id, a.due_at);
    }
  }

  // 2.5) Org-public visibility (#visibility). Every org member sees
  // org_public courses + paths on their dashboard regardless of any
  // explicit assignment. We fold the path ids into pathSrcRank with
  // the 'org' tier so they're picked up by the existing step / title
  // pull-through logic. The course ids are stored separately and
  // unioned into allCourseIds below.
  const { data: orgPublicCourseRows } = await supabase
    .from("courses")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .eq("visibility", "org_public");
  const orgPublicCourseIds = ((orgPublicCourseRows ?? []) as Array<{
    id: string;
  }>).map((r) => r.id);

  const { data: orgPublicPathRows } = await supabase
    .from("learning_paths")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .eq("visibility", "org_public");
  for (const r of (orgPublicPathRows ?? []) as Array<{ id: string }>) {
    if (!pathSrcRank.has(r.id)) {
      pathSrcRank.set(r.id, prec.org);
      pathDueAt.set(r.id, null);
    }
  }

  const myPathIds = Array.from(pathSrcRank.keys());

  // 3) Path metadata + steps + course titles (active only).
  const { data: pathRows } = myPathIds.length
    ? await supabase
        .from("learning_paths")
        .select("id, name, description, thumbnail_url")
        .eq("is_active", true)
        .in("id", myPathIds)
    : { data: [] };
  const pathsList = (pathRows ?? []) as Array<{
    id: string;
    name: string;
    description: string | null;
    thumbnail_url: string | null;
  }>;

  const { data: stepRows } = myPathIds.length
    ? await supabase
        .from("learning_path_courses")
        .select("path_id, course_id, step_number, courses!inner(title)")
        .in("path_id", myPathIds)
        .order("step_number", { ascending: true })
    : { data: [] };
  type StepRaw = {
    path_id: string;
    course_id: string;
    step_number: number;
    courses: { title: string } | { title: string }[];
  };
  const allPathSteps = ((stepRows ?? []) as StepRaw[]).map((s) => {
    const c = Array.isArray(s.courses) ? s.courses[0] : s.courses;
    return {
      path_id: s.path_id,
      course_id: s.course_id,
      step_number: s.step_number,
      title: c?.title ?? "Untitled",
    };
  });
  const pathCourseIds = Array.from(
    new Set(allPathSteps.map((s) => s.course_id))
  );

  // 4) Combined course universe. orgPublicCourseIds is fetched above (3.5)
  //    and folded in so every member of the org sees those courses too.
  const allCourseIds = Array.from(
    new Set([...directCourseIds, ...pathCourseIds, ...orgPublicCourseIds])
  );
  if (allCourseIds.length === 0) {
    return (
      <div>
        <AnnouncementsBanner
          announcements={announcements}
          orgSlug={orgSlug}
        />
        <EmptyDashboard
          orgName={org.name}
          role={role}
          firstName={(user.email ?? "").split("@")[0]}
        />
      </div>
    );
  }

  // 5) Courses (active only — inactive ones are hidden from learners).
  const { data: courseRows } = await supabase
    .from("courses")
    .select(
      "id, title, description, current_version_id, updated_at, thumbnail_url"
    )
    .eq("is_active", true)
    .in("id", allCourseIds);
  const courses = (courseRows ?? []) as Course[];
  const courseById = new Map(courses.map((c) => [c.id, c]));

  // 6) Versions.
  const { data: versionRows } = await supabase
    .from("course_versions")
    .select("id, course_id, version_number, manifest_type")
    .in("course_id", allCourseIds);
  const versions = (versionRows ?? []) as Version[];
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // 7) Attempts.
  const versionIds = versions.map((v) => v.id);
  const { data: attemptRows } = versionIds.length
    ? await supabase
        .from("course_attempts")
        .select(
          "id, course_version_id, completion_status, success_status, score, started_at, completed_at"
        )
        .eq("user_id", user.id)
        .in("course_version_id", versionIds)
    : { data: [] as Attempt[] };
  const attempts = (attemptRows ?? []) as Attempt[];

  // 8) Completed course set.
  const completedCourseIds = new Set<string>();
  for (const a of attempts) {
    const v = versionById.get(a.course_version_id);
    if (!v) continue;
    if (
      a.completion_status === "completed" ||
      a.success_status === "passed"
    ) {
      completedCourseIds.add(v.course_id);
    }
  }

  // 8.5) 48-hour deadline list (overdue + due-within-48h, not yet completed).
  const horizon = Date.now() + 48 * 60 * 60 * 1000;
  type Deadline = {
    courseId: string;
    courseTitle: string;
    dueAt: string;
    overdue: boolean;
    hoursLeft: number;
  };
  const dueSoon: Deadline[] = [];
  const seenForDeadline = new Set<string>();
  for (const a of [...mine, ...mineTeams, ...orgWide]) {
    if (!a.due_at) continue;
    if (seenForDeadline.has(a.course_id)) continue;
    if (completedCourseIds.has(a.course_id)) continue;
    const dueTime = new Date(a.due_at).getTime();
    if (dueTime >= horizon) continue;
    const course = courseById.get(a.course_id);
    if (!course) continue;
    seenForDeadline.add(a.course_id);
    dueSoon.push({
      courseId: a.course_id,
      courseTitle: course.title,
      dueAt: a.due_at,
      overdue: dueTime < Date.now(),
      hoursLeft: Math.round((dueTime - Date.now()) / (1000 * 60 * 60)),
    });
  }
  dueSoon.sort((a, b) => (a.dueAt > b.dueAt ? 1 : -1));

  // 9) Path summaries.
  const paths: PathSummary[] = pathsList
    .map((p) => {
      const steps = allPathSteps.filter((s) => s.path_id === p.id);
      let currentSet = false;
      const stepViews: PathStepView[] = steps.map((s) => {
        let state: PathStepView["state"];
        if (completedCourseIds.has(s.course_id)) {
          state = "completed";
        } else if (!currentSet) {
          state = "current";
          currentSet = true;
        } else {
          state = "locked";
        }
        return {
          course_id: s.course_id,
          title: s.title,
          step_number: s.step_number,
          state,
        };
      });
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        dueAt: pathDueAt.get(p.id) ?? null,
        thumbnail_url: p.thumbnail_url,
        steps: stepViews,
      };
    })
    .filter((p) => p.steps.length > 0);

  // 10) Build GridCards for the course grid. User > team > org precedence.
  // Also tag the card with a path name if the course is part of a path
  // the user is on.
  const pathNameByCourseId = new Map<string, string>();
  for (const p of paths) {
    for (const s of p.steps) {
      if (!pathNameByCourseId.has(s.course_id)) {
        pathNameByCourseId.set(s.course_id, p.name);
      }
    }
  }

  const cards: GridCard[] = [];
  const seen = new Set<string>();

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

  function pushCard(a: Assignment, source: "user" | "team" | "org") {
    if (seen.has(a.course_id)) return;
    const course = courseById.get(a.course_id);
    if (!course) return;
    const status = attemptStatusForCourse(a.course_id);
    cards.push({
      course_id: course.id,
      title: course.title,
      description: course.description,
      source,
      status,
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
  // Include path-only courses (no direct course assignment).
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

  // ----- Stats -----
  const stats = {
    assigned: cards.length,
    notStarted: cards.filter((c) => c.status === "not_started").length,
    inProgress: cards.filter((c) => c.status === "in_progress").length,
    completed: cards.filter(
      (c) => c.status === "completed" || c.status === "passed"
    ).length,
  };

  const lockedTitle = sp.locked
    ? courseById.get(sp.locked)?.title ?? null
    : null;
  const firstName = (user.email ?? "").split("@")[0];

  return (
    <div className="space-y-8">
      <AnnouncementsBanner
        announcements={announcements}
        orgSlug={orgSlug}
      />

      {/* Welcome header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            Welcome back{firstName ? `, ${firstName}` : ""}.
          </h1>
          <p className="text-muted mt-1 text-sm">
            A learning curve is essential to growth. Pick up where you left off.
          </p>
        </div>
      </header>

      {/* Flash banners */}
      {sp.denied && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            <strong>Access denied.</strong> You don&apos;t have permission to view that page.
          </span>
        </div>
      )}
      {sp.locked && (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            <strong>Locked.</strong>{" "}
            {lockedTitle
              ? `"${lockedTitle}" is part of a learning path. Finish the earlier steps first.`
              : "That course is part of a learning path. Finish the earlier steps first."}
          </span>
        </div>
      )}

      {/* 48-hour urgent callout */}
      {dueSoon.length > 0 && (
        <div
          className={`rounded-2xl p-4 sm:p-5 shadow-sm border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            dueSoon.some((d) => d.overdue)
              ? "border-red-200 bg-red-50"
              : "border-amber-200 bg-amber-50"
          }`}
        >
          <div className="flex items-start sm:items-center gap-3">
            <div
              className={`p-2 rounded-full ${
                dueSoon.some((d) => d.overdue)
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3
                className={`font-bold ${
                  dueSoon.some((d) => d.overdue)
                    ? "text-red-900"
                    : "text-amber-900"
                }`}
              >
                {dueSoon.some((d) => d.overdue)
                  ? "Urgent: Course Overdue"
                  : "Urgent: Course Expiring Soon"}
              </h3>
              <p
                className={`text-sm mt-0.5 ${
                  dueSoon.some((d) => d.overdue)
                    ? "text-red-700"
                    : "text-amber-700"
                }`}
              >
                {dueSoon.length === 1 ? (
                  <>
                    &ldquo;<strong>{dueSoon[0].courseTitle}</strong>&rdquo;
                    {dueSoon[0].overdue ? (
                      <>
                        {" "}is{" "}
                        <strong>
                          {Math.abs(dueSoon[0].hoursLeft) >= 24
                            ? Math.ceil(Math.abs(dueSoon[0].hoursLeft) / 24) +
                              " days"
                            : Math.abs(dueSoon[0].hoursLeft) + " hours"}
                        </strong>{" "}
                        overdue.
                      </>
                    ) : (
                      <>
                        {" "}is due in{" "}
                        <strong>
                          {dueSoon[0].hoursLeft <= 0
                            ? "less than an hour"
                            : `${dueSoon[0].hoursLeft} hours`}
                        </strong>
                        .
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <strong>{dueSoon.length} courses</strong> need your
                    attention in the next 48 hours.
                  </>
                )}
              </p>
            </div>
          </div>
          <Link
            href={`/${orgSlug}/courses/${dueSoon[0].courseId}/launch`}
            className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-sm transition shadow-sm whitespace-nowrap ${
              dueSoon.some((d) => d.overdue)
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-amber-600 hover:bg-amber-700 text-white"
            }`}
          >
            <PlayCircle className="w-4 h-4" />
            Start Course Now
          </Link>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <Stat
          label="Assigned"
          value={stats.assigned}
          icon={<BookOpen className="w-5 h-5" />}
          tone="indigo"
        />
        <Stat
          label="Not started"
          value={stats.notStarted}
          icon={<AlertCircle className="w-5 h-5" />}
          tone="slate"
        />
        <Stat
          label="In progress"
          value={stats.inProgress}
          icon={<PlayCircle className="w-5 h-5" />}
          tone="amber"
        />
        <Stat
          label="Completed"
          value={stats.completed}
          icon={<CheckCircle2 className="w-5 h-5" />}
          tone="emerald"
        />
      </div>

      {/* Learning paths */}
      {paths.length > 0 && (
        <LearningPathsSection paths={paths} orgSlug={orgSlug} />
      )}

      {/* Filterable course grid */}
      <DashboardGrid cards={cards} orgSlug={orgSlug} />
    </div>
  );
}

/* -------- subcomponents -------- */

function Stat({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "indigo" | "amber" | "emerald" | "slate";
}) {
  const tones = {
    indigo: "text-indigo-600 bg-indigo-50",
    amber: "text-amber-600 bg-amber-50",
    emerald: "text-emerald-600 bg-emerald-50",
    slate: "text-slate-500 bg-canvas",
  };
  return (
    <div className="bg-paper border border-line rounded-2xl p-4 sm:p-5 flex items-center justify-between gap-2">
      <div>
        <p className="text-xs text-muted font-medium mb-1">{label}</p>
        <p className="text-3xl font-semibold tracking-tight">{value}</p>
      </div>
      <div className={`shrink-0 p-2.5 rounded-xl ${tones[tone]}`}>{icon}</div>
    </div>
  );
}

function LearningPathsSection({
  paths,
  orgSlug,
}: {
  paths: PathSummary[];
  orgSlug: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">
          Your learning paths
        </h2>
        <p className="text-muted text-xs">
          Complete steps in order to unlock the next.
        </p>
      </div>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {paths.map((p) => {
          const total = p.steps.length;
          const done = p.steps.filter((s) => s.state === "completed").length;
          const pct = total === 0 ? 0 : Math.round((done / total) * 100);
          const due = p.dueAt
            ? new Date(p.dueAt).toISOString().slice(0, 10)
            : null;
          const overdue = p.dueAt
            ? new Date(p.dueAt).getTime() < Date.now() && done < total
            : false;
          return (
            <li
              key={p.id}
              className="border border-line rounded-2xl bg-paper overflow-hidden"
            >
              <Link
                href={`/${orgSlug}/paths/${p.id}`}
                className="block relative bg-gradient-to-br from-indigo-600 to-indigo-800 text-white p-5 hover:from-indigo-700 hover:to-indigo-900 transition-colors overflow-hidden"
              >
                {p.thumbnail_url && (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.thumbnail_url}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/80 to-indigo-900/95" />
                  </>
                )}
                <div className="relative flex items-center justify-between mb-1">
                  <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">
                    Learning Path
                  </div>
                  <span className="text-[10px] uppercase tracking-wide opacity-80">
                    View path →
                  </span>
                </div>
                <h3 className="relative text-lg font-semibold leading-tight">
                  {p.name}
                </h3>
                {p.description && (
                  <p className="relative text-xs mt-1 opacity-90 line-clamp-2">
                    {p.description}
                  </p>
                )}
                <div className="relative mt-4">
                  <div className="flex justify-between text-[11px] font-medium opacity-90 mb-1">
                    <span>
                      {done}/{total} complete
                    </span>
                    {due && (
                      <span className={overdue ? "text-red-200" : ""}>
                        {overdue ? "Overdue " : "Due "}
                        {due}
                      </span>
                    )}
                  </div>
                  <div className="w-full bg-white/20 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full bg-white rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </Link>

              <ol className="p-4 space-y-2">
                {p.steps.map((s) => (
                  <li
                    key={s.course_id}
                    className="flex items-center gap-3 text-sm"
                  >
                    <PathBadge state={s.state} step={s.step_number} />
                    {s.state === "current" ? (
                      <Link
                        href={`/${orgSlug}/courses/${s.course_id}/launch`}
                        className="font-medium hover:underline flex-1 truncate"
                      >
                        {s.title}
                      </Link>
                    ) : s.state === "completed" ? (
                      <Link
                        href={`/${orgSlug}/courses/${s.course_id}`}
                        className="text-muted hover:text-ink hover:underline flex-1 truncate"
                      >
                        {s.title}
                      </Link>
                    ) : (
                      <span className="text-muted flex-1 truncate">
                        {s.title}
                      </span>
                    )}
                    {s.state === "locked" && (
                      <Lock className="w-3.5 h-3.5 text-muted shrink-0" />
                    )}
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PathBadge({
  state,
  step,
}: {
  state: PathStepView["state"];
  step: number;
}) {
  if (state === "completed") {
    return (
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-[10px] shrink-0"
        aria-label="Completed"
      >
        ✓
      </span>
    );
  }
  if (state === "current") {
    return (
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs font-semibold shrink-0"
        aria-label="Current step"
      >
        {step}
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line text-muted text-xs shrink-0"
      aria-label="Locked"
    >
      {step}
    </span>
  );
}

function EmptyDashboard({
  orgName,
  role,
  firstName,
}: {
  orgName: string;
  role: OrgRole;
  firstName: string;
}) {
  const canUpload = role === "super_owner" || role === "admin";
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
        Welcome to {orgName}{firstName ? `, ${firstName}` : ""}.
      </h1>
      <p className="text-muted mt-1 text-sm mb-8">
        Nothing&apos;s been assigned to you yet.
      </p>
      <div className="border border-line rounded-2xl bg-paper p-8">
        <BookOpen className="w-8 h-8 text-muted mb-4" />
        <h2 className="text-xl font-semibold mb-2">Nothing here yet</h2>
        <p className="text-muted text-sm leading-relaxed max-w-xl">
          {canUpload
            ? "Upload a course in the admin Library, then assign it to specific learners, teams, or everyone in the org. Once assigned, courses appear on your learner dashboard."
            : "Ask an admin to assign you a course. Once they do, it will show up here automatically."}
        </p>
      </div>
    </div>
  );
}
