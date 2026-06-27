import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Clock,
  PlayCircle,
  Target,
  Award,
  ChevronRight,
} from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { learnerCanAccessCourse } from "@/lib/auth/course-access";
import { createClient } from "@/lib/supabase/server";
import { languageDisplay } from "@/lib/i18n/languages";
import {
  ChangeLanguageMenu,
  type ChangeLanguageOption,
} from "./change-language-menu";

type Version = {
  id: string;
  version_number: number;
  manifest_type: "scorm12" | "cmi5";
  launch_url: string;
  manifest_data: { title?: string; description?: string; masteryScore?: number };
  uploaded_at: string;
};

type Course = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  current_version_id: string | null;
  organization_id: string;
  thumbnail_url: string | null;
};

type Attempt = {
  id: string;
  course_version_id: string;
  status: "in_progress" | "completed" | "passed" | "failed";
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  score: number | null;
  started_at: string;
  completed_at: string | null;
};

export default async function CourseDetailPage({
  params,
}: {
  params: Promise<{ org: string; courseId: string }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const { org, user, role } = await requireOrgAccess(orgSlug);
  const isAdmin = canManage(role);

  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select(
      "id, slug, title, description, status, current_version_id, organization_id, is_active, thumbnail_url"
    )
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) redirect(`/${orgSlug}/dashboard`);
  // Inactive courses are still reachable by admins (they can preview), but
  // hidden from learners.
  if (
    (course as { is_active?: boolean }).is_active === false &&
    !isAdmin
  ) {
    redirect(`/${orgSlug}/dashboard`);
  }
  const c = course as Course;

  // Entitlement: only assigned (direct/org/team) or org_public courses are
  // viewable by learners — closes the private/unassigned-course IDOR. Admins
  // preview freely.
  const canAccess = await learnerCanAccessCourse({
    supabase,
    orgId: org.id,
    userId: user.id,
    courseId: c.id,
    isAdmin,
  });
  if (!canAccess) redirect(`/${orgSlug}/dashboard?denied=1`);

  const { data: versions } = await supabase
    .from("course_versions")
    .select(
      "id, version_number, manifest_type, launch_url, manifest_data, uploaded_at"
    )
    .eq("course_id", c.id)
    .order("version_number", { ascending: false });
  const list = (versions ?? []) as Version[];
  const current = list.find((v) => v.id === c.current_version_id) ?? list[0];
  const versionIds = list.map((v) => v.id);

  // Multi-language packages for this course (#158 Phase 3). The
  // ChangeLanguageMenu silently renders nothing if there are <2 active
  // packages, so this fetch is cheap noise on monolingual courses.
  const { data: pkgRows } = await supabase
    .from("course_packages")
    .select("id, language, display_name, is_active")
    .eq("course_id", c.id)
    .eq("is_active", true);
  const languageOptions: ChangeLanguageOption[] = (
    (pkgRows ?? []) as Array<{
      id: string;
      language: string | null;
      display_name: string | null;
    }>
  ).map((p) => ({
    id: p.id,
    language: p.language,
    display_label:
      p.display_name ??
      languageDisplay(p.language, "native") ??
      p.language ??
      "Default",
  }));
  let savedLanguage: string | null = null;
  if (languageOptions.length >= 2) {
    const { data: prefRow } = await supabase
      .from("course_language_preferences")
      .select("language")
      .eq("user_id", user.id)
      .eq("course_id", c.id)
      .maybeSingle();
    savedLanguage = (prefRow?.language as string | undefined) ?? null;
  }

  const attemptsResp = versionIds.length
    ? await supabase
        .from("course_attempts")
        .select(
          "id, course_version_id, status, completion_status, success_status, score, started_at, completed_at"
        )
        .eq("user_id", user.id)
        .in("course_version_id", versionIds)
        .order("started_at", { ascending: false })
    : { data: [] as Attempt[] };
  const attempts = (attemptsResp.data ?? []) as Attempt[];
  const versionById = new Map(list.map((v) => [v.id, v]));

  // Sticky completion: a course that was ever completed/passed stays
  // "complete" even after the learner relaunches it (which opens a fresh
  // in-progress attempt). Only show "Resume" when there's an open attempt and
  // the course has never been finished. Otherwise "Relaunch" / "Launch".
  const isComplete = attempts.some(
    (a) =>
      a.completion_status === "completed" || a.success_status === "passed"
  );
  const isInProgress =
    !isComplete &&
    attempts.some((a) => a.completion_status === "in_progress");

  const manifestDescription = current?.manifest_data?.description ?? "";
  const description = c.description || manifestDescription;

  const masteryPct =
    typeof current?.manifest_data?.masteryScore === "number"
      ? Math.round(current.manifest_data.masteryScore * 100)
      : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link
        href={`/${orgSlug}/dashboard`}
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      <div className="bg-paper border border-line rounded-2xl overflow-hidden shadow-sm">
        {/* Hero banner */}
        <div className="relative bg-gradient-to-br from-slate-800 to-slate-950 text-white p-7 sm:p-9 overflow-hidden">
          {c.thumbnail_url ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={c.thumbnail_url}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-br from-slate-900/85 to-slate-900/95" />
            </>
          ) : (
            <BookOpen
              className="absolute -top-10 -right-10 w-64 h-64 text-white/5 pointer-events-none"
              strokeWidth={0.5}
            />
          )}
          <div className="relative">
            <div className="inline-flex items-center gap-1.5 bg-white/15 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full mb-3">
              Individual Course
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold leading-tight">
              {c.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-300 mt-4 font-medium">
              <span className="flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" />
                {current?.manifest_type === "cmi5"
                  ? "cmi5 module"
                  : "SCORM module"}
              </span>
              {masteryPct !== null && (
                <span className="flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5" />
                  Mastery score {masteryPct}%
                </span>
              )}
              <span className="flex items-center gap-1.5 capitalize">
                <Clock className="w-3.5 h-3.5" /> {c.status}
              </span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-7 sm:p-9 space-y-7">
          {description && (
            <div>
              <h2 className="font-semibold mb-2">About this course</h2>
              <p className="text-muted text-sm leading-relaxed whitespace-pre-wrap">
                {description}
              </p>
            </div>
          )}

          {masteryPct !== null && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5">
              <h2 className="font-semibold mb-1.5 flex items-center gap-2 text-indigo-900">
                <Target className="w-4 h-4 text-indigo-600" />
                Learning objective
              </h2>
              <p className="text-sm text-indigo-900/90">
                Achieve a score of at least{" "}
                <strong>{masteryPct}%</strong> to pass this course. You can
                retake the course as many times as you need.
              </p>
            </div>
          )}

          {/* Launch CTA */}
          <div className="pt-4 border-t border-line flex flex-wrap items-center gap-3">
            {current ? (
              <Link
                href={`/${orgSlug}/courses/${c.id}/launch`}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-3 bg-indigo-600 hover:bg-indigo-700 text-white px-7 py-3.5 rounded-xl font-semibold transition shadow-sm"
              >
                <PlayCircle className="w-5 h-5" />
                {isComplete
                  ? "Relaunch course"
                  : isInProgress
                    ? "Resume course"
                    : "Launch course"}
              </Link>
            ) : (
              <div className="text-sm text-muted">
                This course doesn&apos;t have a version yet.
              </div>
            )}
            {/* Phase 3: Change language — auto-hides if <2 active packages */}
            <ChangeLanguageMenu
              orgSlug={orgSlug}
              courseId={c.id}
              options={languageOptions}
              currentLanguage={savedLanguage}
            />
            {isAdmin && (
              <Link
                href={`/${orgSlug}/library/${c.id}`}
                className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
              >
                Manage in admin Library <ChevronRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Attempts */}
      <section className="bg-paper border border-line rounded-2xl overflow-hidden shadow-sm">
        <header className="px-6 py-4 border-b border-line">
          <h2 className="font-semibold">My attempts</h2>
          <p className="text-xs text-muted mt-0.5">
            Your history with this course. Click any row for the per-question
            breakdown.
          </p>
        </header>
        {attempts.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            No attempts yet. Click <strong>Launch course</strong> to start.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {attempts.map((a, i) => (
              <AttemptRow
                key={a.id}
                attempt={a}
                number={attempts.length - i}
                version={versionById.get(a.course_version_id)}
                orgSlug={orgSlug}
                courseId={c.id}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AttemptRow({
  attempt,
  number,
  version,
  orgSlug,
  courseId,
}: {
  attempt: Attempt;
  number: number;
  version: Version | undefined;
  orgSlug: string;
  courseId: string;
}) {
  const score =
    attempt.score === null
      ? "—"
      : `${(attempt.score * 100).toFixed(0)}%`;
  const date = new Date(attempt.started_at).toISOString().slice(0, 10);
  const duration =
    attempt.completed_at && attempt.started_at
      ? formatDuration(
          new Date(attempt.completed_at).getTime() -
            new Date(attempt.started_at).getTime()
        )
      : "—";

  return (
    <li>
      <Link
        href={`/${orgSlug}/courses/${courseId}/attempts/${attempt.id}`}
        className="flex items-center justify-between gap-3 px-6 py-3.5 hover:bg-canvas/40 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs text-muted tabular-nums w-7 shrink-0">
            #{number}
          </span>
          <CompletionPill completion={attempt.completion_status} />
          <SuccessPill success={attempt.success_status} />
          {version && (
            <span className="text-xs text-muted shrink-0">
              v{version.version_number}
            </span>
          )}
        </div>
        <div className="flex items-center gap-5 text-xs text-muted shrink-0">
          <span className="font-medium text-ink">{score}</span>
          <span>{date}</span>
          <span className="hidden sm:inline tabular-nums">{duration}</span>
        </div>
      </Link>
    </li>
  );
}

function CompletionPill({
  completion,
}: {
  completion: "in_progress" | "completed";
}) {
  if (completion === "completed") {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-ink text-canvas">
        Completed
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-canvas text-muted border border-line">
      In progress
    </span>
  );
}

function SuccessPill({
  success,
}: {
  success: "unknown" | "passed" | "failed";
}) {
  if (success === "passed") {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-200">
        Passed
      </span>
    );
  }
  if (success === "failed") {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-red-100 text-red-800 border border-red-200">
        Failed
      </span>
    );
  }
  return null;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
