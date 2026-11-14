/**
 * The official rule per context (ADR 0024 step 41): `contextResult()` scores
 * one (learner, course, context) and `contextKeyOf()` builds the context's
 * key exactly as the generated column `course_attempts.context_key` does
 * (0107, step 5).
 *
 * The TypeScript twin of v_context_attempt_scoring and
 * v_context_attempt_summary (0107 section 4a and 4b; twins contract pair 1;
 * build notes N8 and N9). The rule, in plain steps:
 *   1. every input row and grant carries a context_key: a missing or empty
 *      one throws, so no reader is context-blind by accident;
 *   2. `rows` are the rows whose key is the key asked for, by started_at,
 *      then id;
 *   3. `officialRows` drop abandoned rows and revision rows, and previews
 *      (only a preview key can hold one; for a preview key, which only
 *      Preview Reports ask for, the rule is "not abandoned and not a revision
 *      row", contract A1);
 *   4. a granted retake is a row an approved grant names in
 *      `used_attempt_id`, whatever the grant's own context (N9): a retake a
 *      `?lp=` launch consumed before 0107 keeps its place in the path's
 *      window although 0107 labels its grant `individual`;
 *   5. scoring is computeScoring over `officialRows` with those retake ids;
 *      status, stored and done follow from it as on today's pages;
 *   6. the live-retake test is on the retake row's own context: a row of
 *      `officialRows` (so never a revision row) in progress, neither
 *      completed nor passed, and named by a grant (N9, which corrects the
 *      contract's rule 2.3.11 from `rows` to the non-revision rows);
 *   7. the unused grant is the oldest approved grant whose own context_key
 *      is the key asked for, unused and unexpired at `now`: the grant's
 *      context limits only which grant a context may consume.
 *
 * A journey day's done is read from its credit row, never from this
 * function's `done` (contract A4); a path step's done is pathProgress()'s
 * `passed_ever` (lib/paths/progress.ts; build note O1-k).
 *
 * Pure: no next/* and no Supabase runtime import (the house shape of
 * lib/attempts/launch-kind.ts and lib/learner/continue.ts). The strict reads
 * are lib/scoring/context-read.ts's.
 */
import {
  computeScoring,
  courseStatus,
  hasLiveGrantedRetake,
  isAbandonedAttempt,
  isRevisionAttempt,
  officialDone,
  type CourseStatus,
  type EffectivePolicy,
  type ScoringResult,
} from "@/lib/scoring/policy";

export type ContextKind = "individual" | "path" | "journey" | "preview";

/** A course_attempts row as the official rule reads it (database column names). */
export type ContextAttempt = {
  /** uuid, lower case */
  id: string;
  course_version_id: string;
  context_kind: ContextKind;
  /** The generated key (0107 step 5). Required: a missing or empty key throws (step 41). */
  context_key: string;
  status: "in_progress" | "completed" | "failed" | "passed" | "abandoned";
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  /** 0..1 */
  score: number | null;
  /** ISO */
  started_at: string;
  completed_at: string | null;
  is_revision: boolean;
  /** Carried for readers; the rule reads context_key only. */
  learning_path_id: string | null;
  journey_enrollment_id: string | null;
  /** The day's number at launch, display only. */
  journey_day: number | null;
  journey_day_id: string | null;
  journey_version_id: string | null;
};

/** An approved attempt_requests row of the (learner, course). */
export type ContextGrant = {
  id: string;
  /** 'individual' for every row from before 0107 (step 8). */
  context_key: string;
  used_attempt_id: string | null;
  used_at: string | null;
  expires_at: string | null;
  created_at: string;
  reissued_from?: string | null;
};

export type ContextResultInput<A extends ContextAttempt = ContextAttempt, G extends ContextGrant = ContextGrant> = {
  /** The context asked for (contextKeyOf). */
  key: string;
  /** The learner's rows on one course, any context. */
  attempts: A[];
  /** The approved grants of the (learner, course), any context. */
  grants: G[];
  /** DEFAULT_POLICY in practice: normalizePolicy clamps every rule to it (ADR 0014 step 9). */
  policy: EffectivePolicy;
  /** The context's resolved rule (instance_pass_required; twins contract 1.4). */
  passRequired: boolean;
  /** ISO; for grant expiry. */
  now: string;
};

export type ContextResult<A extends ContextAttempt = ContextAttempt, G extends ContextGrant = ContextGrant> = {
  key: string;
  /** Every row with this key, all statuses, revision rows included (resume, the reset notice, counts). */
  rows: A[];
  /** The rows under the official rule: what scoring sees. */
  officialRows: A[];
  /** Attempt ids an approved grant names in used_attempt_id, any grant context (N9). */
  retakeIds: ReadonlySet<string>;
  /** computeScoring(officialRows, policy, retakeIds). */
  scoring: ScoringResult;
  /** courseStatus(scoring, officialRows): a live granted retake reads in_progress. */
  status: CourseStatus;
  /** An official attempt exists and the status is not in_progress (resultStored's rule). */
  stored: boolean;
  /** officialDone(scoring, passRequired): the standing result under the rule passed in. */
  done: boolean;
  /** A granted retake of this context is in progress (N9). */
  liveRetake: boolean;
  /** The oldest approved, unused, unexpired grant whose own context_key is this key. */
  unusedGrant: G | null;
};

