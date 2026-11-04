/**
 * Step 11 of ADR 0014 (grants after a pass, Q2), as pure functions: the one
 * rule the learner course page and POST /api/attempt-requests share, the
 * approval rule of PATCH /api/attempt-requests/{id}, the bulk grant's
 * eligibility and the message texts. The routes and the page do the reads
 * (strict: an unreadable record answers 503 or hides the button); everything
 * that decides what is refused, approved or skipped lives here, so every
 * branch is unit-tested (tests/unit/attempt-requests.test.ts).
 *
 * The SQL twins are consume_grant's `retake_live` and `stands` refusals
 * (0103), the backstop behind every writer.
 *
 * Deliberately free of next/* and Supabase imports so unit tests can load it.
 */
import { hasLiveGrantedRetake, officialDone, type ScoringResult } from "@/lib/scoring/policy";

/** The attempt rows a decision reads: hasLiveGrantedRetake needs `id` and `status`. */
type DecisionAttempt = { id: string; status?: string | null; completion_status?: string | null; success_status?: string | null };

/** The override note on the post-pass approval path: 3 to 2000 characters, trimmed (ADR 0014 step 11 (3)). */
export const OVERRIDE_NOTE_MIN = 3;
export const OVERRIDE_NOTE_MAX = 2000;

/**
 * The texts of ADR 0014 step 11, verbatim. The learner warning's lead
 * ("You passed this course (N %)." or "You have completed this course.")
 * comes from learnerWarningLead; `learner_warning` is the sentence after it.
 */
export const REQUEST_MESSAGES = {
  no_official_result: "You still have an official attempt available.",
  retake_live: "A granted retake is still in progress.",
  needs_override_passed: "This learner passed. Confirm the override and give a reason.",
  needs_override_completed: "This learner has completed this module. Confirm the override and give a reason.",
  learner_warning:
    "If another attempt is granted, the result of that attempt becomes your official result even if it is lower, and the course shows 'in progress' until you finish it. Your current result stays in your history.",
} as const;

/**
 * The first sentence of the learner's warning (ADR 0014 step 11 (1)):
 * "You passed this course (N %)." or "You have completed this course.".
 * A pass with no score reads "You passed this course." (no figure is guessed).
 */
export function learnerWarningLead(standing: { kind: "passed" | "completed"; scorePct: number | null }): string {
  if (standing.kind === "completed") return "You have completed this course.";
  return standing.scorePct === null ? "You passed this course." : `You passed this course (${standing.scorePct} %).`;
}

/**
 * The learner's official result stands (ADR 0014 step 11 (3)): officialDone
 * and not failed, so `passed`, or `completed` on a module that does not
 * require a pass. A `failed` result never stands, with or without a pass
 * mark, so this rule agrees with the bulk and ticket grants.
 */
export function resultStands(scoring: ScoringResult, passRequired: boolean): boolean {
  return officialDone(scoring, passRequired) && scoring.officialStatus !== "failed";
}

export type RequestDecision = "ok" | "no_official_result" | "retake_live";

/**
 * May the learner ask for another official attempt? (ADR 0014 step 11 (1)
 * and (2): the page's rule and the route's, one function.) Only once an
 * official result exists (under the clamp `limitReached` is true as soon as
 * one does) and no granted retake is live. A pass is never a refusal.
 */
export function requestDecision(args: { scoring: ScoringResult; attempts: DecisionAttempt[] }): RequestDecision {
  const { scoring, attempts } = args;
  if (!(scoring.officialAttempt !== null && scoring.limitReached)) return "no_official_result";
  if (hasLiveGrantedRetake(attempts, scoring.retakeIds)) return "retake_live";
  return "ok";
}

export type ApprovalDecision = "approve" | "approve_with_override" | "no_official_result" | "retake_live" | "needs_override";

/**
 * The approval of a pending request (ADR 0014 step 11 (3)): the refusals of
 * (2) first; then, when the result stands, approval needs the ticked
 * confirmation (`overridePassed === true`) and a trimmed note of 3 to 2000
 * characters, else `needs_override`; a result that does not stand is a
 * plain approve. The route answers 400 for a trimmed note over 2000
 * characters on the override path BEFORE calling this, so 2001 never
 * reaches here from the route; the message variant of `needs_override`
 * (passed / completed) is the caller's, from scoring.officialStatus.
 */
export function approvalDecision(args: {
  scoring: ScoringResult;
  attempts: DecisionAttempt[];
  passRequired: boolean;
  overridePassed: boolean | null | undefined;
  note: string | null | undefined;
}): ApprovalDecision {
  const base = requestDecision(args);
  if (base !== "ok") return base;
  if (!resultStands(args.scoring, args.passRequired)) return "approve";
  const n = (args.note ?? "").trim().length;
  return args.overridePassed === true && n >= OVERRIDE_NOTE_MIN && n <= OVERRIDE_NOTE_MAX ? "approve_with_override" : "needs_override";
}

export type BulkEligibility = "grant" | "not_failed" | "no_official" | "retake_live";

/**
 * The bulk grant's per-learner rule (bulk/route.ts: an official result
 * exists and did not pass, that is a failed verdict or, on a pass-required
 * module, anything short of a pass), plus ADR 0014 step 11 (5): a learner
 * whose granted retake is live is skipped.
 */
export function bulkEligibility(args: { scoring: ScoringResult; attempts: DecisionAttempt[]; passRequired: boolean }): BulkEligibility {
  const { scoring, attempts, passRequired } = args;
  if (!scoring.officialAttempt || !scoring.limitReached) return "no_official";
  const failed = scoring.officialStatus === "failed" || (passRequired && scoring.officialStatus !== "passed");
  if (!failed) return "not_failed";
  if (hasLiveGrantedRetake(attempts, scoring.retakeIds)) return "retake_live";
  return "grant";
}
