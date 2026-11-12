import { computeScoring, DEFAULT_POLICY, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";

/**
 * Server-side helpers for the revision rule (Phase 1; ADR 0014):
 *
 *   classifyAttempt()   — is THIS attempt official (inside the scoring window)
 *                         or a revision/practice run? Used by the commit
 *                         paths to decide what a completion may change:
 *                         journey days, XP and the CRM webhook follow
 *                         official attempts only. A revision visit's row
 *                         (is_revision, 0103) is never official.
 *   grantSnapshotFor()  — the learner's approved grants on a course, read
 *                         once and STRICTLY (ADR 0014 step 3): the launch
 *                         page and the forced restart decide from it, so a
 *                         failed read throws GrantReadError instead of
 *                         reading as "no grants".
 *   officialFailedAttemptId() — which attempt holds the learner's official Not
 *                         passed on a course, read strictly, for the attempt page.
 *   grantSnapshotForUsers() — its bulk form for the surfaces that render the
 *                         official-result chain (ADR 0014 steps 7, 8, 11):
 *                         the same strict rule, keyed `${user_id}:${course_id}`.
 *   fetchUnusedGrantsForUsers() — the unused approved grants of a page of
 *                         learners, fail-soft (ADR 0014:186's named reader;
 *                         the Learners page's "retake reset, no grant" label
 *                         reads the strict snapshot instead).
 *   isSchemaMissing()   — a missing relation, column or function (a
 *                         database behind the code); isMissingColumn() is
 *                         the trigger of the narrower-select fallbacks, and
 *                         readWithOptionalColumn() writes that fallback once
 *                         (readPagedWithOptionalColumn() its paged form, the
 *                         first page deciding).
 *   fetchPassRequired() — which courses are configured "pass required"
 *                         (0081), fail-soft on a database that has not run
 *                         the migration yet.
 *
 * No next/* import and no runtime Supabase import: lib/attempts/force-restart.ts
 * and the pure launch helpers import from here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

export type PgError = { code?: string | null; message?: string | null } | null | undefined;

/**
 * A PostgREST / supabase-js error meaning a relation, column or function is
 * not on this database yet (ADR 0014 step 3): the shape of
 * lib/alds/flag.ts isAldsSchemaMissing (which stays for the P4 callers)
 * plus PGRST205 (a table missing from the schema cache).
 */
export function isSchemaMissing(error: PgError): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (
    code === "42703" ||
    code === "42P01" ||
    code === "42883" ||
    code === "PGRST204" ||
    code === "PGRST202" ||
    code === "PGRST205"
  ) {
    return true;
  }
  return /schema cache|does not exist|could not find the/i.test(error.message ?? "");
}

/**
 * The narrower-select fallback's trigger (docs/MIGRATIONS.md: code that
 * reads a new column tolerates it being absent): a missing-column error
 * (42703 from a select or a filter, PGRST204 from a write payload) that
 * names `column`, or names no column at all. Any other error is a real
 * failure and is never retried without the column, so a flagged row can
 * never read as unflagged because of a transient error.
 */
export function isMissingColumn(error: PgError, column: string): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code !== "42703" && code !== "PGRST204") return false;
  const msg = error.message ?? "";
  return msg === "" || msg.includes(column);
}

/**
 * The narrower-select fallback, written once (ADR 0014 steps 7 and 12; every
 * explicit select PR 1b widens goes through it): reads `${base}, ${column}`,
 * and only when that answer is a missing-column error naming `column`
 * (isMissingColumn) reads `base` once. Any other error is returned as it is
 * and never retried without the column.
 */
export async function readWithOptionalColumn<T>(
  column: string,
  read: (columns: string) => PromiseLike<{ data: T | null; error: PgError }>,
  base: string
): Promise<{ data: T | null; error: PgError }> {
  const first = await read(`${base}, ${column}`);
  if (first.error && isMissingColumn(first.error, column)) return await read(base);
  return first;
}

/**
 * The column list a paged read decided (readPagedWithOptionalColumn): null
 * until a page answers without an error. A chunked read passes one object to
 * every chunk, so the first page that answers decides for all of them.
 */
export type OptionalColumnState = { columns: string | null };

/** The error of a page that answered neither rows nor an error (opts.nullIsError). */
const EMPTY_ANSWER = { code: "empty_answer", message: "an answer with neither rows nor an error" };

