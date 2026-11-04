/**
 * Manager Report Card — client-safe types and constants (no server imports).
 * The rules themselves live in report-card.ts; the data loader in insights.ts.
 */

/** Exception kinds, §3 of the proposal, in display vocabulary. */
export type ExceptionKind =
  | "failed"
  | "overdue"
  | "behind"
  | "stuck"
  | "not_started"
  | "inactive"
  | "needs_support";

export type Severity = "critical" | "high" | "normal";
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, normal: 2 };

/**
 * The three words every status uses, plus "unavailable": the learner's
 * official-result chain could not be read (a failed grant read, ADR 0014:188),
 * so no status is computed from their lines.
 */
export type LearnerStatus = "on_track" | "watch" | "needs_support" | "unavailable";
export const STATUS_LABEL: Record<LearnerStatus, string> = {
  on_track: "On track",
  watch: "Watch",
  needs_support: "Needs support",
  unavailable: "History unavailable. Please reload.",
};

export type Tone = "ok" | "warn" | "bad" | "none";

/** One flag on one learner: what → where → since when. */
export type ExceptionFlag = {
  kind: ExceptionKind;
  severity: Severity;
  /** Course / path / journey the flag is about (null for inactive). */
  contentId: string | null;
  contentKind: "course" | "path" | "journey" | null;
  contentTitle: string | null;
  /** Human reason, e.g. "3 days behind", "opened 12 days ago, 20%". */
  detail: string;
};

export type JourneyInsight = {
  programId: string;
  name: string;
  status: "active" | "completed";
  unlockMode: "calendar" | "progress";
  day: number;
  total: number;
  behind: number;
  overdueDeadline: boolean;
  daysDone: number;
  courseDays: number;
  /** Today's / the current mission's title, for the reminder and the card. */
  nextModule: string | null;
  onTrack: boolean;
  /** Missions completed inside the period window (for the period summary). */
  daysInPeriod: number;
};

export type CourseLine = {
  courseId: string;
  title: string;
  /** "unavailable": the grant read failed (ADR 0014:188); the row then carries no figure. */
  status: "not_started" | "in_progress" | "completed" | "passed" | "failed" | "unavailable";
  /** Official score 0–100, null until an official result exists. */
  officialScore: number | null;
  /** Attempts that were not reset (abandoned attempts are counted in resetAttempts). */
  attempts: number;
  /** Attempts reset by a module update or language switch (ADR 0004 step 11); shown as "· N reset". */
  resetAttempts?: number;
  /** Learner-visible progress 0–100 (null when unknown). */
  progressPct: number | null;
  assignedAt: string | null;
  dueAt: string | null;
  overdue: boolean;
  startedAt: string | null;
  lastActivity: string | null;
  /** The official attempt was the learner's FIRST completed attempt and it passed. */
  passedFirstTime: boolean;
  /** Pass-required module not yet passed (counts as "failed" for the exception rule). */
  passRequiredUnmet: boolean;
  /** Reminders this learner has had on the course (reminder_state.nudge_count). */
  nudges: number;
  /** An approved, unused extra attempt already exists (so "grant retry" is moot). */
  openGrant: boolean;
  /** The official window is used up — a grant is the only way to another official attempt. */
  limitReached: boolean;
  /** Completion instant of the OFFICIAL attempt (decision 1), for the period counters. */
  completedAt: string | null;
  /** Done under the official rule incl. pass_required (what "completed" counts). */
  done: boolean;
  /** Reached by an assignment (not only attempted); what "assigned" counts. */
  isAssigned: boolean;
  /**
   * ADR 0014 step 7, from officialRetakeState: "in_progress" while a granted
   * retake runs, "completed" when the current official result is a retake.
   * Optional so a cached row written before PR 1b still renders.
   */
  retakeState?: "none" | "in_progress" | "completed";
  /**
   * The official result a granted retake replaces: while the retake runs,
   * the standing result ("your previous result … stays in your history until
   * you finish", ADR 0014:186); after it completes, the superseded one. Null
   * otherwise. Score 0–100.
   */
  previousOfficial?: { score: number | null; status: "passed" | "failed" | "completed"; completedAt: string } | null;
  /** The grant read failed (ADR 0014:188): the row shows "History unavailable. Please reload." and no figure. */
  historyUnavailable?: boolean;
};

