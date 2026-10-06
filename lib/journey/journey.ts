/**
 * 90-Day Yoddha Journey — shared day math + default milestone copy.
 * Client-safe (no imports). All date work is done on org-local YYYY-MM-DD
 * strings so server and browser agree regardless of host timezone.
 *
 * Rules (user decisions, 2026-09-02):
 *   - Working days: with count_sundays=false, Sundays don't advance the drip.
 *     Day 1 is the first counted day on/after start_date.
 *   - allowedDay = counted days elapsed from start through today (capped at
 *     days_total). The learner may complete days 1..allowedDay in order —
 *     catch-up allowed, getting ahead is not.
 *   - currentDay = completedCount + 1 (the next mission), unlocked iff
 *     currentDay <= allowedDay.
 */

export const DEFAULT_JOURNEY_TZ = "Asia/Kolkata";

export type Milestone = { day: number; icon: string; name: string; message: string };

export const DEFAULT_MILESTONES: Milestone[] = [
  { day: 1, icon: "🏹", name: "Yoddha-in-Making", message: "Your journey begins. One mission a day." },
  { day: 10, icon: "💪", name: "Momentum Built", message: "Ten missions down — the habit is forming." },
  { day: 30, icon: "🛡️", name: "Foundation Builder", message: "A full month of learning. Your base is set." },
  { day: 45, icon: "⚔️", name: "Halfway to Yoddha", message: "Halfway there. Keep the blade sharp." },
  { day: 60, icon: "🚀", name: "Yoddha Rising", message: "Sixty days strong. You're rising fast." },
  { day: 75, icon: "🔥", name: "Final Stretch", message: "The finish line is in sight. Push through." },
  { day: 90, icon: "👑", name: "YODDHA UNLOCKED", message: "90 Days. 90 Learning Missions. One Complete Journey." },
];

/** Every learner-facing journey string, org-overridable via the program's
 *  `copy` jsonb (Settings → Journey copy). Defaults only — nothing here is
 *  shown if the org has overridden the key. */
export const DEFAULT_JOURNEY_COPY = {
  mission_label: "Today's mission",
  mission_subtitle: "Complete today's module to continue your Yoddha journey.",
  cta_start: "Start Mission",
  cta_resume: "Continue Mission",
  on_track_note: "You're on track — the next mission unlocks tomorrow.",
  revise_hint: "Tap any completed day to revisit that module — revision never affects your progress.",
  locked_message:
    "That mission is still locked — the journey unlocks one day at a time. Complete today's mission first.",
  preparing_title: "Mission being prepared",
  preparing_body: "Today's module isn't published yet — check back soon.",
  not_started_title: "Your journey starts soon",
  not_started_body: "Day 1 unlocks on your start date. Get ready.",
  empty_title: "No journey yet",
  empty_body:
    "The journey is assigned by your administrator. Once you're enrolled, your daily missions appear here.",
  paused_title: "Journey paused",
  paused_body:
    "Your administrator has temporarily paused the journey. Your progress is safe — missions resume when it's switched back on.",
  footer_note:
    "One mission per day · missed days can be caught up · no leaderboard points — this journey is you vs. yesterday.",
  banner_line: "today's mission is waiting",
  completion_line: "One mission a day. One complete journey.",
} as const;
export type JourneyCopy = {
  -readonly [K in keyof typeof DEFAULT_JOURNEY_COPY]: string;
};

export function effectiveJourneyCopy(overrides: unknown): JourneyCopy {
  const out: JourneyCopy = { ...DEFAULT_JOURNEY_COPY };
  if (overrides && typeof overrides === "object") {
    for (const key of Object.keys(out) as Array<keyof JourneyCopy>) {
      const v = (overrides as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) out[key] = v.trim();
    }
  }
  return out;
}

/** One entry of a published version's `days` jsonb. */
export type JourneyDayEntry = {
  day: number;
  course_id: string | null;
  mission_title: string | null;
};

