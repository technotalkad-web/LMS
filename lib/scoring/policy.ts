/**
 * Attempt scoring rules (0073) — client-safe, no imports.
 *
 * Learners may revisit a module as often as they like; these rules decide
 * which attempts COUNT. A policy has a scoring window (the first N completed
 * attempts), an official-score basis inside that window, and what happens
 * after the window is used up (practice = unscored relaunches, block = no
 * more launches). ADR 0014 retires the window: normalizePolicy() clamps
 * every rule to DEFAULT_POLICY, and a revision visit's row (is_revision)
 * never counts.
 *
 * computeScoring() mirrors public.v_course_attempt_scoring byte-for-byte in
 * intent: completed attempts ordered by (completed_at ?? started_at,
 * started_at, id); the first N are scored, the rest are practice. Keep the
 * two in sync.
 */

export type OfficialBasis = "first" | "best" | "latest" | "nth";
export type AfterLimit = "practice" | "block";
export type RuleScope = "course" | "path" | "journey";

export type AttemptPolicy = {
  max_scored_attempts: number;
  official_basis: OfficialBasis;
  official_attempt_number: number | null;
  retain_first_attempt: boolean;
  after_limit: AfterLimit;
};

export type EffectivePolicy = AttemptPolicy & {
  /** Where the rule came from. "default" = nothing configured anywhere. */
  source: RuleScope | "default";
  source_id: string | null;
};

/** A stored rule row (attempt_scoring_rules). */
export type ScoringRule = AttemptPolicy & {
  id: string;
  organization_id: string;
  scope: RuleScope;
  target_id: string;
  updated_at: string;
};

/**
 * Platform default (0081): ONE official attempt, first attempt is official,
 * unlimited revision afterwards. Mirrors effective_attempt_policy() in SQL.
 */
export const DEFAULT_POLICY: EffectivePolicy = {
  max_scored_attempts: 1,
  official_basis: "first",
  official_attempt_number: null,
  retain_first_attempt: true,
  after_limit: "practice",
  source: "default",
  source_id: null,
};

export const OFFICIAL_BASIS_OPTIONS: Array<{
  value: OfficialBasis;
  label: string;
  hint: string;
}> = [
  {
    value: "first",
    label: "First attempt",
    hint: "The score a learner gets before any revision — the truest measure of training effectiveness. Cannot be inflated by retakes.",
  },
  {
    value: "best",
    label: "Best of scored attempts",
    hint: "The highest score inside the scoring window. Rewards mastery; retakes can only improve the number.",
  },
  {
    value: "latest",
    label: "Latest scored attempt",
    hint: "The most recent attempt inside the window. Reflects current knowledge, but a careless retake can lower it.",
  },
  {
    value: "nth",
    label: "A specific attempt",
    hint: "Exactly attempt #N (e.g. the 2nd). The official score appears only once that attempt is completed.",
  },
];

/**
 * ADR 0014 steps 6 and 9 (Q1, "Retire the multi-attempt setting"): every
 * rule is clamped to DEFAULT_POLICY, one official attempt and then
 * review-only revision visits; extra official attempts only by grant. The
 * SQL twin is 0103's effective_attempt_policy(). Only where the rule came
 * from (`source`, `source_id`) is still read from the input; the stored
 * values stay in attempt_scoring_rules untouched (no row is rewritten), so
 * `blocked` is always false and `practiceMode === limitReached`.
 */
export function normalizePolicy(raw: unknown): EffectivePolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const source = r.source as EffectivePolicy["source"];
  return {
    max_scored_attempts: DEFAULT_POLICY.max_scored_attempts,
    official_basis: DEFAULT_POLICY.official_basis,
    official_attempt_number: DEFAULT_POLICY.official_attempt_number,
    retain_first_attempt: DEFAULT_POLICY.retain_first_attempt,
    after_limit: DEFAULT_POLICY.after_limit,
    source: ["course", "path", "journey", "default"].includes(source) ? source : "default",
    source_id: typeof r.source_id === "string" ? r.source_id : null,
  };
}

/**
 * ADR 0014 step 9: POST /api/scoring-rules refuses any rule
 * value other than the default. Reads the RAW request body: each of the five
 * rule fields is either absent (undefined or null, which the route's fills
 * already read as the default) or equal to DEFAULT_POLICY's value; a numeric
 * string counts as its number ("1" is 1). `after_limit: "block"` is never
 * default. Pure, so the route's rule is unit-tested
 * (tests/unit/scoring-rules-route.test.ts).
 */
