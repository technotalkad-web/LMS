import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  PlayCircle,
  ChevronRight,
} from "lucide-react";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { learnerCanAccessCourse } from "@/lib/auth/course-access";
import { createClient } from "@/lib/supabase/server";
import { languageDisplay } from "@/lib/i18n/languages";
import { computeScoring, hasLiveGrantedRetake, isRevisionAttempt, latestResetRetake } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { grantSnapshotFor, fetchPassRequired, type GrantSnapshot } from "@/lib/scoring/attempt-kind";
import {
  officialHistory,
  officialRetakeState,
  type HistoryEntry,
  type HistoryGrantInfo,
} from "@/lib/scoring/official-history";
import { requestDecision, resultStands } from "@/lib/attempts/request-decision";
import { fetchMyRevisits } from "@/lib/attempts/revision-visits";
import { courseProgress } from "@/lib/courses/progress-view";
import {
  ChangeLanguageMenu,
  type ChangeLanguageOption,
} from "./change-language-menu";
import { RequestAttemptButton } from "./request-attempt-button";
import { isReadyVersion } from "@/lib/courses/default-rule";

type Version = {
  id: string;
  version_number: number;
  manifest_type: "scorm12" | "cmi5" | "xapi";
  launch_url: string;
  manifest_data: { title?: string; description?: string; masteryScore?: number };
  uploaded_at: string;
  package_id: string | null;
  /** 0077 — undefined before the migration (= ready). */
  upload_status?: string | null;
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
  /** 'abandoned' = reset (module updated, language switched or a retake started): terminal, never in progress. */
  status: "in_progress" | "completed" | "passed" | "failed" | "abandoned";
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  score: number | null;
  started_at: string;
  completed_at: string | null;
  /** 0075 — undefined before the migration. */
  progress_pct?: number | null;
  /** 0103 (ADR 0014): a revision visit's row; undefined before the migration (= false). */
  is_revision?: boolean | null;
};

