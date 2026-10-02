/**
 * Attempt scoring rules (0073) — client-safe, no imports.
 *
 * Learners may revisit a module as often as they like; these rules decide
 * which attempts COUNT. A policy has a scoring window (the first N completed
 * attempts), an official-score basis inside that window, and what happens
 * after the window is used up (practice = unscored relaunches, block = no
 * more launches).
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

export function normalizePolicy(raw: unknown): EffectivePolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const max = Number(r.max_scored_attempts);
  const basis = r.official_basis as OfficialBasis;
  const nth = r.official_attempt_number;
  const after = r.after_limit as AfterLimit;
  const source = r.source as EffectivePolicy["source"];
  return {
    max_scored_attempts:
      Number.isFinite(max) && max >= 1 ? Math.round(max) : DEFAULT_POLICY.max_scored_attempts,
    official_basis: ["first", "best", "latest", "nth"].includes(basis)
      ? basis
      : DEFAULT_POLICY.official_basis,
    official_attempt_number:
      typeof nth === "number" && Number.isFinite(nth) && nth >= 1 ? Math.round(nth) : null,
    retain_first_attempt: r.retain_first_attempt !== false,
    after_limit: after === "block" ? "block" : "practice",
    source: ["course", "path", "journey", "default"].includes(source) ? source : "default",
    source_id: typeof r.source_id === "string" ? r.source_id : null,
  };
}

export type ScorableAttempt = {
  id: string;
  score: number | null;
  started_at: string;
  completed_at: string | null;
  completion_status?: string | null;
  success_status?: string | null;
};

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
  /** Extra official attempts granted to this learner for this module (0 = none). */
  extraAttempts = 0
): ScoringResult {
  const completed = attempts
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
  const extra = Math.max(0, Math.floor(extraAttempts));
  const max = base + extra;
  const attemptNumber = new Map<string, number>();
  completed.forEach((a, i) => attemptNumber.set(a.id, i + 1));

  const scored = completed.slice(0, max);
  const practice = completed.slice(max);
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

  // The official attempt. A granted retake supersedes the window's own
  // basis: once the learner has completed more attempts than the base
  // window allowed, the newest scored attempt is the official one.
  let officialAttempt: ScorableAttempt | undefined;
  if (extra > 0 && completed.length > base) {
    officialAttempt = scored[scored.length - 1];
  } else if (policy.official_basis === "best") {
    officialAttempt = bestOf(scored);
  } else if (policy.official_basis === "latest") {
    officialAttempt = scored[scored.length - 1];
  } else if (policy.official_basis === "nth") {
    officialAttempt = scored[(policy.official_attempt_number ?? 1) - 1];
  } else {
    officialAttempt = scored[0];
  }
  const officialScore = numeric(officialAttempt);
  const officialStatus: ScoringResult["officialStatus"] = !officialAttempt
    ? null
    : officialAttempt.success_status === "passed"
      ? "passed"
      : officialAttempt.success_status === "failed"
        ? "failed"
        : "completed";

  const limitReached = completed.length >= max;
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
    extraAttempts: extra,
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
 */
export function courseStatus(scoring: ScoringResult, attempts: ScorableAttempt[]): CourseStatus {
  if (scoring.officialAttempt) return scoring.officialStatus ?? "completed";
  return attempts.length === 0 ? "not_started" : "in_progress";
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
