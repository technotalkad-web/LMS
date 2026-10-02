import { computeScoring, DEFAULT_POLICY, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";

/**
 * Server-side helpers for the revision rule (Phase 1):
 *
 *   classifyAttempt()   — is THIS attempt official (inside the scoring window)
 *                         or a revision/practice run? Used by the commit
 *                         paths to decide what a completion may change:
 *                         journey days, XP and the CRM webhook follow
 *                         official attempts only.
 *   fetchPassRequired() — which courses are configured "pass required"
 *                         (0081), fail-soft on a database that has not run
 *                         the migration yet.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

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

export async function classifyAttempt(svc: AnyClient, attemptId: string): Promise<AttemptKind | null> {
  const { data: att } = await svc
    .from("course_attempts")
    .select("id, user_id, organization_id, course_version_id, course_versions!inner(course_id)")
    .eq("id", attemptId)
    .maybeSingle();
  const a = att as {
    id: string;
    user_id: string;
    organization_id: string;
    course_version_id: string;
    course_versions: { course_id: string } | Array<{ course_id: string }>;
  } | null;
  if (!a) return null;
  const cv = Array.isArray(a.course_versions) ? a.course_versions[0] : a.course_versions;
  const courseId = cv?.course_id;
  if (!courseId) return null;

  const { data: verRows } = await svc.from("course_versions").select("id").eq("course_id", courseId);
  const verIds = ((verRows ?? []) as Array<{ id: string }>).map((v) => v.id);
  const { data: rows } = await svc
    .from("course_attempts")
    .select("id, score, started_at, completed_at, completion_status, success_status")
    .eq("user_id", a.user_id)
    .in("course_version_id", verIds.length ? verIds : [a.course_version_id]);
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
    // days, XP or the completion webhook.
    official:
      retakeIds.has(attemptId) ||
      scoring.scoredWindowIds.has(attemptId) ||
      (n === null && !scoring.limitReached),
    scoring,
  };
}

/**
 * The grant-designated official RETAKE attempt ids a learner has consumed for a
 * course (Phase 2): approved grants whose retake has been started (used_at set,
 * used_attempt_id recorded). Passing these to computeScoring widens the scored
 * window and makes the newest completed retake the official result. Returns the
 * set of attempt ids; empty on a pre-0083 database.
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
