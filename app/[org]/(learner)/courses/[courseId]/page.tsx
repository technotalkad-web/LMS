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
  computeScoring,
  describePolicy,
  officialBasisLabel,
} from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import {
  ChangeLanguageMenu,
  type ChangeLanguageOption,
} from "./change-language-menu";

type Version = {
  id: string;
  version_number: number;
  manifest_type: "scorm12" | "cmi5" | "xapi";
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
  thumbnail_pos_x: number | null;
  thumbnail_pos_y: number | null;
  /** 0072 — optional so pre-migration rows read as "visible". */
  show_attempts_history?: boolean;
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
  /** 0075 — undefined before the migration. */
  progress_pct?: number | null;
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
  // select("*") for 0072 deploy safety (show_attempts_history).
  const { data: course } = await supabase
    .from("courses")
    .select("*")
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
  const access = await learnerCanAccessCourse({
    supabase,
    orgId: org.id,
    userId: user.id,
    courseId: c.id,
    isAdmin,
  });
  if (!access.allowed) {
    redirect(
      access.upcomingAt
        ? `/${orgSlug}/dashboard?upcoming=${c.id}`
        : `/${orgSlug}/dashboard?denied=course`
    );
  }

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
        // select("*") for 0075 deploy safety (progress_pct).
        .select("*")
        .eq("user_id", user.id)
        .in("course_version_id", versionIds)
        .order("started_at", { ascending: false })
    : { data: [] as Attempt[] };
  const attempts = (attemptsResp.data ?? []) as Attempt[];
  const versionById = new Map(list.map((v) => [v.id, v]));

  // 0073: which attempts count (scoring window / official basis / what
  // happens after the window). Fail-soft → platform default pre-migration.
  const policy = await resolvePolicy(supabase, c.id);
  const scoring = computeScoring(attempts, policy);
  const launchBlocked = scoring.blocked && !isAdmin;
  const scoreTagFor = (id: string): ScoreTag => {
    const n = scoring.attemptNumber.get(id);
    if (n === undefined) return null;
    return n <= policy.max_scored_attempts ? { kind: "scored", n } : { kind: "practice" };
  };

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

  // 0072: admins can hide the attempts history from learners. Admins still
  // see it (with a badge) so they can preview what they've hidden.
  const attemptsHidden = c.show_attempts_history === false;
  const showAttemptsSection = isAdmin || !attemptsHidden;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link
        href={`/${orgSlug}/dashboard`}
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      {/* No overflow-hidden here: it clipped the language dropdown that
          opens from the launch row. The hero clips itself instead. */}
      <div className="bg-paper border border-line rounded-2xl shadow-sm">
        {/* Hero banner */}
        <div className="relative bg-gradient-to-br from-slate-800 to-slate-950 text-white p-7 sm:p-9 overflow-hidden rounded-t-2xl">
          {c.thumbnail_url ? (
            <>
              {/* Hero stays cover (it's a darkened backdrop behind text) but
                  honors the admin's chosen focal point. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={c.thumbnail_url}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                style={{
                  objectPosition: `${c.thumbnail_pos_x ?? 50}% ${c.thumbnail_pos_y ?? 50}%`,
                }}
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
                  : current?.manifest_type === "xapi"
                    ? "xAPI module"
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

          {/* 0073: scoring rules — learners always know which attempt counts */}
          <div className="border border-line rounded-xl p-4 sm:p-5 bg-canvas/40">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold text-sm">Your scoring</h2>
              <span className="text-[11px] text-muted">{describePolicy(policy)}</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Score values respect the 0072 "hide attempt history" toggle;
                  the attempt counters stay so learners always know how many
                  scored attempts they have left. */}
              {showAttemptsSection && (
                <ScoreStat
                  label="Official score"
                  value={pct(scoring.officialScore)}
                  sub={officialBasisLabel(policy)}
                />
              )}
              {showAttemptsSection && (
                <ScoreStat label="Best scored attempt" value={pct(scoring.bestScore)} />
              )}
              <ScoreStat
                label="Scored attempts"
                value={`${scoring.scoredAttempts} of ${policy.max_scored_attempts}`}
                sub={
                  scoring.scoredAttempts >= policy.max_scored_attempts
                    ? "all used"
                    : `${policy.max_scored_attempts - scoring.scoredAttempts} left`
                }
              />
              <ScoreStat
                label="Practice attempts"
                value={String(scoring.practiceAttempts)}
                sub="never affect scores"
              />
            </dl>
            {scoring.practiceMode && (
              <p className="mt-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                You&apos;ve used all {policy.max_scored_attempts} scored attempts. You
                can keep revising as often as you like — further attempts are{" "}
                <strong>practice</strong> and won&apos;t change your official score
                or points.
              </p>
            )}
            {scoring.blocked && (
              <p className="mt-3 text-xs text-red-900 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                You&apos;ve used all {policy.max_scored_attempts} scored attempts and
                this course doesn&apos;t allow further attempts. Contact your
                administrator if you need another attempt.
              </p>
            )}
          </div>

          {/* Launch CTA */}
          <div className="pt-4 border-t border-line flex flex-wrap items-center gap-3">
            {current && !launchBlocked ? (
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
            ) : current ? (
              <button
                type="button"
                disabled
                className="w-full sm:w-auto inline-flex items-center justify-center gap-3 bg-canvas text-muted border border-line px-7 py-3.5 rounded-xl font-semibold cursor-not-allowed"
              >
                <PlayCircle className="w-5 h-5" />
                Attempt limit reached
              </button>
            ) : (
              <div className="text-sm text-muted">
                This course doesn&apos;t have a version yet.
              </div>
            )}
            {current && !launchBlocked && scoring.practiceMode && (
              <span className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 border border-amber-200">
                Practice mode
              </span>
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

      {/* Attempts — hidden from learners when the admin turned the course's
          "show attempt history" toggle off (0072). */}
      {showAttemptsSection && (
      <section className="bg-paper border border-line rounded-2xl overflow-hidden shadow-sm">
        <header className="px-6 py-4 border-b border-line">
          <h2 className="font-semibold flex items-center gap-2">
            My attempts
            {isAdmin && attemptsHidden && (
              <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200">
                Hidden from learners
              </span>
            )}
          </h2>
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
                scoreTag={scoreTagFor(a.id)}
              />
            ))}
          </ul>
        )}
      </section>
      )}
    </div>
  );
}