export function isDefaultRule(body: unknown): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  const absent = (v: unknown) => v === undefined || v === null;
  const max = b.max_scored_attempts;
  const maxOk =
    absent(max) ||
    (typeof max === "number" && max === DEFAULT_POLICY.max_scored_attempts) ||
    (typeof max === "string" && max.trim() !== "" && Number(max) === DEFAULT_POLICY.max_scored_attempts);
  return (
    maxOk &&
    (absent(b.official_basis) || b.official_basis === DEFAULT_POLICY.official_basis) &&
    (absent(b.official_attempt_number) || b.official_attempt_number === DEFAULT_POLICY.official_attempt_number) &&
    (absent(b.retain_first_attempt) || b.retain_first_attempt === DEFAULT_POLICY.retain_first_attempt) &&
    (absent(b.after_limit) || b.after_limit === DEFAULT_POLICY.after_limit)
  );
}

export type ScorableAttempt = {
  id: string;
  score: number | null;
  started_at: string;
  completed_at: string | null;
  completion_status?: string | null;
  success_status?: string | null;
  /** course_attempts.status; 'abandoned' attempts never count (see excludeAbandoned). */
  status?: string | null;
  /**
   * course_attempts.is_revision (0103, ADR 0014): a revision visit's row is
   * never an attempt. Undefined on a database without 0103 (= false).
   */
  is_revision?: boolean | null;
};

/**
 * Blueprint R6, extended by ADR 0004 step 11: an abandoned attempt is never
 * official AND never in progress. It is terminal history (a reset learner
 * reads as not started until they launch again). Callers that do not select
 * `status` are unaffected.
 */
export function isAbandonedAttempt(a: object): boolean {
  return (a as { status?: unknown }).status === "abandoned";
}

/**
 * ADR 0014 step 6: a revision visit's row (is_revision = true) never enters
 * any attempt count, scoring window or status. Only `true` flags a row: a
 * row read from a database without 0103, or by a select that does not name
 * the column, reads as unflagged.
 */
export function isRevisionAttempt(a: object): boolean {
  return (a as { is_revision?: unknown }).is_revision === true;
}

/**
 * The attempts that count for status, scoring and progress: neither
 * abandoned (ADR 0004 step 11) nor a revision visit's row (ADR 0014 step 6).
 */
export function excludeAbandoned<T extends object>(attempts: T[]): T[] {
  const drop = (a: T) => isAbandonedAttempt(a) || isRevisionAttempt(a);
  return attempts.some(drop) ? attempts.filter((a) => !drop(a)) : attempts;
}

/**
 * A granted retake that still blocks a new grant: one of `retakeIds` that is
 * in progress and not finished. One a force restart reset (status
 * 'abandoned') is closed for good and never blocks (ADR 0004 step 11).
 */
export function hasLiveGrantedRetake(
  attempts: Array<{ id: string; status?: string | null; completion_status?: string | null; success_status?: string | null }>,
  retakeIds: ReadonlySet<string>
): boolean {
  return attempts.some(
    (x) => retakeIds.has(x.id) && x.status === "in_progress" && !(x.completion_status === "completed" || x.success_status === "passed")
  );
}

/**
 * Step 8 of ADR 0014: the learner course page's "Your retake was reset…"
 * notice. True when the newest row by `started_at` among the learner's
 * NON-REVISION rows on the course is an abandoned grant retake and no
 * granted retake is live. Revision rows are skipped: after the reset the
 * learner's next launch opens a revision row, which would otherwise hide
 * the notice for good ("a revision visit is never an attempt"). The page
 * hides it once a request is pending or a grant is live (its own inputs).
 */
export function latestResetRetake(
  attempts: Array<{
    id: string;
    started_at?: string | null;
    status?: string | null;
    completion_status?: string | null;
    success_status?: string | null;
    is_revision?: boolean | null;
  }>,
  retakeIds: ReadonlySet<string>
): boolean {
  if (retakeIds.size === 0) return false;
  let newest: (typeof attempts)[number] | undefined;
  for (const a of attempts) {
    if (isRevisionAttempt(a)) continue;
    if (!newest) {
      newest = a;
      continue;
    }
    const ka = ts(a.started_at);
    const kn = ts(newest.started_at);
    if (ka > kn || (ka === kn && a.id > newest.id)) newest = a;
  }
  if (!newest || newest.status !== "abandoned" || !retakeIds.has(newest.id)) return false;
  return !hasLiveGrantedRetake(attempts, retakeIds);
}

/**
 * Attempt counts for admin tables (ADR 0004 step 11): `live` = attempts that
 * were not reset, the number a table shows; `reset` = abandoned attempts,
 * shown as a small "· N reset" suffix when N > 0. A revision visit's row
 * (ADR 0014 step 6) is neither.
 */
export function attemptCounts(attempts: object[]): { live: number; reset: number } {
  let reset = 0;
  let live = 0;
  for (const a of attempts) {
    if (isRevisionAttempt(a)) continue;
    if (isAbandonedAttempt(a)) reset++;
    else live++;
  }
  return { live, reset };
}

