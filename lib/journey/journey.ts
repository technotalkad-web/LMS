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
 *   - currentDay = the lowest course day not credited (the next mission),
 *     unlocked iff currentDay <= allowedDay.
 *
 * Day identity (ADR 0024 step 45, decision A27, section U; build note N18):
 * a credit names its day by id (journey_day_progress.day_id) and a version
 * maps its day numbers to ids (journey_versions.day_ids). creditedDaysFor()
 * turns a learner's credit rows into the numbers, in the pinned version, of
 * the course days they credit, and computeJourneyState() takes those numbers
 * (creditedDays), never a row count. The SQL twin is journey_credit_state()
 * (0107), and tests/unit/context-parity.test.ts runs both on the same cases.
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
  /**
   * The day's identity: the version's `day_ids` entry for this number
   * (ADR 0024 section U). Null when no map was given (a reader that needs no
   * ids, or a database without 0107) or the map has no entry for the day.
   */
  dayId: string | null;
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

/** A version's `day_ids` map ({"<day number>": "<day id>"}), or null when it is not an object. */
function dayIdMap(dayIds: unknown): Record<string, unknown> | null {
  return dayIds !== null && typeof dayIds === "object" && !Array.isArray(dayIds)
    ? (dayIds as Record<string, unknown>)
    : null;
}

/**
 * A version's days by number. `dayIds` is the version's `day_ids` (0107);
 * without it every entry's dayId is null. A day number listed twice is one
 * day whose course is the first entry's that has one (the reading of
 * journey_credit_state and journey_repin_enrollments, 0107).
 */
export function parseVersionDays(days: unknown, dayIds?: unknown): Map<number, JourneyDayEntry> {
  const map = new Map<number, JourneyDayEntry>();
  const ids = dayIdMap(dayIds);
  if (Array.isArray(days)) {
    for (const raw of days) {
      const o = raw as Partial<JourneyDayEntry>;
      const day = Math.round(Number(o?.day));
      if (!Number.isFinite(day) || day < 1) continue;
      const courseId = typeof o.course_id === "string" && o.course_id ? o.course_id : null;
      const title =
        typeof o.mission_title === "string" && o.mission_title.trim() ? o.mission_title.trim() : null;
      const prev = map.get(day);
      if (prev) {
        if (!prev.course_id && courseId) map.set(day, { ...prev, course_id: courseId, mission_title: prev.mission_title ?? title });
        continue;
      }
      const id = ids?.[String(day)];
      map.set(day, {
        day,
        dayId: typeof id === "string" && id ? id.toLowerCase() : null,
        course_id: courseId,
        mission_title: title,
      });
    }
  }
  return map;
}

/** One credit row as the twin reads it (journey_day_progress; lib/journey/credits-read.ts). */
export type JourneyCreditRow = {
  /** The credited day's id (0107); null on a database without the column. */
  day_id: string | null;
  /** The day's number when it was credited. */
  day_number: number;
  completed_at: string | null;
};

/**
 * The numbers, in the pinned version, of the course days whose id holds a
 * credit (ADR 0024 step 45, N18): the `creditedDays` computeJourneyState
 * takes. A course day is an entry with a course and a number from 1 to
 * days_total; its id is its `day_ids` entry. A credit whose day is not a
 * course day of this version (removed, a rest day now, beyond days_total)
 * maps to no number and counts towards nothing; every credit kind counts.
 *
 * `version.day_ids` is what credits-read.ts answers for the version: the map
 * on a database with 0107 (a version without one reads as `{}` there, so it
 * credits nothing, as journey_credit_state does), and null only when the read
 * fell back on a database without the columns. Then, and only then, a credit
 * matches its course day by number: today's reading, the same as the old
 * count wherever no re-pin moved a day.
 */
