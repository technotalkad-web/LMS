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
 *   isSchemaMissing()   — a missing relation, column or function (a
 *                         database behind the code); isMissingColumn() is
 *                         the trigger of the narrower-select fallbacks.
 *   fetchPassRequired() — which courses are configured "pass required"
 *                         (0081), fail-soft on a database that has not run
 *                         the migration yet.
 *
 * No next/* import and no runtime Supabase import: lib/attempts/force-restart.ts
 * and the pure launch helpers import from here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

type PgError = { code?: string | null; message?: string | null } | null | undefined;

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

  const { data: verRows } = await svc.from("course_versions").select("id").eq("course_id", courseId);
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
  const read = (columns: string) =>
    svc
      .from("attempt_requests")
      .select(columns)
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .eq("status", "approved");
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