export type PathLine = {
  pathId: string;
  name: string;
  stepsTotal: number;
  stepsDone: number;
  dueAt: string | null;
  overdue: boolean;
  /** The grant read failed: stepsDone and overdue are not computed and the path list prints the text. */
  historyUnavailable?: boolean;
};

export type LearnerInsight = {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  designation: string | null;
  city: string | null;
  branch: string | null;
  /** business_vertical, for the L3 vertical filter. */
  vertical: string | null;
  /** department under the vertical (0096; the visibility rule of Phase 4c reads it). */
  department: string | null;
  joined: string | null;
  // Signals
  assigned: number;
  completed: number;
  /** 0–100, null when nothing is assigned. */
  completionPct: number | null;
  /** Mean official score over courses with an official result, 0–100. */
  avgScore: number | null;
  assessmentsWithResult: number;
  passedFirstTime: number;
  lastActive: string | null;
  inactiveDays: number | null;
  activeLast7d: boolean;
  journeys: JourneyInsight[];
  courses: CourseLine[];
  paths: PathLine[];
  // Exceptions
  flags: ExceptionFlag[];
  risk: number;
  status: LearnerStatus;
  // Period ("this month") contributions
  completedInPeriod: number;
  passedFirstTimeInPeriod: number;
  journeyDaysInPeriod: number;
  completedInPrevPeriod: number;
  /**
   * ADR 0014:188: the grant read failed, so
   * every course and path line is text only and no completion, score, flag
   * or status is derived from them; the team folds leave this learner out.
   */
  historyUnavailable?: boolean;
  /** The newest revision visit on any course (ADR 0014:199, "Last revisit" beside the inactive flag); null when none or unread. */
  lastRevisitAt?: string | null;
};

export type Signal = {
  key: "completion" | "assessment" | "journey" | "engagement";
  label: string;
  /** 0–100 or null when there is nothing to measure. */
  value: number | null;
  tone: Tone;
  /** Short rendering, e.g. "86%", "78 avg", "58% on track". */
  display: string;
  /** Secondary line, e.g. "22 of 28 passed first time". */
  note: string | null;
  weight: number;
};

export type TeamScore = {
  score: number | null;
  tone: Tone;
  label: string;
  signals: Signal[];
  /** Learners left out of every signal because their history could not be read (ADR 0014:188). */
  unavailable: number;
};

export type ExceptionGroup = {
  kind: ExceptionKind;
  severity: Severity;
  title: string;
  count: number;
  /** Named people (worst first), capped for display. */
  people: Array<{ userId: string; name: string; detail: string }>;
  /** The most common content among the flagged people, if any. */
  content: { id: string; kind: "course" | "path" | "journey"; title: string; n: number } | null;
  suggestion: string;
  /** Primary + secondary buttons the UI renders. */
  actions: ExceptionAction[];
};

/** A person a ticket may name (id + display name; the server re-checks the id). */
export type TicketPerson = { userId: string; name: string };

export type ExceptionAction =
  /** Raise a support ticket with this context (decision 12: managers view, analyse, support). */
  | {
      kind: "ticket";
      label: string;
      category: "grant_retry" | "assign_content" | "extend_due" | "content_issue" | "other";
      people: TicketPerson[];
      content: { kind: "course" | "journey" | "path"; id: string; title: string } | null;
      exception: ExceptionKind | null;
    }
  | { kind: "remind"; label: string; target: "course" | "journey" | "start"; contentId: string | null; userIds: string[] }
  | { kind: "link"; label: string; href: string }
  | { kind: "report"; label: string; userId: string };

