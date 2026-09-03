import Link from "next/link";
import {
  Check,
  Hourglass,
  Lock,
  PauseCircle,
  PlayCircle,
  Swords,
  Target,
} from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import {
  computeJourneyState,
  courseDaysOf,
  effectiveJourneyCopy,
  effectiveMilestones,
  journeyStreak,
  parseVersionDays,
  todayStr,
  DEFAULT_JOURNEY_TZ,
  type Milestone,
} from "@/lib/journey/journey";

export const dynamic = "force-dynamic";

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
  const { user, org } = await requireOrgAccess(orgSlug);
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
            {e.prog.icon ?? "🏹"} {e.prog.name ?? "Journey"}
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

  const [{ data: verRow }, { data: progressRows }, { data: gsRow }] =
    await Promise.all([
      supabase
        .from("journey_versions")
        .select(
          "id, name, icon, days_total, count_sundays, milestones, completion_title, days"
        )
        .eq("id", enrollment.version_id)
        .maybeSingle(),
      supabase
        .from("journey_day_progress")
        .select("day_number, completed_at")
        .eq("enrollment_id", enrollment.id),
      supabase
        .from("gamification_settings")
        .select("timezone")
        .eq("organization_id", org.id)
        .maybeSingle(),
    ]);

  const version = verRow as {
    id: string;
    name: string;
    icon: string;
    days_total: number;
    count_sundays: boolean;
    milestones: unknown;
    completion_title: string;
    days: unknown;
  } | null;
  if (!version) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 text-muted text-sm">
        This journey version is no longer available.
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

  const dayByNumber = parseVersionDays(version.days);
  const courseDays = courseDaysOf(version.days, version.days_total);
  const courseDaySet = new Set(courseDays);
  const progress = (progressRows ?? []) as Array<{
    day_number: number;
    completed_at: string;
  }>;
  const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
  const today = todayStr(tz);

  const state = computeJourneyState({
    startDate: enrollment.start_date,
    today,
    completedCount: progress.length,
    daysTotal: version.days_total,
    countSundays: version.count_sundays === true,
    courseDays,
  });
  const milestones = effectiveMilestones(version.milestones, version.days_total);
  const doneDays = new Set(progress.map((p) => p.day_number));
  const streak = journeyStreak(
    progress.map((p) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(p.completed_at))
    ),
    today,
    version.count_sundays === true
  );

  // ---- Completed: the unlock celebration ----
  if (enrollment.status === "completed") {
    const final = milestones[milestones.length - 1];
    // Alumni keep review access to every journey module (course-access
    // grants it) — give them the links, batched titles in one query.
    const missionDays = [...dayByNumber.values()]
      .filter((d) => d.course_id)
      .sort((a, b) => a.day - b.day);
    const { data: courseRows } = await supabase
      .from("courses")
      .select("id, title")
      .in("id", missionDays.map((d) => d.course_id as string));
    const titleOf = new Map(
      ((courseRows ?? []) as Array<{ id: string; title: string }>).map((c) => [
        c.id,
        c.title,
      ])
    );
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

        {/* Alumni revision — journey modules stay open forever. Plain launch
            links (no journey tag): reviews never touch progress or XP. */}
        {missionDays.length > 0 && (
          <section className="bg-paper border border-line rounded-2xl p-5">
            <h3 className="text-sm font-semibold">📚 Revisit your missions</h3>
            <p className="text-xs text-muted mt-0.5 mb-3">
              Your {version.days_total}-day curriculum stays open — revise any
              module, any time.
            </p>
            <div className="grid sm:grid-cols-2 gap-2">
              {missionDays.map((d) => (
                <Link
                  key={d.day}
                  href={`/${orgSlug}/courses/${d.course_id}/launch`}
                  className="flex items-center gap-2 px-3 py-2 border border-line rounded-lg text-sm hover:border-indigo-400 hover:bg-indigo-50/40"
                >
                  <span className="text-[11px] font-bold text-indigo-700 tabular-nums shrink-0 w-14">
                    Day {d.day}
                  </span>
                  <span className="truncate">
                    {d.mission_title ??
                      titleOf.get(d.course_id as string) ??
                      "Module"}
                  </span>
                </Link>
              ))}
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
  if (mission?.course_id && state.todayUnlocked) {
    const { data: ipRows } = await supabase
      .from("course_attempts")
      .select("id")
      .eq("journey_enrollment_id", enrollment.id)
      .eq("journey_day", state.currentDay)
      .eq("status", "in_progress")
      .limit(1);
    missionInProgress = (ipRows ?? []).length > 0;
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
  const weekCourseIds = [
    ...new Set(
      weekDayNums
        .map((d) => dayByNumber.get(d)?.course_id)
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
    return (
      entry?.mission_title ??
      (entry?.course_id ? weekTitles.get(entry.course_id) : undefined) ??
      `Day ${d} mission`
    );
  };
  const nextCourseDayAfterCurrent =
    courseDays[courseDays.indexOf(state.currentDay) + 1];

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
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight truncate">
            {version.icon} {version.name}
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
                  href={`/${orgSlug}/courses/${mission.course_id}/launch?journey=${enrollment.id}&day=${state.currentDay}`}
                  className="mt-4 w-full sm:max-w-md mx-auto flex items-center justify-center gap-2 px-6 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-semibold shadow-sm"
                >
                  <PlayCircle className="w-5 h-5" />{" "}
                  {missionInProgress ? copy.cta_resume : copy.cta_start} →
                </Link>
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
              return (
                <Link
                  key={d}
                  href={`/${orgSlug}/courses/${entry.course_id}/launch?journey=${enrollment.id}&day=${d}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-canvas transition"
                  aria-label={`Revise day ${d}`}
                >
                  <span className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0" aria-hidden>
                    <Check className="w-4 h-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium truncate">
                      Day {d}: {titleForDay(d)}
                    </span>
                    <span className="block text-xs text-emerald-700">Completed</span>
                  </span>
                  <span className="text-xs font-medium text-indigo-700 shrink-0">
                    Revise
                  </span>
                </Link>
              );
            }
            if (isCurrent) {
              return (
                <div key={d} className="flex items-center gap-3 px-5 py-3 bg-indigo-50/60 border-l-4 border-indigo-500 -ml-px">
                  <span className="h-7 w-7 rounded-full bg-amber-400 text-amber-950 flex items-center justify-center shrink-0" aria-hidden>
                    <PlayCircle className="w-4 h-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold truncate">
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
                      href={`/${orgSlug}/courses/${entry.course_id}/launch?journey=${enrollment.id}&day=${d}`}
                      className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold shrink-0"
                    >
                      {missionInProgress ? "Continue" : "Start"}
                    </Link>
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
                  <span className="block text-sm truncate">
                    Day {d}: {titleForDay(d)}
                  </span>
                  <span className="block text-xs">
                    {d === nextCourseDayAfterCurrent ? "Up next" : `Day ${d} mission`}
                  </span>
                </span>
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
                <span className="block text-sm font-semibold truncate">
                  Day {nextMilestone.day}: {nextMilestone.name}
                </span>
                {nextMilestone.message && (
                  <span className="block text-xs text-indigo-700 truncate">
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
            const unlocked = d <= state.allowedDay;
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
            // Completed missions stay open for revision — relaunch is
            // untagged (validated server-side), so it can never re-credit
            // the day, earn XP, or advance the journey.
            const dayCourseId = dayByNumber.get(d)?.course_id;
            return done && dayCourseId ? (
              <Link
                key={d}
                href={`/${orgSlug}/courses/${dayCourseId}/launch?journey=${enrollment.id}&day=${d}`}
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

