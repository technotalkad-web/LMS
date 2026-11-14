/**
 * The strict reads behind contextResult (ADR 0024 step 41):
 * `readContextResult()` reads one (learner, course) in one context and
 * answers contextResult's answer, or `{ok: false}` on any error. A failed
 * read is never an empty list: the caller refuses or shows its read-error
 * state, so no failed read can open a step or read as "not started".
 *
 * Three reads, each with its own abort signal (step 25: Next memoizes
 * identical GET fetches within one server render, and the launch's
 * evaluate() runs twice in one render after consume_grant): the course's
 * versions (skipped when the caller passes them), the learner's rows of the
 * context on those versions, and the learner's approved grants on the course,
 * every context.
 *
 * Deploy-safe in both orders (`docs/ARCHITECTURE.md` principle 6; step 49,
 * "the readers tolerate the absent columns and apply the context filter when
 * present"): when the attempts read answers 42703 naming a column 0107 adds,
 * or naming is_revision (0107 requires 0103, so a database without the flag
 * has no 0107 either), it reads again without the context columns and
 * without the key filter, and every row and grant is read as the context
 * asked for. When the course has no version, no attempts read runs and the
 * grants read decides the same way: no context_key column, or no
 * attempt_requests table. That is today's reading, one undivided set of
 * rows per learner and course, previews included, because no context and no
 * new-kind preview exists there. The answer says so (`contextColumns:
 * false`). A preview key has no such reading and answers `{ok: false}`
 * there. Any other error, another column's 42703 included, answers `{ok:
 * false}`; a database whose attempts carry the context columns while its
 * grants do not is an error, never a fallback.
 *
 * The file also holds individualContextOnly(), the same rule for the
 * Individual product's paged report reads (step 49): the filter when 0107 is
 * there, today's read when it is not.
 *
 * Server-side by use, but free of next/* and Supabase runtime imports (the
 * shape of lib/scoring/attempt-kind.ts), so every branch is unit-tested with
 * a stub client (tests/unit/learning-context.test.ts).
 */
import { isMissingColumn, isSchemaMissing, type PgError } from "@/lib/scoring/attempt-kind";
import { DEFAULT_POLICY } from "@/lib/scoring/policy";
import {
  ContextKeyError,
  contextKindOfKey,
  contextResult,
  type ContextAttempt,
  type ContextGrant,
  type ContextResult,
} from "@/lib/scoring/context";

// Supabase's builder generics get "excessively deep" when threaded through
// helpers; the calls here are simple enough that a loose client is safer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** The attempt columns every tier reads; `status` (0002) and the two outcome columns (0003). */
export const CONTEXT_ATTEMPT_COLUMNS =
  "id, course_version_id, status, completion_status, success_status, score, started_at, completed_at";
/** The columns a database without 0107 lacks (with the key filter, they are what a 42703 can name). */
export const CONTEXT_COLUMNS_0107 = ["context_kind", "context_key", "journey_day_id", "journey_version_id"] as const;
const CONTEXT_SELECT = "context_kind, context_key, learning_path_id, journey_enrollment_id, journey_day, journey_day_id, journey_version_id";
const GRANT_COLUMNS = "id, used_attempt_id, used_at, expires_at, created_at";

/** A 42703 (or PGRST204) that names one of 0107's context columns, or no column: a database without 0107. */
export function isMissingContextColumn(error: PgError): boolean {
  return CONTEXT_COLUMNS_0107.some((c) => isMissingColumn(error, c));
}

/**
 * Whether a request's attempts reads apply the Individual filter
 * (individualContextOnly): null until an answer decides, then true on a
 * database with 0107 and false on one without it. One object is shared by
 * every page and chunk of a request, so the decision is made once.
 */
export type IndividualFilterState = { applies: boolean | null };