/** 0073: whether a completed attempt fed the score (and its rank) or was practice. */
type ScoreTag = { kind: "scored"; n: number } | { kind: "practice" } | null;

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function ScoreStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums leading-tight">{value}</dd>
      {sub && <dd className="text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}

function AttemptRow({
  attempt,
  number,
  version,
  orgSlug,
  courseId,
  scoreTag,
}: {
  attempt: Attempt;
  number: number;
  version: Version | undefined;
  orgSlug: string;
  courseId: string;
  scoreTag: ScoreTag;
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
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 sm:px-6 py-3.5 hover:bg-canvas/40 transition-colors"
      >
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
          <span className="text-xs text-muted tabular-nums w-7 shrink-0">
            #{number}
          </span>
          <CompletionPill completion={attempt.completion_status} />
          {attempt.completion_status === "in_progress" &&
            typeof attempt.progress_pct === "number" && (
              <span
                title="How far through the module this attempt is"
                className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-amber-50 text-amber-800 border border-amber-200 shrink-0"
              >
                {attempt.progress_pct}% done
              </span>
            )}
          <SuccessPill success={attempt.success_status} />
          {scoreTag?.kind === "scored" && (
            <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-indigo-100 text-indigo-800 border border-indigo-200 shrink-0">
              Scored #{scoreTag.n}
            </span>
          )}
          {scoreTag?.kind === "practice" && (
            <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-canvas text-muted border border-line shrink-0">
              Practice
            </span>
          )}
          {version && (
            <span className="text-xs text-muted shrink-0">
              v{version.version_number}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 sm:gap-5 text-xs text-muted shrink-0 ml-auto pl-10 sm:pl-0">
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