export function creditedDaysFor(
  version: { days: unknown; days_total: number; day_ids: Record<string, unknown> | null },
  progressRows: ReadonlyArray<Pick<JourneyCreditRow, "day_id" | "day_number">>
): number[] {
  const byNumber = parseVersionDays(version.days, version.day_ids ?? undefined);
  const required = [...byNumber.values()].filter(
    (d) => d.course_id !== null && d.day <= version.days_total
  );
  const out = new Set<number>();
  if (version.day_ids === null) {
    const numbers = new Set(progressRows.map((r) => r.day_number));
    for (const d of required) if (numbers.has(d.day)) out.add(d.day);
  } else {
    const ids = new Set(
      progressRows.map((r) => (typeof r.day_id === "string" ? r.day_id.toLowerCase() : null)).filter((x): x is string => !!x)
    );
    for (const d of required) if (d.dayId !== null && ids.has(d.dayId)) out.add(d.day);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The `creditedDays` of the nudges cron and the Report Card's reminder
 * action, from one journey_reminder_counts row (ADR 0024 step 45): its
 * `credited` (0107, the numbers journey_credit_state credits); on a
 * database without 0107 the function answers no such column, and the first
 * `done` course days are credited, today's reading.
 */
export function reminderCreditedDays(
  row: { done?: number | null; credited?: unknown },
  courseDays: readonly number[]
): number[] {
  if (Array.isArray(row.credited)) {
    return row.credited.filter((n): n is number => typeof n === "number" && Number.isInteger(n));
  }
  const done = Math.max(0, Math.floor(Number(row.done ?? 0)) || 0);
  return [...courseDays].sort((a, b) => a - b).slice(0, done);
}

/**
 * The days whose context holds an open official attempt (ADR 0024 step 93,
 * N14), from a caller's attempts read: the enrolment's journey rows that are
 * in progress and not revision visits, whatever their day's place in the
 * pinned version now (a removed day included). Distinct ids in ascending
 * order, as journey_credit_state answers resumable_day_ids.
 */
export function resumableDayIdsFor(
  enrollmentId: string,
  attempts: ReadonlyArray<{
    journey_enrollment_id?: string | null;
    context_kind?: string | null;
    status?: string | null;
    is_revision?: boolean | null;
    journey_day_id?: string | null;
  }>
): string[] {
  const out = new Set<string>();
  for (const a of attempts) {
    if (a.journey_enrollment_id !== enrollmentId || a.context_kind !== "journey") continue;
    if (a.status !== "in_progress" || a.is_revision === true || !a.journey_day_id) continue;
    out.add(a.journey_day_id.toLowerCase());
  }
  return [...out].sort();
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

/**
 * The date (YYYY-MM-DD) in `tz` at the instant `nowIso`: todayStr with the
 * clock passed in, so a pure decision can be tested at a fixed instant (ADR
 * 0024 step 22, the launch resolver; twins contract A12). An unparseable
 * instant or an unknown timezone throws, as todayStr does for the zone.
 */
export function todayStrAt(nowIso: string, tz: string = DEFAULT_JOURNEY_TZ): string {
  const at = new Date(nowIso);
  if (!Number.isFinite(at.getTime())) throw new RangeError("todayStrAt: an invalid instant");
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
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
  /** The course days that are credited (the twin's count; never a row count). */
  completedCount: number;
  /** Highest day the CALENDAR allows (1..daysTotal; 0 before start). In
   *  progress mode this is still computed (start_date gating uses it) but it
   *  no longer gates which mission opens. */
  allowedDay: number;
  /** The next mission's day number: the lowest course day not credited
   *  (daysTotal once finished or when the version has no course day). */
  currentDay: number;
  /** The lowest course day not credited; null when every course day is
   *  credited or the version has none (journey_credit_state's next_day). */
  nextDay: number | null;
  /** The caller's resumable day ids, distinct and in ascending order. */
  resumableDayIds: string[];
  /** The open day's official result failed and no unused journey grant
   *  exists (ADR 0024 step 45). An output only: it never changes
   *  todayUnlocked or openableDay, and no page shows it before phase 6. */
  blockedFailed: boolean;
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
  /**
   * The numbers, in the pinned version, of the days whose id holds a credit:
   * creditedDaysFor() over the credits read (lib/journey/credits-read.ts),
   * or reminderCreditedDays() over a journey_reminder_counts row. Never a
   * row count: the parameter changed its name and type on purpose (ADR 0024
   * step 45), so a caller that still passes a count fails the type check.
   */
  creditedDays: readonly number[];
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
   * Day numbers that actually carry a module (courseDaysOf). Days without
   * one are REST DAYS: the journey skips over them. Required (N18): an empty
   * list means the version has no mission, which is never finished and never
   * opens a day (journey_credit_state: zero required days never complete).
   */
  courseDays: readonly number[];
  /**
   * The ids of the days whose context holds an open official attempt, from
   * the caller's attempts read (resumableDayIdsFor). Passed through, in
   * ascending order; omitted when the caller makes no such read.
   */
  resumableDayIds?: readonly string[];
  /** blocked_failed's two inputs (ADR 0024 step 45), from the caller's
   *  reads of the open day: its official result failed under the resolved
   *  rule, and an unused journey grant exists for it. Both default to false. */
  currentDayFailed?: boolean;
  unusedJourneyGrant?: boolean;
}): JourneyState {
  const { startDate, today, daysTotal, countSundays } = opts;
  const progress = opts.unlockMode === "progress";
  const courseDays = [...new Set(opts.courseDays)]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= daysTotal)
    .sort((a, b) => a - b);
  const credited = new Set(opts.creditedDays);
  const missionsTotal = courseDays.length;
  const completedCount = courseDays.filter((d) => credited.has(d)).length;
  // The open day: the lowest course day not credited (rest days are skipped,
  // and a credited day is never the open day, wherever a re-pin moved it).
  const nextDay = courseDays.find((d) => !credited.has(d)) ?? null;
  // The calendar ceiling — counted days elapsed since start. Still computed in
  // progress mode because start_date gating (allowedDay >= 1) uses it.
  const allowedDay = Math.min(
    daysTotal,
    countedDaysElapsed(startDate, today, countSundays)
  );
  const started = allowedDay >= 1; // today >= start_date (counted)
  const finished = missionsTotal > 0 && nextDay === null;
  const currentDay = nextDay ?? daysTotal;
  // Progress mode drops the calendar ceiling: the next mission is open as soon
  // as it exists, provided the journey has started. Calendar mode keeps the
  // ceiling (can't get ahead of the drip).
  const todayUnlocked = nextDay !== null && (progress ? started : nextDay <= allowedDay);
  const openableDay = todayUnlocked ? currentDay : 0;
  // "Behind" is a calendar concept only — a self-paced (progress) learner can
  // never be behind a schedule, so pending/behind are 0 there. Calendar mode
  // counts the released course days that are not credited (step 45).
  const pendingDays = progress
    ? 0
    : courseDays.filter((d) => d <= allowedDay && !credited.has(d)).length;
  return {
    daysTotal,
    completedCount,
    allowedDay,
    currentDay,
    nextDay,
    todayUnlocked,
    openableDay,
    pendingDays,
    behindDays: progress ? 0 : Math.max(0, pendingDays - 1),
    daysRemaining: Math.max(0, missionsTotal - completedCount),
    pct: missionsTotal > 0 ? Math.round((completedCount / missionsTotal) * 100) : 0,
    finished,
    resumableDayIds: [...new Set(opts.resumableDayIds ?? [])].sort(),
    blockedFailed:
      nextDay !== null && opts.currentDayFailed === true && opts.unusedJourneyGrant !== true,
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
