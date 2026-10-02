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
  const scoring = computeScoring(attempts, policy, await extraAttemptsFor(svc, a.user_id, courseId));
  const n = scoring.attemptNumber.get(attemptId) ?? null;
  return {
    attemptId,
    userId: a.user_id,
    courseId,
    organizationId: a.organization_id,
    attemptNumber: n,
    // An attempt still in progress is official when a scored slot is free
    // for it; a completed one is official when it landed inside the window.
    official: n === null ? !scoring.limitReached : n <= scoring.policy.max_scored_attempts + scoring.extraAttempts,
    scoring,
  };
}

/** Extra official attempts granted to a learner for a course (Phase 2 grants; 0 until then). */
export async function extraAttemptsFor(_svc: AnyClient, _userId: string, _courseId: string): Promise<number> {
  return 0;
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