/** House completion definition (matches the SQL everywhere). */
export function isCompletedAttempt(a: {
  completion_status?: string | null;
  success_status?: string | null;
}): boolean {
  return a.completion_status === "completed" || a.success_status === "passed";
}

export type ScoringResult = {
  policy: EffectivePolicy;
  completedAttempts: number;
  scoredAttempts: number;
  practiceAttempts: number;
  /** Score of the very first completed attempt (retained for learning gain). */
  firstScore: number | null;
  /** Best score inside the scoring window. */
  bestScore: number | null;
  /** Most recent score inside the scoring window. */
  latestScore: number | null;
  officialScore: number | null;
  /**
   * The attempt whose result is official (score AND pass/fail). Under the
   * basis rules it is the first / best / latest / nth scored attempt; when
   * an admin granted extra attempts and one was completed, the newest scored
   * attempt supersedes the earlier ones (the retake IS the new official).
   */
  officialAttempt: ScorableAttempt | null;
  /** Pass/fail of the official attempt; "completed" when the package gave no verdict. */
  officialStatus: "passed" | "failed" | "completed" | null;
  /** Extra scored slots granted on top of the policy window (Phase 2 grants). */
  extraAttempts: number;
  /** Ids of the attempts in the scored window (base window + completed grant retakes). */
  scoredWindowIds: Set<string>;
  /**
   * The grant-retake attempt ids this result was scored with (the `extra`
   * argument as a set; empty for the legacy number form). courseStatus reads
   * it for ADR 0014 step 10 (a live granted retake reads "in progress").
   */
  retakeIds: ReadonlySet<string>;
  /** Best score among practice (revision) attempts — informational only. */
  practiceBestScore: number | null;
  /** A revision attempt passed; never changes the official result. */
  practicePassed: boolean;
  /** All scored slots used. */
  limitReached: boolean;
  /** limitReached && after_limit === "block" — launch must be refused. */
  blocked: boolean;
  /** limitReached && after_limit === "practice" — launches are unscored. */
  practiceMode: boolean;
  /** Completed attempt id → 1-based completion order (practice = > max). */
  attemptNumber: Map<string, number>;
};

