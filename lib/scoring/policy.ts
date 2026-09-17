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

export const DEFAULT_POLICY: EffectivePolicy = {
  max_scored_attempts: 3,
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
  policy: EffectivePolicy
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

  const max = Math.max(1, policy.max_scored_attempts);
  const attemptNumber = new Map<string, number>();
  completed.forEach((a, i) => attemptNumber.set(a.id, i + 1));

  const scored = completed.slice(0, max);
  const numeric = (a: ScorableAttempt | undefined) =>
    a && typeof a.score === "number" && Number.isFinite(a.score) ? a.score : null;

  const firstScore = numeric(completed[0]);
  const bestScore = scored.reduce<number | null>((best, a) => {
    const s = numeric(a);
    return s === null ? best : best === null || s > best ? s : best;
  }, null);
  const latestScore = numeric(scored[scored.length - 1]);
  const nthScore = numeric(scored[(policy.official_attempt_number ?? 1) - 1]);

  const officialScore =
    policy.official_basis === "best"
      ? bestScore
      : policy.official_basis === "latest"
        ? latestScore
        : policy.official_basis === "nth"
          ? nthScore
          : firstScore;

  const limitReached = completed.length >= max;
  return {
    policy,
    completedAttempts: completed.length,
    scoredAttempts: scored.length,
    practiceAttempts: Math.max(0, completed.length - max),
    firstScore,
    bestScore,
    latestScore,
    officialScore,
    limitReached,
    blocked: limitReached && policy.after_limit === "block",
    practiceMode: limitReached && policy.after_limit === "practice",
    attemptNumber,
  };
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
