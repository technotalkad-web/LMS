import {
  SEVERITY_RANK,
  type ExceptionAction,
  type ExceptionFlag,
  type ExceptionGroup,
  type ExceptionKind,
  type LearnerInsight,
  type LearnerStatus,
  type PeriodSummary,
  type Severity,
  type Signal,
  type Struggle,
  type TeamScore,
  type Tone,
} from "./types";

/**
 * Manager Report Card — the RULES (§2, §3, §10 of the approved proposal;
 * decisions 4 and 5). Pure functions over LearnerInsight rows so they are
 * unit-testable and identical at every level (person, team, city, org).
 */

// ---------------------------------------------------------------------------
// Thresholds (decision 4/5) — one place to tune.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  completion: { ok: 85, warn: 65 },
  assessment: { ok: 75, warn: 60 },
  journey: { ok: 80, warn: 60 },
  engagement: { ok: 70, warn: 50 },
  score: { ok: 80, warn: 65 },
  /** Stuck: in progress this many days with under `stuckPct` progress … */
  stuckDays: 10,
  stuckPct: 30,
  /** … or no activity on it for this many days. */
  stuckIdleDays: 7,
  notStartedDays: 7,
  inactiveDays: 7,
  inactiveHighDays: 14,
  journeyEscalateBehind: 3,
  activeWindowDays: 7,
  /** The analytics risk score at which a person "needs support". */
  needsSupportRisk: 5,
  watchRisk: 3,
} as const;

export const WEIGHTS = { completion: 35, assessment: 25, journey: 25, engagement: 15 } as const;

export const SEVERITY_META: Record<Severity, { label: string; tone: Tone }> = {
  critical: { label: "Critical", tone: "bad" },
  high: { label: "High", tone: "warn" },
  normal: { label: "Normal", tone: "warn" },
};

export const EXCEPTION_META: Record<
  ExceptionKind,
  { title: (n: number) => string; suggestion: string }
> = {
  failed: { title: (n) => `${n} failed an assessment`, suggestion: "Coach, then grant a retry" },
  overdue: { title: (n) => `${n} overdue`, suggestion: "Agree a catch-up date this week" },
  behind: { title: (n) => `${n} behind on journey`, suggestion: "Follow up; ask what is blocking" },
  stuck: { title: (n) => `${n} stuck on a course`, suggestion: "Unblock: content, time or access?" },
  not_started: { title: (n) => `${n} haven't started`, suggestion: "Nudge to start; confirm access" },
  inactive: { title: (n) => `${n} inactive 7+ days`, suggestion: "Check in; may be on leave or disengaged" },
  needs_support: { title: (n) => `${n} need manager support`, suggestion: "1:1 conversation this week" },
};

export function toneFor(value: number | null, t: { ok: number; warn: number }): Tone {
  if (value === null) return "none";
  return value >= t.ok ? "ok" : value >= t.warn ? "warn" : "bad";
}

const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 100) : null);
const mean = (xs: number[]): number | null =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

// ---------------------------------------------------------------------------
// Per-person status (§4 roster)
// ---------------------------------------------------------------------------

/** Analytics risk score (v1 weights) over the person's flags — kept explainable. */
export function riskOf(flags: ExceptionFlag[], inactiveDays: number | null, maxNudges: number): number {
  let risk = 0;
  const has = (k: ExceptionKind) => flags.some((f) => f.kind === k);
  const behind = flags.filter((f) => f.kind === "behind");
  if (behind.length) risk += behind.some((f) => f.severity === "critical") ? 3 : 1;
  const overdue = flags.filter((f) => f.kind === "overdue").length;
  if (overdue) risk += Math.min(overdue, 3) * 2;
  if (has("failed")) risk += 2;
  if (inactiveDays !== null && inactiveDays >= THRESHOLDS.inactiveHighDays) risk += inactiveDays >= 21 ? 3 : 2;
  else if (has("not_started") && inactiveDays === null) risk += 2;
  if (maxNudges >= 3) risk += 2;
  return risk;
}

export function statusOf(flags: ExceptionFlag[], risk: number): LearnerStatus {
  const distinct = new Set(flags.filter((f) => f.kind !== "needs_support").map((f) => f.kind));
  if (risk >= THRESHOLDS.needsSupportRisk || distinct.size >= 2) return "needs_support";
  if (distinct.size >= 1 || risk >= THRESHOLDS.watchRisk) return "watch";
  return "on_track";
}