function ts(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

export function computeScoring(
  attempts: ScorableAttempt[],
  policy: EffectivePolicy,
  /**
   * Grant-designated official retakes (0083): the attempt ids that CONSUMED an
   * admin grant. Each adds a scored slot and, once completed, the NEWEST of
   * them becomes the official result — while the first score is retained for
   * learning gain. A plain number is accepted for legacy callers (it only
   * widens the window count; with no ids the basis rule picks the official).
   */
  extra: number | Iterable<string> = 0
): ScoringResult {
  // Abandoned is never official (R6); it never completes either, so this
  // only guards against a mislabelled row. A revision visit's row is never
  // an attempt (ADR 0014 step 6; defensive: R-5 keeps it from completing).
  const completed = excludeAbandoned(attempts)
    .filter((a) => isCompletedAttempt(a))
    .sort((a, b) => {
      const ka = ts(a.completed_at ?? a.started_at);
      const kb = ts(b.completed_at ?? b.started_at);
      if (ka !== kb) return ka - kb;
      const sa = ts(a.started_at);
      const sb = ts(b.started_at);
      if (sa !== sb) return sa - sb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const base = Math.max(1, policy.max_scored_attempts);
  const retakeIds = typeof extra === "number" ? new Set<string>() : new Set(extra);
  const extraCount = typeof extra === "number" ? Math.max(0, Math.floor(extra)) : retakeIds.size;
  const attemptNumber = new Map<string, number>();
  completed.forEach((a, i) => attemptNumber.set(a.id, i + 1));

  // The scored window = the first `base` completed attempts that are NOT grant
  // retakes, plus every completed grant retake. Revisions are everything else.
  // Keeping grant retakes out of the base slots means a retake never displaces
  // the baseline first attempt, and an interleaved revision run (completed
  // between the official attempt and the retake) never sneaks into the window.
  const completedRetakes = completed.filter((a) => retakeIds.has(a.id));
  const baseWindow = completed.filter((a) => !retakeIds.has(a.id)).slice(0, base);
  const scored = [...baseWindow, ...completedRetakes];
  const scoredWindowIds = new Set(scored.map((a) => a.id));
  const practice = completed.filter((a) => !scoredWindowIds.has(a.id));
  const numeric = (a: ScorableAttempt | undefined) =>
    a && typeof a.score === "number" && Number.isFinite(a.score) ? a.score : null;
  const bestOf = (list: ScorableAttempt[]): ScorableAttempt | undefined =>
    list.reduce<ScorableAttempt | undefined>((best, a) => {
      if (!best) return a;
      const s = numeric(a);
      const b = numeric(best);
      return s !== null && (b === null || s > b) ? a : best;
    }, undefined);

  const firstScore = numeric(completed[0]);
  const bestScore = numeric(bestOf(scored));
  const latestScore = numeric(scored[scored.length - 1]);

  // The official attempt. A completed grant retake supersedes the window's own
  // basis: the NEWEST grant retake is THE official result. Otherwise the basis
  // rule applies over the base window.
  let officialAttempt: ScorableAttempt | undefined;
  if (completedRetakes.length > 0) {
    officialAttempt = completedRetakes[completedRetakes.length - 1];
  } else if (policy.official_basis === "best") {
    officialAttempt = bestOf(baseWindow);
  } else if (policy.official_basis === "latest") {
    officialAttempt = baseWindow[baseWindow.length - 1];
  } else if (policy.official_basis === "nth") {
    officialAttempt = baseWindow[(policy.official_attempt_number ?? 1) - 1];
  } else {
    officialAttempt = baseWindow[0];
  }
  const officialScore = numeric(officialAttempt);
  const officialStatus: ScoringResult["officialStatus"] = !officialAttempt
    ? null
    : officialAttempt.success_status === "passed"
      ? "passed"
      : officialAttempt.success_status === "failed"
        ? "failed"
        : "completed";

  // The base official window is full once `base` non-retake attempts are
  // completed. A consumed grant is both a +1 slot and its own retake, so it
  // leaves no free slot; an UNUSED grant is applied at launch, not here.
  const limitReached = baseWindow.length >= base;
  return {
    policy,
    completedAttempts: completed.length,
    scoredAttempts: scored.length,
    practiceAttempts: practice.length,
    firstScore,
    bestScore,
    latestScore,
    officialScore,
    officialAttempt: officialAttempt ?? null,
    officialStatus,
    extraAttempts: extraCount,
    scoredWindowIds,
    retakeIds,
    practiceBestScore: numeric(bestOf(practice)),
    practicePassed: practice.some((a) => a.success_status === "passed"),
    limitReached,
    blocked: limitReached && policy.after_limit === "block",
    practiceMode: limitReached && policy.after_limit === "practice",
    attemptNumber,
  };
}

export type CourseStatus = "not_started" | "in_progress" | "completed" | "passed" | "failed";

/**
 * The learner's status on a module, from the OFFICIAL attempt only: a
 * revision (practice) pass never turns a failed module green, and a
 * failed official attempt is "failed" — learning completed, not passed.
 * No official attempt yet → in progress once any attempt exists.
 *
 * ADR 0014 step 10 (Q3, "show an official retake as in progress"): while a
 * granted retake runs (hasLiveGrantedRetake over the rows scored, with the
 * result's own retakeIds) the status reads "in_progress"; the standing
 * result stays in scoring.officialStatus, which officialDone and the path
 * and journey roll-ups keep reading until the retake completes.
 */
export function courseStatus(scoring: ScoringResult, attempts: ScorableAttempt[]): CourseStatus {
  if (scoring.officialAttempt) {
    if (hasLiveGrantedRetake(attempts, scoring.retakeIds)) return "in_progress";
    return scoring.officialStatus ?? "completed";
  }
  // ADR 0004 step 11: abandoned is never in progress.
  return excludeAbandoned(attempts).length === 0 ? "not_started" : "in_progress";
}

/** Did the official attempt complete the learning (pass required → must have passed)? */
export function officialDone(scoring: ScoringResult, passRequired: boolean): boolean {
  if (!scoring.officialAttempt) return false;
  return passRequired ? scoring.officialStatus === "passed" : true;
}

export function officialBasisLabel(p: AttemptPolicy): string {
  switch (p.official_basis) {
    case "best":
      return "best of scored attempts";
    case "latest":
      return "latest scored attempt";
    case "nth":
      return `attempt #${p.official_attempt_number ?? 1}`;
    default:
      return "first attempt";
  }
}

/** One-sentence summary for admins and learners. */
export function describePolicy(p: AttemptPolicy): string {
  const n = p.max_scored_attempts;
  const window = n === 1 ? "1 scored attempt" : `${n} scored attempts`;
  const after =
    p.after_limit === "block"
      ? "no further attempts after that"
      : "further attempts are practice (unscored)";
  return `${window} · official score = ${officialBasisLabel(p)} · ${after}`;
}

export function policySourceLabel(p: EffectivePolicy): string {
  switch (p.source) {
    case "course":
      return "module rule";
    case "path":
      return "inherited from a learning path";
    case "journey":
      return "inherited from a journey";
    default:
      return "platform default";
  }
}
