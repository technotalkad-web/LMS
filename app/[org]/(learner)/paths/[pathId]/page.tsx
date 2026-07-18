import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Clock,
  PlayCircle,
  CheckCircle2,
  Lock,
  List as ListIcon,
  Award,
} from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";

type PathRow = {
  id: string;
  name: string;
  description: string | null;
  organization_id: string;
  thumbnail_url: string | null;
  visibility: "private" | "org_public" | null;
};

type StepRow = {
  course_id: string;
  step_number: number;
  course: {
    id: string;
    title: string;
    description: string | null;
    current_version_id: string | null;
  };
};

type AssignmentRow = {
  assignee_type: "user" | "team" | "org";
  user_id: string | null;
  team_id: string | null;
  due_at: string | null;
};

type StepView = {
  course_id: string;
  step_number: number;
  title: string;
  description: string | null;
  state: "completed" | "current" | "locked";
  manifestType: string | null;
};

export default async function LearningPathDetailPage({
  params,
}: {
  params: Promise<{ org: string; pathId: string }>;
}) {
  const { org: orgSlug, pathId } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);
  const supabase = await createClient();

  // 1) Path metadata (must be active).
  const { data: pathRow } = await supabase
    .from("learning_paths")
    .select("id, name, description, organization_id, is_active, thumbnail_url, visibility")
    .eq("id", pathId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!pathRow || (pathRow as { is_active?: boolean }).is_active === false) {
    redirect(`/${orgSlug}/dashboard`);
  }
  const path = pathRow as PathRow;

  // 2) Verify the user is assigned to this path (directly, via team, or org-wide).
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

  const { data: assignmentRows } = await supabase
    .from("learning_path_assignments")
    .select("assignee_type, user_id, team_id, due_at")
    .eq("path_id", pathId);
  const assignments = (assignmentRows ?? []) as AssignmentRow[];
  const isAssigned = assignments.some(
    (a) =>
      (a.assignee_type === "user" && a.user_id === user.id) ||
      a.assignee_type === "org" ||
      (a.assignee_type === "team" &&
        a.team_id &&
        myTeamIds.includes(a.team_id))
  );
  // org_public paths are visible to every member of the org regardless of an
  // explicit assignment — the dashboard already surfaces them as tiles, so the
  // detail page must accept them too (otherwise the tile dead-ends in a
  // "denied" bounce). Mirrors the visibility union in dashboard/page.tsx.
  const isOrgPublic = path.visibility === "org_public";
  if (!isAssigned && !isOrgPublic) redirect(`/${orgSlug}/dashboard?denied=path`);

  // Earliest due_at across the user's matching assignments.
  const myDueDates = assignments
    .filter(
      (a) =>
        (a.assignee_type === "user" && a.user_id === user.id) ||
        a.assignee_type === "org" ||
        (a.assignee_type === "team" &&
          a.team_id &&
          myTeamIds.includes(a.team_id))
    )
    .map((a) => a.due_at)
    .filter((d): d is string => !!d)
    .sort();
  const dueAt = myDueDates[0] ?? null;

  // 3) Ordered courses in this path, joined to course rows.
  const { data: stepsRaw } = await supabase
    .from("learning_path_courses")
    .select(
      "course_id, step_number, courses!inner(id, title, description, current_version_id)"
    )
    .eq("path_id", pathId)
    .order("step_number", { ascending: true });
  const steps = ((stepsRaw ?? []) as unknown as Array<{
    course_id: string;
    step_number: number;
    courses:
      | {
          id: string;
          title: string;
          description: string | null;
          current_version_id: string | null;
        }
      | Array<{
          id: string;
          title: string;
          description: string | null;
          current_version_id: string | null;
        }>;
  }>).map((s) => {
    const c = Array.isArray(s.courses) ? s.courses[0] : s.courses;
    return {
      course_id: s.course_id,
      step_number: s.step_number,
      course: c,
    } as StepRow;
  });

  // 4) Versions for those courses (to look up manifest type).
  const courseIds = steps.map((s) => s.course_id);
  const { data: versionRows } = courseIds.length
    ? await supabase
        .from("course_versions")
        .select("id, course_id, manifest_type")
        .in("course_id", courseIds)
    : { data: [] };
  type V = { id: string; course_id: string; manifest_type: string };
  const versions = (versionRows ?? []) as V[];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const manifestTypeByCourse = new Map<string, string>();
  for (const s of steps) {
    const cv = s.course.current_version_id;
    const v = cv ? versionById.get(cv) : null;
    manifestTypeByCourse.set(
      s.course_id,
      v?.manifest_type ??
        versions.find((vv) => vv.course_id === s.course_id)?.manifest_type ??
        ""
    );
  }

  // 5) User attempts for those courses → completion set. Path progress counts
  // ONLY attempts launched from within this path (learning_path_id === pathId);
  // a standalone completion of the same module does not advance the path.
  // (Product decision L2.) Path step links carry ?lp= so launches are tagged.
  const versionIds = versions.map((v) => v.id);
  const { data: attemptRows } = versionIds.length
    ? await supabase
        .from("course_attempts")
        .select(
          "course_version_id, completion_status, success_status, score, started_at, completed_at"
        )
        .eq("user_id", user.id)
        .eq("learning_path_id", pathId)
        .in("course_version_id", versionIds)
    : { data: [] };
  type Attempt = {
    course_version_id: string;
    completion_status: string;
    success_status: string;
    score: number | null;
    started_at: string;
    completed_at: string | null;
  };
  const attempts = (attemptRows ?? []) as Attempt[];
  const completedCourseIds = new Set<string>();
  const inProgressCourseIds = new Set<string>();
  const scoreByCourse = new Map<string, number>();
  for (const a of attempts) {
    const v = versionById.get(a.course_version_id);
    if (!v) continue;
    if (
      a.completion_status === "completed" ||
      a.success_status === "passed"
    ) {
      completedCourseIds.add(v.course_id);
      if (typeof a.score === "number") {
        const prev = scoreByCourse.get(v.course_id);
        if (prev === undefined || a.score > prev) {
          scoreByCourse.set(v.course_id, a.score);
        }
      }
    } else if (a.completion_status === "in_progress") {
      inProgressCourseIds.add(v.course_id);
    }
  }

  // 6) Compute per-step state (completed | current | locked).
  let currentSet = false;
  const stepViews: StepView[] = steps.map((s) => {
    let state: StepView["state"];
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
      step_number: s.step_number,
      title: s.course.title,
      description: s.course.description,
      manifestType: manifestTypeByCourse.get(s.course_id) || null,
      state,
    };
  });

  const total = stepViews.length;
  const done = stepViews.filter((s) => s.state === "completed").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const dueLabel = dueAt
    ? new Date(dueAt).toISOString().slice(0, 10)
    : null;
  const overdue = dueAt
    ? new Date(dueAt).getTime() < Date.now() && done < total
    : false;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link
        href={`/${orgSlug}/dashboard`}
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      <div className="bg-paper border border-line rounded-2xl overflow-hidden shadow-sm">
        {/* Hero */}
        <div className="relative bg-gradient-to-br from-indigo-600 to-indigo-900 text-white p-7 sm:p-9 overflow-hidden">
          {path.thumbnail_url ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={path.thumbnail_url}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/80 to-indigo-950/95" />
            </>
          ) : (
            <ListIcon
              className="absolute -top-10 -right-10 w-64 h-64 text-white/10 pointer-events-none"
              strokeWidth={0.5}
            />
          )}
          <div className="relative">
            <div className="inline-flex items-center gap-1.5 bg-white/15 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full mb-3">
              Learning Path
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold leading-tight">
              {path.name}
            </h1>
            {path.description && (
              <p className="mt-3 text-sm sm:text-base text-indigo-100 max-w-2xl leading-relaxed">
                {path.description}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-indigo-100 mt-4 font-medium">
              <span className="flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5" />
                {total} {total === 1 ? "course" : "courses"}
              </span>
              {dueLabel && (
                <span
                  className={`flex items-center gap-1.5 ${
                    overdue ? "text-red-200 font-semibold" : ""
                  }`}
                >
                  <Clock className="w-3.5 h-3.5" />
                  {overdue ? `Overdue · ${dueLabel}` : `Due ${dueLabel}`}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="px-7 sm:px-9 py-5 border-b border-line bg-canvas/40 flex items-center gap-5">
          <div className="flex-1">
            <div className="flex justify-between text-[11px] font-bold uppercase tracking-wider text-muted mb-1.5">
              <span>Path progress</span>
              <span>{pct}% completed</span>
            </div>
            <div className="w-full bg-canvas rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-indigo-600 h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <div className="shrink-0 text-xs text-muted">
            <span className="font-semibold text-ink">
              {done}
            </span>
            <span className="opacity-70"> / {total}</span>
          </div>
        </div>

        {/* Courses list */}
        <div className="p-7 sm:p-9 space-y-4">
          <h2 className="text-lg font-semibold mb-4">Courses in this path</h2>
          {stepViews.length === 0 ? (
            <div className="text-sm text-muted">
              This path doesn&apos;t have any courses yet.
            </div>
          ) : (
            <div className="space-y-3">
              {stepViews.map((s, i) => (
                <StepCard
                  key={s.course_id}
                  step={s}
                  isLast={i === stepViews.length - 1}
                  orgSlug={orgSlug}
                  inProgress={inProgressCourseIds.has(s.course_id)}
                  score={scoreByCourse.get(s.course_id) ?? null}
                  pathId={pathId}
                />
              ))}
            </div>
          )}
        </div>

        {/* Completed-path celebration */}
        {pct === 100 && total > 0 && (
          <div className="mx-7 sm:mx-9 mb-7 sm:mb-9 border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-2xl p-5 flex items-center gap-4">
            <div className="shrink-0 w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
              <Award className="w-6 h-6 text-emerald-700" />
            </div>
            <div>
              <h3 className="font-semibold">You finished this path 🎉</h3>
              <p className="text-sm text-emerald-800 mt-0.5">
                Every course in <strong>{path.name}</strong> is complete. Nice
                work.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepCard({
  step,
  isLast,
  orgSlug,
  inProgress,
  score,
  pathId,
}: {
  step: StepView;
  isLast: boolean;
  orgSlug: string;
  inProgress: boolean;
  score: number | null;
  pathId: string;
}) {
  void isLast;
  const isCompleted = step.state === "completed";
  const isCurrent = step.state === "current";
  const isLocked = step.state === "locked";

  return (
    <div
      className={`border rounded-2xl p-5 transition-colors ${
        isLocked
          ? "border-line bg-canvas/30 opacity-80"
          : isCurrent
            ? "border-indigo-200 bg-indigo-50/40 ring-1 ring-indigo-100"
            : "border-line bg-paper hover:border-indigo-200"
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        {/* Step badge */}
        <div className="shrink-0">
          {isCompleted ? (
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
            </div>
          ) : isCurrent ? (
            <div className="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-bold">
              {step.step_number}
            </div>
          ) : (
            <div className="w-10 h-10 rounded-full border border-line text-muted flex items-center justify-center text-sm font-medium">
              {step.step_number}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span
              className={`text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded ${
                isCompleted
                  ? "bg-emerald-100 text-emerald-700"
                  : isCurrent
                    ? "bg-indigo-100 text-indigo-700"
                    : "bg-canvas text-muted"
              }`}
            >
              Step {step.step_number}
            </span>
            {isCompleted && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">
                Completed
              </span>
            )}
            {inProgress && !isCompleted && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                In progress
              </span>
            )}
          </div>
          <h3 className="font-semibold text-base sm:text-lg leading-snug">
            {step.title}
          </h3>
          {step.description && (
            <p className="text-sm text-muted mt-1.5 leading-relaxed line-clamp-3">
              {step.description}
            </p>
          )}
          <div className="flex items-center gap-4 text-xs text-muted mt-3">
            <span className="flex items-center gap-1">
              <BookOpen className="w-3.5 h-3.5" />
              {step.manifestType === "cmi5"
                ? "cmi5 module"
                : step.manifestType
                  ? "SCORM module"
                  : "Course"}
            </span>
            {isCompleted && score !== null && (
              <span className="flex items-center gap-1 text-emerald-700 font-medium">
                <Award className="w-3.5 h-3.5" />
                Best: {(score * 100).toFixed(0)}%
              </span>
            )}
          </div>
        </div>

        {/* CTA */}
        <div className="flex flex-col sm:items-end gap-2 shrink-0 sm:min-w-[150px]">
          {isLocked ? (
            <button
              type="button"
              disabled
              title="Finish the previous step to unlock"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-canvas text-muted border border-line px-5 py-2.5 rounded-lg text-sm font-medium cursor-not-allowed"
            >
              <Lock className="w-4 h-4" /> Locked
            </button>
          ) : isCompleted ? (
            <Link
              href={`/${orgSlug}/courses/${step.course_id}`}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-paper border border-line hover:border-ink text-ink px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
            >
              <Award className="w-4 h-4" /> View details
            </Link>
          ) : (
            <Link
              href={`/${orgSlug}/courses/${step.course_id}/launch?lp=${pathId}`}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm"
            >
              <PlayCircle className="w-4 h-4" />
              {inProgress ? "Resume" : "Launch"}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
