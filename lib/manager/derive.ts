import { THRESHOLDS, riskOf, statusOf } from "./report-card";
import type { CourseLine, ExceptionFlag, JourneyInsight, LearnerStatus, PathLine, Severity } from "./types";

/**
 * The per-learner aggregates and §3 exception flags, derived from the
 * content lines alone. Pure, so it runs both inside computeLearnerInsights
 * (live and the 15-minute precompute) and again at read time when a
 * manager's visibility rule hides some of the content (Phase 4c,
 * lib/manager/coverage.ts) — one rule set, applied twice, never two.
 */

export const DAY = 86400000;
export const daysAgo = (iso: string | null, nowMs: number): number | null =>
  iso ? Math.floor((nowMs - new Date(iso).getTime()) / DAY) : null;
export const fmtDay = (iso: string) => iso.slice(0, 10);
export const minIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
export const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

export type DeriveInput = {
  courses: CourseLine[];
  paths: PathLine[];
  journeys: JourneyInsight[];
  /** Person-level: last learning activity on ANY content (never filtered). */
  lastActive: string | null;
  periodDays: number | null;
  nowMs: number;
};

export type Derived = {
  assigned: number;
  completed: number;
  completionPct: number | null;
  avgScore: number | null;
  assessmentsWithResult: number;
  passedFirstTime: number;
  inactiveDays: number | null;
  activeLast7d: boolean;
  flags: ExceptionFlag[];
  risk: number;
  status: LearnerStatus;
  completedInPeriod: number;
  passedFirstTimeInPeriod: number;
  journeyDaysInPeriod: number;
  completedInPrevPeriod: number;
};