export default async function CourseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; courseId: string }>;
  /**
   * ?switch=<lang>: the launch page sent the learner here to confirm a language switch (ADR 0004 step 9).
   * ?retry=1: the launch page refused this launch (ADR 0014 step 3: fail closed); the learner may retry.
   */
  searchParams: Promise<{ switch?: string; retry?: string }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const { switch: switchParam, retry: retryParam } = await searchParams;
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

  // select("*") for 0077 deploy safety (upload_status).
  const { data: versions } = await supabase
    .from("course_versions")
    .select("*")
    .eq("course_id", c.id)
    .order("version_number", { ascending: false });
  const list = (versions ?? []) as Version[];
  // Without a course default: the newest finished version, never an
  // unfinished or failed upload (ADR 0008 D1 keeps failed rows).
  const current = list.find((v) => v.id === c.current_version_id) ?? list.find((v) => isReadyVersion(v.upload_status));
  const versionIds = list.map((v) => v.id);

  // Multi-language packages for this course (#158 Phase 3). The
  // ChangeLanguageMenu silently renders nothing if there are <2 active
  // packages, so this fetch is cheap noise on monolingual courses. Every
  // package is read (the menu keeps the active ones) so the page knows when
  // the course has languages but all of them are hidden: the launch page
  // then sends learners straight back here (ADR 0008 step 13), so the
  // Launch button is replaced by a "Not available right now" state.
  const { data: pkgRows } = await supabase
    .from("course_packages")
    .select("id, language, display_name, is_active")
    .eq("course_id", c.id);
  const allPkgs = (pkgRows ?? []) as Array<{
    id: string;
    language: string | null;
    display_name: string | null;
    is_active: boolean | null;
  }>;
  const activePkgs = allPkgs.filter((p) => p.is_active === true);
  const noActiveLanguage = allPkgs.length > 0 && activePkgs.length === 0;
  const languageOptions: ChangeLanguageOption[] = activePkgs.map((p) => ({
    id: p.id,
    language: p.language,
    display_label:
      p.display_name ??
      languageDisplay(p.language, "native") ??
      p.language ??
      "Default",
  }));
  // Package → language, for the switch confirmation copy (ALDS P4).
  const packageLanguageOf = new Map(languageOptions.map((o) => [o.id, o.language]));
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
  // ADR 0014 step 7 (strict reads): one strict grant read, used two ways.
  // On a failed read the history block and the row markers read "History
  // unavailable. Please reload." (a record is never guessed), while the
  // result card and the launch labels take empty retake ids for this one
  // render (display only) and the step 8 notice stays absent. The learner's
  // own attempt_requests rows are readable through RLS (0083).
  let snapshot: GrantSnapshot | null = null;
  let historyUnavailable = false;
  try {
    snapshot = await grantSnapshotFor(supabase, user.id, c.id);
  } catch {
    historyUnavailable = true;
  }
  const retakeIds: Set<string> = snapshot?.retakeIds ?? new Set<string>();
  const scoring = computeScoring(attempts, policy, retakeIds);
  const passRequired = (await fetchPassRequired(supabase, [c.id])).has(c.id);
  // ADR 0014 step 10: a granted retake is running. courseStatus is not
  // called on this page, so the step is applied here: the CTA resumes it,
  // the "Revision" pill and the revisit notice are hidden, and the official
  // score card keeps the standing result.
  const liveRetake = hasLiveGrantedRetake(attempts, scoring.retakeIds);
  // ADR 0014 step 7: the official-result chain (one definition for every
  // surface) and its retake state.
  const history = officialHistory(attempts, snapshot?.rows ?? []);
  const retakeState = officialRetakeState(history);
  // "Revisited N times": revision_visits is deny-all (0103), so this one read
  // goes through the service client, scoped to the signed-in user's own id
  // and this course. Nothing else on this page uses the service client.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const revisits = await fetchMyRevisits(svc, user.id, c.id);

  // 0083: this learner's extra-attempt request/grant state for the course. A
  // live (approved, unexpired, unused) grant unblocks the launch — the launch
  // gate turns it into a fresh official retake — and suppresses the
  // revisit messaging. Fail-soft (no state) on a pre-0083 database.
  let attemptRequestState: "none" | "pending" | "granted" | "rejected" = "none";
  let grantExpiresAt: string | null = null;
  let requestRejectionNote: string | null = null;
  let hasUnusedGrant = false;
  try {
    const { data: arRows } = await supabase
      .from("attempt_requests")
      .select("status, used_at, expires_at, decision_note, created_at")
      .eq("user_id", user.id)
      .eq("course_id", c.id)
      .order("created_at", { ascending: false });
    const reqs = (arRows ?? []) as Array<{
      status: string;
      used_at: string | null;
      expires_at: string | null;
      decision_note: string | null;
    }>;
    const nowMs = Date.now();
    const liveGrant = reqs.find(
      (r) => r.status === "approved" && !r.used_at && (!r.expires_at || new Date(r.expires_at).getTime() > nowMs)
    );
    const pending = reqs.find((r) => r.status === "pending");
    if (liveGrant) {
      attemptRequestState = "granted";
      grantExpiresAt = liveGrant.expires_at;
      hasUnusedGrant = true;
    } else if (pending) {
      attemptRequestState = "pending";
    } else if (reqs[0]?.status === "rejected") {
      attemptRequestState = "rejected";
      requestRejectionNote = reqs[0].decision_note;
    }
  } catch {
    /* pre-0083 */
  }

  // ADR 0014 step 11 (1): the learner may ask for another official attempt
  // once an official result exists and no granted retake is live (the rule
  // POST /api/attempt-requests checks too: requestDecision), with no open
  // request or grant already. A pass is not a refusal: the modal warns.
  // With the history unavailable the page cannot tell whether a retake is
  // live, so the button is hidden for this render (the route stays the
  // backstop). ADR 0014 step 9 retired the block rule, so nothing refuses a
  // launch here any more.
  const canRequestAttempt =
    !isAdmin &&
    !historyUnavailable &&
    requestDecision({ scoring, attempts }) === "ok" &&
    (attemptRequestState === "none" || attemptRequestState === "rejected");
  // The modal's warning when the official result stands (passed, or
  // completed on a module without a pass mark).
  const standingResult: { kind: "passed" | "completed"; scorePct: number | null } | null = resultStands(scoring, passRequired)
    ? {
        kind: scoring.officialStatus === "passed" ? "passed" : "completed",
        scorePct: scoring.officialScore === null ? null : Math.round(scoring.officialScore * 100),
      }
    : null;

  // Sticky completion: a course that was ever completed/passed stays
  // "complete" even after the learner relaunches it (which opens a fresh
  // in-progress attempt). Only show "Resume" when there's an open attempt and
  // the course has never been finished. Otherwise "Relaunch" / "Launch".
  // 0081: completion follows the OFFICIAL attempt; revision runs never count.
  const isComplete = scoring.officialAttempt !== null;
  // ADR 0004 step 10: in progress = an attempt whose STATUS is in_progress.
  // An abandoned attempt keeps completion_status 'in_progress' but is dead,
  // so it never offers "Resume" (the learner would land on 0 %).
  // Only an attempt the launch can resume counts: its version belongs to an
  // ACTIVE language slot (or to no slot: legacy courses launch through
  // current_version_id). An in-progress attempt on a deactivated slot is
  // closed at the next launch (step 9 rule 3) and the learner starts on an
  // active slot, so offering "Resume" there would land them on 0 %.
  const activePackageIds = new Set(languageOptions.map((o) => o.id));
  const resumable = (a: Attempt) => {
    const pkg = versionById.get(a.course_version_id)?.package_id ?? null;
    return pkg === null || activePackageIds.has(pkg);
  };
  // A revision visit's row is never an attempt in progress (ADR 0014 step 7).
  const isInProgress =
    !isComplete &&
    attempts.some((a) => a.status === "in_progress" && !isRevisionAttempt(a) && resumable(a));

  // A one-line note when the learner's latest attempt was reset by an admin
  // action: its package was deactivated or its version is no longer that
  // language's current version (replaced with force-restart). A reset the
  // learner chose (language switch, granted retake) gets no note.
  // The newest NON-REVISION row (the list is ordered started_at desc): a
  // stale revision row the launch page closed is abandoned and newest, and
  // would otherwise read as a reset (ADR 0014 step 7).
  let resetByAdmin = false;
  const latestAttempt = attempts.find((a) => !isRevisionAttempt(a));
  if (latestAttempt?.status === "abandoned") {
    const { data: allPkgRows } = await supabase
      .from("course_packages")
      .select("id, current_version_id, is_active")
      .eq("course_id", c.id);
    const pkgOfLatest = ((allPkgRows ?? []) as Array<{ id: string; current_version_id: string | null; is_active: boolean }>).find(
      (p) => p.id === versionById.get(latestAttempt.course_version_id)?.package_id
    );
    resetByAdmin =
      !!pkgOfLatest && (pkgOfLatest.is_active === false || pkgOfLatest.current_version_id !== latestAttempt.course_version_id);
  }

  // ADR 0014 step 8: the learner's newest non-revision attempt is a granted
  // retake that a forced restart reset, and no granted retake is live. The
  // notice sits above the request button and is hidden once a request is
  // pending or a grant is live. retakeIds are empty when the strict grant
  // read failed, so the notice is then absent, never wrong.
  const showResetRetakeNotice =
    latestResetRetake(attempts, retakeIds) && attemptRequestState !== "pending" && !hasUnusedGrant;

  const manifestDescription = current?.manifest_data?.description ?? "";
  const description = c.description || manifestDescription;

  // 0072: admins can hide the attempts history from learners. Admins still
  // see it (with a badge) so they can preview what they've hidden.
  const attemptsHidden = c.show_attempts_history === false;
  const showAttemptsSection = isAdmin || !attemptsHidden;

  // ADR 0014 step 7: "My attempts" lists official attempts and granted
  // retakes only (a revision visit is counted in the line under the header),
  // each row carrying its place in the chain. The "Official result history"
  // block reads the same chain; while a retake runs its first line carries
  // the retake's progress (a per-course display, so courseProgress gets the
  // retake ids).
  const attemptRows = attempts.filter((a) => !isRevisionAttempt(a));
  const markers = historyUnavailable ? new Map<string, string[]>() : attemptMarkers(history, retakeState.current);
  const runningPct =
    retakeState.state === "in_progress" ? courseProgress(attempts, undefined, { retakeIds: scoring.retakeIds }).pct : null;
  const historyLines = historyUnavailable ? [] : officialHistoryLines(history, retakeState.current, runningPct);
  const showHistoryBlock = historyUnavailable ? attemptRows.length > 0 : historyLines.length > 0;

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

          {/* Learner-friendly result + status. Only the OFFICIAL score is
              shown — no scoring windows, attempt counts or rule internals. */}
          <div className="space-y-3">
            {scoring.officialAttempt && (
              <div className="border border-line rounded-xl p-4 sm:p-5 bg-canvas/40 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted">
                    Official score
                  </div>
                  <div className="text-2xl font-semibold tabular-nums leading-tight">
                    {pct(scoring.officialScore)}
                  </div>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                    scoring.officialStatus === "passed"
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : scoring.officialStatus === "failed"
                        ? "bg-red-50 text-red-700 border-red-200"
                        : "bg-slate-50 text-slate-700 border-slate-200"
                  }`}
                >
                  {scoring.officialStatus === "passed"
                    ? "Passed"
                    : scoring.officialStatus === "failed"
                      ? "Not passed"
                      : "Completed"}
                </span>
              </div>
            )}

            {/* ADR 0014 step 7: the official-result history, under the
                official score and OUTSIDE the hideable attempts section.
                Text, not links: the attempt page refuses a learner when the
                attempts history is hidden. The grant line names "your
                administrator", never a name or email. */}
            {showHistoryBlock && (
              <div
                className="border border-line rounded-xl p-4 sm:p-5"
                data-testid="official-result-history"
              >
                <div className="text-[11px] uppercase tracking-wide text-muted mb-2">
                  Official result history
                </div>
                {historyUnavailable ? (
                  <p className="text-sm text-muted">History unavailable. Please reload.</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {historyLines.map((line) => (
                      <li key={line.key} data-testid="official-history-line">
                        <div className={line.current ? "text-ink font-medium" : "text-muted"}>{line.text}</div>
                        {line.grant && (
                          <div className="text-xs text-muted mt-0.5">{grantLine(line.grant)}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* ADR 0014 step 3: the launch page refused this launch (a read it
                could not make, or a launch kind the row disagreed with) and
                wrote nothing; a retry decides again. */}
            {retryParam && (
              <p
                className="text-xs text-red-900 bg-red-50 border border-red-200 rounded-lg px-3 py-2"
                role="alert"
                data-testid="launch-retry-notice"
              >
                Could not open the course. Please try again.
              </p>
            )}
            {hasUnusedGrant && (
              <p className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                You&apos;ve been granted another attempt. Launch the course to start
                fresh — your new result replaces the previous one.
                {grantExpiresAt ? (
                  <> Use it before{" "}
                    <strong>{new Date(grantExpiresAt).toLocaleDateString()}</strong>.</>
                ) : null}
              </p>
            )}
            {!hasUnusedGrant && !liveRetake && scoring.practiceMode && (
              <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                You&apos;ve completed this course. You can revisit it any time to
                review — revisiting won&apos;t change your result.
              </p>
            )}
            {attemptRequestState === "pending" && (
              <p className="text-xs text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
                Your request for another attempt is under review.
              </p>
            )}
            {resetByAdmin && !isInProgress && !isComplete && (
              <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Your earlier progress was reset because the module was updated. Launch the course to start the current version.
              </p>
            )}
            {attemptRequestState === "rejected" && (
              <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                A previous attempt request was declined.
                {requestRejectionNote ? <> Note: {requestRejectionNote}</> : null}
              </p>
            )}
            {showResetRetakeNotice && (
              <p
                className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                data-testid="retake-reset-notice"
              >
                Your retake was reset when the module was updated. Request another attempt to continue.
              </p>
            )}
          </div>

          {/* Launch CTA */}
          <div className="pt-4 border-t border-line flex flex-wrap items-center gap-3">
            {current && noActiveLanguage ? (
              <button
                type="button"
                disabled
                data-testid="launch-unavailable"
                title="Every language of this course is hidden right now."
                className="w-full sm:w-auto inline-flex items-center justify-center gap-3 bg-canvas text-muted border border-line px-7 py-3.5 rounded-xl font-semibold cursor-not-allowed"
              >
                <PlayCircle className="w-5 h-5" />
                Not available right now
              </button>
            ) : current ? (
              <Link
                href={`/${orgSlug}/courses/${c.id}/launch`}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-3 bg-indigo-600 hover:bg-indigo-700 text-white px-7 py-3.5 rounded-xl font-semibold transition shadow-sm"
              >
                <PlayCircle className="w-5 h-5" />
                {liveRetake
                  ? "Resume course"
                  : hasUnusedGrant
                    ? "Start granted attempt"
                    : isComplete
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
            {current && !noActiveLanguage && hasUnusedGrant && (
              <span className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
                Official retake
              </span>
            )}
            {current && !noActiveLanguage && !hasUnusedGrant && !liveRetake && scoring.practiceMode && (
              <span className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 border border-amber-200">
                Revision
              </span>
            )}
            {canRequestAttempt && (
              <RequestAttemptButton orgSlug={orgSlug} courseId={c.id} standingResult={standingResult} />
            )}
            {/* Phase 3: Change language — auto-hides if <2 active packages */}
            <ChangeLanguageMenu
              orgSlug={orgSlug}
              courseId={c.id}
              options={languageOptions}
              currentLanguage={savedLanguage}
              initialSwitch={switchParam ?? null}
              inProgress={attempts
                .filter((a) => a.status === "in_progress" && !isRevisionAttempt(a))
                .map((a) => ({
                  language: packageLanguageOf.get(
                    versionById.get(a.course_version_id)?.package_id ?? ""
                  ) ?? null,
                  grantedRetake: retakeIds.has(a.id),
                }))}
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
          {/* ADR 0014 step 7: revision visits are counted, never listed. */}
          {!revisits.failed && revisits.count > 0 && (
            <p className="text-xs text-muted mt-1" data-testid="revisit-count">
              {revisits.count === 1 ? "Revisited 1 time" : `Revisited ${revisits.count} times`}
              {revisits.last && isoDate(revisits.last) ? ` · last on ${isoDate(revisits.last)}` : ""}
            </p>
          )}
          {historyUnavailable && attemptRows.length > 0 && (
            <p className="text-xs text-muted mt-1" data-testid="attempt-markers-unavailable">
              History unavailable. Please reload.
            </p>
          )}
        </header>
        {attemptRows.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            {noActiveLanguage ? (
              <>No attempts yet.</>
            ) : (
              <>No attempts yet. Click <strong>Launch course</strong> to start.</>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {attemptRows.map((a, i) => (
              <AttemptRow
                key={a.id}
                attempt={a}
                number={attemptRows.length - i}
                markers={markers.get(a.id) ?? []}
                version={versionById.get(a.course_version_id)}
                orgSlug={orgSlug}
                courseId={c.id}
              />
            ))}
          </ul>
        )}
      </section>
      )}
    </div>
  );
}

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/** YYYY-MM-DD (the attempt rows' date form); null for a missing or unreadable timestamp. */
function isoDate(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function sortKey(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

/** "N %" in the ADR 0014 step 7 wording; null when the attempt has no score. */
function scorePctText(score: number | null): string | null {
  return score === null ? null : `${Math.round(score * 100)} %`;
}

const RESULT_WORD: Record<HistoryEntry["status"], string> = {
  passed: "Passed",
  failed: "Not passed",
  completed: "Completed",
};

type HistoryLine = { key: string; text: string; current: boolean; grant: HistoryGrantInfo | null };

/**
 * The "Official result history" block's lines (ADR 0014 step 7), newest
 * first: each chain entry ("<date> · N % · Passed · Official result", or
 * "… · Replaced by a granted retake on <date>" once superseded), each reset
 * retake in date order among them ("<date> · Granted retake, reset by a
 * module update"), and, while a granted retake runs, a first line carrying
 * its progress and the standing result. A retake's line carries its grant.
 */
function officialHistoryLines(
  history: ReturnType<typeof officialHistory>,
  current: HistoryEntry | null,
  runningPct: number | null
): HistoryLine[] {
  const dated: Array<{ at: number; line: HistoryLine }> = [];
  for (const e of history.entries) {
    const by = e.supersededBy ? history.entries.find((x) => x.attemptId === e.supersededBy) ?? null : null;
    const byDate = by ? isoDate(by.completedAt) : null;
    const tail = e.supersededBy
      ? `Replaced by a granted retake${byDate ? ` on ${byDate}` : ""}`
      : "Official result";
    const text = [isoDate(e.completedAt), scorePctText(e.score), RESULT_WORD[e.status], tail].filter(Boolean).join(" · ");
    dated.push({ at: sortKey(e.completedAt), line: { key: e.attemptId, text, current: !e.supersededBy, grant: e.grant } });
  }
  for (const r of history.reset) {
    const text = [isoDate(r.startedAt), "Granted retake, reset by a module update"].filter(Boolean).join(" · ");
    dated.push({ at: sortKey(r.startedAt), line: { key: `reset-${r.attemptId}`, text, current: false, grant: r.grant } });
  }
  dated.sort((a, b) => b.at - a.at);
  const lines = dated.map((d) => d.line);
  if (history.running) {
    const previous = current
      ? [scorePctText(current.score), RESULT_WORD[current.status], isoDate(current.completedAt)].filter(Boolean).join(", ")
      : "";
    const text =
      `Official retake in progress${runningPct === null ? "" : ` · ${runningPct} %`}` +
      (previous ? ` — your previous result (${previous}) stays in your history until you finish` : "");
    lines.unshift({ key: `running-${history.running.attemptId}`, text, current: true, grant: history.running.grant });
  }
  return lines;
}

/** "Granted by your administrator on <date>" with the admin's note, never a name or email (ADR 0014:230). */
function grantLine(grant: HistoryGrantInfo): string {
  const date = isoDate(grant.decidedAt);
  const note = grant.decisionNote?.trim();
  return `Granted by your administrator${date ? ` on ${date}` : ""}${note ? `: ${note}` : ""}`;
}

/**
 * "My attempts" row markers (ADR 0014 step 7): the current official
 * result, every superseded one, each granted retake with "in progress" or
 * its result, and a retake a forced restart reset.
 */
function attemptMarkers(history: ReturnType<typeof officialHistory>, current: HistoryEntry | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, label: string) => out.set(id, [...(out.get(id) ?? []), label]);
  for (const e of history.entries) {
    add(e.attemptId, current && e.attemptId === current.attemptId ? "Official result" : "Previous official result");
    if (e.kind === "retake") add(e.attemptId, `Granted retake · ${RESULT_WORD[e.status]}`);
  }
  if (history.running) add(history.running.attemptId, "Granted retake · in progress");
  for (const r of history.reset) add(r.attemptId, "Granted retake, reset by a module update");
  return out;
}

function AttemptRow({
  attempt,
  number,
  markers,
  version,
  orgSlug,
  courseId,
}: {
  attempt: Attempt;
  number: number;
  markers: string[];
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
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 sm:px-6 py-3.5 hover:bg-canvas/40 transition-colors"
      >
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
          <span className="text-xs text-muted tabular-nums w-7 shrink-0">
            #{number}
          </span>
          <CompletionPill completion={attempt.completion_status} status={attempt.status} />
          {attempt.status === "in_progress" &&
            attempt.completion_status === "in_progress" &&
            typeof attempt.progress_pct === "number" && (
              <span
                title="How far through the module this attempt is"
                className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-amber-50 text-amber-800 border border-amber-200 shrink-0"
              >
                {attempt.progress_pct}% done
              </span>
            )}
          <SuccessPill success={attempt.success_status} />
          {markers.map((m) => (
            <span
              key={m}
              data-testid="attempt-marker"
              className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-indigo-50 text-indigo-800 border border-indigo-200 shrink-0"
            >
              {m}
            </span>
          ))}
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
  status,
}: {
  completion: "in_progress" | "completed";
  status: Attempt["status"];
}) {
  // ADR 0004 step 10: an abandoned attempt is neutral and terminal, never
  // "In progress". ADR 0014 step 7: the cause of a close is not stored, so
  // the pill says what is true of every close (the forced-restart notice
  // already names a module update).
  if (status === "abandoned" && completion !== "completed") {
    return (
      <span
        title="This attempt was closed before it finished and does not count"
        className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-slate-100 text-slate-600 border border-slate-200"
      >
        Closed — not counted
      </span>
    );
  }
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
