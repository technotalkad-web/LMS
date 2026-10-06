import {
  DEFAULT_POLICY,
  computeScoring,
  courseStatus,
  isCompletedAttempt,
  officialDone,
  type CourseStatus,
  type ScorableAttempt,
  type ScoringResult,
} from "./policy";
import { resolvePolicies } from "./resolve";
import { fetchGrantRetakeIdsForUsers } from "./attempt-kind";

/**
 * THE learner course-status definitions (Phase 0a, product decision 1).
 *
 * A learner's result on a course comes from their OFFICIAL attempt only —
 * the attempt the scoring policy designates (first / best / latest / nth of
 * the scored window, or the newest admin-granted retake). Revision/practice
 * runs never change it. Concretely:
 *
 *   not_started  no attempt on any version of the course
 *   in_progress  attempts exist, none official yet (nothing completed)
 *   completed    official attempt completed with no pass/fail verdict
 *   passed       official attempt passed
 *   failed       official attempt FAILED — a later practice pass does not
 *                turn it green, and a practice fail after an official pass
 *                is NOT a failure
 *
 * Every surface that reports a learner's status or a "failed" count —
 * learner pages, admin reports and analytics, exports, CRM/Yoddha APIs and
 * the SQL views (`v_course_attempt_summary.official_status`, 0090) — must
 * use these helpers, so the numbers agree everywhere. Do not derive status
 * from "the latest attempt" or count failed attempt rows anywhere else.
 */

export { computeScoring, courseStatus, isCompletedAttempt, officialDone, DEFAULT_POLICY };
export type { CourseStatus, ScorableAttempt, ScoringResult };

/** "Failed" = the official attempt failed. Never a practice/revision run. */
export function isOfficialFailed(s: ScoringResult): boolean {
  return s.officialStatus === "failed";
}

/** "Passed" = the official attempt passed. A practice pass never counts. */
export function isOfficialPassed(s: ScoringResult): boolean {
  return s.officialStatus === "passed";
}

/** Status → the coarse pass/fail verdict callers show as a result pill. */
export function verdictOf(status: CourseStatus): "passed" | "failed" | "completed" | null {
  return status === "passed" || status === "failed" || status === "completed" ? status : null;
}

// Supabase's builder generics get "excessively deep" when threaded through
// helpers; the calls here are simple enough that a loose client is safer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** An attempt row already resolved to its course (callers map version → course). */
export type StatusAttempt = ScorableAttempt & { user_id: string; course_id: string };

export type UserCourseStatus = {
  user_id: string;
  course_id: string;
  status: CourseStatus;
  scoring: ScoringResult;
  attempts: ScorableAttempt[];
};

export function userCourseKey(userId: string, courseId: string): string {
  return `${userId}:${courseId}`;
}

/**
 * Batch: the official status of every (learner, course) pair present in
 * `attempts`, resolving each course's scoring policy and each learner's
 * consumed grant retakes (0083) once. Pairs with no attempts are absent —
 * use `statusOf` to read them back as "not_started".
 *
 * Works with the service-role client or an admin's RLS client (the policy
 * RPC is granted to authenticated; attempt_requests is admin-readable).
 */
export async function officialStatuses(
  client: AnyClient,
  orgId: string,
  attempts: StatusAttempt[]
): Promise<Map<string, UserCourseStatus>> {
  const byKey = new Map<string, StatusAttempt[]>();
  const courseIds = new Set<string>();
  const userIds = new Set<string>();
  for (const a of attempts) {
    if (!a.user_id || !a.course_id) continue;
    courseIds.add(a.course_id);
    userIds.add(a.user_id);
    const k = userCourseKey(a.user_id, a.course_id);
    const list = byKey.get(k);
    if (list) list.push(a);
    else byKey.set(k, [a]);
  }
  const [policies, grants] = await Promise.all([
    resolvePolicies(client, [...courseIds]),
    fetchGrantRetakeIdsForUsers(client, orgId, [...userIds]),
  ]);
  const out = new Map<string, UserCourseStatus>();
  for (const [k, list] of byKey) {
    const { user_id, course_id } = list[0];
    const scoring = computeScoring(list, policies.get(course_id) ?? DEFAULT_POLICY, grants.get(k) ?? new Set<string>());
    out.set(k, { user_id, course_id, status: courseStatus(scoring, list), scoring, attempts: list });
  }
  return out;
}

/** Read one pair from a batch result; a pair with no attempts is "not_started". */
export function statusOf(map: Map<string, UserCourseStatus>, userId: string, courseId: string): CourseStatus {
  return map.get(userCourseKey(userId, courseId))?.status ?? "not_started";
}

export type StatusCounts = Record<CourseStatus, number>;
export const EMPTY_STATUS_COUNTS: StatusCounts = { not_started: 0, in_progress: 0, completed: 0, passed: 0, failed: 0 };

/** Per-course counts of learners by official status, from a batch result. */
export function countByStatus(map: Map<string, UserCourseStatus>, courseId: string): StatusCounts {
  const c: StatusCounts = { ...EMPTY_STATUS_COUNTS };
  for (const v of map.values()) if (v.course_id === courseId) c[v.status]++;
  return c;
}

/** One pass over a batch result: course_id → learner counts by official status. */
export function countsByCourse(map: Map<string, UserCourseStatus>): Map<string, StatusCounts> {
  const out = new Map<string, StatusCounts>();
  for (const v of map.values()) {
    const c = out.get(v.course_id) ?? { ...EMPTY_STATUS_COUNTS };
    c[v.status]++;
    out.set(v.course_id, c);
  }
  return out;
}

/** A learner×course pair has an official result (completed, passed or failed). */
export function hasOfficialResult(status: CourseStatus): boolean {
  return status === "completed" || status === "passed" || status === "failed";
}
