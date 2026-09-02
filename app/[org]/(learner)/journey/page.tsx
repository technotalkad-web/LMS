import Link from "next/link";
import {
  Flag,
  Flame,
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
  searchParams?: Promise<{ locked?: string }>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  const { user, org } = await requireOrgAccess(orgSlug);
  const supabase = await createClient();

  const { data: enrRows } = await supabase
    .from("journey_enrollments")
    .select("id, program_id, version_id, start_date, status, completed_at, created_at")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .in("status", ["active", "completed"])
    .order("created_at", { ascending: false })
    .limit(1);
  const enrollment = (enrRows ?? [])[0] as
    | {
        id: string;
        program_id: string;
        version_id: string;
        start_date: string;
        status: "active" | "completed";
        completed_at: string | null;
      }
    | undefined;

  // Program copy is live (typo fixes reach everyone); rules/content are
  // version-pinned below.
  const { data: progRow } = await supabase
    .from("journey_programs")
    .select("copy, is_active")
    .eq("organization_id", org.id)
    .maybeSingle();
  const copy = effectiveJourneyCopy((progRow as { copy?: unknown } | null)?.copy);
  const programActive =
    (progRow as { is_active?: boolean } | null)?.is_active !== false;

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
    return (
      <div className="max-w-3xl mx-auto space-y-6">
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
  const achieved = milestones.filter((m) => state.completedCount >= m.day);
  const latestAchieved = achieved[achieved.length - 1];
  const nextMilestone = milestones.find((m) => state.completedCount < m.day);
  const notStarted = state.allowedDay === 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {sp.locked && (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{copy.locked_message}</span>
        </div>
      )}

      <header className="text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-muted font-semibold">
          {version.icon} {version.name}
        </p>
        <h1 className="mt-1 text-4xl sm:text-5xl font-extrabold tracking-tight tabular-nums">
          DAY {state.currentDay}{" "}
          <span className="text-muted font-bold">/ {version.days_total}</span>
        </h1>
        {latestAchieved && (
          <p className="mt-1 text-sm text-indigo-700 font-medium">
            {latestAchieved.icon} {latestAchieved.name}
          </p>
        )}
      </header>

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
                  className="mt-4 inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-semibold shadow-sm"
                >
                  <PlayCircle className="w-5 h-5" /> {copy.cta_start}
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

      {/* Milestone path */}
      <MilestonePath milestones={milestones} completed={state.completedCount} />

      {/* Stats */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Missions" value={`${state.completedCount}/${courseDays.length}`} sub={`${state.pct}%`} icon={<Flag className="w-4 h-4 text-indigo-600" />} />
        <Stat label="Streak" value={streak > 0 ? `${streak} day${streak === 1 ? "" : "s"}` : "—"} icon={<Flame className="w-4 h-4 text-orange-500" />} />
        <Stat
          label="Pending"
          value={String(state.pendingDays)}
          sub={state.behindDays > 0 ? `${state.behindDays} behind` : "on track"}
          tone={state.behindDays > 0 ? "warn" : undefined}
          icon={<Hourglass className="w-4 h-4 text-amber-600" />}
        />
        <Stat label="Days left" value={String(state.daysRemaining)} icon={<Swords className="w-4 h-4 text-slate-500" />} />
      </section>

      {/* The day-path grid */}
      <section className="bg-paper border border-line rounded-2xl p-4 sm:p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold">Your journey path</h3>
          {nextMilestone && (
            <p className="text-xs text-muted">
              Next milestone: Day {nextMilestone.day} {nextMilestone.icon}{" "}
              {nextMilestone.name}
            </p>
          )}
        </div>
        <div className="grid grid-cols-10 sm:grid-cols-[repeat(15,minmax(0,1fr))] gap-1.5">
          {Array.from({ length: version.days_total }, (_, i) => i + 1).map((d) => {
            const done = doneDays.has(d);
            const isCurrent = d === state.currentDay && !state.finished;
            const unlocked = d <= state.allowedDay;
            const rest = !courseDaySet.has(d);
            const ms = milestones.find((m) => m.day === d);
            return (
              <div
                key={d}
                title={`Day ${d}${ms ? ` — ${ms.name}` : rest ? " — rest day" : ""}`}
                className={`aspect-square rounded-md flex items-center justify-center text-[9px] font-bold ${
                  done
                    ? "bg-indigo-600 text-white"
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
          })}
        </div>
        <p className="mt-3 text-[11px] text-muted">{copy.footer_note}</p>
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

function Stat({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  tone?: "warn";
}) {
  return (
    <div className="bg-paper border border-line rounded-2xl px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted font-bold inline-flex items-center gap-1.5">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && (
        <p className={`text-[11px] ${tone === "warn" ? "text-amber-700 font-semibold" : "text-muted"}`}>
          {sub}
        </p>
      )}
    </div>
  );
}