/**
 * The paged form of readWithOptionalColumn, written once:
 * reads pages of `pageSize` rows (default 1,000, the PostgREST cap)
 * through `read(columns, from, to)` until a short page.
 *
 * The first page decides. It is read through readWithOptionalColumn, so a
 * missing-column error naming `column` re-reads it with `base`; the column
 * list that answered it without an error is then used for every later page
 * (and every later call sharing `opts.state`) and is never decided again. An
 * error on any later page, a missing-column error included, is never retried
 * with another column list: it ends the read and is returned with the rows
 * read so far. Each caller keeps its own rule for that error (fail closed,
 * throw, or count what was read).
 *
 * `opts.nullIsError` makes a page that answers neither rows nor an error an
 * error (`empty_answer`), for the callers that fail closed on it; otherwise
 * such a page reads as empty and ends the read. `opts.maxPages` is a safety
 * ceiling on the pages read.
 */
export async function readPagedWithOptionalColumn<T>(
  column: string,
  read: (columns: string, from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError }>,
  base: string,
  opts: { pageSize?: number; maxPages?: number; nullIsError?: boolean; state?: OptionalColumnState } = {}
): Promise<{ data: T[]; error: PgError }> {
  const pageSize = opts.pageSize ?? 1000;
  const state = opts.state ?? { columns: null };
  const out: T[] = [];
  for (let page = 0; opts.maxPages === undefined || page < opts.maxPages; page++) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    let res: { data: T[] | null; error: PgError };
    if (state.columns !== null) {
      res = await read(state.columns, from, to);
    } else {
      let used = base;
      res = await readWithOptionalColumn<T[]>(
        column,
        (columns) => {
          used = columns;
          return read(columns, from, to);
        },
        base
      );
      if (!res.error) state.columns = used;
    }
    if (res.error) return { data: out, error: res.error };
    if (res.data == null && opts.nullIsError) return { data: out, error: EMPTY_ANSWER };
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return { data: out, error: null };
}

export type AttemptKind = {
  attemptId: string;
  userId: string;
  courseId: string;
  organizationId: string;
  /** 1-based completion order among the learner's completed attempts on this course; null while in progress. */
  attemptNumber: number | null;
  /** Inside the scoring window (official) — or beyond it (revision/practice). */
  official: boolean;
  scoring: ScoringResult;
};

const KIND_ATTEMPT_COLUMNS = "id, user_id, organization_id, course_version_id, course_versions!inner(course_id)";
/** `status` is a 0002 column; only `is_revision` (0103) can be missing. */
const KIND_LIST_COLUMNS = "id, score, started_at, completed_at, completion_status, success_status, status";