/** A row, a grant or a request without a usable context key (step 41: never read context-blind). */
export class ContextKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextKeyError";
  }
}

export type ContextRef =
  | { kind: "individual" }
  | { kind: "path"; pathId: string }
  | { kind: "journey"; enrollmentId: string; dayId: string }
  | { kind: "preview"; runId?: string | null; dayId?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idPart(id: string | null | undefined, what: string): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new ContextKeyError(`contextKeyOf: ${what} is not a uuid`);
  // Postgres prints a uuid in lower case, so the generated key holds lower case.
  return id.toLowerCase();
}

/**
 * The key of a context, the same string as the generated column of step 5:
 * `individual`; `path:<path id>`; `journey:<enrolment id>:<day id>` (the
 * day's id, never its number, A27); `preview`, `preview:<run id>` or
 * `preview:<run id>:<day id>`. Ids are written in lower case; an id that is
 * not a uuid throws, because no such key can exist in the column.
 */
export function contextKeyOf(ref: ContextRef): string {
  switch (ref.kind) {
    case "individual":
      return "individual";
    case "path":
      return `path:${idPart(ref.pathId, "the path id")}`;
    case "journey":
      return `journey:${idPart(ref.enrollmentId, "the enrolment id")}:${idPart(ref.dayId, "the day id")}`;
    case "preview": {
      const run = ref.runId == null ? "" : `:${idPart(ref.runId, "the run id")}`;
      const day = ref.dayId == null ? "" : `:${idPart(ref.dayId, "the day id")}`;
      return `preview${run}${day}`;
    }
  }
}

/** The kind a key names, by its prefix; null for anything else. */
export function contextKindOfKey(key: string): ContextKind | null {
  if (key === "individual") return "individual";
  if (key.startsWith("path:")) return "path";
  if (key.startsWith("journey:")) return "journey";
  if (key === "preview" || key.startsWith("preview:")) return "preview";
  return null;
}

function hasKey(x: { context_key?: unknown }): boolean {
  return typeof x.context_key === "string" && x.context_key !== "";
}

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The official rule of one context (ADR 0024 step 41; the steps are in the header). */
export function contextResult<A extends ContextAttempt, G extends ContextGrant>(i: ContextResultInput<A, G>): ContextResult<A, G> {
  if (typeof i.key !== "string" || i.key === "") throw new ContextKeyError("contextResult: no context key asked for");
  for (const a of i.attempts) {
    if (!hasKey(a)) throw new ContextKeyError(`contextResult: attempt ${String(a.id)} has no context_key`);
  }
  for (const g of i.grants) {
    if (!hasKey(g)) throw new ContextKeyError(`contextResult: grant ${String(g.id)} has no context_key`);
  }
  const previewKey = contextKindOfKey(i.key) === "preview";

  const rows = i.attempts
    .filter((a) => a.context_key === i.key)
    .sort((a, b) => ms(a.started_at) - ms(b.started_at) || byId(a, b));
  const officialRows = rows.filter(
    (a) => !isAbandonedAttempt(a) && !isRevisionAttempt(a) && (previewKey || a.context_kind !== "preview")
  );

  const retakeIds = new Set<string>();
  for (const g of i.grants) if (g.used_attempt_id) retakeIds.add(g.used_attempt_id);

  const scoring = computeScoring(officialRows, i.policy, retakeIds);
  const status = courseStatus(scoring, officialRows);
  const liveRetake = hasLiveGrantedRetake(officialRows, retakeIds);

  const nowMs = ms(i.now);
  const unused = i.grants
    .filter((g) => g.context_key === i.key && !g.used_at && (!g.expires_at || ms(g.expires_at) > nowMs))
    .sort((a, b) => ms(a.created_at) - ms(b.created_at) || byId(a, b));

  return {
    key: i.key,
    rows,
    officialRows,
    retakeIds,
    scoring,
    status,
    stored: scoring.officialAttempt !== null && status !== "in_progress",
    done: officialDone(scoring, i.passRequired),
    liveRetake,
    unusedGrant: unused[0] ?? null,
  };
}

/**
 * Some row of the context's scored window passed: the twin of the scoring
 * view's `passed_in_window` (build note N12). Practice rows, abandoned rows,
 * revision rows and previews are never in the window.
 */
export function passedInWindow(r: Pick<ContextResult, "officialRows" | "scoring">): boolean {
  return r.officialRows.some((a) => r.scoring.scoredWindowIds.has(a.id) && a.success_status === "passed");
}
