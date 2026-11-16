import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  ArrowLeft,
  BookOpen,
  Clock,
  PlayCircle,
  CheckCircle2,
  Lock,
  List as ListIcon,
  Award,
  AlertTriangle,
  Eye,
} from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canViewReports } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { myGroupIdsServer } from "@/lib/org/groups";
import { LocalDateTime } from "@/components/ui/local-datetime";
import { readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import {
  PATH_STEP_LABEL_TEXT,
  pathDisplay,
  pathProgress,
  pathStepLabel,
  resolvedStepRule,
  type PathDisplayStep,
} from "@/lib/paths/progress";
import {
  NO_PATH_TERMS,
  readGrantRows,
  readPathAttempts,
  readPathCompletions,
  readPathStepFacts,
  readPathTerms,
} from "@/lib/paths/facts-read";

type PathRow = {
  id: string;
  name: string;
  description: string | null;
  organization_id: string;
  thumbnail_url: string | null;
  visibility: "private" | "org_public" | null;
  sequence_mode: "strict" | "random" | null;
};

type CourseRow = {
  id: string;
  title: string;
  description: string | null;
  current_version_id: string | null;
  is_active: boolean | null;
  pass_required: boolean | null;
};

type StepRow = {
  course_id: string;
  step_number: number;
  release_at: string | null;
  /** The step's own rule (0107); absent on a database without it. */
  pass_required?: boolean | null;
  courses: CourseRow | CourseRow[] | null;
};

type AssignmentRow = {
  assignee_type: "user" | "team" | "org" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
  due_at: string | null;
};

/** A shown step with what its card needs. */
type StepView = {
  step: PathDisplayStep;
  title: string;
  description: string | null;
  manifestType: string | null;
  /** The words beside a done step's result (pathStepLabel, the owner's O4 answer), or null. */
  label: string | null;
};

/**
 * A learner's Learning Path page (ADR 0024 phase 2, P2-7): the path's steps,
 * each with its state, from the path rule (pathProgress() over the learner's
 * path rows, grants, stored step facts, the stored completion and the
 * enrolment terms; build notes O1-i and O1-k), shown through pathDisplay()
 * (the owner's P2-Q1 answer, "Leave the step out", and O5-d): a step whose
 * course is inactive is not rendered, the shown steps are numbered and
 * counted among themselves, a step that only a hidden step holds back reads
 * the plain "Locked", and "Completed", the end banner and the celebration
 * come from the stored completion only. A done step that does not stand on
 * its latest result carries pathStepLabel()'s words (O4).
 *
 * Reads: the learner's session for the path, the steps, the versions, the
 * path rows, the grants, the step facts and the completion; a service client,
 * created after requireOrgAccess, for the enrolment terms only, naming the
 * organisation and the learner (ruling (a) of P2-7: a learner's own session
 * reads no terms row that only a Custom Group reaches). Any failed read
 * shows a notice instead of the steps: a step is never shown locked or not
 * done on a guess. On a database without 0107 the facts read as none, and
 * the terms and the completion read as none (no due date, never Completed).
 */
export default async function LearningPathDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; pathId: string }>;
  searchParams: Promise<{ saving?: string; failed?: string; end?: string }>;
}) {
  const { org: orgSlug, pathId } = await params;
  // ADR 0019 step 9: where the continue address ended, one banner at most
  // (failed, then saving, then end).
  const sp = await searchParams;
  const continueBanner: "failed" | "saving" | "end" | null =
    sp.failed === "1" ? "failed" : sp.saving === "1" ? "saving" : sp.end === "1" ? "end" : null;
  const { user, org, role } = await requireOrgAccess(orgSlug);
  // ADR 0024 step 23 ("Buttons"): each step offers the report-viewing roles
  // a Preview beside Start. It opens the course outside this path (no
  // ?lp=), so it has no Continue and leaves the path's record alone.
  const canPreview = canViewReports(role);
  const supabase = await createClient();

  // 1) Path metadata (must be active).
  const { data: pathRow } = await supabase
    .from("learning_paths")
    .select("id, name, description, organization_id, is_active, thumbnail_url, visibility, sequence_mode")
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

  // select("*") for 0069 deploy safety (group_id).
  const { data: assignmentRows } = await supabase
    .from("learning_path_assignments")
    .select("*")
    .eq("path_id", pathId);
  const assignments = (assignmentRows ?? []) as AssignmentRow[];
  // Custom Group assignments (0069) — resolved live, only when present.
  const myGroupIds = assignments.some((a) => a.assignee_type === "group")
    ? await myGroupIdsServer(org.id, user.id)
    : new Set<string>();
  const matchesMe = (a: AssignmentRow) =>
    (a.assignee_type === "user" && a.user_id === user.id) ||
    a.assignee_type === "org" ||
    (a.assignee_type === "team" && a.team_id && myTeamIds.includes(a.team_id)) ||
    (a.assignee_type === "group" && a.group_id != null && myGroupIds.has(a.group_id));
  const isAssigned = assignments.some(matchesMe);
  // org_public paths are visible to every member of the org regardless of an
  // explicit assignment — the dashboard already surfaces them as tiles, so the
  // detail page must accept them too (otherwise the tile dead-ends in a
  // "denied" bounce). Mirrors the visibility union in dashboard/page.tsx.
  const isOrgPublic = path.visibility === "org_public";
  if (!isAssigned && !isOrgPublic) redirect(`/${orgSlug}/dashboard?denied=path`);

  // 3) The steps in order, each with its course (the card's fields, its
  // activity and its rule), and the step's own rule (a 0107 column: the
  // narrower-select fallback reads the steps without it on a database that
  // lacks it, and the course's rule decides). Every step is read, an
  // inactive course's included: the path rule counts it (its lock holds the
  // later steps back), and pathDisplay leaves it out.
  const { data: stepsRaw, error: stepsErr } = await readWithOptionalColumn<unknown[]>(
    "pass_required",
    (columns) =>
      supabase
        .from("learning_path_courses")
        .select(columns)
        .eq("path_id", pathId)
        .order("step_number", { ascending: true }),
    "course_id, step_number, release_at, courses(id, title, description, current_version_id, is_active, pass_required)"
  );
  const steps = ((stepsRaw ?? []) as StepRow[]).map((s) => {
    const course = (Array.isArray(s.courses) ? s.courses[0] : s.courses) ?? null;
    return {
      course_id: s.course_id,
      step_number: s.step_number,
      release_at: s.release_at,
      pass_required: resolvedStepRule(s.pass_required, course?.pass_required),
      course,
    };
  });

  // 4) Versions for those courses (the manifest type, and the version →
  // course map of the path rows).
  const courseIds = steps.map((s) => s.course_id);
  const { data: versionRows, error: versionsErr } = courseIds.length
    ? await supabase.from("course_versions").select("id, course_id, manifest_type").in("course_id", courseIds)
    : { data: [], error: null };
  type V = { id: string; course_id: string; manifest_type: string };
  const versions = (versionRows ?? []) as V[];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const manifestTypeOf = (courseId: string, currentVersionId: string | null | undefined) => {
    const v = currentVersionId ? versionById.get(currentVersionId) : null;
    return v?.manifest_type ?? versions.find((vv) => vv.course_id === courseId)?.manifest_type ?? "";
  };

  // 5) The path rule's inputs (lib/paths/facts-read.ts), each strict.
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const [rowsRead, grantsRead, factsRead, completionsRead, termsRead] = await Promise.all([
    readPathAttempts(supabase, { userId: user.id, pathIds: [pathId], versions }),
    readGrantRows(supabase, user.id, courseIds),
    readPathStepFacts(supabase, user.id, [pathId]),
    readPathCompletions(supabase, user.id, [pathId]),
    readPathTerms(svc, org.id, user.id, [pathId]),
  ]);
  const unreadable =
    !!stepsErr || !!versionsErr || !rowsRead.ok || !grantsRead.ok || !factsRead.ok || !completionsRead.ok || !termsRead.ok;

  let views: StepView[] = [];
  let done = 0;
  let total = 0;
  let completed = false;
  let dueAt: string | null = null;
  let overdue = false;
  if (unreadable) {
    console.warn(JSON.stringify({ event: "path_progress_unreadable", path_id: pathId, user_id: user.id }));
  } else {
    const key = pathId.toLowerCase();
    const progress = pathProgress({
      pathId,
      steps: steps.map((s) => ({ course_id: s.course_id, step_number: s.step_number, release_at: s.release_at, pass_required: s.pass_required })),
      attempts: rowsRead.attempts,
      grants: grantsRead.grants,
      facts: factsRead.facts,
      completion: completionsRead.byPath.get(key) ?? null,
      terms: termsRead.byPath.get(key) ?? NO_PATH_TERMS,
      now: new Date().toISOString(),
    });
    const courseById = new Map(steps.map((s) => [s.course_id.toLowerCase(), s.course]));
    const display = pathDisplay(
      progress,
      steps.filter((s) => s.course?.is_active === true).map((s) => s.course_id),
      path.sequence_mode
    );
    views = display.steps.map((step) => {
      const course = courseById.get(step.course_id.toLowerCase()) ?? null;
      const label = pathStepLabel(step);
      return {
        step,
        title: course?.title ?? "",
        description: course?.description ?? null,
        manifestType: manifestTypeOf(step.course_id, course?.current_version_id) || null,
        label: label === null ? null : PATH_STEP_LABEL_TEXT[label],
      };
    });
    done = display.done;
    total = display.total;
    completed = progress.completed;
    dueAt = progress.due_at;
    overdue = progress.overdue;
  }

  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const dueLabel = dueAt ? new Date(dueAt).toISOString().slice(0, 10) : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link
        href={`/${orgSlug}/dashboard`}
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      {continueBanner === "failed" && (
        <div
          data-testid="continue-failed-banner"
          className="border border-amber-200 bg-amber-50 text-amber-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            This module needs a pass to complete this step. You can ask for another attempt from the course page.
          </span>
        </div>
      )}
      {continueBanner === "saving" && (
        <div
          data-testid="continue-saving-banner"
          className="border border-line bg-paper text-ink rounded-xl px-4 py-3 text-sm flex items-start gap-2"
        >
          <Clock className="w-4 h-4 mt-0.5 shrink-0 text-muted" />
          <span>
            Your result for the last module is not recorded yet. If you finished it, it can take a moment:{" "}
            <Link href={`/${orgSlug}/paths/${pathId}`} className="underline font-medium">
              open this path again
            </Link>
            . If not, open the module again to finish it.
          </span>
        </div>
      )}
      {/* The end banner shows only for a completed path (P2-Q1): Continue's
          ?end=1 after the last step in order is not a completion. */}
      {continueBanner === "end" && completed && (
        <div
          data-testid="continue-end-banner"
          className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2"
        >
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <span>That was the last step of this path.</span>
        </div>
      )}

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
            {!unreadable && (
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
            )}
          </div>
        </div>

        {unreadable ? (
          <div
            data-testid="path-progress-unreadable"
            className="m-7 sm:m-9 border border-amber-200 bg-amber-50 text-amber-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Your progress on this path could not be loaded right now. Refresh the page to try again.</span>
          </div>
        ) : (
          <>
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
              {views.length === 0 ? (
                <div className="text-sm text-muted">
                  This path doesn&apos;t have any courses yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {views.map((v) => (
                    <StepCard
                      key={v.step.course_id}
                      view={v}
                      orgSlug={orgSlug}
                      pathId={pathId}
                      canPreview={canPreview}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Completed-path celebration: the stored completion only (P2-Q1),
                never the shown count, so a path completed before one of its
                steps was hidden stays celebrated. */}
            {completed && (
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
          </>
        )}
      </div>
    </div>
  );
}

function StepCard({
  view,
  orgSlug,
  pathId,
  canPreview,
}: {
  view: StepView;
  orgSlug: string;
  pathId: string;
  /** canViewReports(role): the step offers a Preview (ADR 0024 step 23). */
  canPreview: boolean;
}) {
  const step = view.step;
  const isCompleted = step.state === "completed";
  const isCurrent = step.state === "current";
  const isLocked = step.state === "locked";
  const isUnreleased = step.state === "unreleased";
  // An official row of the step's path context is open (an open revision
  // visit's row never marks a step in progress: pathProgress reads the
  // official rows only, ADR 0014 steps 6 and 12).
  const inProgress = step.open_attempt && !isCompleted;
  const score = step.latest_score;
  // Show the schedule on every future-dated step — including ones that are
  // also prereq-locked — so learners can see the whole upcoming calendar.
  const showsReleaseDate =
    !isCompleted && step.release_at && new Date(step.release_at).getTime() > Date.now();

  return (
    <div
      className={`border rounded-2xl p-5 transition-colors ${
        isLocked || isUnreleased
          ? "border-line bg-canvas/30 opacity-80"
          : isCurrent
            ? "border-indigo-200 bg-indigo-50/40 ring-1 ring-indigo-100"
            : "border-line bg-paper hover:border-indigo-200"
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        {/* Step badge: the step's place among the shown steps (P2-Q1). */}
        <div className="shrink-0">
          {isCompleted ? (
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
            </div>
          ) : isCurrent ? (
            <div className="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-bold">
              {step.position}
            </div>
          ) : (
            <div className="w-10 h-10 rounded-full border border-line text-muted flex items-center justify-center text-sm font-medium">
              {step.position}
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
              Step {step.position}
            </span>
            {isCompleted && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">
                Completed
              </span>
            )}
            {isCompleted && view.label && (
              <span
                data-testid="path-step-label"
                className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded bg-sky-100 text-sky-800"
              >
                {view.label}
              </span>
            )}
            {inProgress && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                In progress
              </span>
            )}
            {showsReleaseDate && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded bg-sky-100 text-sky-800 inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Releases <LocalDateTime iso={step.release_at!} />
              </span>
            )}
          </div>
          <h3 className="font-semibold text-base sm:text-lg leading-snug">
            {view.title}
          </h3>
          {view.description && (
            <p className="text-sm text-muted mt-1.5 leading-relaxed line-clamp-3">
              {view.description}
            </p>
          )}
          <div className="flex items-center gap-4 text-xs text-muted mt-3">
            <span className="flex items-center gap-1">
              <BookOpen className="w-3.5 h-3.5" />
              {view.manifestType === "cmi5"
                ? "cmi5 module"
                : view.manifestType === "xapi"
                  ? "xAPI module"
                  : view.manifestType
                    ? "SCORM module"
                    : "Course"}
            </span>
            {isCompleted && score !== null && (
              <span className="flex items-center gap-1 text-emerald-700 font-medium">
                <Award className="w-3.5 h-3.5" />
                Score: {(score * 100).toFixed(0)}%
              </span>
            )}
          </div>
        </div>

        {/* CTA */}
        <div className="flex flex-col sm:items-end gap-2 shrink-0 sm:min-w-[150px]">
          {isUnreleased ? (
            <button
              type="button"
              disabled
              title="This chapter hasn't been released yet"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-canvas text-muted border border-line px-5 py-2.5 rounded-lg text-sm font-medium cursor-not-allowed"
            >
              <Clock className="w-4 h-4" /> Coming soon
            </button>
          ) : isLocked ? (
            // The hint only when a shown earlier step is not done; a step
            // that only a hidden step holds back reads "Locked", no reason
            // given (P2-Q1).
            <button
              type="button"
              disabled
              data-testid="step-locked"
              title={step.lockedByVisibleStep ? "Finish the previous step to unlock" : undefined}
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
          {/* Any step, locked or not: a preview runs outside the path's
              order and release dates (ADR 0024 step 22's preview row). */}
          {canPreview && (
            <Link
              href={`/${orgSlug}/courses/${step.course_id}/launch?mode=preview`}
              data-testid="step-preview"
              title="Opens this course on its own as a preview: not an official record, and not part of this path"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 bg-paper border border-line hover:border-ink text-muted hover:text-ink px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
            >
              <Eye className="w-3.5 h-3.5" /> Preview
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
