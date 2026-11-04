/**
 * The launch page's decisions for ADR 0014 step 3, as pure functions (the
 * page itself cannot run in a unit test): the launch kind, the kind rule
 * and the cutover rule at the row, the consume_grant outcomes, the insert
 * invariant, the token expiry after a retake opens, the revision seed and
 * the visit record. The page does the reads and the writes; everything that
 * decides what is refused, written or seeded lives here, so every branch is
 * unit-tested (tests/unit/launch-kind.test.ts).
 *
 * Deliberately free of next/* and Supabase runtime imports so unit tests can
 * load it. It reads neither a role nor a P4 value: the preview verdict
 * comes in from lib/alds/launch.ts launchModeFor().
 */
import { isSchemaMissing } from "@/lib/scoring/attempt-kind";

/**
 * The kind a launch is headed for before the row is known (ADR 0014 step 3,
 * "The launch kind rule"):
 *   first  — the official window has a free slot (`!limitReached`);
 *   grant  — the window is used, an unused grant exists, this request may
 *            consume one, and no granted retake is live on any version;
 *   at_row — the window is used and no grant is consumed: the row decides
 *            between `retake` (the row is a grant retake) and `revision`.
 */
export type CandidateKind = "first" | "grant" | "at_row";

export function candidateKind(i: {
  limitReached: boolean;
  unusedGrantId: string | null;
  /** False on the re-run after consume_grant answered used/stale/retake_live/stands. */
  consumeGrants: boolean;
  /** An in-progress granted retake on any version of the course (it blocks a new grant). */
  liveRetakeOnAnyVersion: boolean;
}): CandidateKind {
  if (!i.limitReached) return "first";
  if (i.unusedGrantId && i.consumeGrants && !i.liveRetakeOnAnyVersion) return "grant";
  return "at_row";
}

export type RowAction =
  | "insert_first"
  | "resume_first"
  | "resume_retake"
  | "resume_revision"
  | "flag_then_resume"
  | "insert_revision"
  | "refuse";

export type RowDecision = { action: RowAction; reason: string };

/** The in-progress row on the resolved version, as the lookup read it. */
export type LaunchRow = { id: string; is_revision?: boolean | null } | null;

/**
 * The kind rule and the cutover rule at the row (ADR 0014 step 3). The
 * launch is refused whenever the row disagrees with the kind: a `first` or
 * `retake` launch never lands on a flagged row, a grant retake row is never
 * resumed as a revision, and an inconsistent input refuses rather than
 * guess. A pre-0103 row (`is_revision` undefined) reads as unflagged.
 */
export function rowAction(i: {
  candidate: CandidateKind;
  limitReached: boolean;
  row: LaunchRow;
  retakeIds: ReadonlySet<string>;
}): RowDecision {
  const refuse = (reason: string): RowDecision => ({ action: "refuse", reason });
  if (i.candidate === "grant") return refuse("grant_candidate_at_row");
  if (i.candidate === "first" && i.limitReached) return refuse("kind_mismatch");
  if (i.candidate === "at_row" && !i.limitReached) return refuse("kind_mismatch");
  const revision = i.candidate === "at_row";
  const row = i.row;
  if (!row) return revision ? { action: "insert_revision", reason: "no_row" } : { action: "insert_first", reason: "no_row" };
  const flagged = row.is_revision === true;
  if (i.retakeIds.has(row.id)) {
    return flagged ? refuse("retake_row_flagged") : { action: "resume_retake", reason: "retake_row" };
  }
  if (flagged) return revision ? { action: "resume_revision", reason: "flagged_row" } : refuse("first_on_flagged_row");
  return revision ? { action: "flag_then_resume", reason: "cutover" } : { action: "resume_first", reason: "official_row" };
}

/** The outcomes public.consume_grant (0103) answers. */
export type ConsumeGrantOutcome = "opened" | "unavailable" | "used" | "expired" | "retake_live" | "stale" | "stands";

/**
 * What the page does with consume_grant's answer (ADR 0014 step 3, "Grant
 * path, one transaction"): `opened` proceeds on the returned retake;
 * `used`, `stale`, `retake_live` and `stands` re-run the kind rule in the
 * same request without consuming (the learner gets a revisit or the
 * winner's retake, never an unrequested retake); anything else
 * (`unavailable`, `expired`, an unknown value, an error, a missing
 * function, a raised 23505) refuses, nothing written.
 */
export function afterConsumeGrant(outcome: unknown): "proceed" | "rerun" | "refuse" {
  if (outcome === "opened") return "proceed";
  if (outcome === "used" || outcome === "stale" || outcome === "retake_live" || outcome === "stands") return "rerun";
  return "refuse";
}

/**
 * The insert invariant (ADR 0014 step 3): a new row is official only for a
 * free window slot or a consumed grant; every other new row is a revision
 * visit's. The page's insert names the column only when this is true.
 */
export function insertIsRevision(limitReached: boolean, consumeGrantId: string | null): boolean {
  return limitReached && !consumeGrantId;
}

/**
 * I-4: an insert that named `is_revision` and no 0100 column (the P4 flag
 * off, or the P4 retry itself) failing on a missing schema means 0103 is not
 * on this database: the launch refuses with the retry notice (logged
 * schema_missing) and never writes an unflagged revision row.
 */
export function revisionInsertRefused(
  error: { code?: string | null; message?: string | null } | null | undefined,
  namedIsRevision: boolean,
  namedP4Columns: boolean
): boolean {
  return namedIsRevision && !namedP4Columns && isSchemaMissing(error);
}

/**
 * After `opened`: the launch tokens to expire (ADR 0014 step 3).
 * The ids consume_grant abandoned, plus every NON-revision attempt of the
 * learner on the course except the new retake, whatever its status, so a
 * "Try again" pass in attempt #1's still-open tab answers 401 once the
 * retake is open. De-duplicated, in first-seen order.
 */
export function tokenExpiryTargets(i: {
  attempts: Array<{ id: string; is_revision?: boolean | null }>;
  abandonedIds: readonly string[];
  newAttemptId: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of i.abandonedIds) add(id);
  for (const a of i.attempts) if (a.is_revision !== true && a.id !== i.newAttemptId) add(a.id);
  return out;
}

/**
 * The revision seed (ADR 0014 step 3, "Seed, keyed on the row"): only a
 * launch whose resolved row is flagged is seeded from the official attempt,
 * every time; a `first`, `retake` or `grant` launch never is. A cutover
 * (flag_then_resume) seeds only when flag_revision_attempt answered 1 in
 * this request. SCORM gets the rebuilt cmi; cmi5 and xAPI get the State
 * copy and the LMS.OfficialResult document.
 */
export function seedPlan(i: {
  action: RowAction;
  /** flag_revision_attempt's answer in this request; null when it was not called. */
  flagResult: number | null;
  manifestType: string;
}): { seed: boolean; scorm: boolean; state: boolean; officialResult: boolean } {
  const seed =
    i.action === "resume_revision" ||
    i.action === "insert_revision" ||
    (i.action === "flag_then_resume" && i.flagResult === 1);
  const scorm = seed && i.manifestType === "scorm12";
  const state = seed && i.manifestType !== "scorm12";
  return { seed, scorm, state, officialResult: state };
}

/**
 * The revision visit record (ADR 0014 step 3, "Visit record"): only a
 * flagged row, never a staff or data_analyst preview (`isPreview` comes from
 * launchModeFor, never from a P4 value).
 */
export function shouldRecordVisit(i: { isPreview: boolean; rowIsRevision: boolean }): boolean {
  return i.rowIsRevision && !i.isPreview;
}