export function deriveLearner(i: DeriveInput): Derived {
  const { courses, paths, journeys, lastActive, periodDays, nowMs } = i;
  const periodStart = periodDays === null ? null : new Date(nowMs - periodDays * DAY).toISOString();
  const prevStart = periodDays === null ? null : new Date(nowMs - 2 * periodDays * DAY).toISOString();
  const inPeriod = (iso: string | null | undefined) => !!iso && (periodStart === null || iso >= periodStart);
  const inPrev = (iso: string | null | undefined) => !!iso && prevStart !== null && periodStart !== null && iso >= prevStart && iso < periodStart;
  const activeCutoff = new Date(nowMs - THRESHOLDS.activeWindowDays * DAY).toISOString();

  const assignedCourses = courses.filter((c) => c.isAssigned);
  const assigned = assignedCourses.length;
  const completed = assignedCourses.filter((c) => c.done).length;
  const withResult = courses.filter((c) => c.officialScore !== null);
  const avgScore = withResult.length ? Math.round(withResult.reduce((s, c) => s + (c.officialScore ?? 0), 0) / withResult.length) : null;
  let completedInPeriod = 0, completedInPrevPeriod = 0, passedFirstTimeInPeriod = 0;
  for (const c of courses) {
    if (inPeriod(c.completedAt)) completedInPeriod++;
    if (inPrev(c.completedAt)) completedInPrevPeriod++;
    if (c.passedFirstTime && inPeriod(c.completedAt)) passedFirstTimeInPeriod++;
  }
  const journeyDaysInPeriod = journeys.reduce((n, j) => n + (j.daysInPeriod ?? 0), 0);
  const inactiveDays = daysAgo(lastActive, nowMs);
  const earliestAssigned = assignedCourses.reduce<string | null>((acc, c) => minIso(acc, c.assignedAt), null);

  /* ---- §3 exception rules ---- */
  const flags: ExceptionFlag[] = [];
  for (const c of courses) {
    if (c.status === "failed" || c.passRequiredUnmet) {
      flags.push({ kind: "failed", severity: "critical", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
        detail: c.officialScore !== null ? `${c.title} · ${c.officialScore}%` : `${c.title} · not passed` });
    }
    if (c.overdue) {
      flags.push({ kind: "overdue", severity: "critical", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
        detail: `${c.title} · due ${fmtDay(c.dueAt!)}` });
    }
    if (c.status === "in_progress") {
      const openDays = daysAgo(c.startedAt, nowMs) ?? 0;
      const idleDays = daysAgo(c.lastActivity, nowMs) ?? 0;
      if ((openDays >= THRESHOLDS.stuckDays && (c.progressPct ?? 0) < THRESHOLDS.stuckPct) || idleDays >= THRESHOLDS.stuckIdleDays) {
        flags.push({ kind: "stuck", severity: "high", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
          detail: `${c.title} · opened ${openDays}d ago${c.progressPct !== null ? `, ${c.progressPct}%` : ""}${idleDays >= THRESHOLDS.stuckIdleDays ? `, idle ${idleDays}d` : ""}` });
      }
    }
    if (c.status === "not_started" && c.assignedAt && (daysAgo(c.assignedAt, nowMs) ?? 0) >= THRESHOLDS.notStartedDays) {
      flags.push({ kind: "not_started", severity: "normal", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
        detail: `${c.title} · assigned ${daysAgo(c.assignedAt, nowMs)}d ago` });
    }
  }
  for (const pth of paths) {
    if (pth.overdue) flags.push({ kind: "overdue", severity: "critical", contentId: pth.pathId, contentKind: "path", contentTitle: pth.name, detail: `${pth.name} · due ${fmtDay(pth.dueAt!)}` });
  }
  for (const j of journeys) {
    if (j.status !== "active") continue;
    if (j.overdueDeadline || j.behind >= 1) {
      const sev: Severity = j.overdueDeadline || j.behind >= THRESHOLDS.journeyEscalateBehind ? "critical" : "high";
      flags.push({ kind: "behind", severity: sev, contentId: j.programId, contentKind: "journey", contentTitle: j.name,
        detail: j.overdueDeadline ? `${j.name} · past deadline` : `${j.behind} day${j.behind === 1 ? "" : "s"} behind · next: ${j.nextModule ?? `Day ${j.day}`}` });
    }
  }
  if (inactiveDays !== null && inactiveDays >= THRESHOLDS.inactiveDays) {
    flags.push({ kind: "inactive", severity: inactiveDays >= THRESHOLDS.inactiveHighDays ? "high" : "normal", contentId: null, contentKind: null, contentTitle: null, detail: `no activity for ${inactiveDays} days` });
  } else if (
    inactiveDays === null &&
    earliestAssigned &&
    (daysAgo(earliestAssigned, nowMs) ?? 0) >= THRESHOLDS.inactiveDays &&
    !flags.some((f) => f.kind === "not_started")
  ) {
    // Never active at all: one flag, not two — "not started" already says it
    // when there is an assignment to start.
    flags.push({ kind: "inactive", severity: "normal", contentId: null, contentKind: null, contentTitle: null, detail: "never active since being assigned" });
  }
  const maxNudges = Math.max(0, ...courses.map((c) => c.nudges));
  const risk = riskOf(flags, inactiveDays, maxNudges);
  const status = statusOf(flags, risk);
  if (status === "needs_support") {
    const distinct = [...new Set(flags.map((f) => f.kind))];
    flags.push({ kind: "needs_support", severity: "critical", contentId: null, contentKind: null, contentTitle: null,
      detail: distinct.map((k) => k.replace("_", " ")).join(" · ") });
  }

  return {
    assigned,
    completed,
    completionPct: assigned > 0 ? Math.round((completed / assigned) * 100) : null,
    avgScore,
    assessmentsWithResult: withResult.length,
    passedFirstTime: courses.filter((c) => c.passedFirstTime).length,
    inactiveDays,
    activeLast7d: !!lastActive && lastActive >= activeCutoff,
    flags,
    risk,
    status,
    completedInPeriod,
    passedFirstTimeInPeriod,
    journeyDaysInPeriod,
    completedInPrevPeriod,
  };
}
