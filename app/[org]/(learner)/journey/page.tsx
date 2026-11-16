import Link from "next/link";
import {
  Check,
  Eye,
  Globe,
  Hourglass,
  Lock,
  PauseCircle,
  PlayCircle,
  Swords,
  Target,
} from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canViewReports } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { JourneyIcon } from "@/components/ui/journey-icon";
import {
  computeJourneyState,
  courseDaysOf,
  creditCoursesFor,
  creditedDaysFor,
  dateOfDay,
  effectiveJourneyCopy,
  effectiveMilestones,
  journeyStreak,
  parseVersionDays,
  todayStr,
  DEFAULT_JOURNEY_TZ,
  type Milestone,
} from "@/lib/journey/journey";
import { readJourneyCredits } from "@/lib/journey/credits-read";
import { readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import { languageSwitchLaunchUrl, SWITCH_CHOOSE } from "@/lib/courses/slot-routing";

export const dynamic = "force-dynamic";

/** The pinned version's columns on every database; `day_ids` (0107) is read beside them with the fallback. */
const VERSION_COLUMNS =
  "id, name, icon, days_total, count_sundays, milestones, completion_title, days, unlock_mode";
type VersionRow = {
  id: string;
  name: string;
  icon: string;
  days_total: number;
  count_sundays: boolean;
  milestones: unknown;
  completion_title: string;
  days: unknown;
  unlock_mode?: string | null;
  /** 0107: {"<day number>": "<day id>"}; undefined on a database without the column. */
  day_ids?: unknown;
};

/**
 * The learner's Yoddha Journey home: DAY X/N, today's mission, the milestone
 * path and the completion celebration. EVERYTHING displayed — name, icon,
 * day count, curriculum, milestones, every string — comes from the
 * enrollment's PINNED PUBLISHED VERSION (or the program's editable copy),
 * so admins can reshape the journey without code and without disturbing
 * runs already in flight. All reads are RLS-scoped to the caller.
 */
export default async function JourneyPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ locked?: string; j?: string }>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  const { user, org, role } = await requireOrgAccess(orgSlug);
  // ADR 0024 step 23 ("Buttons"): each day offers the report-viewing roles a
  // Preview of its module (DayPreview). It opens the course outside the
  // journey (no ?journey= or &day=), so it is never a journey attempt.
  const canPreview = canViewReports(role);
  const supabase = await createClient();

  // ALL the learner's journeys (multi-journey, 0063) with their programs
  // joined via `*` (deploy-safe: pre-0063 columns simply come back
  // undefined). Program copy/name/etc are LIVE; rules are version-pinned.
  type LiveProgram = {
    priority?: number;
    is_active?: boolean;
    name?: string;
    icon?: string;
    milestones?: unknown;
    completion_title?: string;
    copy?: unknown;
    is_mandatory?: boolean;
    deadline_days?: number | null;
  };
  type EnrRow = {
    id: string;
    program_id: string;
    version_id: string;
    start_date: string;
    status: "active" | "completed";
    completed_at: string | null;
    created_at: string;
    journey_programs: LiveProgram | LiveProgram[];
  };
  const { data: enrRows } = await supabase
    .from("journey_enrollments")
    .select(
      "id, program_id, version_id, start_date, status, completed_at, created_at, journey_programs!inner(*)"
    )
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .in("status", ["active", "completed"]);
  const all = ((enrRows ?? []) as EnrRow[]).map((e) => ({
    ...e,
    prog: (Array.isArray(e.journey_programs)
      ? e.journey_programs[0]
      : e.journey_programs) as LiveProgram,
  }));

  // Selection: explicit ?j= wins; else the highest-priority RUNNING journey
  // (rank 1 first); else a paused one; else the most recent completed.
  const byPriority = (a: (typeof all)[number], b: (typeof all)[number]) =>
    (a.prog.priority ?? 100) - (b.prog.priority ?? 100) ||
    (a.created_at < b.created_at ? 1 : -1);
  const running = all
    .filter((e) => e.status === "active" && e.prog.is_active !== false)
    .sort(byPriority);
  const pausedOnly = all
    .filter((e) => e.status === "active" && e.prog.is_active === false)
    .sort(byPriority);
  const completedOnes = all
    .filter((e) => e.status === "completed")
    .sort((a, b) => ((a.completed_at ?? "") < (b.completed_at ?? "") ? 1 : -1));
  const enrollment =
    all.find((e) => e.id === sp.j) ??
    running[0] ??
    pausedOnly[0] ??
    completedOnes[0];

  const liveProg = enrollment?.prog ?? null;
  const copy = effectiveJourneyCopy(liveProg?.copy);
  const programActive = liveProg?.is_active !== false;

  // Journey switcher (only when the learner holds more than one).
  const switchable = [...running, ...pausedOnly, ...completedOnes];
  const journeySwitcher =
    switchable.length > 1 ? (
      <div className="flex flex-wrap items-center gap-2">
        {switchable.map((e) => (
          <Link
            key={e.id}
            href={`/${orgSlug}/journey?j=${e.id}`}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
              e.id === enrollment?.id
                ? "bg-indigo-600 text-white border-indigo-600"
                : "border-line hover:border-ink"
            }`}
          >
            <JourneyIcon icon={e.prog.icon ?? "🏹"} /> {e.prog.name ?? "Journey"}
            {e.status === "completed" ? " ✓" : ""}
          </Link>
        ))}
      </div>
    ) : null;

  if (!enrollment) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <Swords className="w-10 h-10 mx-auto text-muted opacity-50" />
        <h1 className="mt-4 text-2xl font-semibold">{copy.empty_title}</h1>
        <p className="text-muted text-sm mt-2 max-w-md mx-auto">{copy.empty_body}</p>
      </div>
    );
  }

  // The learner's credits by day id (ADR 0024 step 45), through the one
  // reader, which falls back to the day number on a database without 0107.
  // The pinned version is read with its day_ids (0107) for the launch links
  // (step 22: a link made by the app carries the day id), through the
  // narrower-select fallback: on a database without the column it is read
  // without it, and every link carries the day's number, which the launch
  // resolves through the pinned version.
  const [{ data: verRow }, credits, { data: gsRow }] =
    await Promise.all([
      readWithOptionalColumn<VersionRow>(
        "day_ids",
        (columns) =>
          supabase
            .from("journey_versions")
            .select(columns)
            .eq("id", enrollment.version_id)
            .maybeSingle(),
        VERSION_COLUMNS
      ),
      readJourneyCredits(supabase, [{ id: enrollment.id, version_id: enrollment.version_id }]),
      supabase
        .from("gamification_settings")
        .select("timezone")
        .eq("organization_id", org.id)
        .maybeSingle(),
    ]);

  const version = verRow;
  if (!version) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 text-muted text-sm">
        This journey version is no longer available.
      </div>
    );
  }
  // A failed credit read is never "no missions done": the page says so and
  // shows no day as open or locked on a guess.
  if (!credits.ok) {
    console.warn(JSON.stringify({ event: "journey_credits_unreadable", where: "journey_page", code: credits.error?.code ?? null }));
    return (
      <div className="max-w-2xl mx-auto text-center py-16 text-muted text-sm">
        Your journey progress could not be loaded. Refresh the page to try again.
      </div>
    );
  }

  // COSMETIC fields (name, icon, milestones, completion title — nothing that
  // moves a learner's progress) come LIVE from the program: an admin rename
  // or milestone tweak reaches every learner instantly, no republish and no
  // effect on their run. STRUCTURE (days, days_total, count_sundays) stays
  // pinned to the enrollment's published version.
  if (liveProg) {
    version.name = liveProg.name ?? version.name;
    version.icon = liveProg.icon ?? version.icon;
    version.completion_title = liveProg.completion_title ?? version.completion_title;
    version.milestones = liveProg.milestones; // null = org reset to defaults
  }

  // Each entry carries its day id when the version has day_ids (0107).
  const dayByNumber = parseVersionDays(version.days, version.day_ids);
  // A launch link's `day`: the day's id (step 22), or its number on a
  // database without day_ids, which the launch resolves through the pinned
  // version (an old link's number keeps working, P2-6 item 1).
  const dayParam = (d: number): string => dayByNumber.get(d)?.dayId ?? String(d);
  const courseDays = courseDaysOf(version.days, version.days_total);
  const courseDaySet = new Set(courseDays);
  const progress = credits.rowsOf(enrollment.id);
  const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
  const today = todayStr(tz);

  // Each day is marked done by its own credit, never by position: the
  // numbers, in the pinned version, of the days whose id holds a credit.
  const creditedDays = creditedDaysFor(
    { days: version.days, days_total: version.days_total, day_ids: credits.dayIdsOf(enrollment.version_id) },
    progress
  );
  // The course on each credited day's credit row, by the same matching: a
  // credited day's review opens that course, the one the learner completed,
  // even after a publish swapped the day's course (ADR 0024 step 22, section
  // 95's row "A day's course swapped"); the day's new course is never
  // offered on a credited day. Null when that course was deleted: the day
  // shows as done with nothing to review.
  const creditCourse = creditCoursesFor(
    { days: version.days, days_total: version.days_total, day_ids: credits.dayIdsOf(enrollment.version_id) },
    progress
  );
  const unlockMode = version.unlock_mode === "progress" ? "progress" : "calendar";
  const state = computeJourneyState({
    startDate: enrollment.start_date,
    today,
    creditedDays,
    daysTotal: version.days_total,
    countSundays: version.count_sundays === true,
    unlockMode,
    courseDays,
  });
  const milestones = effectiveMilestones(version.milestones, version.days_total);
  const doneDays = new Set(creditedDays);
  // The streak reads the credits' dates (activity on a day), not a count.
  const streak = journeyStreak(
    progress
      .filter((p) => p.completed_at)
      .map((p) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(p.completed_at as string))
      ),
    today,
    version.count_sundays === true
  );

  // ---- Completed: the unlock celebration ----
  if (enrollment.status === "completed") {
    const final = milestones[milestones.length - 1];
    // A completed enrolment reviews each credited day on the course on its
    // credit row (ADR 0024 step 22's row for a completed E; course-access
    // grants the same course): the pinned version's mission days that hold
    // a credit whose course still exists, each with that course. A day
    // without a credit has nothing to review, and a completed enrolment
    // opens no new official attempt. An inactive program closes the review
    // too (the owner's O5 answer), so the list is not offered then. Titles
    // are batched in one query.
    const missionDays = programActive
      ? [...dayByNumber.values()]
          .flatMap((d) => {
            const reviewCourse = creditCourse.get(d.day);
            return d.course_id && reviewCourse ? [{ ...d, reviewCourse }] : [];
          })
          .sort((a, b) => a.day - b.day)
      : [];
    const titleOf = new Map<string, string>();
    if (missionDays.length > 0) {
      const { data: courseRows } = await supabase
        .from("courses")
        .select("id, title")
        .in("id", [...new Set(missionDays.map((d) => d.reviewCourse))]);
      for (const c of (courseRows ?? []) as Array<{ id: string; title: string }>) titleOf.set(c.id, c.title);
    }
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        {journeySwitcher}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-amber-400 via-orange-500 to-rose-600 text-white text-center px-6 py-14 shadow-lg">
          <div className="text-6xl mb-3" aria-hidden>
            {final?.icon ?? "👑"}
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight">
            🎉 {version.completion_title.toUpperCase()} UNLOCKED
          </h1>
          <p className="mt-3 text-lg font-medium opacity-95">
            {final?.message || copy.completion_line}
          </p>
          <p className="mt-1 text-sm opacity-80">
            Completed on{" "}
            {enrollment.completed_at
              ? new Date(enrollment.completed_at).toLocaleDateString("en-IN", {
                  day: "numeric", month: "long", year: "numeric",
                })
              : "your final mission day"}
            . The {version.completion_title} badge is on your profile — permanently.
          </p>
        </section>
        <MilestonePath milestones={milestones} completed={version.days_total} />

        {/* Alumni revision: each credited day's module stays open for
            review while the program is active. */}
        {missionDays.length > 0 && (
          <section className="bg-paper border border-line rounded-2xl p-5">
            <h3 className="text-sm font-semibold">📚 Revisit your missions</h3>
            <p className="text-xs text-muted mt-0.5 mb-3">
              Your {version.days_total}-day curriculum stays open — revise any
              module, any time.
            </p>
            <div className="grid sm:grid-cols-2 gap-2">
              {missionDays.map((d) => {
                const reviewCourse = d.reviewCourse;
                return (
                  <div key={d.day} className="flex items-center gap-1.5">
                    <Link
                      // ?journey=E&day=<day id> (step 22): the launch admits
                      // it as the review of the course on the day's credit
                      // row, a revision visit that never touches progress or
                      // XP, and "Exit course" comes back here.
                      href={`/${orgSlug}/courses/${reviewCourse}/launch?journey=${enrollment.id}&day=${dayParam(d.day)}`}
                      className="flex flex-1 min-w-0 items-center gap-2 px-3 py-2 border border-line rounded-lg text-sm hover:border-indigo-400 hover:bg-indigo-50/40"
                    >
                      <span className="text-[11px] font-bold text-indigo-700 tabular-nums shrink-0 w-14">
                        Day {d.day}
                      </span>
                      <span className="min-w-0 line-clamp-2">
                        {/* The day's mission title names the day's own course; a
                            swapped day shows the course the learner completed. */}
                        {(reviewCourse === d.course_id ? d.mission_title : null) ??
                          titleOf.get(reviewCourse) ??
                          "Module"}
                      </span>
                    </Link>
                    <DayPreview canPreview={canPreview} orgSlug={orgSlug} courseId={reviewCourse} day={d.day} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="text-center flex items-center justify-center gap-3 flex-wrap">
          <Link
            href={`/${orgSlug}/journey/certificate`}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-semibold shadow-sm"
          >
            🎓 View your certificate
          </Link>
          <Link
            href={`/${orgSlug}/dashboard`}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90"
          >
            Continue to {org.name} →
          </Link>
        </div>
      </div>
    );
  }

  // ---- Paused by the admin ----
  if (!programActive) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        {journeySwitcher && <div className="mb-6 flex justify-center">{journeySwitcher}</div>}
        <PauseCircle className="w-10 h-10 mx-auto text-muted opacity-60" />
        <h1 className="mt-4 text-2xl font-semibold">{copy.paused_title}</h1>
        <p className="text-muted text-sm mt-2 max-w-md mx-auto">{copy.paused_body}</p>
        <p className="text-xs text-muted mt-4 tabular-nums">
          Your place is saved at Day {state.currentDay} / {version.days_total}.
        </p>
      </div>
    );
  }

  // ---- Active journey ----
  const mission = dayByNumber.get(state.currentDay);
  // "Continue" instead of "Start" when the learner already began today's
  // mission (tagged in-progress attempt) — coming back mid-module resumes
  // from their bookmark, and the button should say so.
  let missionInProgress = false;
  // ADR 0024 P2-9 (review F2): the course of the day's open attempt, read
  // with it. A publish that swapped the day's course after the learner
  // started it leaves that attempt open on the started course (0107's
  // re-pin keeps it), and the launch of the day goes on into that course,
  // so "Change language" names it and counts its languages. Picked as
  // launch_context picks the day's open attempt: the mission's course
  // first, else the oldest.
  let missionStartedCourseId: string | null = null;
  if (mission?.course_id && state.todayUnlocked) {
    const { data: ipRows } = await supabase
      .from("course_attempts")
      .select("id, course_versions(course_id)")
      .eq("journey_enrollment_id", enrollment.id)
      .eq("journey_day", state.currentDay)
      .eq("status", "in_progress")
      .order("started_at", { ascending: true })
      .limit(10);
    // A to-one embed: an object at run time (the client's types read a list).
    type Started = { course_id: string | null } | Array<{ course_id: string | null }> | null;
    const open = (ipRows ?? []) as unknown as Array<{ id: string; course_versions: Started }>;
    missionInProgress = open.length > 0;
    const courseOf = (v: Started) => (Array.isArray(v) ? v[0]?.course_id : v?.course_id) ?? null;
    const started = open.map((r) => courseOf(r.course_versions)).filter((id): id is string => !!id);
    missionStartedCourseId = started.find((id) => id === mission.course_id) ?? started[0] ?? null;
  }
  // ADR 0024 P2-9 (step 27 (c)): today's mission whose course has two or
  // more active languages offers "Change language", which opens the launch's
  // own picker in this day's context (the course page's menu switches the
  // Individual course only). A day whose open attempt is on another course
  // (the day's course swapped after the learner started it, review F2) shows
  // no link: the switch would close that attempt and the day would not open a
  // new one there, so the route refuses every other language (review F1).
  // One count of the mission course's active packages, only when the mission
  // can be launched; display only, so a failed read shows no link.
  const swappedDay = missionStartedCourseId !== null && missionStartedCourseId !== mission?.course_id;
  const switchCourseId = swappedDay ? null : (mission?.course_id ?? null);
  let missionMultiLanguage = false;
  if (switchCourseId && state.todayUnlocked) {
    const { count, error: pkgErr } = await supabase
      .from("course_packages")
      .select("id", { count: "exact", head: true })
      .eq("course_id", switchCourseId)
      .eq("is_active", true);
    if (pkgErr) console.warn(JSON.stringify({ event: "journey_languages_unreadable", enrollment_id: enrollment.id, code: pkgErr.code ?? null }));
    missionMultiLanguage = !pkgErr && (count ?? 0) >= 2;
  }
  const achieved = milestones.filter((m) => state.completedCount >= m.day);
  const latestAchieved = achieved[achieved.length - 1];
  const nextMilestone = milestones.find((m) => state.completedCount < m.day);
  const notStarted = state.allowedDay === 0;

  // Weekly roadmap: the learner's current 7-day window, as a simple list
  // (the full path lives in the collapsible "all days" grid below it).
  const week = Math.max(1, Math.ceil(state.currentDay / 7));
  const weekStart = (week - 1) * 7 + 1;
  const weekEnd = Math.min(week * 7, version.days_total);
  const weekDayNums = Array.from(
    { length: weekEnd - weekStart + 1 },
    (_, i) => weekStart + i
  );
  // The days' own courses, and each credited day's credit-row course (the
  // one a done day shows and reviews).
  const weekCourseIds = [
    ...new Set(
      weekDayNums
        .flatMap((d) => [dayByNumber.get(d)?.course_id, creditCourse.get(d)])
        .filter((id): id is string => !!id)
    ),
  ];
  const weekTitles = new Map<string, string>();
  if (weekCourseIds.length > 0) {
    const { data: wcRows } = await supabase
      .from("courses")
      .select("id, title")
      .in("id", weekCourseIds);
    for (const c of (wcRows ?? []) as Array<{ id: string; title: string }>) {
      weekTitles.set(c.id, c.title);
    }
  }
  const titleForDay = (d: number): string => {
    const entry = dayByNumber.get(d);
    // A credited day shows the course the learner completed (step 22): after
    // a publish swapped the day's course, the day's mission title names the
    // new course, so the credit row's course title is shown instead.
    const credited = creditCourse.get(d);
    if (credited && credited !== entry?.course_id) {
      return weekTitles.get(credited) ?? `Day ${d} mission`;
    }
    return (
      entry?.mission_title ??
      (entry?.course_id ? weekTitles.get(entry.course_id) : undefined) ??
      `Day ${d} mission`
    );
  };
  const nextCourseDayAfterCurrent =
    courseDays[courseDays.indexOf(state.currentDay) + 1];

  // Deadline (0065, live from the program): counted like the drip.
  const deadlineDate =
    typeof liveProg?.deadline_days === "number" && liveProg.deadline_days > 0
      ? dateOfDay(
          enrollment.start_date,
          liveProg.deadline_days,
          version.count_sundays === true
        )
      : null;
  const deadlineOverdue = deadlineDate !== null && today > deadlineDate;
  const deadlineLabel = deadlineDate
    ? new Date(`${deadlineDate}T00:00:00`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {journeySwitcher}
      {sp.locked && (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{copy.locked_message}</span>
        </div>
      )}

      {/* Identity + streak */}
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-700 font-bold">
            {version.days_total}-day journey
          </p>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight break-words">
            <JourneyIcon icon={version.icon} /> {version.name}
          </h1>
        </div>
        {streak > 0 && (
          <span
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-amber-100 text-amber-900 text-sm font-bold shrink-0 tabular-nums"
            title="Daily learning streak"
          >
            🔥 {streak} day{streak === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {/* Progress card */}
      <section className="bg-paper border border-line rounded-2xl p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold tabular-nums">
            Day {state.currentDay} of {version.days_total}
          </h2>
          <span className="text-sm font-semibold text-indigo-700 tabular-nums">
            {state.pct}% complete
          </span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-canvas border border-line overflow-hidden">
          <div
            className="h-full bg-indigo-600 rounded-full transition-all"
            style={{ width: `${Math.max(state.pct, 2)}%` }}
          />
        </div>
        <div className="mt-4 grid grid-cols-3 divide-x divide-line text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted font-bold">
              Missions
            </p>
            <p className="mt-0.5 text-sm font-bold tabular-nums">
              {state.completedCount}/{courseDays.length}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted font-bold">
              Today&apos;s goal
            </p>
            <p
              className={`mt-0.5 text-sm font-bold ${
                state.todayUnlocked
                  ? "text-amber-700"
                  : notStarted
                    ? "text-muted"
                    : "text-emerald-700"
              }`}
            >
              {state.finished
                ? "Journey done"
                : notStarted
                  ? "Starts soon"
                  : state.todayUnlocked
                    ? state.pendingDays > 1
                      ? `${state.pendingDays} missions`
                      : "1 mission"
                    : "Done for today"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted font-bold">
              Next badge
            </p>
            <p className="mt-0.5 text-sm font-bold tabular-nums">
              {nextMilestone
                ? `Day ${nextMilestone.day} ${nextMilestone.icon}`
                : latestAchieved
                  ? `${latestAchieved.icon} earned`
                  : "—"}
            </p>
          </div>
        </div>
        {deadlineLabel && !state.finished && (
          <p
            className={`mt-3 text-center text-xs font-medium ${
              deadlineOverdue ? "text-red-700" : "text-muted"
            }`}
          >
            {deadlineOverdue
              ? `⚠️ Deadline passed (${deadlineLabel}) — catch up now`
              : `⏳ Complete by ${deadlineLabel}`}
          </p>
        )}
        {latestAchieved && (
          <p className="mt-3 text-center text-xs text-indigo-700 font-medium">
            {latestAchieved.icon} {latestAchieved.name}
          </p>
        )}
      </section>

      {/* Today's mission */}
      <section className="border-2 border-indigo-200 bg-gradient-to-b from-indigo-50/70 to-paper rounded-2xl p-6 text-center shadow-sm">
        <p className="text-[11px] uppercase tracking-[0.2em] font-bold text-indigo-700 inline-flex items-center gap-1.5">
          <Target className="w-4 h-4" /> {copy.mission_label}
        </p>
        {notStarted ? (
          <>
            <h2 className="mt-2 text-2xl font-semibold">{copy.not_started_title}</h2>
            <p className="text-muted text-sm mt-1">{copy.not_started_body}</p>
          </>
        ) : mission?.course_id ? (
          <>
            <h2 className="mt-2 text-2xl font-semibold">
              <MissionTitle courseId={mission.course_id} override={mission.mission_title} />
            </h2>
            <p className="text-muted text-sm mt-1">{copy.mission_subtitle}</p>
            {state.todayUnlocked ? (
              <>
                <Link
                  href={`/${orgSlug}/courses/${mission.course_id}/launch?journey=${enrollment.id}&day=${dayParam(state.currentDay)}`}
                  className="mt-4 w-full sm:max-w-md mx-auto flex items-center justify-center gap-2 px-6 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-semibold shadow-sm"
                >
                  <PlayCircle className="w-5 h-5" />{" "}
                  {missionInProgress ? copy.cta_resume : copy.cta_start} →
                </Link>
                {missionMultiLanguage && switchCourseId && (
                  <Link
                    href={languageSwitchLaunchUrl({
                      orgSlug,
                      courseId: switchCourseId,
                      context: { kind: "journey", enrollmentId: enrollment.id, dayId: dayParam(state.currentDay) },
                      switchTo: SWITCH_CHOOSE,
                    })}
                    data-testid="mission-change-language"
                    className="mt-2 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-muted hover:text-ink"
                  >
                    <Globe className="w-3.5 h-3.5" /> Change language
                  </Link>
                )}
                {state.pendingDays > 1 && (
                  <p className="mt-2 text-xs text-amber-700">
                    You&apos;re {state.behindDays} day{state.behindDays === 1 ? "" : "s"} behind —
                    missions unlock one after another as you complete them.
                  </p>
                )}
              </>
            ) : (
              <p className="mt-4 inline-flex items-center gap-2 text-sm text-muted">
                <Hourglass className="w-4 h-4" />
                {copy.on_track_note}
              </p>
            )}
          </>
        ) : (
          <>
            <h2 className="mt-2 text-2xl font-semibold">{copy.preparing_title}</h2>
            <p className="text-muted text-sm mt-1">{copy.preparing_body}</p>
          </>
        )}
      </section>

      {/* Weekly roadmap — the current 7-day window as a simple list */}
      <section className="bg-paper border border-line rounded-2xl overflow-hidden">
        <div className="flex items-baseline justify-between px-5 pt-4 pb-2">
          <h3 className="text-sm font-semibold">Week {week} roadmap</h3>
          <span className="text-[11px] text-muted">1 mission per day</span>
        </div>
        <div className="divide-y divide-line border-t border-line">
          {weekDayNums.map((d) => {
            const entry = dayByNumber.get(d);
            const rest = !courseDaySet.has(d);
            const done = doneDays.has(d);
            const isCurrent = d === state.currentDay && !state.finished;
            if (rest) {
              return (
                <div key={d} className="flex items-center gap-3 px-5 py-2.5 text-muted/70">
                  <span className="h-7 w-7 rounded-full bg-canvas border border-line flex items-center justify-center text-[11px]" aria-hidden>
                    ·
                  </span>
                  <span className="text-xs">Day {d} — rest day</span>
                </div>
              );
            }
            if (done && entry?.course_id) {
              // The review opens the course on the day's credit row (step
              // 22), never the day's current course after a swap; a credit
              // whose course was deleted shows the day as done, no link.
              const reviewCourse = creditCourse.get(d) ?? null;
              const doneBody = (
                <>
                  <span className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0" aria-hidden>
                    <Check className="w-4 h-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium line-clamp-2">
                      Day {d}: {titleForDay(d)}
                    </span>
                    <span className="block text-xs text-emerald-700">Completed</span>
                  </span>
                </>
              );
              return (
                <div key={d} className="flex items-center hover:bg-canvas transition">
                  {reviewCourse ? (
                    <Link
                      href={`/${orgSlug}/courses/${reviewCourse}/launch?journey=${enrollment.id}&day=${dayParam(d)}`}
                      className="flex flex-1 min-w-0 items-center gap-3 px-5 py-3"
                      aria-label={`Revise day ${d}`}
                    >
                      {doneBody}
                      <span className="text-xs font-medium text-indigo-700 shrink-0">
                        Revise
                      </span>
                    </Link>
                  ) : (
                    <div className="flex flex-1 min-w-0 items-center gap-3 px-5 py-3">{doneBody}</div>
                  )}
                  <DayPreview canPreview={canPreview} orgSlug={orgSlug} courseId={reviewCourse ?? entry.course_id} day={d} className="mr-5" />
                </div>
              );
            }
            if (isCurrent) {
              return (
                <div key={d} className="flex items-center gap-3 px-5 py-3 bg-indigo-50/60 border-l-4 border-indigo-500 -ml-px">
                  <span className="h-7 w-7 rounded-full bg-amber-400 text-amber-950 flex items-center justify-center shrink-0" aria-hidden>
                    <PlayCircle className="w-4 h-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold line-clamp-2">
                      Day {d}: {titleForDay(d)}
                    </span>
                    <span className="block text-xs text-amber-700 font-medium">
                      {state.todayUnlocked
                        ? missionInProgress
                          ? "In progress — pick up where you left off"
                          : "Ready to start"
                        : notStarted
                          ? "Unlocks on your start date"
                          : "Unlocks tomorrow"}
                    </span>
                  </span>
                  {state.todayUnlocked && entry?.course_id && (
                    <Link
                      href={`/${orgSlug}/courses/${entry.course_id}/launch?journey=${enrollment.id}&day=${dayParam(d)}`}
                      className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold shrink-0"
                    >
                      {missionInProgress ? "Continue" : "Start"}
                    </Link>
                  )}
                  {entry?.course_id && (
                    <DayPreview canPreview={canPreview} orgSlug={orgSlug} courseId={entry.course_id} day={d} />
                  )}
                </div>
              );
            }
            return (
              <div key={d} className="flex items-center gap-3 px-5 py-3 text-muted">
                <span className="h-7 w-7 rounded-full bg-canvas border border-line flex items-center justify-center text-[11px] font-bold shrink-0" aria-hidden>
                  {d}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm line-clamp-2">
                    Day {d}: {titleForDay(d)}
                  </span>
                  <span className="block text-xs">
                    {d === nextCourseDayAfterCurrent ? "Up next" : `Day ${d} mission`}
                  </span>
                </span>
                {entry?.course_id && (
                  <DayPreview canPreview={canPreview} orgSlug={orgSlug} courseId={entry.course_id} day={d} />
                )}
                <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden />
              </div>
            );
          })}
          {nextMilestone && (
            <div className="flex items-center gap-3 px-5 py-3 bg-canvas/60">
              <span className="h-7 w-7 rounded-full bg-ink text-canvas flex items-center justify-center text-sm shrink-0" aria-hidden>
                {nextMilestone.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold line-clamp-2">
                  Day {nextMilestone.day}: {nextMilestone.name}
                </span>
                {nextMilestone.message && (
                  <span className="block text-xs text-indigo-700 line-clamp-2">
                    {nextMilestone.message}
                  </span>
                )}
              </span>
              <span className="text-xs text-muted shrink-0 tabular-nums">
                {nextMilestone.day - state.completedCount} mission
                {nextMilestone.day - state.completedCount === 1 ? "" : "s"} away
              </span>
            </div>
          )}
        </div>

        {/* Full path, collapsed by default — every completed day is a
            revise link; zero JS (native <details>). */}
        <details className="border-t border-line">
          <summary className="px-5 py-2.5 text-xs font-medium text-indigo-700 cursor-pointer hover:bg-canvas">
            View all {version.days_total} days
          </summary>
          <div className="px-5 pb-4">
            <div className="grid grid-cols-10 sm:grid-cols-[repeat(15,minmax(0,1fr))] gap-1.5">
          {Array.from({ length: version.days_total }, (_, i) => i + 1).map((d) => {
            const done = doneDays.has(d);
            const isCurrent = d === state.currentDay && !state.finished;
            const unlocked =
              unlockMode === "progress"
                ? d <= (state.finished ? version.days_total : state.openableDay)
                : d <= state.allowedDay;
            const rest = !courseDaySet.has(d);
            const ms = milestones.find((m) => m.day === d);
            const cell = (
              <div
                title={`Day ${d}${ms ? ` — ${ms.name}` : rest ? " — rest day" : ""}${done ? " — completed · tap to revise" : ""}`}
                className={`aspect-square rounded-md flex items-center justify-center text-[9px] font-bold ${
                  done
                    ? "bg-indigo-600 text-white hover:bg-indigo-500 hover:ring-2 hover:ring-indigo-300 cursor-pointer transition"
                    : isCurrent
                      ? "bg-amber-400 text-amber-950 ring-2 ring-amber-500 animate-pulse"
                      : rest
                        ? "bg-canvas text-muted/40"
                        : unlocked
                          ? "bg-amber-100 text-amber-800"
                          : "bg-canvas text-muted/60 border border-line"
                }`}
              >
                {ms ? <span className="text-[11px]">{ms.icon}</span> : rest ? "·" : d}
              </div>
            );
            // Completed missions stay open for revision: the link opens the
            // course on the day's credit row (step 22), and the launch admits
            // it as a review, a revision visit that never re-credits the
            // day, earns XP or advances the journey.
            const reviewCourse = done ? creditCourse.get(d) : null;
            return done && reviewCourse ? (
              <Link
                key={d}
                href={`/${orgSlug}/courses/${reviewCourse}/launch?journey=${enrollment.id}&day=${dayParam(d)}`}
                aria-label={`Revise day ${d}`}
              >
                {cell}
              </Link>
            ) : (
              <div key={d}>{cell}</div>
            );
          })}
            </div>
          </div>
        </details>

        <p className="px-5 py-3 text-[11px] text-muted border-t border-line">
          {state.completedCount > 0 ? `${copy.revise_hint} ` : ""}
          {copy.footer_note}
        </p>
      </section>
    </div>
  );
}

/**
 * A journey day's Preview (ADR 0024 step 23, "Buttons"), for the
 * report-viewing roles only: the day's module on its own, `?mode=preview`
 * and no product parameter (no ?journey= or &day=), so it is never a journey
 * attempt, credits nothing and has no Continue. Shown on every day that
 * holds a module, open or not: a preview runs outside the journey's
 * calendar (step 22's preview row).
 */
function DayPreview({
  canPreview,
  orgSlug,
  courseId,
  day,
  className = "",
}: {
  canPreview: boolean;
  orgSlug: string;
  courseId: string;
  day: number;
  className?: string;
}) {
  return canPreview ? (
    <Link
      href={`/${orgSlug}/courses/${courseId}/launch?mode=preview`}
      data-testid="day-preview"
      aria-label={`Preview day ${day}`}
      title="Opens this module on its own as a preview: not an official record, and not part of your journey"
      className={`inline-flex items-center gap-1 px-2.5 py-1 border border-line rounded-lg text-[11px] font-medium text-muted hover:text-ink hover:border-ink shrink-0 ${className}`}
    >
      <Eye className="w-3 h-3" aria-hidden /> Preview
    </Link>
  ) : null;
}

/** Course-title fallback lookup for the mission card (RLS members read). */
async function MissionTitle({
  courseId,
  override,
}: {
  courseId: string;
  override: string | null;
}) {
  if (override) return <>{override}</>;
  const supabase = await createClient();
  const { data } = await supabase
    .from("courses")
    .select("title")
    .eq("id", courseId)
    .maybeSingle();
  return <>{(data as { title?: string } | null)?.title ?? "Today's module"}</>;
}

function MilestonePath({
  milestones,
  completed,
}: {
  milestones: Milestone[];
  completed: number;
}) {
  return (
    <section className="bg-paper border border-line rounded-2xl px-4 py-5 overflow-x-auto">
      <div className="flex items-start min-w-max gap-0">
        {milestones.map((m, i) => {
          const achieved = completed >= m.day;
          const isNext = milestones.findIndex((x) => completed < x.day) === i;
          return (
            <div key={`${m.day}-${i}`} className="flex items-start">
              {i > 0 && (
                <div
                  className={`h-1 w-8 sm:w-14 mt-5 rounded ${
                    achieved ? "bg-indigo-600" : "bg-line"
                  }`}
                />
              )}
              <div className="flex flex-col items-center w-20 text-center">
                <div
                  className={`h-10 w-10 rounded-full flex items-center justify-center text-lg shadow-sm ${
                    achieved
                      ? "bg-indigo-600"
                      : isNext
                        ? "bg-amber-100 ring-2 ring-amber-400"
                        : "bg-canvas border border-line grayscale opacity-60"
                  }`}
                  aria-hidden
                >
                  {m.icon}
                </div>
                <p className="mt-1.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                  Day {m.day}
                </p>
                <p className={`text-[11px] leading-tight font-medium ${achieved ? "text-indigo-700" : ""}`}>
                  {m.name}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