export async function classifyAttempt(svc: AnyClient, attemptId: string): Promise<AttemptKind | null> {
  // ADR 0014 step 6: the attempt's own flag, with the narrower-select
  // fallback on a database without 0103 (the flag then reads as false).
  const readAttempt = (columns: string) =>
    svc.from("course_attempts").select(columns).eq("id", attemptId).maybeSingle();
  let { data: att, error: attErr } = await readAttempt(`${KIND_ATTEMPT_COLUMNS}, is_revision`);
  if (attErr && isMissingColumn(attErr, "is_revision")) {
    ({ data: att, error: attErr } = await readAttempt(KIND_ATTEMPT_COLUMNS));
  }
  const a = att as {
    id: string;
    user_id: string;
    organization_id: string;
    course_version_id: string;
    is_revision?: boolean | null;
    course_versions: { course_id: string } | Array<{ course_id: string }>;
  } | null;
  if (!a) return null;
  const cv = Array.isArray(a.course_versions) ? a.course_versions[0] : a.course_versions;
  const courseId = cv?.course_id;
  if (!courseId) return null;
  const isRevision = a.is_revision === true;

  const { data: verRows, error: verErr } = await svc.from("course_versions").select("id").eq("course_id", courseId);
  const verIds = ((verRows ?? []) as Array<{ id: string }>).map((v) => v.id);
  // `status` and `is_revision` (ADR 0014 step 6): computeScoring
  // drops abandoned and revision rows, so an abandoned-but-completed row no
  // longer takes a place in the ordinal that decides `official` (0099's
  // after-apply count #3 expects zero such rows on both environments).
  const listFor = (columns: string) =>
    svc
      .from("course_attempts")
      .select(columns)
      .eq("user_id", a.user_id)
      .in("course_version_id", verIds.length ? verIds : [a.course_version_id]);
  let { data: rows, error: rowsErr } = await listFor(`${KIND_LIST_COLUMNS}, is_revision`);
  if (rowsErr && isMissingColumn(rowsErr, "is_revision")) {
    ({ data: rows, error: rowsErr } = await listFor(KIND_LIST_COLUMNS));
  }
  // A failed versions read is a failed list read (ADR 0015): the list above
  // would have narrowed to this row's own version, and a row beyond the window
  // through another version would read as number 1. So scoring runs on no rows:
  // a non-revision row answers official with a null number.
  if (verErr) rows = [];
  const attempts = (rows ?? []) as ScorableAttempt[];
  const policy = (await resolvePolicy(svc, courseId).catch(() => DEFAULT_POLICY)) ?? DEFAULT_POLICY;
  const retakeIds = await grantRetakeIdsFor(svc, a.user_id, courseId);
  const scoring = computeScoring(attempts, policy, retakeIds);
  const n = scoring.attemptNumber.get(attemptId) ?? null;
  return {
    attemptId,
    userId: a.user_id,
    courseId,
    organizationId: a.organization_id,
    attemptNumber: n,
    // Official when it is a grant retake, or it landed inside the scored window,
    // or it is still in progress with a free official slot. Revision runs and
    // attempts beyond the window are not official — they never credit journey
    // days, XP or the completion webhook. A revision visit's row is never
    // official (ADR 0014 step 6), whatever else is true of it.
    official:
      !isRevision &&
      (retakeIds.has(attemptId) ||
        scoring.scoredWindowIds.has(attemptId) ||
        (n === null && !scoring.limitReached)),
    scoring,
  };
}

/** One approved grant of the snapshot (0083 columns; `reissued_from` from 0103). */
export type GrantRow = {
  id: string;
  used_attempt_id: string | null;
  used_at: string | null;
  expires_at: string | null;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  reason: string | null;
  /** 0103; undefined when the database has no such column (the chain then follows no re-issue link). */
  reissued_from?: string | null;
};

export type GrantSnapshot = {
  /** Attempt ids that consumed an approved grant (used_attempt_id set). */
  retakeIds: Set<string>;
  /** The oldest approved grant not yet used and not expired; null when none. */
  unusedGrant: GrantRow | null;
  /** Every approved grant row, for later consumers (the official-result chain). */
  rows: GrantRow[];
};

/** A grant read that failed for a reason other than a missing schema: callers fail closed. */
export class GrantReadError extends Error {
  constructor(readonly code: string) {
    super(`grant read failed: ${code}`);
    this.name = "GrantReadError";
  }
}

const GRANT_COLUMNS = "id, used_attempt_id, used_at, expires_at, created_at, decided_by, decided_at, decision_note, reason";

/**
 * The learner's approved grants on a course, in ONE error-checked select
 * (ADR 0014 step 3). Error order: a missing `reissued_from` (a database
 * without 0103) re-reads without it, and the chain then follows no re-issue
 * link; only then is a missing relation (isSchemaMissing, pre-0083) "no
 * grants"; any other error, or an answer with neither rows nor an error,
 * throws GrantReadError.
 */
export async function grantSnapshotFor(
  svc: AnyClient,
  userId: string,
  courseId: string,
  nowIso: string = new Date().toISOString()
): Promise<GrantSnapshot> {
  // Its own abort signal: Next memoizes identical GET fetches within one
  // server render, and the launch page reads the grants again after
  // consume_grant, when a concurrent launch may have used the grant. A
  // signal opts the read out of that cache. Elsewhere it costs nothing: the
  // course and attempt pages read the grants once per render, and route
  // handlers have no such cache.
  const read = (columns: string) =>
    svc
      .from("attempt_requests")
      .select(columns)
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .eq("status", "approved")
      .abortSignal(new AbortController().signal);
  let res: { data: unknown; error: PgError } = await read(`${GRANT_COLUMNS}, reissued_from`);
  if (res.error && isMissingColumn(res.error, "reissued_from")) res = await read(GRANT_COLUMNS);
  if (res.error) {
    if (isSchemaMissing(res.error)) return grantSnapshotOf([], nowIso);
    throw new GrantReadError(String(res.error.code ?? "") || "error");
  }
  if (res.data == null) throw new GrantReadError("empty_answer");
  return grantSnapshotOf(res.data as GrantRow[], nowIso);
}