/** Worst-first ordering for the roster. */
export function compareWorstFirst(a: LearnerInsight, b: LearnerInsight): number {
  const rank: Record<LearnerStatus, number> = { needs_support: 0, watch: 1, on_track: 2 };
  return (
    rank[a.status] - rank[b.status] ||
    b.risk - a.risk ||
    b.flags.length - a.flags.length ||
    a.name.localeCompare(b.name)
  );
}

// ---------------------------------------------------------------------------
// Team score (§2)
// ---------------------------------------------------------------------------

export function teamScore(learners: LearnerInsight[]): TeamScore {
  const assigned = learners.reduce((s, l) => s + l.assigned, 0);
  const completed = learners.reduce((s, l) => s + l.completed, 0);
  const completion = pct(completed, assigned);

  const scores = learners.map((l) => l.avgScore).filter((v): v is number => v !== null);
  const assessment = mean(scores);
  const withResult = learners.reduce((s, l) => s + l.assessmentsWithResult, 0);
  const firstTime = learners.reduce((s, l) => s + l.passedFirstTime, 0);

  const journeyLearners = learners.filter((l) => l.journeys.some((j) => j.status === "active"));
  const onTrack = journeyLearners.filter((l) =>
    l.journeys.filter((j) => j.status === "active").every((j) => j.onTrack)
  ).length;
  const journey = pct(onTrack, journeyLearners.length);

  const engagement = pct(learners.filter((l) => l.activeLast7d).length, learners.length);

  const signals: Signal[] = [
    {
      key: "completion",
      label: "Learning completion",
      value: completion,
      tone: toneFor(completion, THRESHOLDS.completion),
      display: completion === null ? "—" : `${completion}%`,
      note: assigned ? `${completed} of ${assigned} assigned items done` : "Nothing assigned yet",
      weight: WEIGHTS.completion,
    },
    {
      key: "assessment",
      label: "Assessment performance",
      value: assessment,
      tone: toneFor(assessment, THRESHOLDS.assessment),
      display: assessment === null ? "—" : `${assessment} avg`,
      note: withResult ? `${firstTime} of ${withResult} passed first time` : "No assessments taken yet",
      weight: WEIGHTS.assessment,
    },
    {
      key: "journey",
      label: "Journey progress",
      value: journey,
      tone: toneFor(journey, THRESHOLDS.journey),
      display: journey === null ? "—" : `${journey}% on track`,
      note: journeyLearners.length
        ? `${onTrack} of ${journeyLearners.length} journey learners on track`
        : "No active journey in this team",
      weight: WEIGHTS.journey,
    },
    {
      key: "engagement",
      label: "Engagement (7 days)",
      value: engagement,
      tone: toneFor(engagement, THRESHOLDS.engagement),
      display: engagement === null ? "—" : `${engagement}% active`,
      note: learners.length ? `${learners.filter((l) => l.activeLast7d).length} of ${learners.length} active this week` : null,
      weight: WEIGHTS.engagement,
    },
  ];

  // Weighted average over the signals that have data; a missing signal's
  // weight is redistributed (the proposal names journey; the same rule keeps
  // a brand-new team without assessments from scoring 0 on them).
  const live = signals.filter((s) => s.value !== null);
  const wsum = live.reduce((s, x) => s + x.weight, 0);
  const score = wsum > 0 ? Math.round(live.reduce((s, x) => s + x.value! * x.weight, 0) / wsum) : null;
  const tone = toneFor(score, THRESHOLDS.score);
  const label = score === null ? "No data yet" : tone === "ok" ? "Good" : tone === "warn" ? "Needs attention" : "Needs support";
  return { score, tone, label, signals };
}

// ---------------------------------------------------------------------------
// "What needs your attention" (§3): at most five groups, severity first.
// ---------------------------------------------------------------------------

const KIND_ORDER: ExceptionKind[] = ["needs_support", "failed", "overdue", "behind", "stuck", "not_started", "inactive"];

