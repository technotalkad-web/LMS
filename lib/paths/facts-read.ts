/**
 * The path rule's inputs, read (ADR 0024 build note O1-i, phase 2 slice
 * P2-7): `readPathStepFacts()` as O1-i writes it, and beside it the other
 * reads the path page, the dashboard path tile and Continue feed
 * `pathProgress()` (lib/paths/progress.ts) with.
 *
 *   readPathStepFacts()   the learner's learning_path_step_completions rows
 *                         for the given paths, one read, on the caller's own
 *                         client (the table's select policy gives a learner
 *                         their own rows, O1-b);
 *   readPathCompletions() the learner's learning_path_completions rows, one
 *                         read, on the caller's own client (its policy is
 *                         `user_id = auth.uid()`);
 *   readPathTerms()       v_path_enrollment_terms for the learner, one read,
 *                         on a SERVICE client the caller creates after
 *                         requireOrgAccess, naming the organisation and the
 *                         learner (ruling (a) of P2-7: group_member_ids is
 *                         not security definer, so a learner's own session
 *                         reads no terms row that only a Custom Group
 *                         reaches);
 *   readPathAttempts()    the learner's path rows on the steps' courses, one
 *                         read; pathAttemptsOf() maps rows already read
 *                         (the dashboard's select("*")) the same way;
 *   readGrantRows()       the learner's approved grants on a list of courses,
 *                         every context (a retake's membership is by its
 *                         grant, N9).
 *
 * Every reader answers `{ok: false}` on any error, and on an answer with
 * neither rows nor an error. A failed read is never an empty list: an empty
 * fact list would lock a step again, an empty attempts or grants list would
 * read a step as not done, and an empty completion list would read a
 * completed path as in progress. The caller shows its read-error state.
 *
 * Deploy-safe (`docs/ARCHITECTURE.md` principle 6). The two tables and the
 * view exist only with 0107: on a missing-relation error naming them, and on
 * no other error, the facts read answers an empty list and the completions
 * and the terms read as none (the Gate line of P2-7). The attempts read
 * drops previews through the one fallback (readWithContextFilter over
 * withoutPreviews: on a database without 0107 it reads today's select once)
 * and names no 0107 column: each row tagged with a path is that path's row
 * (`path:<path id>`, contextKeyOf), which is the generated key exactly on a
 * database with 0107 (the shape check ties a path row to its path id) and
 * today's reading (path-tagged rows only, product decision L2) on one
 * without it. is_revision is read through readWithOptionalColumn (a database
 * without 0103 reads it as false). The grants read names context_key through
 * readWithOptionalColumn; without it every grant reads `individual` (step 8),
 * and without attempt_requests (before 0083) there are none.
 *
 * Every read carries its own abort signal (step 25: Next memoizes identical
 * GET fetches within one server render). No state is kept between calls.
 * Free of next/* and Supabase runtime imports, so every branch is
 * unit-tested with a stub client (tests/unit/path-facts-read.test.ts).
 */
import { isMissingRelation, readWithOptionalColumn, type PgError } from "@/lib/scoring/attempt-kind";
import {
  CONTEXT_ATTEMPT_COLUMNS,
  readWithContextFilter,
  withoutPreviews,
  type ContextFilterState,
} from "@/lib/scoring/context-read";
import { contextKeyOf, type ContextAttempt } from "@/lib/scoring/context";
import type { PathAttempt, PathGrant, PathStepFact } from "@/lib/paths/progress";

// Supabase's builder generics get "excessively deep" when threaded through
// helpers; the calls here are simple enough that a loose client is safer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

export type PathReadFailure = { ok: false; code: string | null };

type Answer<T> = { data: T | null; error: PgError };

const signal = () => new AbortController().signal;
const lower = (s: string) => s.toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error?: PgError): PathReadFailure => ({ ok: false, code: error ? String(error.code ?? "") || null : null });
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** A number, or a numeric column PostgREST sent as a string. */
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const uniq = (ids: readonly string[]) => [...new Set(ids.filter((x) => typeof x === "string" && x !== ""))];

/** The PostgREST cap on one `in` list this file sends (as fetchGrantRetakeIds chunks). */
const CHUNK = 300;

/**
 * The learner's stored step facts (learning_path_step_completions, build
 * note O1-a) for the given paths: one read (O1-i). An empty list for no
 * paths, or on a database without the table; `{ok: false}` on any other
 * error.
 */
