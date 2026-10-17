import {
  DEFAULT_POLICY,
  attemptCounts,
  computeScoring,
  courseStatus,
  excludeAbandoned,
  isAbandonedAttempt,
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

export { attemptCounts, computeScoring, courseStatus, excludeAbandoned, isAbandonedAttempt, isCompletedAttempt, officialDone, DEFAULT_POLICY };
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

/** Enrolment summary of one course: the Library course card and its Reports tab. */
export type EnrolledSummary = {
  total: number;
  /** Official attempt completed or passed. */
  completed: number;
  /** Official attempt failed. */
  failed: number;
  inProgress: number;
  /** No attempt, or only reset (abandoned) attempts (ADR 0004 step 11). */
  notStarted: number;
};

/**
 * Counts the enrolled learners of `courseId` by official status, from a batch
 * `officialStatuses()` result over their attempts on that course. Learners
 * with no entry, or whose only attempts were reset, are not started, so the
 * five numbers always sum to `total`. One function for both pages, so the
 * Library card and the course Reports tab can never disagree.
 */
export function enrolledStatusSummary(
  enrolled: ReadonlySet<string>,
  official: Map<string, UserCourseStatus>,
  courseId: string
): EnrolledSummary {
  const out: EnrolledSummary = { total: enrolled.size, completed: 0, failed: 0, inProgress: 0, notStarted: 0 };
  let started = 0;
  for (const uid of enrolled) {
    const s = official.get(userCourseKey(uid, courseId))?.status ?? "not_started";
    if (s === "not_started") continue;
    started++;
    if (s === "completed" || s === "passed") out.completed++;
    else if (s === "failed") out.failed++;
    else out.inProgress++;
  }
  out.notStarted = enrolled.size - started;
  return out;
}

/**
 * The enrolled learners of one course and their official statuses, read the
 * SAME way for the Library course card and the course Reports tab, so the
 * two pages always agree (gap 3). Enrolled = direct, team and org-wide
 * assignments (custom-group assignments are not expanded, as before). Every
 * read is paged at the PostgREST row cap and every `.in()` list is chunked,
 * so a large org-wide course is counted completely; attempts are read by the
 * course's versions and narrowed to the enrolled learners in memory.
 * Fail-soft: a failed read is logged and the summary counts what was read.
 * Works with an admin's RLS client (the pages are admin-gated).
 */
export async function loadEnrolledCourseStatus(
  client: AnyClient,
  orgId: string,
  courseId: string,
  versionIds: string[]
): Promise<{ enrolledUserIds: Set<string>; officialByUser: Map<string, UserCourseStatus>; summary: EnrolledSummary }> {
  const PAGE = 1000;
  const CHUNK = 150;
  type Row = Record<string, unknown>;
  // Pages one query; `build(from, to)` returns the ranged builder.
  const paged = async (what: string, build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    const out: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build(from, from + PAGE - 1);
      if (error) {
        console.warn(`[enrolled-status] ${what} read failed:`, error.message);
        break;
      }
      const rows = (data ?? []) as Row[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  };

  const assignments = (await paged("assignments", (f, t) =>
    client.from("course_assignments").select("id, assignee_type, user_id, team_id").eq("course_id", courseId).order("id").range(f, t)
  )) as Array<{ assignee_type: string; user_id: string | null; team_id: string | null }>;

  const teamIds = [...new Set(assignments.filter((a) => a.assignee_type === "team" && a.team_id).map((a) => a.team_id as string))];
  const teamUsers = new Map<string, Set<string>>();
  for (let i = 0; i < teamIds.length; i += CHUNK) {
    const part = teamIds.slice(i, i + CHUNK);
    const rows = (await paged("team members", (f, t) =>
      client.from("team_members").select("team_id, user_id").in("team_id", part).order("team_id").order("user_id").range(f, t)
    )) as Array<{ team_id: string; user_id: string }>;
    for (const r of rows) (teamUsers.get(r.team_id) ?? teamUsers.set(r.team_id, new Set()).get(r.team_id)!).add(r.user_id);
  }

  const orgMemberIds = assignments.some((a) => a.assignee_type === "org")
    ? ((await paged("org members", (f, t) =>
        client.from("organization_members").select("user_id").eq("organization_id", orgId).order("user_id").range(f, t)
      )) as Array<{ user_id: string }>).map((r) => r.user_id)
    : [];

  const enrolledUserIds = new Set<string>();
  for (const a of assignments) {
    if (a.assignee_type === "user" && a.user_id) enrolledUserIds.add(a.user_id);
    else if (a.assignee_type === "team" && a.team_id) for (const uid of teamUsers.get(a.team_id) ?? []) enrolledUserIds.add(uid);
    else if (a.assignee_type === "org") for (const uid of orgMemberIds) enrolledUserIds.add(uid);
  }

  const attempts: StatusAttempt[] = [];
  if (enrolledUserIds.size > 0) {
    for (let i = 0; i < versionIds.length; i += CHUNK) {
      const part = versionIds.slice(i, i + CHUNK);
      const rows = (await paged("attempts", (f, t) =>
        client
          .from("course_attempts")
          .select("id, user_id, status, completion_status, success_status, score, started_at, completed_at")
          .in("course_version_id", part)
          .order("id")
          .range(f, t)
      )) as unknown as Array<ScorableAttempt & { user_id: string }>;
      for (const a of rows) if (enrolledUserIds.has(a.user_id)) attempts.push({ ...a, course_id: courseId });
    }
  }
  const officialByUser = await officialStatuses(client, orgId, attempts);
  return { enrolledUserIds, officialByUser, summary: enrolledStatusSummary(enrolledUserIds, officialByUser, courseId) };
}