export function buildExceptions(
  learners: LearnerInsight[],
  opts: { orgSlug: string; max?: number; namesVisible?: boolean }
): ExceptionGroup[] {
  const max = opts.max ?? 5;
  const groups: ExceptionGroup[] = [];
  for (const kind of KIND_ORDER) {
    // One entry per learner (their worst flag of this kind) for the count,
    // people and severity; EVERY flag of the kind for the content tally and
    // the action targets (a learner can be failed/overdue on several modules).
    const hits: Array<{ l: LearnerInsight; f: ExceptionFlag }> = [];
    const all: Array<{ l: LearnerInsight; f: ExceptionFlag }> = [];
    for (const l of learners) {
      const mine = l.flags.filter((x) => x.kind === kind).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
      if (mine.length) hits.push({ l, f: mine[0] });
      for (const f of mine) all.push({ l, f });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || b.l.risk - a.l.risk);
    const severity = hits[0].f.severity;
    const tally = new Map<string, { id: string; kind: "course" | "path" | "journey"; title: string; n: number }>();
    for (const { f } of all) {
      if (!f.contentId || !f.contentKind) continue;
      const cur = tally.get(f.contentId) ?? { id: f.contentId, kind: f.contentKind, title: f.contentTitle ?? "", n: 0 };
      cur.n++;
      tally.set(f.contentId, cur);
    }
    const content = [...tally.values()].sort((a, b) => b.n - a.n || a.title.localeCompare(b.title))[0] ?? null;
    const userIds = hits.map((h) => h.l.userId);
    const actions = actionsFor(kind, content, userIds, all, opts.orgSlug);
    groups.push({
      kind,
      severity,
      title: EXCEPTION_META[kind].title(hits.length),
      count: hits.length,
      people: hits.slice(0, 6).map(({ l, f }) => ({ userId: l.userId, name: opts.namesVisible === false ? "A team member" : l.name, detail: f.detail })),
      content,
      suggestion: EXCEPTION_META[kind].suggestion,
      actions,
    });
  }
  groups.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.count - a.count ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  );
  return groups.slice(0, max);
}

function actionsFor(
  kind: ExceptionKind,
  content: ExceptionGroup["content"],
  userIds: string[],
  all: Array<{ l: LearnerInsight; f: ExceptionFlag }>,
  orgSlug: string
): ExceptionAction[] {
  const base = `/${orgSlug}/team-performance`;
  /** Learners with a flag of this kind on exactly this content. */
  const onContent = (): string[] =>
    content ? [...new Set(all.filter((h) => h.f.contentId === content.id).map((h) => h.l.userId))] : [];
  switch (kind) {
    case "failed": {
      // Grant retries on the most common failed module, for the people who
      // failed THAT module, have used their official window and do not
      // already hold an open grant.
      const eligible = content
        ? [...new Set(all
            .filter(({ l, f }) => {
              if (f.contentId !== content.id) return false;
              const line = l.courses.find((c) => c.courseId === content.id);
              return !!line && line.limitReached && !line.openGrant;
            })
            .map((h) => h.l.userId))]
        : [];
      return [
        ...(content && eligible.length
          ? [{ kind: "grant" as const, label: `Grant retry · ${content.title}`, courseId: content.id, userIds: eligible }]
          : []),
        ...(content ? [{ kind: "link" as const, label: "View module", href: `${base}?content=course:${content.id}` }] : []),
      ];
    }
    case "overdue":
      return [
        { kind: "link", label: "View overdue", href: `${base}?status=overdue` },
        ...(content && content.kind === "course"
          ? [{ kind: "remind" as const, label: "Send reminder", target: "course" as const, contentId: content.id, userIds: onContent() }]
          : []),
      ];
    case "behind":
      return [
        ...(content ? [{ kind: "remind" as const, label: "Send reminder", target: "journey" as const, contentId: content.id, userIds: onContent() }] : []),
        { kind: "link", label: "View journey", href: content ? `${base}?content=journey:${content.id}` : base },
      ];
    case "stuck":
      return [
        ...(content ? [{ kind: "remind" as const, label: "Send reminder", target: "course" as const, contentId: content.id, userIds: onContent() }] : []),
        { kind: "link", label: "View learners", href: `${base}?status=stuck` },
      ];
    case "not_started":
      return content
        ? [{ kind: "remind", label: "Send start reminder", target: "start", contentId: content.id, userIds: onContent() }]
        : [];
    case "inactive":
      return [{ kind: "link", label: "View employees", href: `${base}?status=inactive` }];
    case "needs_support": {
      // The person with the highest risk opens first.
      const first = [...all].sort((a, b) => b.l.risk - a.l.risk)[0]?.l ?? null;
      void userIds;
      return first ? [{ kind: "report", label: `Open ${first.name.split(" ")[0]}'s report`, userId: first.userId }] : [];
    }
  }
}