/**
 * The Individual product's attempts reads on its report surfaces (ADR 0024
 * step 49: "From the first pull request the readers tolerate the absent
 * columns and apply the Individual filter when present"): the course card
 * and Reports tab (loadEnrolledCourseStatus), the course learners table and
 * its CSV. On a database with 0107 they read `context_kind = 'individual'`,
 * the rows the old-name summary views and the course matviews read from
 * 0107 on (step 9), so a path's, a journey's or a preview's attempt no
 * longer counts in the course's numbers; on a database without 0107 they
 * read today's rows (`docs/ARCHITECTURE.md` principle 6).
 *
 * Wraps a paged read's query: `read(columns, from, to, individual)` builds
 * it and adds `.eq("context_kind", "individual")` when `individual` is
 * true. The first answer decides, for every later page and chunk that
 * shares `state`: an answer without an error is a database with 0107; a
 * missing-column error naming context_kind (isMissingColumn) is a database
 * without it, and the same page is read again without the filter. Once
 * decided it is never revisited, and a later error, a missing-column error
 * included, is returned as it is. Any other error decides nothing and is
 * returned as it is, so the caller keeps its own error path. It composes
 * with readPagedWithOptionalColumn's is_revision fallback in either order of
 * the two errors (a database without 0103 has no 0107 either).
 */
export function individualContextOnly<T>(
  state: IndividualFilterState,
  read: (columns: string, from: number, to: number, individual: boolean) => PromiseLike<{ data: T[] | null; error: PgError }>
): (columns: string, from: number, to: number) => Promise<{ data: T[] | null; error: PgError }> {
  return async (columns, from, to) => {
    if (state.applies === false) return await read(columns, from, to, false);
    const res = await read(columns, from, to, true);
    if (state.applies === null) {
      if (!res.error) state.applies = true;
      else if (isMissingColumn(res.error, "context_kind")) {
        state.applies = false;
        return await read(columns, from, to, false);
      }
    }
    return res;
  };
}

export type ReadContextAttempt = ContextAttempt;
export type ReadContextGrant = ContextGrant;

export type ContextReadFailure =
  | "bad_key"
  | "versions_read"
  | "attempts_read"
  | "grants_read"
  | "empty_answer"
  | "no_context_schema"
  | "rule";

export type ContextRead =
  | {
      ok: true;
      result: ContextResult<ReadContextAttempt, ReadContextGrant>;
      /** false: a database without 0107, read as one undivided context (the header). */
      contextColumns: boolean;
    }
  | { ok: false; reason: ContextReadFailure; code: string | null };

const fail = (reason: ContextReadFailure, error?: PgError): ContextRead => ({
  ok: false,
  reason,
  code: error ? String(error.code ?? "") || null : null,
});

const signal = () => new AbortController().signal;

type Answer<T> = { data: T | null; error: PgError };

/**
 * One context's official result for one (learner, course), read strictly
 * (the header has the reads, the fallback and the failure rule).
 * `passRequired` is the context's resolved rule; `now` defaults to the
 * clock and is read for grant expiry only.
 */