/** Day numbers of a version's days that carry a module (the missions). */
export function courseDaysOf(days: unknown, daysTotal: number): number[] {
  return [...parseVersionDays(days).values()]
    .filter((d) => d.course_id && d.day <= daysTotal)
    .map((d) => d.day)
    .sort((a, b) => a - b);
}

export function parseVersionDays(days: unknown): Map<number, JourneyDayEntry> {
  const map = new Map<number, JourneyDayEntry>();
  if (Array.isArray(days)) {
    for (const raw of days) {
      const o = raw as Partial<JourneyDayEntry>;
      const day = Math.round(Number(o?.day));
      if (!Number.isFinite(day) || day < 1) continue;
      map.set(day, {
        day,
        course_id: typeof o.course_id === "string" && o.course_id ? o.course_id : null,
        mission_title:
          typeof o.mission_title === "string" && o.mission_title.trim()
            ? o.mission_title.trim()
            : null,
      });
    }
  }
  return map;
}

/** Org overrides (journey milestones jsonb) merged over defaults. */
export function effectiveMilestones(overrides: unknown, daysTotal: number): Milestone[] {
  let list = DEFAULT_MILESTONES;
  if (Array.isArray(overrides) && overrides.length > 0) {
    const parsed = overrides
      .map((m) => {
        const o = m as Partial<Milestone>;
        return typeof o?.day === "number" && o.day >= 1
          ? {
              day: Math.round(o.day),
              icon: typeof o.icon === "string" && o.icon ? o.icon : "⭐",
              name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : `Day ${o.day}`,
              message: typeof o.message === "string" ? o.message.trim() : "",
            }
          : null;
      })
      .filter((m): m is Milestone => !!m);
    if (parsed.length > 0) list = parsed;
  }
  return list
    .filter((m) => m.day <= daysTotal)
    .sort((a, b) => a.day - b.day);
}