// ---------------------------------------------------------------------------
// Where the team struggles (§10): pivot exceptions by content, benchmark.
// ---------------------------------------------------------------------------

export function buildStruggles(
  learners: LearnerInsight[],
  benchmark: Map<string, { failRate: number | null; enrolled: number }>,
  max = 5
): Struggle[] {
  const byCourse = new Map<string, Struggle>();
  const row = (id: string, title: string): Struggle => {
    const cur = byCourse.get(id);
    if (cur) return cur;
    const s: Struggle = { id, kind: "course", title, failed: 0, stuck: 0, notStarted: 0, overdue: 0, pending: 0, total: 0, teamFailRate: null, orgFailRate: null, diagnosis: null };
    byCourse.set(id, s);
    return s;
  };
  const enrolledByCourse = new Map<string, number>();
  const failedByCourse = new Map<string, number>();
  for (const l of learners) {
    for (const c of l.courses) {
      enrolledByCourse.set(c.courseId, (enrolledByCourse.get(c.courseId) ?? 0) + 1);
      if (c.status === "failed" || c.passRequiredUnmet) failedByCourse.set(c.courseId, (failedByCourse.get(c.courseId) ?? 0) + 1);
    }
    for (const f of l.flags) {
      if (f.contentKind !== "course" || !f.contentId) continue;
      const s = row(f.contentId, f.contentTitle ?? "");
      if (f.kind === "failed") s.failed++;
      else if (f.kind === "stuck") s.stuck++;
      else if (f.kind === "not_started") s.notStarted++;
      else if (f.kind === "overdue") s.overdue++;
      else continue;
      s.total++;
    }
  }
  // Journey days: pending missions among people behind.
  const byDay = new Map<string, Struggle>();
  for (const l of learners) {
    for (const j of l.journeys) {
      if (j.status !== "active" || j.behind <= 0 || !j.nextModule) continue;
      const id = `${j.programId}:${j.day}`;
      const cur = byDay.get(id) ?? { id, kind: "journey-day" as const, title: `Day ${j.day} · ${j.nextModule}`, failed: 0, stuck: 0, notStarted: 0, overdue: 0, pending: 0, total: 0, teamFailRate: null, orgFailRate: null, diagnosis: null };
      cur.pending++;
      cur.total++;
      byDay.set(id, cur);
    }
  }
  for (const s of byCourse.values()) {
    const enrolled = enrolledByCourse.get(s.id) ?? 0;
    s.teamFailRate = pct(failedByCourse.get(s.id) ?? 0, enrolled);
    const b = benchmark.get(s.id);
    s.orgFailRate = b?.failRate ?? null;
    if (s.failed > 0 && s.teamFailRate !== null) {
      if (s.orgFailRate !== null && s.orgFailRate >= 20) s.diagnosis = "content";
      else if (s.orgFailRate === null || s.teamFailRate >= Math.max(15, s.orgFailRate * 2)) s.diagnosis = "team";
    } else if (s.notStarted > 0 && s.failed === 0 && s.stuck === 0) {
      s.diagnosis = "timing";
    }
  }
  return [...byCourse.values(), ...byDay.values()].sort((a, b) => b.total - a.total || a.title.localeCompare(b.title)).slice(0, max);
}

// ---------------------------------------------------------------------------
// "This period"
// ---------------------------------------------------------------------------

export function periodSummary(learners: LearnerInsight[], days: number | null): PeriodSummary {
  const coursesCompleted = learners.reduce((s, l) => s + l.completedInPeriod, 0);
  const prev = learners.reduce((s, l) => s + l.completedInPrevPeriod, 0);
  return {
    days,
    coursesCompleted,
    passedFirstTime: learners.reduce((s, l) => s + l.passedFirstTimeInPeriod, 0),
    assessmentsWithResult: learners.reduce((s, l) => s + l.assessmentsWithResult, 0),
    journeyMissions: learners.reduce((s, l) => s + l.journeyDaysInPeriod, 0),
    completionsDelta: days === null ? null : coursesCompleted - prev,
  };
}

/** Roster filter (§9 Status). */
export function matchesStatusFilter(l: LearnerInsight, filter: string): boolean {
  if (!filter) return true;
  if (filter === "on_track" || filter === "watch" || filter === "needs_support") return l.status === filter;
  return l.flags.some((f) => f.kind === filter);
}
