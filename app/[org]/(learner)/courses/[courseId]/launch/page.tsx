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

type Course = {
  id: string;
  organization_id: string;
  current_version_id: string | null;
  title: string;
  is_active?: boolean;
};

type Version = {
  id: string;
  manifest_type: "scorm12" | "cmi5";
  launch_url: string;
  manifest_data: { raw?: { courseId?: string; auId?: string } };
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
  searchParams: Promise<{ lang?: string; lp?: string; journey?: string; day?: string }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const {
    lang: langParam,
    lp: lpParam,
    journey: journeyParam,
    day: dayParam,
  } = await searchParams;
  const { user, org, role } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select("id, organization_id, current_version_id, title, is_active")
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
  if (journeyParam && dayParam) {
    const dayN = parseInt(dayParam, 10);
    // Rules and curriculum come from the enrollment's PINNED VERSION —
    // a later publish never changes what an in-flight run launches.
    const { data: enrRow } = await supabase
      .from("journey_enrollments")
      .select(
        "id, start_date, status, journey_versions!inner(days_total, count_sundays, days), journey_programs!inner(is_active)"
      )
      .eq("id", journeyParam)
      .eq("user_id", user.id)
      .maybeSingle();
    const enr = enrRow as {
      id: string;
      start_date: string;
      status: string;
      journey_versions:
        | { days_total: number; count_sundays: boolean; days: unknown }
        | Array<{ days_total: number; count_sundays: boolean; days: unknown }>;
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
          courseDays: courseDaysOf(prog.days, prog.days_total),
        });
        if (dayN === state.currentDay && state.todayUnlocked) {
          journeyCtx = { enrollmentId: enr.id, day: dayN };
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

  // ---------------------------------------------------------------
  // Multi-language resolution (Phase 2 + Phase 3 of #158)
  //
  // Priority order:
  //   1. ?lang=xx query param (if it matches an active package on the course)
  //   2. user's saved preference in course_language_preferences
  //   3. if only ONE active package exists, auto-use it
  //   4. otherwise render the picker (early return)
  //   5. legacy fallback to course.current_version_id when no packages
  // ---------------------------------------------------------------
  const { data: pkgRows } = await supabase
    .from("course_packages")
    .select("id, language, display_name, current_version_id, is_active")
    .eq("course_id", courseId)
    .eq("is_active", true);
  const activePackages = (pkgRows ?? []) as PackageRow[];

  let resolvedVersionId: string | null = null;
  let chosenPackageId: string | null = null;

  if (activePackages.length === 0) {
    // Legacy path: no packages yet — fall back to course.current_version_id
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
    }
    if (!chosen) {
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

  // GRANDFATHER ROUTING (silent module versioning):
  // If the learner already has an in-progress attempt on ANY version of the
  // chosen package — including a now-retired version that a newer one replaced —
  // resume THAT version so their bookmark/suspend_data stays intact. New
  // learners (no in-progress attempt) get the current version. "Force restart"
  // replaces abandon old in-progress attempts at replace time, so none match
  // here and the learner starts fresh on the new version. No learner-facing
  // choice or notice either way.
  if (chosenPackageId) {
    const { data: pkgVers } = await supabase
      .from("course_versions")
      .select("id")
      .eq("package_id", chosenPackageId);
    const pkgVerIds = ((pkgVers ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (pkgVerIds.length > 0) {
      const { data: ip } = await supabase
        .from("course_attempts")
        .select("course_version_id")
        .eq("user_id", user.id)
        .in("course_version_id", pkgVerIds)
        .eq("status", "in_progress")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ip?.course_version_id) {
        resolvedVersionId = ip.course_version_id as string;
      }
    }
  }

  const { data: version } = await supabase
    .from("course_versions")
    .select("id, manifest_type, launch_url, manifest_data")
    .eq("id", resolvedVersionId)
    .maybeSingle();
  if (!version) redirect(`/${orgSlug}/courses/${courseId}`);
  const v = version as Version;

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

  // Find or create the attempt. Resume by most recent ACTIVITY (not
  // started_at): when historical duplicate attempts exist, the one the
  // learner actually worked in is the one holding their bookmark — resuming
  // the other one is exactly the "lost my place" bug (0062 also makes new
  // duplicates impossible via a partial unique index).
  let attemptId: string | null = null;
  let cmi: CmiData = {};
  const { data: existing } = await supabase
    .from("course_attempts")
    .select("id, cmi_data")
    .eq("course_version_id", v.id)
    .eq("user_id", user.id)
    .eq("status", "in_progress")
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    attemptId = existing.id;
    cmi = (existing.cmi_data ?? {}) as CmiData;
    // Resuming an untagged in-progress attempt from the journey: tag it so
    // its completion credits the journey day (and stays XP-exempt).
    if (journeyCtx) {
      await supabase
        .from("course_attempts")
        .update({
          journey_enrollment_id: journeyCtx.enrollmentId,
          journey_day: journeyCtx.day,
        })
        .eq("id", existing.id)
        .eq("user_id", user.id);
    }
  } else {
    // ?lp=<pathId> threads through from the path detail page so reports
    // can slice attempts by which learning path they were launched from.
    // We trust the param only if it points at a path the user is actually
    // assigned to (or that's org_public) and that contains this course as
    // a step — otherwise NULL so reports stay honest.
    let pathContextId: string | null = null;
    if (lpParam) {
      const stepMatch = stepInPaths.some((s) => s.path_id === lpParam);
      if (stepMatch) pathContextId = lpParam;
    }
    const { data: created, error: insErr } = await supabase
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
      })
      .select("id")
      .single();
    attemptId = created?.id ?? null;
    // Unique-violation on 0062's one-in-progress index: a concurrent request
    // (double click / router prefetch) created the attempt a moment ago —
    // resume that one instead of failing the launch.
    if (!attemptId && insErr?.code === "23505") {
      const { data: raced } = await supabase
        .from("course_attempts")
        .select("id, cmi_data")
        .eq("course_version_id", v.id)
        .eq("user_id", user.id)
        .eq("status", "in_progress")
        .limit(1)
        .maybeSingle();
      if (raced) {
        attemptId = raced.id;
        cmi = (raced.cmi_data ?? {}) as CmiData;
      }
    }
  }
  if (!attemptId) {
    return <div className="p-10 text-red-700">Failed to create attempt.</div>;
  }

  const contentBase = `/${orgSlug}/courses/${courseId}/content/`;
  // Exit takes the learner back to their dashboard rather than the course
  // detail page; mid-course exits usually mean "I'm done for now", and the
  // dashboard is where they make their next pick.
  const backHref = `/${orgSlug}/dashboard`;

  // --- SCORM 1.2 path ---
  if (v.manifest_type === "scorm12") {
    if (!cmi["cmi.core.student_id"]) cmi["cmi.core.student_id"] = user.id;
    if (!cmi["cmi.core.student_name"]) {
      cmi["cmi.core.student_name"] = user.email ?? "Learner";
    }
    const launchSrc = contentBase + v.launch_url.replace(/^\/+/, "");
    return (
      <ScormRuntime
        attemptId={attemptId}
        initialCmi={cmi}
        iframeSrc={launchSrc}
        courseTitle={c.title}
        backHref={backHref}
      />
    );
  }

  // --- cmi5 path ---
  const svcUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const svc = createServiceClient(svcUrl, svcKey, {
    auth: { persistSession: false },
  });

  const authToken = randomBytes(32).toString("hex");
  const { data: token } = await svc
    .from("cmi5_launch_tokens")
    .insert({
      auth_token: authToken,
      attempt_id: attemptId,
    })
    .select("fetch_token")
    .single();

  if (!token) {
    return (
      <div className="p-10 text-red-700">Failed to mint cmi5 launch token.</div>
    );
  }

  // xAPI endpoint URL must point at the live host so the SCORM/cmi5
  // player (in the iframe) can POST progress back. The helper handles
  // the build-time-inlining bug (#145, #146) — keep the empty-string
  // fallback so this never regresses to localhost.
  const host = (await originFromRequest()) || "https://localhost:3000";

  const launchParams = new URLSearchParams({
    endpoint: `${host}/api/xapi/`,
    fetch: `${host}/api/xapi/fetch?fetch_token=${token.fetch_token}`,
    actor: JSON.stringify({
      objectType: "Agent",
      name: user.email ?? "Learner",
      account: {
        homePage: host,
        name: user.id,
      },
    }),
    registration: attemptId,
    activityId:
      v.manifest_data?.raw?.auId ??
      v.manifest_data?.raw?.courseId ??
      `urn:uuid:${v.id}`,
  });

  const launchPath = v.launch_url.replace(/^\/+/, "");
  const sep = launchPath.includes("?") ? "&" : "?";
  const iframeSrc = `${contentBase}${launchPath}${sep}${launchParams}`;

  return (
    <Cmi5Runtime
      iframeSrc={iframeSrc}
      courseTitle={c.title}
      backHref={backHref}
    />
  );
}