export async function readPathStepFacts(
  client: AnyClient,
  userId: string,
  pathIds: readonly string[]
): Promise<{ ok: true; facts: PathStepFact[] } | PathReadFailure> {
  const ids = uniq(pathIds);
  if (ids.length === 0) return { ok: true, facts: [] };
  try {
    const r: Answer<Array<Record<string, unknown>>> = await client
      .from("learning_path_step_completions")
      .select("path_id, course_id, done_at, rule_pass_required")
      .eq("user_id", userId)
      .in("path_id", ids)
      .abortSignal(signal());
    if (r.error) return isMissingRelation(r.error, "learning_path_step_completions") ? { ok: true, facts: [] } : fail(r.error);
    if (r.data == null) return fail();
    return {
      ok: true,
      facts: r.data.map((f) => ({
        path_id: String(f.path_id),
        course_id: String(f.course_id),
        done_at: String(f.done_at),
        rule_pass_required: f.rule_pass_required === true,
      })),
    };
  } catch {
    return fail();
  }
}

/** A learning_path_completions row as pathProgress() takes it. */
export type PathCompletion = { completed_at: string; path_score: number | null };

/**
 * The learner's stored path completions for the given paths, keyed by the
 * path id in lower case: one read on the caller's own client. Read as none
 * on a database without the table; `{ok: false}` on any other error.
 */
export async function readPathCompletions(
  client: AnyClient,
  userId: string,
  pathIds: readonly string[]
): Promise<{ ok: true; byPath: Map<string, PathCompletion> } | PathReadFailure> {
  const ids = uniq(pathIds);
  const byPath = new Map<string, PathCompletion>();
  if (ids.length === 0) return { ok: true, byPath };
  try {
    const r: Answer<Array<Record<string, unknown>>> = await client
      .from("learning_path_completions")
      .select("path_id, completed_at, path_score")
      .eq("user_id", userId)
      .in("path_id", ids)
      .abortSignal(signal());
    if (r.error) return isMissingRelation(r.error, "learning_path_completions") ? { ok: true, byPath } : fail(r.error);
    if (r.data == null) return fail();
    for (const c of r.data) byPath.set(lower(String(c.path_id)), { completed_at: String(c.completed_at), path_score: num(c.path_score) });
    return { ok: true, byPath };
  } catch {
    return fail();
  }
}

/** v_path_enrollment_terms' answer for one path, as pathProgress() takes it. */
export type PathTerms = { due_at: string | null; enrolled_at: string | null };

/** No terms row: an "Everyone" path without an assignment row, or a database without the view. */
export const NO_PATH_TERMS: PathTerms = { due_at: null, enrolled_at: null };

/**
 * The learner's enrolment terms (v_path_enrollment_terms: the due date of
 * decision A9 and the first assignment) for the given paths, keyed by the
 * path id in lower case. `svc` is a service client the caller creates after
 * requireOrgAccess has answered (ruling (a) of P2-7), and the read names the
 * organisation and the learner. Read as none on a database without the
 * view; `{ok: false}` on any other error.
 */
export async function readPathTerms(
  svc: AnyClient,
  orgId: string,
  userId: string,
  pathIds: readonly string[]
): Promise<{ ok: true; byPath: Map<string, PathTerms> } | PathReadFailure> {
  const ids = uniq(pathIds);
  const byPath = new Map<string, PathTerms>();
  if (ids.length === 0) return { ok: true, byPath };
  try {
    const r: Answer<Array<Record<string, unknown>>> = await svc
      .from("v_path_enrollment_terms")
      .select("path_id, due_at, enrolled_at")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .in("path_id", ids)
      .abortSignal(signal());
    if (r.error) return isMissingRelation(r.error, "v_path_enrollment_terms") ? { ok: true, byPath } : fail(r.error);
    if (r.data == null) return fail();
    for (const t of r.data) byPath.set(lower(String(t.path_id)), { due_at: str(t.due_at), enrolled_at: str(t.enrolled_at) });
    return { ok: true, byPath };
  } catch {
    return fail();
  }
}

/**
 * Rows already read (the dashboard's select("*"), or readPathAttempts's
 * read) as the path rows pathProgress() takes: a row tagged with a path
 * (learning_path_id) whose version is one of the steps' courses, keyed
 * `path:<path id>`. With 0107 a row tagged with a path is that path's row,
 * or a by-role preview from before P2-5 (context_kind `preview`), which is
 * left out; without 0107 there is no context_kind and the tag decides, as
 * before. Rows of every path come back; pathProgress() takes each path's
 * own.
 */
