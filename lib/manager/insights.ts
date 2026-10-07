import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll, fetchByIds } from "@/lib/db/chunked";
import { DEFAULT_POLICY, computeScoring, courseStatus, officialDone } from "@/lib/scoring/policy";
import { resolvePolicies } from "@/lib/scoring/resolve";
import { fetchGrantRetakeIdsForUsers, fetchPassRequired } from "@/lib/scoring/attempt-kind";
import { courseProgress } from "@/lib/courses/progress-view";
import {
  DEFAULT_JOURNEY_TZ,
  computeJourneyState,
  courseDaysOf,
  dateOfDay,
  parseVersionDays,
  todayStr,
} from "@/lib/journey/journey";
import { fetchActiveMembers, resolveGroupMembers, type GroupRow } from "@/lib/org/groups";
import { isReleased } from "@/lib/learner/release";
import { THRESHOLDS, riskOf, statusOf } from "./report-card";
import type { CourseLine, ExceptionFlag, JourneyInsight, LearnerInsight, PathLine, Severity } from "./types";

/**
 * Per-learner insights for a SCOPED list of people (a manager's team), live.
 *
 * This is the Learner Analytics per-learner computation extracted into one
 * function: the same assignment expansion (user / team / group / org, released
 * only, paths entitle their courses), the same official-attempt scoring
 * (policy + granted retakes), the same journey maths as the reminder cron,
 * `course_attempts.last_activity_at` for engagement (not the gamification
 * clock, which ignores journey courses), and the §3 exception rules. All reads
 * are service-role and chunked; the caller has already resolved WHO may be
 * read (lib/manager/access.ts).
 */

export type InsightOptions = {
  orgId: string;
  orgSlug: string;
  /** The people to compute for — already scope-checked by the caller. */
  userIds: string[];
  /** 7 / 30 / 90 / null (all time). Affects period counts only; flags are always "now". */
  periodDays: number | null;
  /** Extra period windows to roll up from the same data load (the precompute cache fills all four at once). */
  periods?: Array<number | null>;
  /** "" | course:<id> | path:<id> | journey:<id> — narrows every number to that content. */
  content?: string;
  now?: Date;
};

export type CatalogEntry = { id: string; title: string };
export type Catalog = {
  courses: CatalogEntry[];
  paths: CatalogEntry[];
  journeys: CatalogEntry[];
};

export type InsightsResult = {
  learners: LearnerInsight[];
  /** Per extra period requested via `periods` (key = days or "all"). */
  byPeriod?: Map<string, LearnerInsight[]>;
  catalog: Catalog;
  /** Org-wide fail rate per course (%) from the nightly matview, for §10 benchmarks. */
  benchmark: Map<string, { failRate: number | null; enrolled: number }>;
  today: string;
  tz: string;
};

type AttemptRow = {
  id: string;
  user_id: string;
  course_version_id: string;
  completion_status: "in_progress" | "completed" | null;
  success_status: "unknown" | "passed" | "failed" | null;
  score: number | null;
  started_at: string | null;
  completed_at: string | null;
  last_activity_at: string | null;
  progress_pct?: number | null;
  units?: unknown;
};
type CourseAssign = {
  course_id: string;
  assignee_type: "user" | "org" | "team" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
  due_at: string | null;
  release_at: string | null;
  assigned_at: string | null;
};
type PathAssign = {
  path_id: string;
  assignee_type: "user" | "org" | "team" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
  due_at: string | null;
  assigned_at: string | null;
};
type EnrRow = {
  id: string;
  user_id: string;
  program_id: string;
  status: string;
  start_date: string;
  journey_versions:
    | { days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }
    | Array<{ days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }>;
};

const DAY = 86400000;
/** A relation that does not exist yet (pre-migration database) — the only read failure tolerated. */
function isMissingRelation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /does not exist|schema cache|relation/i.test(msg);
}
const toScorable = (a: AttemptRow) => ({
  id: a.id,
  score: a.score,
  started_at: a.started_at ?? "",
  completed_at: a.completed_at,
  completion_status: a.completion_status,
  success_status: a.success_status,
});
const minIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
const daysAgo = (iso: string | null, nowMs: number): number | null =>
  iso ? Math.floor((nowMs - new Date(iso).getTime()) / DAY) : null;