export async function readContextResult(
  client: AnyClient,
  opts: {
    userId: string;
    courseId: string;
    key: string;
    passRequired: boolean;
    now?: string;
    /** The course's version ids when the caller holds them already (one read fewer). */
    versionIds?: string[];
  }
): Promise<ContextRead> {
  const kind = contextKindOfKey(opts.key);
  if (kind === null) return fail("bad_key");
  const now = opts.now ?? new Date().toISOString();
  try {
    let versionIds = opts.versionIds;
    if (!versionIds) {
      const v: Answer<Array<{ id: string }>> = await client
        .from("course_versions")
        .select("id")
        .eq("course_id", opts.courseId)
        .abortSignal(signal());
      if (v.error) return fail("versions_read", v.error);
      if (v.data == null) return fail("empty_answer");
      versionIds = v.data.map((r) => r.id);
    }

    let attempts: ContextAttempt[] = [];
    let contextColumns = true;
    // Whether the attempts read decided the schema; with no version it never
    // runs, and the grants read decides it instead.
    let attemptsRead = false;
    if (versionIds.length > 0) {
      attemptsRead = true;
      const ids = versionIds;
      const read = (columns: string, keyFilter: boolean): PromiseLike<Answer<Array<Record<string, unknown>>>> => {
        let q = client.from("course_attempts").select(columns).eq("user_id", opts.userId).in("course_version_id", ids);
        if (keyFilter) q = q.eq("context_key", opts.key);
        return q.abortSignal(signal());
      };
      let res = await read(`${CONTEXT_ATTEMPT_COLUMNS}, is_revision, ${CONTEXT_SELECT}`, true);
      // A database without 0107: a 42703 naming a context column, or naming
      // is_revision, which comes first in the select list and which every
      // database with 0107 has (0107 requires 0103). Today's select, no
      // context filter.
      if (res.error && (isMissingContextColumn(res.error) || isMissingColumn(res.error, "is_revision"))) {
        if (kind === "preview") return fail("no_context_schema", res.error);
        contextColumns = false;
        res = await read(`${CONTEXT_ATTEMPT_COLUMNS}, is_revision`, false);
        // A database without 0103 as well: no revision flag (it reads as false).
        if (res.error && isMissingColumn(res.error, "is_revision")) res = await read(CONTEXT_ATTEMPT_COLUMNS, false);
      }
      if (res.error) return fail("attempts_read", res.error);
      if (res.data == null) return fail("empty_answer");
      attempts = res.data.map((r) =>
        contextColumns ? toAttempt(r) : toAttempt({ ...r, context_kind: kind, context_key: opts.key })
      );
    }

    // The grants: every approved grant of the (learner, course), any context
    // (a retake's membership is by used_attempt_id, note N9).
    const readGrants = (columns: string): PromiseLike<Answer<Array<Record<string, unknown>>>> =>
      client
        .from("attempt_requests")
        .select(columns)
        .eq("user_id", opts.userId)
        .eq("course_id", opts.courseId)
        .eq("status", "approved")
        .abortSignal(signal());
    let grants: ContextGrant[] = [];
    if (contextColumns) {
      const g = await readGrants(`${GRANT_COLUMNS}, context_key`);
      const missing = g.error && (isMissingColumn(g.error, "context_key") || g.error.code === "42P01" || g.error.code === "PGRST205");
      if (missing && !attemptsRead) {
        // No attempts read decided the schema, and the grants have no
        // context_key (or no table, before 0083): a database without 0107.
        if (kind === "preview") return fail("no_context_schema", g.error);
        contextColumns = false;
      } else {
        if (g.error) return fail("grants_read", g.error);
        if (g.data == null) return fail("empty_answer");
        grants = g.data.map((r) => toGrant(r));
      }
    }
    if (!contextColumns) {
      const g = await readGrants(GRANT_COLUMNS);
      // A database without attempt_requests (before 0083) has no grants, as
      // grantSnapshotFor reads it.
      if (g.error && !isSchemaMissing(g.error)) return fail("grants_read", g.error);
      if (!g.error && g.data == null) return fail("empty_answer");
      grants = (g.error ? [] : (g.data ?? [])).map((r) => toGrant({ ...r, context_key: opts.key }));
    }

    const result = contextResult({
      key: opts.key,
      attempts,
      grants,
      policy: DEFAULT_POLICY,
      passRequired: opts.passRequired,
      now,
    });
    return { ok: true, result, contextColumns };
  } catch (e) {
    // A thrown read (a network failure) or a row the rule refuses.
    return fail(e instanceof ContextKeyError ? "rule" : "attempts_read");
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** A number, or a numeric column PostgREST sent as a string. */
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

function toAttempt(r: Record<string, unknown>): ContextAttempt {
  return {
    id: String(r.id),
    course_version_id: String(r.course_version_id),
    context_kind: r.context_kind as ContextAttempt["context_kind"],
    context_key: r.context_key as string,
    status: r.status as ContextAttempt["status"],
    completion_status: r.completion_status as ContextAttempt["completion_status"],
    success_status: r.success_status as ContextAttempt["success_status"],
    score: num(r.score),
    started_at: String(r.started_at),
    completed_at: str(r.completed_at),
    is_revision: r.is_revision === true,
    learning_path_id: str(r.learning_path_id),
    journey_enrollment_id: str(r.journey_enrollment_id),
    journey_day: num(r.journey_day),
    journey_day_id: str(r.journey_day_id),
    journey_version_id: str(r.journey_version_id),
  };
}

function toGrant(r: Record<string, unknown>): ContextGrant {
  return {
    id: String(r.id),
    context_key: r.context_key as string,
    used_attempt_id: str(r.used_attempt_id),
    used_at: str(r.used_at),
    expires_at: str(r.expires_at),
    created_at: String(r.created_at),
  };
}