/** Today's date string in a timezone (YYYY-MM-DD). */
export function todayStr(tz: string = DEFAULT_JOURNEY_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

/** Day-of-week 0=Sun..6=Sat for a YYYY-MM-DD string (timezone-agnostic). */
function dow(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Counted (working) days in [start, today] inclusive; 0 if today < start. */
export function countedDaysElapsed(
  start: string,
  today: string,
  countSundays: boolean
): number {
  if (today < start) return 0;
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const total = Math.round((t - s) / 86400000) + 1;
  if (countSundays) return total;
  // Sundays inside the window don't count.
  const fullWeeks = Math.floor(total / 7);
  let sundays = fullWeeks;
  const startDow = dow(start);
  for (let i = fullWeeks * 7; i < total; i++) {
    if ((startDow + i) % 7 === 0) sundays++;
  }
  return total - sundays;
}

/** The calendar date on which counted day N falls (for milestone ETAs). */
export function dateOfDay(
  start: string,
  n: number,
  countSundays: boolean
): string {
  let d = start;
  let counted = 0;
  for (let guard = 0; guard < 1000; guard++) {
    if (countSundays || dow(d) !== 0) counted++;
    if (counted >= n) return d;
    d = addDays(d, 1);
  }
  return d;
}

export type JourneyUnlockMode = "calendar" | "progress";

export type JourneyState = {
  daysTotal: number;
  completedCount: number;
  /** Highest day the CALENDAR allows (1..daysTotal; 0 before start). In
   *  progress mode this is still computed (start_date gating uses it) but it
   *  no longer gates which mission opens. */
  allowedDay: number;
  /** The next mission's day number (completedCount + 1, capped). */
  currentDay: number;
  /** Is the next mission launchable right now? */
  todayUnlocked: boolean;
  /** The day the learner may OPEN right now (0 = nothing: not started yet,
   *  waiting on the calendar, or finished). Use this — not allowedDay — to
   *  decide launchability and the per-day "released/openable" flag. */
  openableDay: number;
  /** Calendar missions released but not done yet (always 0 in progress mode —
   *  a self-paced journey has no calendar "behind" concept). */
  pendingDays: number;
  /** pendingDays beyond today's own mission (0 = on track; always 0 in
   *  progress mode). */
  behindDays: number;
  daysRemaining: number;
  pct: number;
  finished: boolean;
};

export function computeJourneyState(opts: {
  startDate: string; // YYYY-MM-DD
  today: string; // YYYY-MM-DD (org-local)
  completedCount: number;
  daysTotal: number;
  countSundays: boolean;
  /**
   * How missions unlock. 'calendar' (default) = day N opens on its calendar
   * day, catch-up in order, never ahead of the calendar. 'progress' = the
   * next day opens as soon as the previous is completed (self-paced, still in
   * order); only Day 1 waits for start_date.
   */
  unlockMode?: JourneyUnlockMode;
  /**
   * Day numbers that actually carry a module, ascending. Days without one
   * are REST DAYS: the journey skips over them (they can never complete, so
   * treating them as missions would deadlock a pinned version forever).
   * Omitted = every day has a module.
   */
  courseDays?: number[];
}): JourneyState {
  const { startDate, today, completedCount, daysTotal, countSundays } = opts;
  const progress = opts.unlockMode === "progress";
  const courseDays =
    opts.courseDays && opts.courseDays.length > 0
      ? [...opts.courseDays].filter((d) => d >= 1 && d <= daysTotal).sort((a, b) => a - b)
      : Array.from({ length: daysTotal }, (_, i) => i + 1);
  const missionsTotal = courseDays.length;
  // The calendar ceiling — counted days elapsed since start. Still computed in
  // progress mode because start_date gating (allowedDay >= 1) uses it.
  const allowedDay = Math.min(
    daysTotal,
    countedDaysElapsed(startDate, today, countSundays)
  );
  const started = allowedDay >= 1; // today >= start_date (counted)
  const finished = missionsTotal > 0 && completedCount >= missionsTotal;
  // The next MISSION's day number (rest days are skipped automatically).
  const currentDay = finished
    ? daysTotal
    : (courseDays[completedCount] ?? daysTotal);
  // Progress mode drops the calendar ceiling: the next mission is open as soon
  // as it exists, provided the journey has started. Calendar mode keeps the
  // ceiling (can't get ahead of the drip).
  const todayUnlocked = !finished && (progress ? started : currentDay <= allowedDay);
  const openableDay = todayUnlocked ? currentDay : 0;
  // Released/openable missions: calendar counts everything the drip has
  // reached; progress counts the completed ones plus the single open next day
  // (all days once finished).
  const releasedMissions = progress
    ? finished
      ? missionsTotal
      : started
        ? courseDays.filter((d) => d <= currentDay).length
        : 0
    : courseDays.filter((d) => d <= allowedDay).length;
  // "Behind" is a calendar concept only — a self-paced (progress) learner can
  // never be behind a schedule, so pending/behind are 0 there.
  const pendingDays = progress ? 0 : Math.max(0, releasedMissions - completedCount);
  return {
    daysTotal,
    completedCount,
    allowedDay,
    currentDay,
    todayUnlocked,
    openableDay,
    pendingDays,
    behindDays: progress ? 0 : Math.max(0, pendingDays - 1),
    daysRemaining: Math.max(0, missionsTotal - completedCount),
    pct: missionsTotal > 0 ? Math.round((completedCount / missionsTotal) * 100) : 0,
    finished,
  };
}

/** Journey streak: consecutive counted days with a completion, ending today
 *  or the most recent counted day. `completionDates` = org-local YYYY-MM-DD. */
export function journeyStreak(
  completionDates: string[],
  today: string,
  countSundays: boolean
): number {
  const days = new Set(completionDates);
  let d = today;
  // The streak survives if today's mission simply isn't done YET — start
  // from today if completed, else from the previous counted day.
  if (!days.has(d)) d = prevCounted(d, countSundays);
  let streak = 0;
  for (let guard = 0; guard < 400; guard++) {
    if (!days.has(d)) break;
    streak++;
    d = prevCounted(d, countSundays);
  }
  return streak;
}

function prevCounted(dateStr: string, countSundays: boolean): string {
  let d = addDays(dateStr, -1);
  if (!countSundays && dow(d) === 0) d = addDays(d, -1);
  return d;
}