const fmtDay = (iso: string) => iso.slice(0, 10);

export async function computeLearnerInsights(svc: SupabaseClient, opts: InsightOptions): Promise<InsightsResult> {
  const { orgId, orgSlug } = opts;
  void orgSlug;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const userIds = [...new Set(opts.userIds)];
  const userSet = new Set(userIds);
  const content = opts.content ?? "";
  const lensCourse = content.startsWith("course:") ? content.slice(7) : null;
  const lensPath = content.startsWith("path:") ? content.slice(5) : null;
  const lensJourney = content.startsWith("journey:") ? content.slice(8) : null;

  /* ---- org timezone / today (journey maths, "active today") ---- */
  const { data: gsRow } = await svc
    .from("gamification_settings")
    .select("timezone")
    .eq("organization_id", orgId)
    .maybeSingle();
  const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
  // "Today" in the org's calendar, derived from `now` so a caller-supplied
  // clock keeps journey maths and period windows consistent.
  const today = opts.now ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now) : todayStr(tz);

  /* ---- catalog (titles for everything we may show; the picker lists active only) ---- */
  const { data: courseRows } = await svc
    .from("courses")
    .select("id, title, is_active")
    .eq("organization_id", orgId)
    .order("title");
  const allCourses = (courseRows ?? []) as Array<{ id: string; title: string; is_active: boolean }>;
  const courseTitle = new Map(allCourses.map((c) => [c.id, c.title]));
  const { data: pathRows } = await svc
    .from("learning_paths")
    .select("id, name, is_active")
    .eq("organization_id", orgId)
    .order("name");
  const allPaths = (pathRows ?? []) as Array<{ id: string; name: string; is_active: boolean }>;
  const pathName = new Map(allPaths.map((p) => [p.id, p.name]));
  const pathCourseRows = allPaths.length
    ? await fetchByIds<{ path_id: string; course_id: string; step_number: number; release_at: string | null }>(
        svc, "learning_path_courses", "path_id, course_id, step_number, release_at", "path_id", allPaths.map((p) => p.id), undefined, "path_id"
      )
    : [];
  pathCourseRows.sort((a, b) => (a.step_number ?? 0) - (b.step_number ?? 0));
  // Only ACTIVE paths and RELEASED steps of ACTIVE courses count (a learner
  // cannot open a deactivated path/course or an unreleased step, so none of
  // them may read as "not started"/overdue or be nudged about) — the same
  // rule as the learner dashboard and the CRM progress feed.
  const activeCourse = new Set(allCourses.filter((c) => c.is_active !== false).map((c) => c.id));
  const activePath = new Set(allPaths.filter((p) => p.is_active !== false).map((p) => p.id));
  const coursesOfPath = new Map<string, string[]>();
  for (const r of pathCourseRows) {
    if (!activePath.has(r.path_id) || !activeCourse.has(r.course_id) || !isReleased(r.release_at, nowMs)) continue;
    coursesOfPath.set(r.path_id, [...(coursesOfPath.get(r.path_id) ?? []), r.course_id]);
  }
  const { data: progRows } = await svc.from("journey_programs").select("*").eq("organization_id", orgId);
  const programs = (progRows ?? []) as Array<{ id: string; name: string; is_active: boolean; deadline_days?: number | null }>;
  const programById = new Map(programs.map((p) => [p.id, p]));
  const catalog: Catalog = {
    courses: allCourses.filter((c) => c.is_active).map((c) => ({ id: c.id, title: c.title })),
    paths: allPaths.filter((p) => p.is_active !== false).map((p) => ({ id: p.id, title: p.name })),
    journeys: programs.filter((p) => p.is_active !== false).map((p) => ({ id: p.id, title: p.name })),
  };

  if (userIds.length === 0) {
    // Catalog-only call (the L3 cached path still needs the org benchmark for §7 gaps).
    return { learners: [], catalog, benchmark: await loadBenchmark(svc, catalog.courses.map((c) => c.id)), today, tz };
  }

  /* ---- people ---- */
  type MemberRow = { user_id: string; designation: string | null; city: string | null; branch: string | null; business_vertical: string | null; department?: string | null; date_of_joining: string | null };
  let memberRows: MemberRow[];
  try {
    memberRows = await fetchByIds<MemberRow>(svc, "organization_members", "user_id, designation, city, branch, business_vertical, department, date_of_joining", "user_id", userIds, (q) => q.eq("organization_id", orgId), "user_id");
  } catch (e) {
    // 0096 deploy safety: no department column yet.
    if (!/department/.test(String((e as Error)?.message ?? e))) throw e;
    memberRows = await fetchByIds<MemberRow>(svc, "organization_members", "user_id, designation, city, branch, business_vertical, date_of_joining", "user_id", userIds, (q) => q.eq("organization_id", orgId), "user_id");
  }
  const memberById = new Map(memberRows.map((m) => [m.user_id, m]));
  const profRows = await fetchByIds<{ id: string; first_name: string | null; last_name: string | null; email: string | null; avatar_url: string | null }>(
    svc, "profiles", "id, first_name, last_name, email, avatar_url", "id", userIds
  );
  const profById = new Map(profRows.map((p) => [p.id, p]));
  const nameOf = (id: string) => {
    const p = profById.get(id);
    return [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim() || p?.email?.split("@")[0] || id.slice(0, 8);
  };

  /* ---- attempts + versions ---- */
  const attempts = await fetchByIds<AttemptRow>(
    svc, "course_attempts",
    "id, user_id, course_version_id, completion_status, success_status, score, started_at, completed_at, last_activity_at, progress_pct, units:cmi_data->cmi5->units",
    "user_id", userIds, (q) => q.eq("organization_id", orgId)
  );
  const versionIds = [...new Set(attempts.map((a) => a.course_version_id))];
  const versionRows = versionIds.length
    ? await fetchByIds<{ id: string; course_id: string; unit_count: number | null }>(
        svc, "course_versions", "id, course_id, unit_count:manifest_data->unitCount", "id", versionIds
      )
    : [];
  const courseOfVersion = new Map(versionRows.map((v) => [v.id, v.course_id]));
  const unitCountByVersion = new Map(versionRows.map((v) => [v.id, typeof v.unit_count === "number" ? v.unit_count : null]));
  const attemptsByUser = new Map<string, AttemptRow[]>();
  for (const a of attempts) attemptsByUser.set(a.user_id, [...(attemptsByUser.get(a.user_id) ?? []), a]);

  /* ---- assignment expansion (released only; paths entitle their courses) ---- */
  const courseAssigns = await fetchAll<CourseAssign>(svc, "course_assignments", "*", (q) => q.eq("organization_id", orgId));
  const pathAssigns = await fetchAll<PathAssign>(svc, "learning_path_assignments", "*", (q) => q.eq("organization_id", orgId));
  const teamIds = [...new Set([...courseAssigns, ...pathAssigns].filter((a) => a.assignee_type === "team" && a.team_id).map((a) => a.team_id as string))];
  const teamUserIds = new Map<string, Set<string>>();
  if (teamIds.length) {
    const rows = await fetchByIds<{ team_id: string; user_id: string }>(svc, "team_members", "team_id, user_id", "team_id", teamIds, undefined, "user_id");
    for (const r of rows) {
      if (!userSet.has(r.user_id)) continue;
      (teamUserIds.get(r.team_id) ?? teamUserIds.set(r.team_id, new Set()).get(r.team_id)!).add(r.user_id);
    }
  }
  const groupIds = [...new Set([...courseAssigns, ...pathAssigns].filter((a) => a.assignee_type === "group" && a.group_id).map((a) => a.group_id as string))];
  const groupUserIds = new Map<string, Set<string>>();
  if (groupIds.length) {
    try {
      const { data: groupRows } = await svc
        .from("org_groups")
        .select("id, organization_id, name, group_type, rules, is_active")
        .in("id", groupIds);
      const groups = ((groupRows ?? []) as GroupRow[]).filter((g) => g.is_active !== false);
      const needsMembers = groups.some((g) => g.group_type === "dynamic");
      const allMembers = needsMembers ? await fetchActiveMembers(svc, orgId) : undefined;
      for (const g of groups) {
        const ids = await resolveGroupMembers(svc, g, allMembers);
        groupUserIds.set(g.id, new Set(ids.filter((u) => userSet.has(u))));
      }
    } catch (e) {
      // Only a pre-0067 database (no org_groups) is tolerated; a transient
      // read error must not silently shrink the assigned set.
      if (!isMissingRelation(e)) throw e;
    }
  }
  const targetsOf = (a: CourseAssign | PathAssign): Iterable<string> => {
    if (a.assignee_type === "user" && a.user_id) return userSet.has(a.user_id) ? [a.user_id] : [];
    if (a.assignee_type === "team" && a.team_id) return teamUserIds.get(a.team_id) ?? [];
    if (a.assignee_type === "group" && a.group_id) return groupUserIds.get(a.group_id) ?? [];
    if (a.assignee_type === "org") return userIds;
    return [];
  };
  type AssignInfo = { due: string | null; assignedAt: string | null; viaPath: boolean; direct: boolean };
  const assignedByUser = new Map<string, Map<string, AssignInfo>>();
  const pathsByUser = new Map<string, Map<string, { due: string | null; assignedAt: string | null }>>();
  // Due date: the earliest of the rows that reach the person — except that a
  // DIRECT (per-person) assignment's date is the most specific and wins, so an
  // admin can extend one person's date without touching the team's.
  const addCourse = (uid: string, cid: string, due: string | null, at: string | null, viaPath: boolean, direct = false) => {
    const m = assignedByUser.get(uid) ?? new Map<string, AssignInfo>();
    const prev = m.get(cid);
    const mergedDue = !prev ? due
      : direct && !prev.direct ? due
      : prev.direct && !direct ? prev.due
      : due && (!prev.due || due < prev.due) ? due : prev.due;
    m.set(cid, {
      due: mergedDue,
      assignedAt: prev ? minIso(prev.assignedAt, at) : at,
      viaPath: prev ? prev.viaPath && viaPath : viaPath,
      direct: (prev?.direct ?? false) || direct,
    });
    assignedByUser.set(uid, m);
  };
  for (const a of courseAssigns) {
    if (!isReleased(a.release_at, nowMs) || !activeCourse.has(a.course_id)) continue;
    for (const uid of targetsOf(a)) addCourse(uid, a.course_id, a.due_at, a.assigned_at, false, a.assignee_type === "user");
  }
  for (const a of pathAssigns) {
    if (!activePath.has(a.path_id)) continue;
    for (const uid of targetsOf(a)) {
      const m = pathsByUser.get(uid) ?? new Map();
      const prev = m.get(a.path_id);
      m.set(a.path_id, {
        due: prev ? (a.due_at && (!prev.due || a.due_at < prev.due) ? a.due_at : prev.due) : a.due_at,
        assignedAt: prev ? minIso(prev.assignedAt, a.assigned_at) : a.assigned_at,
      });
      pathsByUser.set(uid, m);
      for (const cid of coursesOfPath.get(a.path_id) ?? []) addCourse(uid, cid, null, a.assigned_at, true);
    }
  }

  /* ---- journeys (same maths as the reminder cron) ---- */
  const tolerateMissing = <T,>(e: unknown): T[] => {
    if (isMissingRelation(e)) return []; // pre-0058 database — no journeys
    throw e;
  };
  const enrollments = await fetchByIds<EnrRow>(
    svc, "journey_enrollments",
    "id, user_id, program_id, status, start_date, journey_versions!inner(days, days_total, count_sundays, unlock_mode)",
    "user_id", userIds, (q) => q.eq("organization_id", orgId).in("status", ["active", "completed"])
  ).catch(tolerateMissing<EnrRow>);
  const dayRows = enrollments.length
    ? await fetchByIds<{ enrollment_id: string; completed_at: string | null }>(
        svc, "journey_day_progress", "enrollment_id, completed_at", "enrollment_id", enrollments.map((e) => e.id)
      ).catch(tolerateMissing<{ enrollment_id: string; completed_at: string | null }>)
    : [];
  const dayDoneByEnr = new Map<string, string[]>();
  for (const r of dayRows) dayDoneByEnr.set(r.enrollment_id, [...(dayDoneByEnr.get(r.enrollment_id) ?? []), r.completed_at ?? ""]);
  const journeysByUser = new Map<string, Array<JourneyInsight & { dayCompletions: string[]; courseIds: Set<string> }>>();
  for (const e of enrollments) {
    const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
    const prog = programById.get(e.program_id);
    if (!v || !prog || prog.is_active === false) continue;
    if (lensJourney && e.program_id !== lensJourney) continue;
    const done = dayDoneByEnr.get(e.id) ?? [];
    const unlockMode: "calendar" | "progress" = v.unlock_mode === "progress" ? "progress" : "calendar";
    const state = computeJourneyState({
      startDate: e.start_date,
      today,
      completedCount: done.length,
      daysTotal: v.days_total,
      countSundays: v.count_sundays === true,
      unlockMode,
      courseDays: courseDaysOf(v.days, v.days_total),
    });
    const deadline = typeof prog.deadline_days === "number" && prog.deadline_days > 0 ? dateOfDay(e.start_date, prog.deadline_days, v.count_sundays === true) : null;
    const active = e.status === "active" && !state.finished;
    const behind = active && unlockMode === "calendar" ? state.behindDays : 0;
    const overdueDeadline = active && deadline !== null && today > deadline;
    const entry = parseVersionDays(v.days).get(state.currentDay);
    const nextModule = active ? entry?.mission_title ?? (entry?.course_id ? courseTitle.get(entry.course_id) ?? null : null) : null;
    const courseIds = new Set<string>();
    for (const d of parseVersionDays(v.days).values()) if (d.course_id) courseIds.add(d.course_id);
    const j = {
      programId: e.program_id,
      name: prog.name,
      status: (e.status === "completed" || state.finished ? "completed" : "active") as "active" | "completed",
      unlockMode,
      day: state.currentDay,
      total: state.daysTotal,
      behind,
      overdueDeadline,
      daysDone: done.length,
      courseDays: courseDaysOf(v.days, v.days_total).length,
      nextModule,
      onTrack: !active || (behind === 0 && !overdueDeadline),
      dayCompletions: done,
      courseIds,
    };
    journeysByUser.set(e.user_id, [...(journeysByUser.get(e.user_id) ?? []), j]);
  }

  /* ---- reminders, open grants, policies ---- */
  const nudgeRows = await fetchByIds<{ user_id: string; course_id: string; nudge_count: number }>(
    svc, "reminder_state", "user_id, course_id, nudge_count", "user_id", userIds, (q) => q.eq("organization_id", orgId), "user_id"
  ).catch(() => []);
  const nudges = new Map<string, number>();
  for (const n of nudgeRows) nudges.set(`${n.user_id}:${n.course_id}`, n.nudge_count ?? 0);
  const grantRows = await fetchByIds<{ user_id: string; course_id: string; expires_at: string | null }>(
    svc, "attempt_requests", "user_id, course_id, expires_at", "user_id", userIds,
    (q) => q.eq("organization_id", orgId).eq("status", "approved").is("used_at", null), "user_id"
  ).catch(() => []);
  const openGrants = new Set<string>();
  for (const g of grantRows) if (!g.expires_at || g.expires_at > nowIso) openGrants.add(`${g.user_id}:${g.course_id}`);

  const allCourseIds = new Set<string>();
  for (const m of assignedByUser.values()) for (const cid of m.keys()) allCourseIds.add(cid);
  for (const cid of courseOfVersion.values()) allCourseIds.add(cid);
  const courseIdList = [...allCourseIds];
  const [policies, grants, passRequired] = await Promise.all([
    resolvePolicies(svc, courseIdList),
    fetchGrantRetakeIdsForUsers(svc, orgId, userIds),
    fetchPassRequired(svc, courseIdList),
  ]);

  /* ---- org benchmark (nightly matview; fail-soft) ---- */
  const benchmark = await loadBenchmark(svc, courseIdList);

  /* ---- per-learner rollup (one data load, any number of period windows) ---- */
  const activeCutoff = new Date(nowMs - THRESHOLDS.activeWindowDays * DAY).toISOString();
  const rollup = (periodDays: number | null): LearnerInsight[] => {
  const periodStart = periodDays === null ? null : new Date(nowMs - periodDays * DAY).toISOString();
  const prevStart = periodDays === null ? null : new Date(nowMs - 2 * periodDays * DAY).toISOString();
  const inPeriod = (iso: string | null) => !!iso && (periodStart === null || iso >= periodStart);
  const inPrev = (iso: string | null) => !!iso && prevStart !== null && periodStart !== null && iso >= prevStart && iso < periodStart;

  return userIds.map((uid): LearnerInsight => {
    const m = memberById.get(uid);
    const p = profById.get(uid);
    const my = attemptsByUser.get(uid) ?? [];
    const myJourneys = journeysByUser.get(uid) ?? [];

    // Content lens → which courses count.
    let courseFilter: Set<string> | null = null;
    if (lensCourse) courseFilter = new Set([lensCourse]);
    else if (lensPath) courseFilter = new Set(coursesOfPath.get(lensPath) ?? []);
    else if (lensJourney) {
      courseFilter = new Set<string>();
      for (const j of myJourneys) for (const c of j.courseIds) courseFilter.add(c);
    }
    const counts = (cid: string) => courseFilter === null || courseFilter.has(cid);

    const assignedMap = assignedByUser.get(uid) ?? new Map<string, AssignInfo>();
    const byCourse = new Map<string, AttemptRow[]>();
    for (const a of my) {
      const cid = courseOfVersion.get(a.course_version_id);
      if (cid) byCourse.set(cid, [...(byCourse.get(cid) ?? []), a]);
    }
    const courseIds = new Set<string>([...assignedMap.keys(), ...byCourse.keys()].filter(counts));

    // Engagement is about the PERSON, not the lens: last activity comes from
    // every attempt and every journey day they have, whatever content filter
    // the manager is looking through.
    let lastActive: string | null = null;
    for (const a of my) lastActive = maxIso(lastActive, maxIso(a.last_activity_at, maxIso(a.completed_at, a.started_at)));
    for (const j of journeysByUser.get(uid) ?? []) for (const d of j.dayCompletions) lastActive = maxIso(lastActive, d || null);

    const courses: CourseLine[] = [];
    const stepDone = new Map<string, boolean>(); // official rule incl. pass_required, for path steps
    let completedInPeriod = 0, completedInPrevPeriod = 0, passedFirstTimeInPeriod = 0;
    for (const cid of courseIds) {
      const list = byCourse.get(cid) ?? [];
      const info = assignedMap.get(cid);
      const scoring = computeScoring(list.map(toScorable), policies.get(cid) ?? DEFAULT_POLICY, grants.get(`${uid}:${cid}`) ?? new Set<string>());
      const status = courseStatus(scoring, list.map(toScorable));
      const progress = courseProgress(list, unitCountByVersion);
      let startedAt: string | null = null, lastActivity: string | null = null;
      for (const a of list) {
        startedAt = minIso(startedAt, a.started_at);
        lastActivity = maxIso(lastActivity, maxIso(a.last_activity_at, maxIso(a.completed_at, a.started_at)));
      }
      const official = scoring.officialAttempt;
      // "Completed in period" is dated by the OFFICIAL attempt (decision 1),
      // never by a practice run's completion.
      const officialCompletedAt = scoring.officialStatus !== null ? official?.completed_at ?? null : null;
      // "Passed first time" = the learner's FIRST completed attempt passed
      // (under best/latest policies the official attempt may be a later one).
      const firstAttempt = list.find((a) => scoring.attemptNumber.get(a.id) === 1);
      const passedFirstTime = !!firstAttempt && firstAttempt.success_status === "passed";
      const hasOfficial = scoring.officialStatus !== null;
      const passRequiredUnmet = passRequired.has(cid) && hasOfficial && scoring.officialStatus !== "passed";
      // A pass-required module is only "done" once passed (same rule as the
      // learner's path page and the CRM feed).
      const done = officialDone(scoring, passRequired.has(cid));
      stepDone.set(cid, done);
      const overdue = !!info?.due && info.due < nowIso && !done;
      courses.push({
        courseId: cid,
        title: courseTitle.get(cid) ?? "Untitled course",
        status,
        officialScore: scoring.officialScore === null ? null : Math.round(scoring.officialScore * 100),
        attempts: list.length,
        progressPct: progress.done ? 100 : progress.pct,
        assignedAt: info?.assignedAt ?? null,
        dueAt: info?.due ?? null,
        overdue,
        startedAt,
        lastActivity,
        passedFirstTime,
        passRequiredUnmet,
        nudges: nudges.get(`${uid}:${cid}`) ?? 0,
        openGrant: openGrants.has(`${uid}:${cid}`),
        limitReached: scoring.limitReached,
      });
      if (inPeriod(officialCompletedAt)) completedInPeriod++;
      if (inPrev(officialCompletedAt)) completedInPrevPeriod++;
      if (passedFirstTime && inPeriod(officialCompletedAt)) passedFirstTimeInPeriod++;
    }
    courses.sort((a, b) => {
      const order = (c: CourseLine) => (c.status === "failed" || c.overdue ? 0 : c.status === "in_progress" ? 1 : c.status === "not_started" ? 2 : 3);
      return order(a) - order(b) || a.title.localeCompare(b.title);
    });

    const assignedCourses = courses.filter((c) => assignedMap.has(c.courseId));
    const assigned = assignedCourses.length;
    const completed = assignedCourses.filter((c) => stepDone.get(c.courseId)).length;
    const withResult = courses.filter((c) => c.officialScore !== null);
    const avgScore = withResult.length ? Math.round(withResult.reduce((s, c) => s + (c.officialScore ?? 0), 0) / withResult.length) : null;

    const paths: PathLine[] = [];
    for (const [pid, info] of pathsByUser.get(uid) ?? new Map<string, { due: string | null; assignedAt: string | null }>()) {
      if (lensPath && pid !== lensPath) continue;
      if (lensCourse || lensJourney) continue;
      const steps = coursesOfPath.get(pid) ?? [];
      const doneN = steps.filter((c) => stepDone.get(c) === true).length;
      paths.push({ pathId: pid, name: pathName.get(pid) ?? "Learning path", stepsTotal: steps.length, stepsDone: doneN, dueAt: info.due, overdue: !!info.due && info.due < nowIso && doneN < steps.length });
    }

    let journeyDaysInPeriod = 0;
    for (const j of myJourneys) for (const d of j.dayCompletions) if (inPeriod(d)) journeyDaysInPeriod++;
    const inactiveDays = daysAgo(lastActive, nowMs);
    const earliestAssigned = [...assignedMap.entries()].reduce<string | null>((acc, [cid, i]) => (counts(cid) ? minIso(acc, i.assignedAt) : acc), null);

    /* ---- §3 exception rules ---- */
    const flags: ExceptionFlag[] = [];
    for (const c of courses) {
      if (c.status === "failed" || c.passRequiredUnmet) {
        flags.push({ kind: "failed", severity: "critical", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
          detail: c.officialScore !== null ? `${c.title} · ${c.officialScore}%` : `${c.title} · not passed` });
      }
      if (c.overdue) {
        flags.push({ kind: "overdue", severity: "critical", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
          detail: `${c.title} · due ${fmtDay(c.dueAt!)}` });
      }
      if (c.status === "in_progress") {
        const openDays = daysAgo(c.startedAt, nowMs) ?? 0;
        const idleDays = daysAgo(c.lastActivity, nowMs) ?? 0;
        if ((openDays >= THRESHOLDS.stuckDays && (c.progressPct ?? 0) < THRESHOLDS.stuckPct) || idleDays >= THRESHOLDS.stuckIdleDays) {
          flags.push({ kind: "stuck", severity: "high", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
            detail: `${c.title} · opened ${openDays}d ago${c.progressPct !== null ? `, ${c.progressPct}%` : ""}${idleDays >= THRESHOLDS.stuckIdleDays ? `, idle ${idleDays}d` : ""}` });
        }
      }
      if (c.status === "not_started" && c.assignedAt && (daysAgo(c.assignedAt, nowMs) ?? 0) >= THRESHOLDS.notStartedDays) {
        flags.push({ kind: "not_started", severity: "normal", contentId: c.courseId, contentKind: "course", contentTitle: c.title,
          detail: `${c.title} · assigned ${daysAgo(c.assignedAt, nowMs)}d ago` });
      }
    }
    for (const pth of paths) {
      if (pth.overdue) flags.push({ kind: "overdue", severity: "critical", contentId: pth.pathId, contentKind: "path", contentTitle: pth.name, detail: `${pth.name} · due ${fmtDay(pth.dueAt!)}` });
    }
    for (const j of myJourneys) {
      if (j.status !== "active") continue;
      if (j.overdueDeadline || j.behind >= 1) {
        const sev: Severity = j.overdueDeadline || j.behind >= THRESHOLDS.journeyEscalateBehind ? "critical" : "high";
        flags.push({ kind: "behind", severity: sev, contentId: j.programId, contentKind: "journey", contentTitle: j.name,
          detail: j.overdueDeadline ? `${j.name} · past deadline` : `${j.behind} day${j.behind === 1 ? "" : "s"} behind · next: ${j.nextModule ?? `Day ${j.day}`}` });
      }
    }
    if (inactiveDays !== null && inactiveDays >= THRESHOLDS.inactiveDays) {
      flags.push({ kind: "inactive", severity: inactiveDays >= THRESHOLDS.inactiveHighDays ? "high" : "normal", contentId: null, contentKind: null, contentTitle: null, detail: `no activity for ${inactiveDays} days` });
    } else if (
      inactiveDays === null &&
      earliestAssigned &&
      (daysAgo(earliestAssigned, nowMs) ?? 0) >= THRESHOLDS.inactiveDays &&
      !flags.some((f) => f.kind === "not_started")
    ) {
      // Never active at all: one flag, not two — "not started" already says it
      // when there is an assignment to start.
      flags.push({ kind: "inactive", severity: "normal", contentId: null, contentKind: null, contentTitle: null, detail: "never active since being assigned" });
    }
    const maxNudges = Math.max(0, ...courses.map((c) => c.nudges));
    const risk = riskOf(flags, inactiveDays, maxNudges);
    const status = statusOf(flags, risk);
    if (status === "needs_support") {
      const distinct = [...new Set(flags.map((f) => f.kind))];
      flags.push({ kind: "needs_support", severity: "critical", contentId: null, contentKind: null, contentTitle: null,
        detail: distinct.map((k) => k.replace("_", " ")).join(" · ") });
    }

    return {
      userId: uid,
      name: nameOf(uid),
      email: p?.email ?? "",
      avatarUrl: p?.avatar_url ?? null,
      designation: m?.designation ?? null,
      city: m?.city ?? null,
      branch: m?.branch ?? null,
      vertical: m?.business_vertical ?? null,
      department: m?.department ?? null,
      joined: m?.date_of_joining ?? null,
      assigned,
      completed,
      completionPct: assigned > 0 ? Math.round((completed / assigned) * 100) : null,
      avgScore,
      assessmentsWithResult: withResult.length,
      passedFirstTime: courses.filter((c) => c.passedFirstTime).length,
      lastActive,
      inactiveDays,
      activeLast7d: !!lastActive && lastActive >= activeCutoff,
      journeys: myJourneys.map(({ dayCompletions: _d, courseIds: _c, ...j }) => { void _d; void _c; return j; }),
      courses,
      paths,
      flags,
      risk,
      status,
      completedInPeriod,
      passedFirstTimeInPeriod,
      journeyDaysInPeriod,
      completedInPrevPeriod,
    };
  });
  };

  const learners = rollup(opts.periodDays);
  const byPeriod = opts.periods
    ? new Map(opts.periods.map((d) => [periodKey(d), periodKey(d) === periodKey(opts.periodDays) ? learners : rollup(d)]))
    : undefined;
  return { learners, byPeriod, catalog, benchmark, today, tz };
}

/** Cache / map key for a period window. */
export function periodKey(days: number | null): string {
  return days === null ? "all" : String(days);
}

/** Org-wide fail rate per course from the nightly matview (fail-soft: absent/unrefreshed → empty). */
async function loadBenchmark(svc: SupabaseClient, courseIds: string[]): Promise<InsightsResult["benchmark"]> {
  const benchmark = new Map<string, { failRate: number | null; enrolled: number }>();
  if (courseIds.length === 0) return benchmark;
  try {
    const rows = await fetchByIds<{ course_id: string; total_enrolled: number | null; total_failed: number | null }>(
      svc, "mv_course_performance", "course_id, total_enrolled, total_failed", "course_id", courseIds, undefined, "course_id"
    );
    for (const r of rows) {
      const enrolled = r.total_enrolled ?? 0;
      benchmark.set(r.course_id, { enrolled, failRate: enrolled > 0 ? Math.round(((r.total_failed ?? 0) / enrolled) * 100) : null });
    }
  } catch {
    /* matview absent / not refreshed yet */
  }
  return benchmark;
}