/**
 * The attempt that holds the learner's official Not passed on a course, by the course
 * page's own condition (ADR 0017's note of 2026-11-06): computeScoring over the
 * learner's attempts on the course and the retake ids of the strict grant read, and
 * `officialStatus === "failed"`. The attempt page shows the sentence that names the
 * official result only on that attempt, so a row a granted retake replaced does not
 * tell the learner their result is Not passed. A failed or empty read answers null
 * (ADR 0014 step 7), except a grant read grantSnapshotFor takes for a missing schema:
 * a PGRST002 or PGRST205 answer reads as no grants, as it does on the course page, so
 * for that render the sentence can show on a row a retake replaced.
 *
 * Three reads on `client`, with the caller's RLS. No policy read: normalizePolicy
 * clamps every rule to DEFAULT_POLICY (ADR 0014 step 9), so the course page's
 * resolvePolicy can only answer that, and a failed read of it would go unseen. The
 * attempts read names its columns, so it does not pull each row's cmi_data.
 */
export async function officialFailedAttemptId(client: AnyClient, userId: string, courseId: string): Promise<string | null> {
  try {
    const { data: versions, error: versionsErr } = await client.from("course_versions").select("id").eq("course_id", courseId);
    const versionIds = ((versions ?? []) as Array<{ id: string }>).map((v) => v.id);
    if (versionsErr || versionIds.length === 0) return null;
    const { data: attempts, error: attemptsErr } = await readWithOptionalColumn<ScorableAttempt[]>(
      "is_revision",
      (columns) => client.from("course_attempts").select(columns).eq("user_id", userId).in("course_version_id", versionIds),
      KIND_LIST_COLUMNS
    );
    if (attemptsErr || !attempts?.length) return null;
    const { retakeIds } = await grantSnapshotFor(client, userId, courseId);
    const scoring = computeScoring(attempts, DEFAULT_POLICY, retakeIds);
    return scoring.officialStatus === "failed" ? (scoring.officialAttempt?.id ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The snapshot of a list of approved grant rows (pure): the retake ids are
 * the rows with `used_attempt_id` set, and the unused grant is the oldest
 * row (by `created_at`) with `used_at` null and `expires_at` null or in the
 * future (the rules of grantRetakeIdsFor and unusedGrantFor, from one read).
 */
export function grantSnapshotOf(rows: GrantRow[], nowIso: string = new Date().toISOString()): GrantSnapshot {
  const retakeIds = new Set<string>();
  for (const r of rows) if (r.used_attempt_id) retakeIds.add(r.used_attempt_id);
  const nowMs = Date.parse(nowIso);
  const live = rows
    .filter((g) => !g.used_at && (!g.expires_at || Date.parse(g.expires_at) > nowMs))
    .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { retakeIds, unusedGrant: live[0] ?? null, rows };
}

/** One approved grant of the bulk snapshot: the snapshot's columns plus the pair it belongs to. */
export type GrantPairRow = GrantRow & { user_id: string; course_id: string };

/** The `.in()` chunk of the bulk grant reads (the chunk of fetchGrantRetakeIdsForUsers). */
const GRANT_CHUNK = 300;

/**
 * The bulk form of grantSnapshotFor (ADR 0014 step 3, "its bulk form
 * grantSnapshotForUsers(svc, orgId, courseIds, userIds)"), for the surfaces
 * that render the official-result chain (steps 7, 8 and 11): the approved
 * grants of `userIds` in the organisation, `user_id` chunked by 300, and
 * `course_id` filtered in the query when `courseIds` holds at most 300 ids
 * (a longer list is filtered in memory; null means every course of the
 * users, for the Report Card and the CRM feed). Each chunk is paged,
 * `.order("id").range(from, from + 999)` until a short page:
 * PostgREST cuts an answer at 1,000 rows without an error,
 * and the order keeps the pages, and so a CRM status, stable between calls.
 * The same strict rule and error order as grantSnapshotFor, through
 * readPagedWithOptionalColumn: a missing `reissued_from` on the first page
 * re-reads without it, and every later page and chunk reads without it; a
 * missing relation (isSchemaMissing) before any page has answered is an
 * empty map, "no grants" (pre-0083); any other error, an error on a later
 * page (a schema-missing one included: the first page decides), or a page
 * with neither rows nor an error throws GrantReadError, so a partial read
 * never stands as the whole.
 * Keyed `${user_id}:${course_id}`; a pair with no grant is absent (callers
 * read it as an empty snapshot).
 */
export async function grantSnapshotForUsers(
  svc: AnyClient,
  orgId: string,
  courseIds: string[] | null,
  userIds: string[],
  nowIso: string = new Date().toISOString()
): Promise<Map<string, GrantSnapshot>> {
  const out = new Map<string, GrantSnapshot>();
  const users = [...new Set(userIds.filter(Boolean))];
  const courses = courseIds === null ? null : [...new Set(courseIds.filter(Boolean))];
  if (!orgId || users.length === 0 || (courses !== null && courses.length === 0)) return out;
  const inQuery = courses !== null && courses.length <= GRANT_CHUNK ? courses : null;
  const inMemory = courses !== null && courses.length > GRANT_CHUNK ? new Set(courses) : null;
  const decided: OptionalColumnState = { columns: null };
  const rows: GrantPairRow[] = [];
  for (let i = 0; i < users.length; i += GRANT_CHUNK) {
    const chunk = users.slice(i, i + GRANT_CHUNK);
    const res = await readPagedWithOptionalColumn<GrantPairRow>(
      "reissued_from",
      (columns, from, to) => {
        const q = svc.from("attempt_requests").select(columns).eq("organization_id", orgId).eq("status", "approved").in("user_id", chunk);
        return (inQuery ? q.in("course_id", inQuery) : q).order("id").range(from, to);
      },
      `${GRANT_COLUMNS}, user_id, course_id`,
      { state: decided, nullIsError: true }
    );
    if (res.error) {
      // "No grants" only while no page has answered: once one has, the
      // relation exists and any error is a failed read.
      if (decided.columns === null && isSchemaMissing(res.error)) return new Map();
      throw new GrantReadError(String(res.error.code ?? "") || "error");
    }
    for (const r of res.data) if (!inMemory || inMemory.has(r.course_id)) rows.push(r);
  }
  const byPair = new Map<string, GrantPairRow[]>();
  for (const r of rows) {
    const k = `${r.user_id}:${r.course_id}`;
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(r);
  }
  for (const [k, list] of byPair) out.set(k, grantSnapshotOf(list, nowIso));
  return out;
}

/**
 * The grant-designated official RETAKE attempt ids a learner has consumed for a
 * course (Phase 2): approved grants whose retake has been started (used_at set,
 * used_attempt_id recorded). Passing these to computeScoring widens the scored
 * window and makes the newest completed retake the official result. Returns the
 * set of attempt ids; empty on a pre-0083 database. Fail-soft, for display
 * callers only: the launch page and the forced restart read grantSnapshotFor().
 */
export async function grantRetakeIdsFor(svc: AnyClient, userId: string, courseId: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userId || !courseId) return out;
  try {
    const { data, error } = await svc
      .from("attempt_requests")
      .select("used_attempt_id")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .eq("status", "approved")
      .not("used_attempt_id", "is", null);
    if (error) return out;
    for (const r of (data ?? []) as Array<{ used_attempt_id: string | null }>) {
      if (r.used_attempt_id) out.add(r.used_attempt_id);
    }
  } catch {
    /* pre-0083 */
  }
  return out;
}

/**
 * Grant-retake attempt ids per course for ONE learner (batch form of
 * grantRetakeIdsFor), for the learner surfaces that score many courses at once.
 * Returns course_id → set of retake attempt ids; empty on pre-0083.
 */
export async function fetchGrantRetakeIds(svc: AnyClient, userId: string, courseIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const ids = [...new Set(courseIds.filter(Boolean))];
  if (!userId || ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await svc
        .from("attempt_requests")
        .select("course_id, used_attempt_id")
        .eq("user_id", userId)
        .in("course_id", ids.slice(i, i + 300))
        .eq("status", "approved")
        .not("used_attempt_id", "is", null);
      if (error) return out;
      for (const r of (data ?? []) as Array<{ course_id: string; used_attempt_id: string | null }>) {
        if (!r.used_attempt_id) continue;
        (out.get(r.course_id) ?? out.set(r.course_id, new Set()).get(r.course_id)!).add(r.used_attempt_id);
      }
    }
  } catch {
    /* pre-0083 */
  }
  return out;
}

/**
 * Grant-retake attempt ids keyed `${user_id}:${course_id}` for a page of
 * learners (the bulk progress feed). Empty on pre-0083.
 */
export async function fetchGrantRetakeIdsForUsers(svc: AnyClient, orgId: string, userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!orgId || ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await svc
        .from("attempt_requests")
        .select("user_id, course_id, used_attempt_id")
        .eq("organization_id", orgId)
        .in("user_id", ids.slice(i, i + 300))
        .eq("status", "approved")
        .not("used_attempt_id", "is", null);
      if (error) return out;
      for (const r of (data ?? []) as Array<{ user_id: string; course_id: string; used_attempt_id: string | null }>) {
        if (!r.used_attempt_id) continue;
        const k = `${r.user_id}:${r.course_id}`;
        (out.get(k) ?? out.set(k, new Set()).get(k)!).add(r.used_attempt_id);
      }
    }
  } catch {
    /* pre-0083 */
  }
  return out;
}

