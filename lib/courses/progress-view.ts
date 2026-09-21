/**
 * Progress views for admin surfaces (0075) — client-safe, pure.
 *
 * Turns raw attempt rows into what an admin needs to see per learner:
 *   course   → progress % + screens done / total (where the package reports it)
 *   path     → overall % (completed steps, plus the current step's partial)
 *              + the current step and its %
 *   journey  → overall % (days done) + the current day's module %
 */

export type ProgressAttemptRow = {
  course_version_id: string;
  completion_status: string | null;
  success_status: string | null;
  started_at: string | null;
  progress_pct?: number | null;
  /** cmi_data->cmi5->units (PostgREST JSON path select) or the full cmi_data. */
  units?: unknown;
  cmi_data?: unknown;
};

export type CourseProgressView = {
  /** 0–100, or null when the package gives no signal. 100 == complete. */
  pct: number | null;
  done: boolean;
  started: boolean;
  screensDone: number | null;
  screensTotal: number | null;
};

export function isDoneAttempt(a: { completion_status: string | null; success_status: string | null }): boolean {
  return a.completion_status === "completed" || a.success_status === "passed";
}

function unitsOf(a: ProgressAttemptRow): Record<string, string> | null {
  const direct = a.units;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, string>;
  const cmi = a.cmi_data as { cmi5?: { units?: unknown } } | undefined;
  const u = cmi?.cmi5?.units;
  if (u && typeof u === "object" && !Array.isArray(u)) return u as Record<string, string>;
  return null;
}

/**
 * Progress of one learner on one course from their attempts on any of its
 * versions. `unitCountByVersion` maps version id → manifest unitCount.
 */
export function courseProgress(
  attempts: ProgressAttemptRow[],
  unitCountByVersion?: Map<string, number | null>
): CourseProgressView {
  if (attempts.length === 0) {
    return { pct: null, done: false, started: false, screensDone: null, screensTotal: null };
  }
  const done = attempts.some(isDoneAttempt);
  const open = attempts
    .filter((a) => !isDoneAttempt(a) && a.completion_status !== "completed")
    .sort((x, y) => ((x.started_at ?? "") < (y.started_at ?? "") ? 1 : -1))[0];
  const source = done ? null : open ?? null;
  let screensDone: number | null = null;
  let screensTotal: number | null = null;
  if (source) {
    const units = unitsOf(source);
    if (units) screensDone = Object.values(units).filter((v) => v === "completed").length;
    const total = unitCountByVersion?.get(source.course_version_id);
    if (typeof total === "number" && total > 0) screensTotal = total;
    if (screensDone !== null && screensTotal === null) screensDone = screensDone || null;
  }
  const pct = done
    ? 100
    : typeof source?.progress_pct === "number"
      ? Math.min(99, source.progress_pct)
      : null;
  return { pct, done, started: true, screensDone, screensTotal };
}

/** "45%", "45% · 9/20 screens", "100%", "In progress", "Not started", "—". */
export function formatCourseProgress(v: CourseProgressView): string {
  if (!v.started) return "Not started";
  if (v.done) return "100%";
  if (v.pct === null) return "In progress";
  const screens =
    v.screensDone !== null && v.screensTotal !== null ? ` · ${v.screensDone}/${v.screensTotal} screens` : "";
  return `${v.pct}%${screens}`;
}

export type StepProgressView = {
  /** Steps completed / total. */
  stepsDone: number;
  stepsTotal: number;
  /** Overall %: completed steps plus the current step's partial progress. */
  overallPct: number;
  /** The first unfinished step in sequence, with its own progress. */
  current: { index: number; courseId: string; title: string; pct: number | null } | null;
};

/**
 * Learning-path progress. `steps` in sequence order; `progressByCourse`
 * gives each step's CourseProgressView for this learner.
 */
export function pathProgress(
  steps: Array<{ course_id: string; title: string }>,
  progressByCourse: Map<string, CourseProgressView>
): StepProgressView {
  const total = steps.length;
  let done = 0;
  let current: StepProgressView["current"] = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const p = progressByCourse.get(s.course_id);
    if (p?.done) done++;
    else if (current === null) current = { index: i + 1, courseId: s.course_id, title: s.title, pct: p?.pct ?? null };
  }
  const partial = current && typeof current.pct === "number" ? current.pct / 100 : 0;
  const overallPct = total === 0 ? 0 : Math.min(100, Math.round(((done + partial) / total) * 100));
  return { stepsDone: done, stepsTotal: total, overallPct, current };
}

/** "3/5 steps · 65% · Step 4: 45%" */
export function formatPathProgress(v: StepProgressView): string {
  const base = `${v.stepsDone}/${v.stepsTotal} steps · ${v.overallPct}%`;
  if (!v.current) return base;
  const cur = v.current.pct === null ? "not started" : `${v.current.pct}%`;
  return `${base} · Step ${v.current.index}: ${cur}`;
}

export type JourneyProgressView = {
  daysDone: number;
  daysTotal: number;
  overallPct: number;
  currentDay: number | null;
  currentPct: number | null;
};

/** Journey progress: days done over course days, plus today's mission %. */
export function journeyProgress(
  daysDone: number,
  courseDaysTotal: number,
  currentDay: number | null,
  currentMission: CourseProgressView | null
): JourneyProgressView {
  const partial = currentMission && !currentMission.done && typeof currentMission.pct === "number" ? currentMission.pct / 100 : 0;
  const overallPct =
    courseDaysTotal === 0 ? 0 : Math.min(100, Math.round(((daysDone + partial) / courseDaysTotal) * 100));
  return {
    daysDone,
    daysTotal: courseDaysTotal,
    overallPct,
    currentDay,
    currentPct: currentMission && !currentMission.done ? currentMission.pct : null,
  };
}
