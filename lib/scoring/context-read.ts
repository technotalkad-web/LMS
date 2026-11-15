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
 * every context. A caller that reads the same (learner, course, key) again in
 * one request passes the earlier answer's schema decision and grants
 * (`reuse`), and that read is the attempts read only.
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
 * there, today's read when it is not; and the preview filter of the feeds and
 * the raw readers (ADR 0024 phase 2, P2-3; steps 49 and 80):
 * withoutPreviews() drops `context_kind = 'preview'` rows, and
 * readWithContextFilter(), the one fallback both filters read through, reads
 * today's select once on a database without the column.
 *
 * Server-side by use, but free of next/* and Supabase runtime imports (the
 * shape of lib/scoring/attempt-kind.ts), so every branch is unit-tested with
 * a stub client (tests/unit/learning-context.test.ts).
 */
import {
  isMissingColumn,
  isMissingRelation,
  isSchemaMissing,
  readWithOptionalFilter,
  type OptionalFilterState,
  type PgError,
} from "@/lib/scoring/attempt-kind";
import { DEFAULT_POLICY } from "@/lib/scoring/policy";
import {
  ContextKeyError,
  contextKindOfKey,
  contextResult,
  isContextKey,
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
 * Whether a request's reads apply a filter on `context_kind`
 * (readWithContextFilter): null until an answer decides, then true on a
 * database with 0107 and false on one without it. One object is shared by
 * every page, chunk and read of a request (or of one sweep run), so the
 * decision is made once (OptionalFilterState).
 */
export type ContextFilterState = OptionalFilterState;
/** The Individual filter's state (individualContextOnly): the same decision. */
export type IndividualFilterState = ContextFilterState;

/**
 * The one fallback for a filter on `context_kind` (`docs/ARCHITECTURE.md`
 * principle 6; ADR 0024 step 49, "the readers tolerate the absent columns
 * and apply the filter when present"): readWithOptionalFilter on that
 * column. `read(apply)` builds the read and adds the filter when `apply` is
 * true. On a database without 0107 the first answer is a missing-column
 * error naming context_kind, and the same read is made once without the
 * filter: today's select. Any other error is returned as it is.
 */
export function readWithContextFilter<R extends { error: PgError }>(
  state: ContextFilterState,
  read: (apply: boolean) => PromiseLike<R>
): Promise<R> {
  return readWithOptionalFilter("context_kind", state, read);
}

/**
 * The preview filter (ADR 0024 steps 49 and 80, P2-3): drops the rows whose
 * `context_kind` is `preview` when `apply` is true, so a Preview (a staff
 * member's by-role row since the 0107 paste, or a Preview by mode from P2-5)
 * moves no tenant LRS statement, CRM row, report number or date. 0107 makes
 * the column not null, so `neq` keeps every other row. `column` names the
 * column through an `!inner` embed (`course_attempts.context_kind`) for a
 * read that reaches attempts that way. Always used inside
 * readWithContextFilter, which decides `apply`.
 */
export function withoutPreviews<Q>(query: Q, apply: boolean, column = "context_kind"): Q {
  if (!apply) return query;
  return (query as unknown as { neq: (column: string, value: string) => Q }).neq(column, "preview");
}

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
 * the two errors (a database without 0103 has no 0107 either). The decision
 * is readWithContextFilter's, the one fallback.
 */
export function individualContextOnly<T>(
  state: IndividualFilterState,
  read: (columns: string, from: number, to: number, individual: boolean) => PromiseLike<{ data: T[] | null; error: PgError }>
): (columns: string, from: number, to: number) => Promise<{ data: T[] | null; error: PgError }> {
  return (columns, from, to) => readWithContextFilter(state, (individual) => read(columns, from, to, individual));
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
      /**
       * The approved grants of the (learner, course) the result was scored
       * with, every context, as read: a caller that judges the same rows by
       * another rule (Continue's path step through pathStepStatus; ADR 0024
       * O1-k) takes them from here, never from a second read.
       */
      grants: ReadContextGrant[];
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
    /**
     * An earlier ok answer's schema decision and grants, for a caller that
     * reads the same (learner, course, key) again in one request (Continue's
     * wait; the P2-7 review, F5). The read then makes the attempts read only:
     * with `contextColumns: false` it reads today's select at once, with no
     * failed read first, and the grants are these, not read again. The 0103
     * fallback (no is_revision) stays live.
     */
    reuse?: { contextColumns: boolean; grants: ReadContextGrant[] };
  }
): Promise<ContextRead> {
  // A key that is not in the generated column's form (an upper-case id, a
  // missing id, any other text; isContextKey) matches no row, so it would
  // read as not started: it answers bad_key before any read (H4 of the
  // ADR's note of 2026-11-14).
  const kind = contextKindOfKey(opts.key);
  if (kind === null || !isContextKey(opts.key)) return fail("bad_key");
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
    let contextColumns = opts.reuse?.contextColumns ?? true;
    if (!contextColumns && kind === "preview") return fail("no_context_schema");
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
      let res = contextColumns
        ? await read(`${CONTEXT_ATTEMPT_COLUMNS}, is_revision, ${CONTEXT_SELECT}`, true)
        : await read(`${CONTEXT_ATTEMPT_COLUMNS}, is_revision`, false);
      // A database without 0103 when an earlier answer already decided "no
      // 0107" (reuse): no revision flag (it reads as false).
      if (!contextColumns && res.error && isMissingColumn(res.error, "is_revision")) res = await read(CONTEXT_ATTEMPT_COLUMNS, false);
      // A database without 0107: a 42703 naming a context column, or naming
      // is_revision, which comes first in the select list and which every
      // database with 0107 has (0107 requires 0103). Today's select, no
      // context filter.
      else if (res.error && (isMissingContextColumn(res.error) || isMissingColumn(res.error, "is_revision"))) {
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
    if (opts.reuse) grants = opts.reuse.grants;
    else if (contextColumns) {
      const g = await readGrants(`${GRANT_COLUMNS}, context_key`);
      const missing = g.error && (isMissingColumn(g.error, "context_key") || isMissingRelation(g.error, "attempt_requests"));
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
    if (!opts.reuse && !contextColumns) {
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
    return { ok: true, result, contextColumns, grants };
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
