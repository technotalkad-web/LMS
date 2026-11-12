import { redirect } from "next/navigation";
import { originFromRequest } from "@/lib/http/origin";
import { randomBytes } from "crypto";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { learnerCanAccessCourse } from "@/lib/auth/course-access";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { ScormRuntime } from "./scorm-runtime";
import { Cmi5Runtime } from "./cmi5-runtime";
import { LaunchLanguagePicker } from "./launch-language-picker";
import { isSupportedLanguage, languageDisplay } from "@/lib/i18n/languages";
import type { CmiData } from "@/lib/scorm/types";
import {
  computeJourneyState,
  courseDaysOf,
  parseVersionDays,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";
import { myGroupIdsServer } from "@/lib/org/groups";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { computeScoring, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";
import { grantSnapshotFor, isMissingColumn, isSchemaMissing, type GrantSnapshot } from "@/lib/scoring/attempt-kind";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";
import { decideSlotRouting, type SlotAttempt, type SlotSource } from "@/lib/courses/slot-routing";
import { launchFallback } from "@/lib/courses/default-rule";
import { aldsP4Enabled, isAldsSchemaMissing, logAldsSkip } from "@/lib/alds/flag";
import {
  buildLaunchData,
  launchModeFor,
  lmsAuActivityId,
  newSessionId,
  p4AttemptColumns,
  recordLearningSession,
  registrationKindFor,
  servedLanguageFor,
  writeLaunchData,
} from "@/lib/alds/launch";
import { LMS_LAUNCH_DATA_STATE_ID, LMS_OFFICIAL_RESULT_STATE_ID } from "@/lib/alds/rpc";
import {
  afterConsumeGrant,
  candidateKind,
  insertIsRevision,
  revisionInsertRefused,
  rowAction,
  seedPlan,
  shouldRecordVisit,
  tokenExpiryTargets,
  type CandidateKind,
  type RowAction,
  type RowDecision,
} from "@/lib/attempts/launch-kind";
import { buildOfficialResult, buildRevisionCmi } from "@/lib/attempts/revision-seed";
import { isKivoStamped } from "@/lib/courses/engine-version";
import { officialResultStored } from "@/lib/learner/continue";

type Course = {
  id: string;
  organization_id: string;
  current_version_id: string | null;
  title: string;
  is_active?: boolean;
  pass_required?: boolean | null;
};

type Version = {
  id: string;
  manifest_type: "scorm12" | "cmi5" | "xapi";
  launch_url: string;
  manifest_data: {
    raw?: { courseId?: string; auId?: string; activityId?: string };
    masteryScore?: number | null;
    /** ADR 0017's cached engine stamp: a string for a KIVO build, null for another, absent when unread. */
    engineVersion?: string | null;
  };
  package_id: string | null;
};

type PackageRow = {
  id: string;
  language: string | null;
  display_name: string | null;
  current_version_id: string | null;
  is_active: boolean;
};

export default async function LaunchPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; courseId: string }>;
  searchParams: Promise<{
    lang?: string;
    lp?: string;
    journey?: string;
    day?: string;
    back?: string;
  }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const {
    lang: langParam,
    lp: lpParam,
    journey: journeyParam,
    day: dayParam,
    back: backParam,
  } = await searchParams;
  const { user, org, role } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select("id, organization_id, current_version_id, title, is_active, pass_required")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (!course) {
    redirect(`/${orgSlug}/courses/${courseId}`);
  }
  if ((course as Course).is_active === false) {
    redirect(`/${orgSlug}/dashboard`);
  }
  const c = course as Course;
  // The bar's Continue state (ADR 0019, note of 2026-11-11): the continue
  // address's own reading of the course's setting.
  const passRequired = c.pass_required === true;

  // ---- Yoddha journey context (?journey=<enrollmentId>&day=<n>) ----
  // Runs BEFORE the generic entitlement gate: a locked journey day must
  // bounce to the friendly journey?locked notice, not to the generic
  // "denied" redirect the gate would produce for a journey-only course.
  // Trusted only after re-validation: the enrollment must be the caller's
  // own and active, that program day must point at THIS course, and the day
  // must be the next unlockable one (catch-up allowed, never ahead of the
  // calendar). A locked day bounces to the journey home; a completed day
  // launches untagged (review mode). RLS scopes every read to the caller.
  let journeyCtx: { enrollmentId: string; day: number } | null = null;
  // The next journey day's course — warmed in the background by the runtime
  // while the learner works through today's mission (never launched here).
  let journeyNextCourseId: string | null = null;
  if (journeyParam && dayParam) {
    const dayN = parseInt(dayParam, 10);
    // Rules and curriculum come from the enrollment's PINNED VERSION —
    // a later publish never changes what an in-flight run launches.
    const { data: enrRow } = await supabase
      .from("journey_enrollments")
      .select(
        "id, start_date, status, journey_versions!inner(days_total, count_sundays, days, unlock_mode), journey_programs!inner(is_active)"
      )
      .eq("id", journeyParam)
      .eq("user_id", user.id)
      // The enrollment is trusted only within this attempt's organisation:
      // its id is written into the attempt by the server below.
      .eq("organization_id", org.id)
      .maybeSingle();
    const enr = enrRow as {
      id: string;
      start_date: string;
      status: string;
      journey_versions:
        | { days_total: number; count_sundays: boolean; days: unknown; unlock_mode?: string | null }
        | Array<{ days_total: number; count_sundays: boolean; days: unknown; unlock_mode?: string | null }>;
      journey_programs: { is_active: boolean } | Array<{ is_active: boolean }>;
    } | null;
    const prog = enr
      ? Array.isArray(enr.journey_versions)
        ? enr.journey_versions[0]
        : enr.journey_versions
      : null;
    const parent = enr
      ? Array.isArray(enr.journey_programs)
        ? enr.journey_programs[0]
        : enr.journey_programs
      : null;
    if (
      enr &&
      prog &&
      enr.status === "active" &&
      parent?.is_active !== false &&
      Number.isFinite(dayN)
    ) {
      const dayEntry = parseVersionDays(prog.days).get(dayN);
      if (dayEntry?.course_id === courseId) {
        const { data: doneRows } = await supabase
          .from("journey_day_progress")
          .select("day_number")
          .eq("enrollment_id", enr.id);
        // Completed DAY NUMBERS, not just a count — with rest days in the
        // curriculum the two differ, and the old `dayN > count` comparison
        // wrongly bounced reviews of finished missions to the locked notice.
        const doneDays = new Set(
          ((doneRows ?? []) as Array<{ day_number: number }>).map(
            (r) => r.day_number
          )
        );
        const { data: gsRow } = await supabase
          .from("gamification_settings")
          .select("timezone")
          .eq("organization_id", org.id)
          .maybeSingle();
        const tz =
          (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
        const state = computeJourneyState({
          startDate: enr.start_date,
          today: todayStr(tz),
          completedCount: doneDays.size,
          daysTotal: prog.days_total,
          countSundays: prog.count_sundays === true,
          unlockMode: prog.unlock_mode === "progress" ? "progress" : "calendar",
          courseDays: courseDaysOf(prog.days, prog.days_total),
        });
        if (dayN === state.currentDay && state.todayUnlocked) {
          journeyCtx = { enrollmentId: enr.id, day: dayN };
          const upcoming = [...parseVersionDays(prog.days).values()]
            .filter((d) => d.day > dayN && d.day <= prog.days_total && d.course_id)
            .sort((a, b) => a.day - b.day)[0];
          if (upcoming?.course_id && upcoming.course_id !== courseId) {
            journeyNextCourseId = upcoming.course_id;
          }
        } else if (!doneDays.has(dayN)) {
          redirect(`/${orgSlug}/journey?locked=${dayN}`);
        }
        // Completed day → revision of a finished mission: launch untagged so
        // it can never double-credit or earn XP. Learners may revise as
        // often as they like.
      }
    }
  }

  // Entitlement gate (closes the private/unassigned-course IDOR): a learner may
  // only launch an assigned (direct/org/team) or org_public course whose
  // assignment is released, or a journey day up to their unlocked day.
  // Admins preview freely. Mirrors the dashboard so launchable == visible.
  const access = await learnerCanAccessCourse({
    supabase,
    orgId: org.id,
    userId: user.id,
    courseId: c.id,
    isAdmin: canManage(role),
  });
  if (!access.allowed) {
    redirect(
      access.upcomingAt
        ? `/${orgSlug}/dashboard?upcoming=${courseId}`
        : `/${orgSlug}/dashboard?denied=1`
    );
  }

  // Language packages (ADR 0008 step 13), read BEFORE the attempt rule below:
  // a launch with every language hidden goes back to the course page before
  // a granted retake resets anything. A failed read goes back too, never to
  // the course-default fallback (which may be a hidden language's version).
  const { data: pkgRows, error: pkgErr } = await supabase
    .from("course_packages")
    .select("id, language, display_name, current_version_id, is_active")
    .eq("course_id", courseId);
  if (pkgErr) {
    console.warn("[launch] package read failed:", pkgErr.message);
    redirect(`/${orgSlug}/courses/${courseId}`);
  }
  const allPackages = (pkgRows ?? []) as PackageRow[];
  const activePackages = allPackages.filter((p) => p.is_active);
  const fallback = launchFallback({ packageCount: allPackages.length, activeCount: activePackages.length });
  if (fallback === "redirect") {
    // Every language is hidden from learners: nothing to launch.
    redirect(`/${orgSlug}/courses/${courseId}`);
  }

  // ADR 0009: attempt rows are written by the server only. The reads stay on
  // the caller's RLS session; every write below goes through this ONE
  // service client with explicit id/user_id/organization_id (ADR 0014 step
  // 3 adds the strict grant read, the closes, consume_grant, the cutover
  // flag, the seed and the visit record). Membership is already proven: the
  // course was read under RLS ("members read org courses") with
  // organization_id = org.id, every version is read with course_id = c.id,
  // and a journey context only from this organisation.
  const svcAttempt = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ADR 0014 step 3, fail closed: every read that feeds the launch verdict or
  // the row choice refuses on error, and so does every disagreement between
  // the launch kind and the row. One refusal for all of them: back to the
  // course page with the retry notice, nothing written. redirect() throws, so
  // no refusal may sit inside a try that would swallow it.
  const refuse: (reason: string) => never = (reason) => {
    console.warn(JSON.stringify({ event: "launch_refused", reason, course_id: c.id, user_id: user.id }));
    redirect(`/${orgSlug}/courses/${courseId}?retry=1`);
  };

  // The learner's approved grants on this course, read in one strict select
  // per decision (grantSnapshotFor): a failed read refuses; a database
  // without attempt_requests has none.
  const readGrants = async (): Promise<GrantSnapshot> =>
    (await grantSnapshotFor(svcAttempt, user.id, c.id).catch((e: unknown) => {
      console.warn("[launch] grant read failed:", e instanceof Error ? e.message : String(e));
      return null;
    })) ?? refuse("grant_read_failed");

  // 0073/0081 attempt rule (ADR 0014: one official attempt, then review-only
  // revision visits; extra official attempts only by a consumed grant),
  // evaluated across ALL versions/languages of the course so a language
  // switch or a new version can't reopen the window. It writes nothing, so a
  // launch that ends on the language picker spends nothing. The candidate
  // kind (lib/attempts/launch-kind.ts): `first` while the window has a free
  // slot, `grant` when an unused grant is consumed on this launch, otherwise
  // `at_row` (the row decides: a granted retake resumes, anything else is a
  // revision visit). Admins preview freely.
  type MyAttempt = ScorableAttempt & { course_version_id: string; cmi_data: CmiData | null; status?: string };
  type Evaluation = { my: MyAttempt[]; scoring: ScoringResult | null; candidate: CandidateKind };
  const MY_COLUMNS = "id, score, started_at, completed_at, completion_status, success_status, course_version_id, cmi_data, status";
  const evaluate = async (grantsNow: GrantSnapshot, consumeGrants: boolean): Promise<Evaluation> => {
    if (canManage(role)) return { my: [], scoring: null, candidate: "first" };
    const policy = await resolvePolicy(supabase, c.id);
    const { data: verRows, error: verErr } = await supabase
      .from("course_versions")
      .select("id")
      .eq("course_id", c.id);
    if (verErr) refuse("versions_read_failed");
    const vIds = ((verRows ?? []) as Array<{ id: string }>).map((r) => r.id);
    let my: MyAttempt[] = [];
    if (vIds.length > 0) {
      // is_revision (0103) with the narrower-select fallback. Its own abort
      // signal: Next memoizes identical GET fetches within one render, and
      // evaluate runs again after consume_grant, when a concurrent launch may
      // have closed rows and opened its retake.
      const readMy = (columns: string) =>
        supabase
          .from("course_attempts")
          .select(columns)
          .eq("user_id", user.id)
          .in("course_version_id", vIds)
          .abortSignal(new AbortController().signal);
      let { data: myRows, error: myErr } = await readMy(`${MY_COLUMNS}, is_revision`);
      if (myErr && isMissingColumn(myErr, "is_revision")) ({ data: myRows, error: myErr } = await readMy(MY_COLUMNS));
      if (myErr) refuse("attempts_read_failed");
      my = (myRows ?? []) as unknown as MyAttempt[];
    }
    // Consumed grants widen the official window (0083).
    const scoring = computeScoring(my, policy, grantsNow.retakeIds);
    // A granted retake in progress on ANY version only blocks consuming
    // another grant; whether THIS launch resumes a retake is the row's call.
    const liveRetakeOnAnyVersion = my.some((a) => a.status === "in_progress" && grantsNow.retakeIds.has(a.id));
    const candidate = candidateKind({
      limitReached: scoring.limitReached,
      unusedGrantId: grantsNow.unusedGrant?.id ?? null,
      consumeGrants,
      liveRetakeOnAnyVersion,
    });
    // ADR 0014 step 9: the block rule is retired, so no launch is refused
    // for a used window (normalizePolicy clamps every rule to the default).
    return { my, scoring, candidate };
  };
  let grants = await readGrants();
  let ev = await evaluate(grants, true);

  // ---------------------------------------------------------------
  // Multi-language resolution (Phase 2 + Phase 3 of #158)
  //
  // Priority order:
  //   1. ?lang=xx query param (if it matches an active package on the course)
  //   2. user's saved preference in course_language_preferences
  //   3. if only ONE active package exists, auto-use it
  //   4. otherwise render the picker (early return)
  //   5. legacy fallback to course.current_version_id only when the course
  //      has NO package rows at all; packages exist but none is active →
  //      back to the course page (ADR 0008 step 13, checked above, before
  //      the attempt rule). The course default never chooses a learner's
  //      language.
  // ---------------------------------------------------------------
  let resolvedVersionId: string | null = null;
  let chosenPackageId: string | null = null;
  // How the package was chosen (ADR 0004 step 9): an explicit ?lang= (the
  // picker navigates there too), the saved preference, or the only active one.
  let slotSource: SlotSource = "single";

  if (fallback === "legacy") {
    // Legacy path: no packages at all — fall back to course.current_version_id
    resolvedVersionId = c.current_version_id;
  } else if (activePackages.length === 1) {
    resolvedVersionId = activePackages[0].current_version_id;
    chosenPackageId = activePackages[0].id;
  } else {
    // Pick from explicit ?lang= if it matches an active package.
    let chosen: PackageRow | null = null;
    if (langParam && isSupportedLanguage(langParam)) {
      chosen =
        activePackages.find((p) => p.language === langParam) ?? null;
      if (chosen) slotSource = "explicit";
    }
    if (!chosen) {
      slotSource = "preference";
      // Look up saved preference.
      const { data: prefRow } = await supabase
        .from("course_language_preferences")
        .select("language")
        .eq("user_id", user.id)
        .eq("course_id", courseId)
        .maybeSingle();
      const savedLang = (prefRow?.language as string | undefined) ?? null;
      if (savedLang) {
        chosen =
          activePackages.find((p) => p.language === savedLang) ?? null;
      }
    }
    if (!chosen) {
      // Render picker — learner has no signal we can use.
      return (
        <LaunchLanguagePicker
          orgSlug={orgSlug}
          courseId={courseId}
          courseTitle={c.title}
          packages={activePackages.map((p) => ({
            id: p.id,
            language: p.language,
            display_label:
              p.display_name ??
              languageDisplay(p.language, "native") ??
              p.language ??
              "Default",
          }))}
        />
      );
    }
    resolvedVersionId = chosen.current_version_id;
    chosenPackageId = chosen.id;
  }

  if (!resolvedVersionId) {
    redirect(`/${orgSlug}/courses/${courseId}`);
  }

  const initialVersionId: string = resolvedVersionId;
  const initialPackageId: string | null = chosenPackageId;

  // The version this launch runs (ADR 0014 step 3, Routing), resolved once
  // per kind decision: the other-slot handling, the grandfather routing and
  // the version read. A revision visit's rows are invisible to both routing
  // steps, so a revisit resolves to the current version of the chosen slot;
  // the same reads list the stale revision rows (flagged, in progress, on a
  // non-current version of the chosen package), closed below. A `grant`
  // launch ignores every open row: consume_grant closes them all, so its
  // version is the chosen slot's current one.
  type Resolution = { v: Version; deactivated: string[]; staleRevisionIds: string[] };
  const IP_COLUMNS = "id, course_version_id, started_at, last_activity_at";
  const resolveVersion = async (candidate: CandidateKind, grantsNow: GrantSnapshot): Promise<Resolution> => {
    let versionId: string = initialVersionId;
    let packageId: string | null = initialPackageId;
    let deactivated: string[] = [];
    let openRevisionRows: SlotAttempt[] = [];
    const packageOfVersion = new Map<string, string>();

    // OTHER-SLOT HANDLING (ADR 0004 step 9, lib/courses/slot-routing.ts): an
    // in-progress attempt on ANOTHER language slot of this course. Own-slot
    // resume wins; an explicit ?lang= goes back to the course page's language
    // switch confirm (nothing abandoned); a preference / single-slot launch
    // continues the other slot's attempt; only an attempt on a DEACTIVATED
    // slot is closed (conditional on status = 'in_progress', tokens expired).
    // Grant retakes are never touched. Skipped on the legacy no-package path.
    if (candidate !== "grant" && packageId) {
      const [{ data: allPkgRows, error: allPkgErr }, { data: courseVerRows, error: courseVerErr }] = await Promise.all([
        supabase.from("course_packages").select("id, is_active").eq("course_id", courseId),
        supabase.from("course_versions").select("id, package_id").eq("course_id", courseId),
      ]);
      if (allPkgErr || courseVerErr) refuse("routing_read_failed");
      for (const r of (courseVerRows ?? []) as Array<{ id: string; package_id: string | null }>) {
        if (r.package_id) packageOfVersion.set(r.id, r.package_id);
      }
      const allVersionIds = [...packageOfVersion.keys()];
      let inProgress: SlotAttempt[] = [];
      if (allVersionIds.length) {
        const readIp = (columns: string) =>
          supabase
            .from("course_attempts")
            .select(columns)
            .eq("user_id", user.id)
            .in("course_version_id", allVersionIds)
            .eq("status", "in_progress");
        let { data: ipRows, error: ipErr } = await readIp(`${IP_COLUMNS}, is_revision`);
        if (ipErr && isMissingColumn(ipErr, "is_revision")) ({ data: ipRows, error: ipErr } = await readIp(IP_COLUMNS));
        if (ipErr) refuse("routing_read_failed");
        inProgress = (ipRows ?? []) as unknown as SlotAttempt[];
      }
      openRevisionRows = inProgress.filter((a) => a.is_revision === true);
      const decision = inProgress.length
        ? decideSlotRouting({
            source: slotSource,
            chosenPackageId: packageId,
            packageOfVersion,
            activePackageIds: new Set(
              ((allPkgRows ?? []) as Array<{ id: string; is_active: boolean }>).filter((p) => p.is_active).map((p) => p.id)
            ),
            inProgress,
            retakeIds: grantsNow.retakeIds,
          })
        : ({ kind: "continue", abandon: [] } as const);

      if (decision.kind === "confirm-switch") {
        // (1) Back to the course page, which opens the existing confirm for
        // this language (a confirmed switch resets the other slot's progress).
        redirect(`/${orgSlug}/courses/${courseId}?switch=${encodeURIComponent(langParam ?? "")}`);
      }
      // (3) is carried out below, only once every launch gate has passed: a
      // launch that is then refused (no version, prerequisite lock, scheduled
      // release) closes nothing.
      deactivated = [...decision.abandon];
      if (decision.kind === "cross-slot") {
        // (2) Grandfather across slots: run the attempt the learner already has.
        packageId = decision.packageId;
        versionId = decision.versionId;
      }
    }

    // GRANDFATHER ROUTING (silent module versioning):
    // If the learner already has an in-progress attempt on ANY version of the
    // chosen package — including a now-retired version that a newer one replaced —
    // resume THAT version so their bookmark/suspend_data stays intact. New
    // learners (no in-progress attempt) get the current version. "Force restart"
    // replaces abandon old in-progress attempts at replace time, so none match
    // here and the learner starts fresh on the new version. No learner-facing
    // choice or notice either way. A revision visit's row never routes
    // (is_revision = false, with the filter dropped on a database without it).
    if (candidate !== "grant" && packageId) {
      const { data: pkgVers, error: pkgVersErr } = await supabase
        .from("course_versions")
        .select("id")
        .eq("package_id", packageId);
      if (pkgVersErr) refuse("routing_read_failed");
      const pkgVerIds = ((pkgVers ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (pkgVerIds.length > 0) {
        const readGrandfather = (withFlagFilter: boolean) => {
          let q = supabase
            .from("course_attempts")
            .select("course_version_id")
            .eq("user_id", user.id)
            .in("course_version_id", pkgVerIds)
            .eq("status", "in_progress");
          if (withFlagFilter) q = q.eq("is_revision", false);
          return q.order("started_at", { ascending: false }).limit(1).maybeSingle();
        };
        let { data: ip, error: gfErr } = await readGrandfather(true);
        if (gfErr && isMissingColumn(gfErr, "is_revision")) ({ data: ip, error: gfErr } = await readGrandfather(false));
        if (gfErr) refuse("routing_read_failed");
        const ipVersion = (ip as { course_version_id?: string } | null)?.course_version_id;
        if (ipVersion) versionId = ipVersion;
      }
    }

    const { data: version } = await supabase
      .from("course_versions")
      .select("id, manifest_type, launch_url, manifest_data, package_id")
      .eq("id", versionId)
      // Bound to this course: a pointer to another course's version redirects
      // and is never written into an attempt.
      .eq("course_id", c.id)
      .maybeSingle();
    if (!version) redirect(`/${orgSlug}/courses/${courseId}`);
    const resolved = version as Version;
    const currentOfChosen = packageId ? (allPackages.find((p) => p.id === packageId)?.current_version_id ?? null) : null;
    const staleRevisionIds = packageId
      ? openRevisionRows
          .filter(
            (a) =>
              packageOfVersion.get(a.course_version_id) === packageId &&
              a.course_version_id !== currentOfChosen &&
              a.course_version_id !== resolved.id
          )
          .map((a) => a.id)
      : [];
    return { v: resolved, deactivated, staleRevisionIds };
  };
  let res = await resolveVersion(ev.candidate, grants);
  let v = res.v;

  // ALDS P4 launch contract (ADR 0006 §C, notes (a)–(c) of 2026-10-19),
  // behind ALDS_P4 (default off). With the flag off nothing below that
  // names `p4` runs and this launch is today's. Staff launches are previews
  // (is_preview, launch_mode 'Browse'); a revision visit's row is 'Review'
  // (ADR 0014 step 3); the served language is the attempt's slot (by the
  // version's package, which also covers a cross-slot resume): the attempt
  // column stores null for the unlabeled legacy slot (as the 0100 backfill
  // does), the LaunchData says "und". Never read by scoring (ADR 0005 D1).
  const p4 = aldsP4Enabled();
  const packageOfServed = (ver: Version) => allPackages.find((p) => p.id === ver.package_id);

  // PREREQ LOCK: if this course is in a learning path the user is assigned
  // to, every earlier step in that path must be completed first — UNLESS
  // the path's sequence_mode is 'random', in which case the prereq lock
  // is intentionally skipped per admin choice. The check itself is gated
  // by the per-path sequence_mode lookup further down (#188).
  const { data: pathStepRows } = await supabase
    .from("learning_path_courses")
    .select("path_id, step_number, release_at")
    .eq("course_id", courseId);
  const stepInPaths = (pathStepRows ?? []) as Array<{
    path_id: string;
    step_number: number;
    release_at: string | null;
  }>;
  if (stepInPaths.length > 0) {
    const pathIds = stepInPaths.map((s) => s.path_id);
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
    const { data: paRows } = await supabase
      .from("learning_path_assignments")
      .select("*")
      .in("path_id", pathIds);
    const paList = (paRows ?? []) as Array<{
      path_id: string;
      assignee_type: "user" | "org" | "team" | "group";
      user_id: string | null;
      team_id: string | null;
      group_id?: string | null;
    }>;
    // Custom Group path assignments (0069) — resolved live when present.
    const myGroupIds = paList.some((a) => a.assignee_type === "group")
      ? await myGroupIdsServer(org.id, user.id)
      : new Set<string>();
    const assignedPathIds = new Set(
      paList
        .filter(
          (a) =>
            (a.assignee_type === "user" && a.user_id === user.id) ||
            a.assignee_type === "org" ||
            (a.assignee_type === "team" &&
              a.team_id &&
              myTeamIds.includes(a.team_id)) ||
            (a.assignee_type === "group" && a.group_id != null && myGroupIds.has(a.group_id))
        )
        .map((a) => a.path_id)
    );
    // Enforce prereqs for paths the learner is ASSIGNED to OR that are
    // org_public — org_public paths grant access without an assignment, so
    // gating only on assignment silently let learners skip strict sequencing on
    // any public path. (#L1)
    const { data: pathMetaRows } = await supabase
      .from("learning_paths")
      .select("id, sequence_mode, visibility")
      .in("id", pathIds);
    const pathMeta = (pathMetaRows ?? []) as Array<{
      id: string;
      sequence_mode: string | null;
      visibility: string | null;
    }>;
    const enforcedPathIds = new Set(
      pathMeta
        .filter((p) => assignedPathIds.has(p.id) || p.visibility === "org_public")
        .map((p) => p.id)
    );
    // SCHEDULED-RELEASE GATE: a step with a future release_at blocks launch
    // while ANY enforced path (assigned or org_public) containing this course
    // is unreleased — regardless of sequence_mode. Admins bypass for QA.
    if (
      !canManage(role) &&
      stepInPaths.some(
        (s) =>
          enforcedPathIds.has(s.path_id) &&
          s.release_at &&
          new Date(s.release_at).getTime() > Date.now()
      )
    ) {
      redirect(`/${orgSlug}/dashboard?upcoming=${courseId}`);
    }
    if (enforcedPathIds.size > 0) {
      // 'random' sequence-mode paths intentionally let learners take steps in
      // any order — only 'strict' paths are prereq-locked.
      const strictPathIds = new Set(
        pathMeta
          .filter(
            (p) =>
              enforcedPathIds.has(p.id) &&
              (p.sequence_mode ?? "strict") === "strict"
          )
          .map((p) => p.id)
      );
      const relevant = stepInPaths.filter((s) => strictPathIds.has(s.path_id));
      const { data: allStepRows } = await supabase
        .from("learning_path_courses")
        .select("path_id, course_id, step_number")
        .in("path_id", Array.from(strictPathIds));
      const allSteps = (allStepRows ?? []) as Array<{
        path_id: string;
        course_id: string;
        step_number: number;
      }>;
      const prereqCourseIds = new Set<string>();
      for (const s of relevant) {
        for (const a of allSteps) {
          if (a.path_id === s.path_id && a.step_number < s.step_number) {
            prereqCourseIds.add(a.course_id);
          }
        }
      }
      if (prereqCourseIds.size > 0) {
        const prereqIds = Array.from(prereqCourseIds);
        const { data: vRows } = await supabase
          .from("course_versions")
          .select("id, course_id")
          .in("course_id", prereqIds);
        const verToCourse = new Map<string, string>(
          ((vRows ?? []) as Array<{ id: string; course_id: string }>).map(
            (vr) => [vr.id, vr.course_id] as [string, string]
          )
        );
        const verIds = Array.from(verToCourse.keys());
        const { data: aRows } = verIds.length
          ? await supabase
              .from("course_attempts")
              .select("course_version_id, completion_status, success_status")
              .eq("user_id", user.id)
              .in("course_version_id", verIds)
          : { data: [] };
        const doneCourseIds = new Set<string>();
        for (const a of (aRows ?? []) as Array<{
          course_version_id: string;
          completion_status: string;
          success_status: string;
        }>) {
          const cid = verToCourse.get(a.course_version_id);
          if (!cid) continue;
          if (
            a.completion_status === "completed" ||
            a.success_status === "passed"
          ) {
            doneCourseIds.add(cid);
          }
        }
        const incomplete = prereqIds.filter((cid) => !doneCourseIds.has(cid));
        if (incomplete.length > 0) {
          redirect(`/${orgSlug}/dashboard?locked=${courseId}`);
        }
      }
    }
  }

  // The closes of a resolution, run only once every launch gate has passed
  // (a launch that is then refused closes nothing), conditional on
  // status = 'in_progress' and the learner's own rows, fail-soft.
  const closeAfterResolution = async (r: Resolution) => {
    if (r.deactivated.length > 0) {
      // (3) The slot was deactivated by an admin: this attempt can never be
      // resumed from the picker again.
      // Abandoning is irreversible: re-check (4) with an error-checked read
      // and close nothing if it cannot be read. A database without
      // attempt_requests (pre-0083) has no grants.
      const { data: grantRows, error: grantErr } = await svcAttempt
        .from("attempt_requests")
        .select("used_attempt_id")
        .in("used_attempt_id", r.deactivated)
        .eq("status", "approved");
      const grantMissing = (grantErr as { code?: string } | null)?.code === "42P01";
      const closable =
        grantErr && !grantMissing
          ? []
          : r.deactivated.filter(
              (id) => !((grantRows ?? []) as Array<{ used_attempt_id: string | null }>).some((g) => g.used_attempt_id === id)
            );
      if (grantErr && !grantMissing) console.warn("[launch] grant re-check failed; nothing closed:", grantErr.message);
      if (closable.length > 0) {
        const { data: abRows, error: abErr } = await svcAttempt
          .from("course_attempts")
          .update({ status: "abandoned" })
          .in("id", closable)
          .eq("user_id", user.id)
          .eq("status", "in_progress")
          .select("id");
        if (abErr) console.warn("[launch] deactivated-slot close failed:", abErr.message);
        const closedIds = ((abRows ?? []) as Array<{ id: string }>).map((row) => row.id);
        const tokErr = await expireLaunchTokens(svcAttempt, closedIds);
        if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
        // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
        await enqueueAbandonedStatements(svcAttempt, closedIds);
      }
    }
    if (r.staleRevisionIds.length > 0) {
      // ADR 0014 step 3 (Routing): a revision visit's row left in progress on
      // a non-current version of the chosen package closes here, so the next
      // revisit opens on the current version (revision rows only; nothing is
      // lost, every revisit re-seeds from the official attempt).
      const { data: stRows, error: stErr } = await svcAttempt
        .from("course_attempts")
        .update({ status: "abandoned" })
        .in("id", r.staleRevisionIds)
        .eq("user_id", user.id)
        .eq("status", "in_progress")
        .eq("is_revision", true)
        .select("id");
      if (stErr && !isMissingColumn(stErr, "is_revision")) console.warn("[launch] stale revision close failed:", stErr.message);
      const staleIds = ((stRows ?? []) as Array<{ id: string }>).map((row) => row.id);
      const tokErr = await expireLaunchTokens(svcAttempt, staleIds);
      if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
      await enqueueAbandonedStatements(svcAttempt, staleIds);
    }
  };
  await closeAfterResolution(res);

  // ?lp=<pathId> threads through from the path detail page so reports
  // can slice attempts by which learning path they were launched from.
  // We trust the param only if it points at a path the user is actually
  // assigned to (or that's org_public) and that contains this course as
  // a step — otherwise NULL so reports stay honest.
  const pathContextId: string | null =
    lpParam && stepInPaths.some((s) => s.path_id === lpParam) ? lpParam : null;

  // The in-progress row on the resolved version: resume by most recent
  // ACTIVITY (not started_at): when historical duplicate attempts exist, the
  // one the learner actually worked in is the one holding their bookmark —
  // resuming the other one is exactly the "lost my place" bug (0062 also
  // makes new duplicates impossible via a partial unique index). The row's
  // own flag decides the kind (is_revision, with the fallback); a failed
  // read refuses.
  type LaunchRowFull = { id: string; cmi_data: CmiData | null; is_revision?: boolean | null; status?: string };
  const ROW_COLUMNS = "id, cmi_data, status";
  // Each read has its own abort signal: Next memoizes identical GET fetches
  // within one render, and I-5 below re-reads after a concurrent request's
  // insert; without it the re-read returned the first "no row" answer.
  const lookupRow = async (versionId: string): Promise<LaunchRowFull | null> => {
    const read = (columns: string) =>
      supabase
        .from("course_attempts")
        .select(columns)
        .eq("course_version_id", versionId)
        .eq("user_id", user.id)
        .eq("status", "in_progress")
        .order("last_activity_at", { ascending: false, nullsFirst: false })
        .order("started_at", { ascending: false })
        .limit(1)
        .abortSignal(new AbortController().signal)
        .maybeSingle();
    let { data: found, error: rowErr } = await read(`${ROW_COLUMNS}, is_revision`);
    if (rowErr && isMissingColumn(rowErr, "is_revision")) ({ data: found, error: rowErr } = await read(ROW_COLUMNS));
    if (rowErr) refuse("row_read_failed");
    return (found ?? null) as unknown as LaunchRowFull | null;
  };

  // Resuming a row the kind rule accepted (lib/attempts/launch-kind.ts
  // rowAction): the cutover rule flags an unflagged row of a revision launch
  // in place first, and only a result of exactly 1 resumes it.
  type Taken = { attemptId: string; cmi: CmiData; isRevision: boolean; flagResult: number | null; action: RowAction };
  const takeRow = async (decision: RowDecision, existing: LaunchRowFull, tagJourney: boolean): Promise<Taken> => {
    if (decision.action === "refuse") refuse(decision.reason);
    if (decision.action === "insert_first" || decision.action === "insert_revision") refuse("row_exists");
    let flag: number | null = null;
    if (decision.action === "flag_then_resume") {
      // Cutover (ADR 0014 step 3): rows opened before 0103, or under a legacy
      // multi-attempt rule. Any error, 0 rows (a retake, completed, or changed
      // under us) or a missing function refuses; the retry decides again.
      const { data: flagged, error: flagErr } = await svcAttempt.rpc("flag_revision_attempt", { p_attempt_id: existing.id });
      if (flagErr) refuse(isSchemaMissing(flagErr) ? "schema_missing" : "flag_failed");
      if (flagged !== 1) refuse("flag_not_applied");
      flag = 1;
    }
    // Resuming an untagged in-progress attempt from the journey: tag it so
    // its completion credits the journey day (and stays XP-exempt).
    if (tagJourney && journeyCtx) {
      const { error: tagErr } = await svcAttempt
        .from("course_attempts")
        .update({
          journey_enrollment_id: journeyCtx.enrollmentId,
          journey_day: journeyCtx.day,
        })
        .eq("id", existing.id)
        .eq("user_id", user.id)
        .eq("organization_id", org.id);
      // Fail-soft as before (the launch goes on); ids only in the log.
      if (tagErr) console.warn(`[launch] journey tag failed on attempt ${existing.id}:`, tagErr.message);
    }
    return {
      attemptId: existing.id,
      cmi: (existing.cmi_data ?? {}) as CmiData,
      isRevision: existing.is_revision === true || flag === 1,
      flagResult: flag,
      action: decision.action,
    };
  };

  let attemptId: string | null = null;
  let cmi: CmiData = {};
  let rowIsRevision = false;
  let rowAct: RowAction = "insert_first";
  let flagResult: number | null = null;
  // The grant consumed on THIS launch (consume_grant answered `opened`).
  let openedGrantId: string | null = null;

  // I-1, the grant path, ONE transaction (ADR 0014 step 3; 0103
  // consume_grant): the grant row is locked, every open row of the learner
  // on the course closed, the fresh unseeded retake inserted and the grant
  // stamped, or nothing at all. There is no fallback to separate writes.
  if (ev.candidate === "grant" && grants.unusedGrant) {
    const grantId = grants.unusedGrant.id;
    const { data: cgData, error: cgErr } = await svcAttempt.rpc("consume_grant", {
      p_grant_id: grantId,
      p_user_id: user.id,
      p_course_id: c.id,
      p_version_id: v.id,
      p_org_id: org.id,
      p_learning_path_id: pathContextId,
      p_journey_enrollment_id: journeyCtx?.enrollmentId ?? null,
      p_journey_day: journeyCtx?.day ?? null,
    });
    // A raised error (a 23505 race, the consistency check, a deadlock) or a
    // missing function refuses, nothing written.
    if (cgErr) refuse(isSchemaMissing(cgErr) ? "schema_missing" : `consume_grant_error_${cgErr.code ?? "unknown"}`);
    const cg = (Array.isArray(cgData) ? cgData[0] : cgData) as
      | { outcome?: string | null; attempt_id?: string | null; abandoned_ids?: string[] | null }
      | null;
    const next = afterConsumeGrant(cg?.outcome);
    if (next === "refuse") refuse(`consume_grant_${String(cg?.outcome ?? "no_answer")}`);
    if (next === "proceed") {
      if (!cg?.attempt_id) refuse("consume_grant_no_attempt");
      const retakeId = cg.attempt_id;
      attemptId = retakeId;
      openedGrantId = grantId;
      const abandonedIds = cg.abandoned_ids ?? [];
      // The tokens of every NON-revision attempt of the learner on the course
      // die now, not only the abandoned ones: a "Try again" pass in
      // attempt #1's still-open tab must not upgrade it after the retake
      // opened. Fail-soft, as every token expiry.
      const tokErr = await expireLaunchTokens(
        svcAttempt,
        tokenExpiryTargets({ attempts: ev.my, abandonedIds, newAttemptId: retakeId })
      );
      if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
      // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
      await enqueueAbandonedStatements(svcAttempt, abandonedIds);
      // The 0100 columns of the retake, only with ALDS_P4 on: one update,
      // skipped on a database without 0100, never refusing (the grant is
      // already spent and the retake open; scoring never reads them).
      if (p4) {
        const { error: p4Err } = await svcAttempt
          .from("course_attempts")
          .update(p4AttemptColumns({ role, revision: false, language: packageOfServed(v)?.language }))
          .eq("id", retakeId)
          .eq("user_id", user.id)
          .eq("organization_id", org.id);
        if (p4Err) {
          if (isAldsSchemaMissing(p4Err)) logAldsSkip("grant_retake_columns", "schema_missing", { attemptId: retakeId });
          else console.warn("[alds] retake columns update failed", { attemptId: retakeId, code: p4Err.code });
        }
      }
    } else {
      // used | stale | retake_live | stands: never an unrequested retake.
      // Re-read the attempts and the grants and run the kind rule again in
      // THIS request, without consuming (never a self-redirect); routing
      // runs in full now (the grant resolution skipped it). The launch gates
      // above do not depend on the version and are not repeated.
      grants = await readGrants();
      ev = await evaluate(grants, false);
      res = await resolveVersion(ev.candidate, grants);
      v = res.v;
      await closeAfterResolution(res);
    }
  }

  if (!attemptId) {
    const limitReached = ev.scoring?.limitReached ?? false;
    // H: a `first` launch first closes any open flagged row on the resolved
    // version (conditional on in_progress and is_revision; nothing is lost,
    // the next revisit re-seeds), then looks up unflagged rows. Fail-soft: a
    // row left open is refused by the kind rule below.
    if (ev.candidate === "first") {
      const { data: flRows, error: flErr } = await svcAttempt
        .from("course_attempts")
        .update({ status: "abandoned" })
        .eq("course_version_id", v.id)
        .eq("user_id", user.id)
        .eq("status", "in_progress")
        .eq("is_revision", true)
        .select("id");
      if (flErr && !isMissingColumn(flErr, "is_revision")) console.warn("[launch] flagged-row close failed:", flErr.message);
      const flIds = ((flRows ?? []) as Array<{ id: string }>).map((row) => row.id);
      if (flIds.length > 0) {
        const tokErr = await expireLaunchTokens(svcAttempt, flIds);
        if (tokErr) console.warn("[launch] token expiry failed:", tokErr.message);
        await enqueueAbandonedStatements(svcAttempt, flIds);
      }
    }

    // I-2: the kind rule at the row.
    const existing = await lookupRow(v.id);
    const decision = rowAction({ candidate: ev.candidate, limitReached, row: existing, retakeIds: grants.retakeIds });
    let taken: Taken | null = null;
    if (existing) {
      taken = await takeRow(decision, existing, true);
    } else if (decision.action === "insert_first" || decision.action === "insert_revision") {
      // I-3, the insert invariant: a new row is official only for a free
      // window slot; every other new row is a revision visit's, and only
      // then is the column named (the journey-column pattern), so a first
      // launch keeps working on a database without 0103.
      const namedIsRevision = decision.action === "insert_revision";
      if (namedIsRevision !== insertIsRevision(limitReached, null)) refuse("kind_mismatch");
      let { data: created, error: insErr } = await svcAttempt
        .from("course_attempts")
        .insert({
          course_version_id: v.id,
          user_id: user.id,
          organization_id: org.id,
          status: "in_progress",
          cmi_data: {},
          learning_path_id: pathContextId,
          // Only name the 0058 columns when there IS journey context (which
          // itself requires 0058) — naming them unconditionally would fail
          // every launch on a database that hasn't run the migration yet.
          ...(journeyCtx
            ? {
                journey_enrollment_id: journeyCtx.enrollmentId,
                journey_day: journeyCtx.day,
              }
            : {}),
          ...(namedIsRevision ? { is_revision: true } : {}),
          // The 0100 columns, only with ALDS_P4 on (ADR 0006 note (c)).
          ...(p4 ? p4AttemptColumns({ role, revision: namedIsRevision, language: packageOfServed(v)?.language }) : {}),
        })
        .select("id")
        .single();
      let namedP4 = p4;
      // I-4: flag on, 0100 absent on this database: retry once without the
      // three 0100 columns (is_revision re-sent when it was named), so a
      // launch never fails for P4. The 0062 23505 fallback below follows
      // either insert as before.
      if (p4 && !created && isAldsSchemaMissing(insErr)) {
        logAldsSkip("launch_insert", "schema_missing", { versionId: v.id });
        namedP4 = false;
        ({ data: created, error: insErr } = await svcAttempt
          .from("course_attempts")
          .insert({
            course_version_id: v.id,
            user_id: user.id,
            organization_id: org.id,
            status: "in_progress",
            cmi_data: {},
            learning_path_id: pathContextId,
            ...(journeyCtx
              ? {
                  journey_enrollment_id: journeyCtx.enrollmentId,
                  journey_day: journeyCtx.day,
                }
              : {}),
            ...(namedIsRevision ? { is_revision: true } : {}),
          })
          .select("id")
          .single());
      }
      // A revision insert failing on a missing schema: 0103 is not on this
      // database. Refuse (logged schema_missing); never an unflagged
      // revision row, never a retry without the column.
      if (!created && revisionInsertRefused(insErr, namedIsRevision, namedP4)) refuse("schema_missing");
      if (created) {
        taken = { attemptId: created.id, cmi: {}, isRevision: namedIsRevision, flagResult: null, action: decision.action };
      } else if (insErr?.code === "23505") {
        // I-5: a concurrent request (double click / router prefetch) created
        // the attempt a moment ago on 0062's one-in-progress index. Re-read
        // it with its flag and apply the kind rule; any disagreement refuses.
        const raced = await lookupRow(v.id);
        if (!raced) refuse("raced_row_missing");
        taken = await takeRow(
          rowAction({ candidate: ev.candidate, limitReached, row: raced, retakeIds: grants.retakeIds }),
          raced,
          false
        );
      }
    } else {
      refuse(decision.reason);
    }
    if (taken) {
      attemptId = taken.attemptId;
      cmi = taken.cmi;
      rowIsRevision = taken.isRevision;
      rowAct = taken.action;
      flagResult = taken.flagResult;
    }
  }
  if (!attemptId) {
    return <div className="p-10 text-red-700">Failed to create attempt.</div>;
  }

  // K: the seed, keyed on the row, on EVERY launch whose resolved row is a
  // revision visit's (ADR 0014 step 3; lib/attempts/launch-kind.ts seedPlan),
  // from the OFFICIAL attempt (scoring.officialAttempt, whatever version or
  // language it is on), never on a first, retake or grant launch. What the
  // learner sees is the official attempt's progress, answers and result.
  // Failures are logged with ids and the launch goes on.
  const seed = seedPlan({ action: rowAct, flagResult, manifestType: v.manifest_type });
  const official = (ev.scoring?.officialAttempt ?? null) as MyAttempt | null;
  if (seed.scorm) {
    // SCORM: the served cmi and the row's cmi_data are rebuilt from the
    // official attempt alone, by an update conditional on the row's flag.
    cmi = buildRevisionCmi(official);
    const { error: seedErr } = await svcAttempt
      .from("course_attempts")
      .update({ cmi_data: cmi })
      .eq("id", attemptId)
      .eq("user_id", user.id)
      .eq("is_revision", true)
      .eq("status", "in_progress");
    if (seedErr) {
      console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official?.id ?? null }));
    }
  }
  if (seed.state && official) {
    // cmi5 / xAPI: the official attempt's State documents overwrite the
    // revision row's, never the two LMS-owned documents (cmi5 §10.1, ADR
    // 0006 note (j)): LMS.LaunchData names the SOURCE attempt (registration,
    // session, launch mode), and LMS.OfficialResult is written below.
    // Unconditional: the flag may be off now and the source's document still
    // stored. The guard is this request's own verdict (seedPlan: the row read,
    // inserted or raced is flagged, or the cutover answered 1). supabase-js
    // returns its errors, so both calls destructure and log theirs (ids
    // only, as the SCORM branch does); the launch goes on either way.
    try {
      const { data: states, error: stateReadErr } = await svcAttempt
        .from("xapi_state")
        .select("state_id, content, content_type")
        .eq("attempt_id", official.id)
        .neq("state_id", LMS_LAUNCH_DATA_STATE_ID)
        .neq("state_id", LMS_OFFICIAL_RESULT_STATE_ID);
      if (stateReadErr) {
        console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official.id, step: "state_read" }));
      }
      const rows = (stateReadErr ? [] : (states ?? [])) as Array<{ state_id: string; content: unknown; content_type: string | null }>;
      if (rows.length > 0) {
        const { error: stateSeedErr } = await svcAttempt
          .from("xapi_state")
          .upsert(rows.map((r) => ({ ...r, attempt_id: attemptId })), { onConflict: "attempt_id,state_id" });
        if (stateSeedErr) {
          console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official.id, step: "state_upsert" }));
        }
      }
    } catch (e) {
      console.warn(JSON.stringify({ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official.id, reason: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (seed.officialResult && ev.scoring) {
    // LMS.OfficialResult (cmi5 and xAPI only): the official
    // attempt's status, integer-percent score and dates, for the revision
    // registration; not P4-gated. Ids, a status, a score and dates only.
    const { error: orErr } = await svcAttempt.from("xapi_state").upsert(
      {
        attempt_id: attemptId,
        state_id: LMS_OFFICIAL_RESULT_STATE_ID,
        content: buildOfficialResult({ scoring: { ...ev.scoring, officialAttempt: official }, writtenAt: new Date().toISOString() }),
        content_type: "application/json",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "attempt_id,state_id" }
    );
    if (orErr) console.warn(JSON.stringify({ event: "official_result_write_failed", attempt_id: attemptId }));
  }

  // Row-driven decisions (ADR 0014 step 3): the launch mode follows the
  // row's flag; staff and data_analyst launches are previews.
  const launch = launchModeFor({ role, revision: rowIsRevision });
  const servedLanguage = servedLanguageFor(packageOfServed(v)?.language);

  // L: the revision visit record (ADR 0014 step 3), written once the launch
  // is certain, only for a flagged row and never for a preview
  // (shouldRecordVisit): through record_revision_visit (its 10 s dedupe), a
  // plain insert when the function fails for another reason than a missing
  // schema (one high rather than lost), a log line when that fails too.
  const recordRevisionVisit = async (visitAttemptId: string): Promise<void> => {
    const visit = {
      p_org: org.id,
      p_user: user.id,
      p_course: c.id,
      p_version: v.id,
      p_attempt: visitAttemptId,
      p_kind: v.manifest_type,
    };
    const { error: visitErr } = await svcAttempt.rpc("record_revision_visit", visit);
    if (!visitErr) return;
    if (isSchemaMissing(visitErr)) {
      console.warn(JSON.stringify({ event: "revision_visit_skipped", reason: "schema_missing", attempt_id: visitAttemptId }));
      return;
    }
    const { error: plainErr } = await svcAttempt.from("revision_visits").insert({
      organization_id: visit.p_org,
      user_id: visit.p_user,
      course_id: visit.p_course,
      course_version_id: visit.p_version,
      attempt_id: visit.p_attempt,
      launch_kind: visit.p_kind,
    });
    if (plainErr) console.warn(JSON.stringify({ event: "revision_visit_failed", attempt_id: visitAttemptId }));
  };

  // ALDS step 0 (P1): every content URL names the ATTEMPT's version, so the
  // iframe runs the package this attempt was opened on (its language, or a
  // retired version it is grandfathered on) — never the course's current
  // one. The attempt above was selected/inserted with course_version_id =
  // v.id, so v.id IS course_attempts.course_version_id.
  const attemptVersionId = v.id;
  const contentBase = `/${orgSlug}/courses/${courseId}/content/v/${attemptVersionId}/`;
  // Exit returns the learner to the context they launched from: the journey
  // (?journey=), the learning path (?lp=, only when this course really is a
  // step of it), the dashboard (?back=dashboard from its cards), otherwise
  // the course page. Fixed targets only — never a caller-supplied URL.
  const { backHref, backLabel } = resolveReturnTarget({
    orgSlug,
    courseId,
    journeyEnrollmentId: journeyParam || null,
    pathId:
      lpParam && stepInPaths.some((s) => s.path_id === lpParam) ? lpParam : null,
    back: backParam || null,
  });

  // ADR 0019 step 8: the bar's Continue goes to the continue address only on a
  // Learning Path launch this course really is a step of (pathContextId), and
  // never on a journey launch. The title stays in the bar unless the version's
  // cached engine stamp says it is a KIVO build, which shows its own title.
  const continueHref =
    pathContextId && !journeyParam
      ? `/${orgSlug}/continue?lp=${encodeURIComponent(pathContextId)}&from=${encodeURIComponent(courseId)}`
      : null;
  const showTitle = !isKivoStamped(v.manifest_data);
  // ADR 0019, note of 2026-11-11: Continue waits until the module's official
  // result is stored. Ready at once for a preview (the roles the continue
  // address moves on without a wait) or when the page's own scoring of the
  // learner's attempts on the course already reads stored, through the
  // continue address's own test (a revision visit, a relaunch after a
  // result). Waiting on a first launch (its new row is not in ev.my, and no
  // official attempt exists yet), on a resumed granted retake (courseStatus
  // reads in_progress), on a pass_required course whose verdict is pending,
  // and on the launch that has just opened a granted retake (openedGrantId):
  // ev was read before consume_grant inserted the retake, so ev.my still
  // reads the earlier result as stored.
  const continueReady =
    continueHref !== null &&
    (launch.isPreview ||
      (openedGrantId === null && ev.scoring !== null && officialResultStored(ev.scoring, ev.my, passRequired)));
  // The status the bar polls while it waits (a learner-owned GET, the caller's session).
  const continueStatusHref =
    continueHref !== null ? `/api/attempts/${encodeURIComponent(attemptId)}/result-stored` : null;

  // Background preload of the NEXT module (journey: next day with a course;
  // learning path: next step). Only its content launch file is warmed — the
  // runtime fetches it after this module is up and the browser is idle, so
  // the following step opens from cache. Fail-soft: no next → nothing.
  const preloadUrls: string[] = [];
  try {
    let nextCourseId: string | null = journeyNextCourseId;
    if (!nextCourseId && lpParam && stepInPaths.some((s) => s.path_id === lpParam)) {
      const cur = stepInPaths.find((s) => s.path_id === lpParam)!.step_number;
      const { data: nextStep } = await supabase
        .from("learning_path_courses")
        .select("course_id")
        .eq("path_id", lpParam)
        .gt("step_number", cur)
        .order("step_number", { ascending: true })
        .limit(1)
        .maybeSingle();
      nextCourseId = (nextStep as { course_id?: string } | null)?.course_id ?? null;
    }
    if (nextCourseId && nextCourseId !== courseId) {
      const { data: nextCourse } = await supabase
        .from("courses")
        .select("id, current_version_id")
        .eq("id", nextCourseId)
        .eq("organization_id", org.id)
        .maybeSingle();
      const nextVersionId = (nextCourse as { current_version_id?: string | null } | null)?.current_version_id;
      if (nextVersionId) {
        const { data: nextVersion } = await supabase
          .from("course_versions")
          .select("launch_url")
          .eq("id", nextVersionId)
          .maybeSingle();
        const launch = (nextVersion as { launch_url?: string } | null)?.launch_url;
        if (launch) {
          preloadUrls.push(
            `/${orgSlug}/courses/${nextCourseId}/content/v/${nextVersionId}/${launch.replace(/^\/+/, "").split("?")[0]}`
          );
        }
      }
    }
  } catch {
    /* preloading is best effort */
  }

  // --- SCORM 1.2 path ---
  if (v.manifest_type === "scorm12") {
    if (rowIsRevision) {
      // ADR 0014 step 3 (SCORM runtime): a revision visit's row runs in
      // review / no-credit, set unconditionally before entry = resume (the
      // SCO may overwrite any key at runtime; the commit route records
      // nothing for this row either way).
      cmi["cmi.core.lesson_mode"] = "review";
      cmi["cmi.core.credit"] = "no-credit";
      cmi["cmi.core.entry"] = "resume";
    }
    if (!cmi["cmi.core.student_id"]) cmi["cmi.core.student_id"] = user.id;
    if (!cmi["cmi.core.student_name"]) {
      cmi["cmi.core.student_name"] = user.email ?? "Learner";
    }
    const launchSrc = contentBase + v.launch_url.replace(/^\/+/, "");
    if (shouldRecordVisit({ isPreview: launch.isPreview, rowIsRevision })) await recordRevisionVisit(attemptId);
    return (
      <ScormRuntime
        attemptId={attemptId}
        initialCmi={cmi}
        iframeSrc={launchSrc}
        courseTitle={c.title}
        backHref={backHref}
        backLabel={backLabel}
        preloadUrls={preloadUrls}
        revision={rowIsRevision}
        showTitle={showTitle}
        continueHref={continueHref}
        continueReady={continueReady}
        continueStatusHref={continueStatusHref}
      />
    );
  }

  // --- cmi5 / standalone xAPI (TinCan) path ---
  // Both mint the same attempt-bound LRS token. cmi5 hands it over through
  // the one-shot `fetch` handshake; a tincan.xml package gets it directly
  // on the launch URL as the standard `auth` parameter. Everything after
  // that (statements, State API resume, progress) is shared.
  const authToken = randomBytes(32).toString("hex");
  const { data: token } = await svcAttempt
    .from("cmi5_launch_tokens")
    .insert({
      auth_token: authToken,
      attempt_id: attemptId,
    })
    .select("fetch_token")
    .single();

  if (!token) {
    return (
      <div className="p-10 text-red-700">Failed to mint launch token.</div>
    );
  }
  if (shouldRecordVisit({ isPreview: launch.isPreview, rowIsRevision })) await recordRevisionVisit(attemptId);

  // xAPI endpoint URL must point at the live host so the SCORM/cmi5
  // player (in the iframe) can POST progress back. The helper handles
  // the build-time-inlining bug (#145, #146) — keep the empty-string
  // fallback so this never regresses to localhost.
  const host = (await originFromRequest()) || "https://localhost:3000";

  const actor = JSON.stringify({
    objectType: "Agent",
    name: user.email ?? "Learner",
    account: {
      homePage: host,
      name: user.id,
    },
  });
  // ADR 0006 step 17: with ALDS_P4 on, a cmi5 launch names the LMS-issued
  // AU id (BLUEPRINT §1.2); launchedActivityIds() accepts it in every
  // deploy and keeps the publisher ids. Flag off, a version without a
  // package, or a tincan package: today's publisher-id chain.
  const lmsAuId =
    p4 && v.manifest_type === "cmi5" && v.package_id ? lmsAuActivityId(v.package_id) : null;
  const activityId =
    lmsAuId ??
    (v.manifest_data?.raw?.auId ??
      v.manifest_data?.raw?.activityId ??
      v.manifest_data?.raw?.courseId ??
      `urn:uuid:${v.id}`);

  const isXapi = v.manifest_type === "xapi";
  const launchParams = isXapi
    ? // TinCan launch (xAPI launch guidelines): endpoint, auth, actor,
      // activity_id, registration. `auth` is the verbatim Authorization
      // header value; Basic <base64(user:token)> is what every TinCan
      // player (Storyline, Captivate, iSpring, KIVO) expects, and
      // authenticateXapi() unwraps it back to the attempt token.
      new URLSearchParams({
        endpoint: `${host}/api/xapi/`,
        auth: `Basic ${Buffer.from(`lms:${authToken}`).toString("base64")}`,
        actor,
        activity_id: activityId,
        // Same attempt ⇒ same registration on relaunch, so saved state
        // (State API) is found again and the session resumes.
        registration: attemptId,
        // Some engines read the cmi5-style name for the activity.
        activityId,
      })
    : new URLSearchParams({
        endpoint: `${host}/api/xapi/`,
        fetch: `${host}/api/xapi/fetch?fetch_token=${token.fetch_token}`,
        actor,
        registration: attemptId,
        activityId,
      });

  const launchPath = v.launch_url.replace(/^\/+/, "");
  const sep = launchPath.includes("?") ? "&" : "?";
  const iframeSrc = `${contentBase}${launchPath}${sep}${launchParams}`;

  // ADR 0006 step 16 (cmi5 §10.1), ALDS_P4 on, cmi5 only: write the
  // LMS-owned LMS.LaunchData document before the runtime renders and record
  // the session. Both fail soft: a failed write is logged with ids and the
  // launch proceeds (a 2.0 engine then runs its flagged fallback,
  // uncertified). The document carries ids and the slot language only. A
  // version without a package (the legacy no-package path) has no package
  // id for the template, so it gets no document; its session is recorded.
  if (p4 && !isXapi) {
    const sessionId = newSessionId();
    if (v.package_id) {
      // alds_manifest is a 0100 column: a separate, fail-soft read (any
      // error, or 0100 absent, leaves the course family out of grouping).
      let courseUlid: string | null = null;
      try {
        const { data: aldsRow, error: aldsErr } = await svcAttempt
          .from("course_versions")
          .select("alds_manifest")
          .eq("id", v.id)
          .maybeSingle();
        if (!aldsErr) {
          const manifest = (aldsRow as { alds_manifest?: unknown } | null)?.alds_manifest as
            | { courseUlid?: unknown }
            | null
            | undefined;
          courseUlid = typeof manifest?.courseUlid === "string" ? manifest.courseUlid : null;
        }
      } catch {
        courseUlid = null;
      }
      // ADR 0006 note (h): a registration's kind never changes between its
      // launches. A relaunch of an in-progress grant retake consumes no
      // grant, so the kind comes from the attempt's own link to its grant,
      // from this launch's strict grant snapshot (ADR 0014 step 3); a
      // revision visit's row stays `retake`.
      const launchData = buildLaunchData({
        attemptId,
        packageId: v.package_id,
        versionId: v.id,
        servedLanguage,
        launchMode: launch.launchMode,
        registrationKind: registrationKindFor({
          consumeGrantId: openedGrantId,
          revision: rowIsRevision,
          attemptIsGrantRetake: grants.retakeIds.has(attemptId),
        }),
        sessionId,
        publisherCourseId: v.manifest_data?.raw?.courseId ?? null,
        courseUlid,
        masteryScore: typeof v.manifest_data?.masteryScore === "number" ? v.manifest_data.masteryScore : null,
        // cmi5 §10.2.6: a URL, not a path (the fixed in-app back target).
        returnURL: `${host}${backHref}`,
      });
      const { error: ldErr } = await writeLaunchData(svcAttempt, attemptId, launchData);
      if (ldErr) console.warn("[alds] LaunchData write failed", { attemptId, code: ldErr.code });
    } else {
      logAldsSkip("launch_data", "no_package", { attemptId, versionId: v.id });
    }
    await recordLearningSession(svcAttempt, {
      sessionId,
      organizationId: org.id,
      attemptId,
      launchKind: "cmi5",
      fetchToken: token.fetch_token,
      activityId,
      launchMode: launch.launchMode,
    });
  }

  return (
    <Cmi5Runtime
      iframeSrc={iframeSrc}
      courseTitle={c.title}
      backHref={backHref}
      backLabel={backLabel}
      preloadUrls={preloadUrls}
      revision={rowIsRevision}
      showTitle={showTitle}
      continueHref={continueHref}
      continueReady={continueReady}
      continueStatusHref={continueStatusHref}
    />
  );
}

/**
 * Where "Exit course" goes. Every target is a fixed in-app path built from
 * validated ids, so a crafted launch URL can never bounce a learner
 * elsewhere.
 */
function resolveReturnTarget({
  orgSlug,
  courseId,
  journeyEnrollmentId,
  pathId,
  back,
}: {
  orgSlug: string;
  courseId: string;
  journeyEnrollmentId: string | null;
  pathId: string | null;
  back: string | null;
}): { backHref: string; backLabel: string } {
  if (journeyEnrollmentId) {
    return {
      backHref: `/${orgSlug}/journey?j=${encodeURIComponent(journeyEnrollmentId)}`,
      backLabel: "Back to journey",
    };
  }
  if (pathId) {
    return {
      backHref: `/${orgSlug}/paths/${encodeURIComponent(pathId)}`,
      backLabel: "Back to path",
    };
  }
  if (back === "dashboard") {
    return { backHref: `/${orgSlug}/dashboard`, backLabel: "Back to dashboard" };
  }
  return { backHref: `/${orgSlug}/courses/${courseId}`, backLabel: "Back to course" };
}