export function pathAttemptsOf(
  rows: ReadonlyArray<Record<string, unknown>>,
  courseOfVersion: ReadonlyMap<string, string>
): PathAttempt[] {
  const out: PathAttempt[] = [];
  for (const r of rows) {
    const pathId = str(r.learning_path_id);
    if (pathId === null || !UUID.test(pathId)) continue;
    if (r.context_kind !== undefined && r.context_kind !== null && r.context_kind !== "path") continue;
    const versionId = String(r.course_version_id);
    const courseId = courseOfVersion.get(versionId);
    if (!courseId) continue;
    out.push({
      id: String(r.id),
      course_id: courseId,
      course_version_id: versionId,
      context_kind: "path",
      context_key: contextKeyOf({ kind: "path", pathId }),
      status: r.status as ContextAttempt["status"],
      completion_status: r.completion_status as ContextAttempt["completion_status"],
      success_status: r.success_status as ContextAttempt["success_status"],
      score: num(r.score),
      started_at: String(r.started_at),
      completed_at: str(r.completed_at),
      is_revision: r.is_revision === true,
      learning_path_id: lower(pathId),
      journey_enrollment_id: null,
      journey_day: null,
      journey_day_id: null,
      journey_version_id: null,
    });
  }
  return out;
}

/**
 * The learner's path rows on the given versions (the steps' courses), for
 * the given paths: one read (two on a database without 0107, the filter's
 * fallback; one more without 0103). Previews are dropped (withoutPreviews);
 * the columns are 0103's and older, so no 0107 column is named.
 */
export async function readPathAttempts(
  client: AnyClient,
  opts: { userId: string; pathIds: readonly string[]; versions: ReadonlyArray<{ id: string; course_id: string }> }
): Promise<{ ok: true; attempts: PathAttempt[] } | PathReadFailure> {
  const pathIds = uniq(opts.pathIds);
  const versionIds = uniq(opts.versions.map((v) => v.id));
  if (pathIds.length === 0 || versionIds.length === 0) return { ok: true, attempts: [] };
  const previews: ContextFilterState = { applies: null };
  try {
    const r = await readWithOptionalColumn<Array<Record<string, unknown>>>(
      "is_revision",
      (columns) =>
        readWithContextFilter(previews, (apply) =>
          withoutPreviews(
            client
              .from("course_attempts")
              .select(columns)
              .eq("user_id", opts.userId)
              .in("course_version_id", versionIds)
              .in("learning_path_id", pathIds),
            apply
          ).abortSignal(signal())
        ),
      `${CONTEXT_ATTEMPT_COLUMNS}, learning_path_id`
    );
    if (r.error) return fail(r.error);
    if (r.data == null) return fail();
    return { ok: true, attempts: pathAttemptsOf(r.data, new Map(opts.versions.map((v) => [v.id, v.course_id]))) };
  } catch {
    return fail();
  }
}

const GRANT_COLUMNS = "id, course_id, used_attempt_id, used_at, expires_at, created_at";

/**
 * The learner's approved grants on the given courses, every context, as
 * rows (pathProgress() reads a retake by its grant, N9): one read per 300
 * courses. context_key through readWithOptionalColumn (`individual` without
 * it, step 8); none on a database without attempt_requests (before 0083);
 * `{ok: false}` on any other error.
 */
export async function readGrantRows(
  client: AnyClient,
  userId: string,
  courseIds: readonly string[]
): Promise<{ ok: true; grants: PathGrant[] } | PathReadFailure> {
  const ids = uniq(courseIds);
  const grants: PathGrant[] = [];
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const r = await readWithOptionalColumn<Array<Record<string, unknown>>>(
        "context_key",
        (columns) =>
          client
            .from("attempt_requests")
            .select(columns)
            .eq("user_id", userId)
            .in("course_id", chunk)
            .eq("status", "approved")
            .abortSignal(signal()),
        GRANT_COLUMNS
      );
      if (r.error) {
        if (isMissingRelation(r.error, "attempt_requests")) return { ok: true, grants: [] };
        return fail(r.error);
      }
      if (r.data == null) return fail();
      for (const g of r.data) {
        grants.push({
          id: String(g.id),
          course_id: String(g.course_id),
          context_key: str(g.context_key) ?? "individual",
          used_attempt_id: str(g.used_attempt_id),
          used_at: str(g.used_at),
          expires_at: str(g.expires_at),
          created_at: String(g.created_at),
        });
      }
    }
    return { ok: true, grants };
  } catch {
    return fail();
  }
}

/** Each course's consumed grants' attempt ids (the course cards' retake ids, fetchGrantRetakeIds's shape). */
export function retakeIdsByCourse(grants: ReadonlyArray<PathGrant>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const g of grants) {
    if (!g.used_attempt_id) continue;
    (out.get(g.course_id) ?? out.set(g.course_id, new Set()).get(g.course_id)!).add(g.used_attempt_id);
  }
  return out;
}