export type Struggle = {
  id: string;
  kind: "course" | "journey-day";
  title: string;
  failed: number;
  stuck: number;
  notStarted: number;
  overdue: number;
  pending: number;
  total: number;
  /** Team fail rate (%) vs the organisation's, when known. */
  teamFailRate: number | null;
  orgFailRate: number | null;
  /** "team" when the team is far above the org rate; "content" when the org rate is high too; "timing" for fresh not-started. */
  diagnosis: "team" | "content" | "timing" | null;
};

export type PeriodSummary = {
  days: number | null;
  coursesCompleted: number;
  passedFirstTime: number;
  assessmentsWithResult: number;
  journeyMissions: number;
  /** completions this period minus the previous period of the same length. */
  completionsDelta: number | null;
  /** Learners left out of every sum because their history could not be read (ADR 0014:188). */
  unavailable: number;
};

export const PERIODS = [
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "all", label: "All time", days: null },
] as const;

export const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "on_track", label: "On track" },
  { value: "watch", label: "Watch" },
  { value: "needs_support", label: "Needs support" },
  { value: "not_started", label: "Not started" },
  { value: "failed", label: "Failed" },
  { value: "overdue", label: "Overdue" },
  { value: "behind", label: "Behind on journey" },
  { value: "stuck", label: "Stuck" },
  { value: "inactive", label: "Inactive" },
];

// ---------------------------------------------------------------------------
// Phase 2 — L2 "team of teams" (§6)
// ---------------------------------------------------------------------------

/** One L1 team inside the viewer's hierarchy, scored like a person. */
export type TeamCard = {
  managerId: string;
  managerName: string;
  /** The viewer's own direct team (they are also someone's L1). */
  isOwn: boolean;
  size: number;
  score: TeamScore;
  failed: number;
  overdue: number;
  behind: number;
  stuck: number;
  notStarted: number;
  inactive: number;
  needsSupport: number;
  /** Most-failed module in this team, if any. */
  topFailed: { id: string; title: string; n: number } | null;
  /** Completions this period minus the previous period (null for all time). */
  completionsDelta: number | null;
  /** People in the team with at least one exception (for a ticket raised about the team). */
  flagged: TicketPerson[];
  /** Members whose history could not be read, left out of the score (= score.unavailable). */
  unavailable: number;
};

/** A team that needs the L2's attention, with one suggested step. */
export type TeamException = {
  managerId: string;
  managerName: string;
  isOwn: boolean;
  severity: Severity;
  /** e.g. "5 failed Objection Handling · 6 overdue · journey on track 43%" */
  summary: string;
  suggestion: string;
  actions: ExceptionAction[];
};

/** Content that several teams struggle with → likely a content/training gap, not one manager. */
export type CommonStruggle = {
  id: string;
  kind: "course" | "journey-day";
  title: string;
  teamsAffected: number;
  /** Teams where at least one person FAILED it (drives the "content gap" rule). */
  teamsFailing: number;
  teamsTotal: number;
  /** Distinct learners flagged on it across the hierarchy. */
  learners: number;
  /** Breakdown by exception kind. */
  failed: number;
  stuck: number;
  notStarted: number;
  overdue: number;
  pending: number;
  diagnosis: "content" | "spread" | null;
};

// ---------------------------------------------------------------------------
// Phase 3 — L3 organisation view (§7)
// ---------------------------------------------------------------------------

/** An org-wide learning gap: content that fails / stalls across the hierarchy. */
export type OrgGap = {
  id: string;
  kind: "course" | "journey-day";
  title: string;
  /** Learners in the hierarchy flagged on it (distinct). */
  learners: number;
  failed: number;
  notStarted: number;
  stuck: number;
  overdue: number;
  pending: number;
  /** Hierarchy fail rate (%) among people with the course, and the org benchmark. */
  failRate: number | null;
  orgFailRate: number | null;
  /** Share of assigned people who have not started (%). */
  notStartedRate: number | null;
  /** Cities / groups affected. */
  groupsAffected: number;
  groupsTotal: number;
  /** One line a national head can act on. */
  advice: string;
};