/** An approved grant not yet used (fetchUnusedGrantsForUsers); the caller tests `expires_at`. */
export type UnusedGrant = { id: string; course_id: string; expires_at: string | null };

/**
 * The approved, unused grants of a page of learners (ADR 0014:186's named
 * read): `id, user_id, course_id, expires_at` with `status = 'approved'` and
 * `used_at is null`, `user_id` chunked by 300, keyed `${user_id}:${course_id}`.
 * Fail-soft: an error or a thrown exception returns the pairs read so far,
 * with no failure signal. A missing pair therefore cannot tell "no unused
 * grant" from "not read", so the Learners page's "retake reset, no grant"
 * label does not read this map: it reads the strict snapshot's
 * `unusedGrant`, which is absent with
 * the history when the read fails.
 */
export async function fetchUnusedGrantsForUsers(svc: AnyClient, orgId: string, userIds: string[]): Promise<Map<string, UnusedGrant[]>> {
  const out = new Map<string, UnusedGrant[]>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!orgId || ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += GRANT_CHUNK) {
      const { data, error } = await svc
        .from("attempt_requests")
        .select("id, user_id, course_id, expires_at")
        .eq("organization_id", orgId)
        .eq("status", "approved")
        .is("used_at", null)
        .in("user_id", ids.slice(i, i + GRANT_CHUNK));
      if (error) return out;
      for (const r of (data ?? []) as Array<UnusedGrant & { user_id: string }>) {
        const k = `${r.user_id}:${r.course_id}`;
        (out.get(k) ?? out.set(k, []).get(k)!).push({ id: r.id, course_id: r.course_id, expires_at: r.expires_at });
      }
    }
  } catch {
    /* the pairs read so far */
  }
  return out;
}

/**
 * An approved, unexpired, UNUSED grant for this learner+course, if any — the
 * launch gate uses it to turn the next launch into a fresh OFFICIAL retake
 * (instead of a revision run) and then marks it used. Null on pre-0083.
 */
export async function unusedGrantFor(svc: AnyClient, userId: string, courseId: string): Promise<{ id: string } | null> {
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await svc
      .from("attempt_requests")
      .select("id, expires_at")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .eq("status", "approved")
      .is("used_at", null)
      .order("created_at", { ascending: true })
      .limit(5);
    if (error) return null;
    const live = (data ?? []).find((g: { expires_at: string | null }) => !g.expires_at || g.expires_at > nowIso);
    return live ? { id: (live as { id: string }).id } : null;
  } catch {
    return null;
  }
}

/** Course ids configured "pass required" among the given ids; empty set on a pre-0081 database. */
export async function fetchPassRequired(client: AnyClient, courseIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(courseIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await client
        .from("courses")
        .select("id, pass_required")
        .in("id", ids.slice(i, i + 300))
        .eq("pass_required", true);
      if (error) return out;
      for (const r of (data ?? []) as Array<{ id: string }>) out.add(r.id);
    }
  } catch {
    /* pre-0081 */
  }
  return out;
}
