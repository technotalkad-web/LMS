import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk, fetchAll, fetchByIds, readAllSoft, readAllStrict, readByIdsSoft } from "@/lib/db/chunked";
import {
  DEFAULT_POLICY,
  attemptCounts,
  computeScoring,
  courseStatus,
  excludeAbandoned,
  isCompletedAttempt,
  isRevisionAttempt,
  officialDone,
  type CourseStatus,
  type EffectivePolicy,
} from "@/lib/scoring/policy";
import { resolvePolicies } from "@/lib/scoring/resolve";
import {
  GrantReadError,
  fetchPassRequired,
  grantSnapshotForUsers,
  readPagedWithOptionalColumn,
  type GrantSnapshot,
  type OptionalColumnState,
  type PgError,
} from "@/lib/scoring/attempt-kind";
import { officialHistory, officialRetakeState } from "@/lib/scoring/official-history";
import { readWithContextFilter, withoutPreviews, type ContextFilterState } from "@/lib/scoring/context-read";
import { fetchRevisionVisitStats } from "@/lib/attempts/revision-visits";
import { courseProgress } from "@/lib/courses/progress-view";
import {
  DEFAULT_JOURNEY_TZ,
  computeJourneyState,
  courseDaysOf,
  creditedDaysFor,
  dateOfDay,
  parseVersionDays,
  todayStr,
} from "@/lib/journey/journey";
import { readJourneyCredits } from "@/lib/journey/credits-read";
import { fetchActiveMembers, namedMembershipStrict, resolveGroupMembers, type AssigneeRow, type GroupRow } from "@/lib/org/groups";
import { isReleased } from "@/lib/learner/release";
import { THRESHOLDS } from "./report-card";
import { DAY, daysAgo, deriveLearner, fmtDay, maxIso, minIso } from "./derive";
import type { CourseLine, JourneyInsight, LearnerInsight, PathLine } from "./types";

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
  /** 'abandoned' never counts as in progress or official (ADR 0004 step 11). */
  status?: string | null;
  completion_status: "in_progress" | "completed" | null;
  success_status: "unknown" | "passed" | "failed" | null;
  score: number | null;
  started_at: string | null;
  completed_at: string | null;
  last_activity_at: string | null;
  progress_pct?: number | null;
  units?: unknown;
  /** 0103 (ADR 0014): a revision visit's row; absent on a database without the column (= false). */
  is_revision?: boolean | null;
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
  version_id: string;
  status: string;
  start_date: string;
  journey_versions:
    | { days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }
    | Array<{ days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }>;
};

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
  status: a.status ?? null,
  is_revision: a.is_revision ?? null,
});
void fmtDay; void daysAgo;

/**
 * A course line's scoring: the one place in this file that works out a
 * course's status (ADR 0029, note of 2026-11-25, part 1, point 3), for the
 * Report Card's roll-up and for the manager's reminder
 * (readCourseReminderLines), so the two cannot drift. `status` is
 * courseStatus over computeScoring of the learner's rows on the course,
 * with the retake ids of their approved grants. ADR 0024's phase that moves
 * the Report Card's lines onto contextResult moves this function, and both
 * readers with it.
 */
function scoreLine(list: AttemptRow[], policy: EffectivePolicy, retakeIds: ReadonlySet<string>) {
  const scorable = list.map(toScorable);
  const scoring = computeScoring(scorable, policy, retakeIds);
  // ADR 0014 step 10: "in_progress" while a granted retake runs.
  const status = courseStatus(scoring, scorable);
  return { scorable, scoring, status };
}

/** The attempts select; `is_revision` (0103) is added through the narrower-select fallback. */
const ATTEMPT_COLUMNS =
  "id, user_id, course_version_id, status, completion_status, success_status, score, started_at, completed_at, last_activity_at, progress_pct, units:cmi_data->cmi5->units";

/**
 * The learners' attempts in the organisation (fetchByIds' chunks of 150 and
 * pages of 1,000, ordered by id), with `is_revision` read through
 * readPagedWithOptionalColumn (ADR 0014 steps 7 and 12). fetchByIds throws
 * the error message alone, which cannot tell a missing column from another
 * failure, so the pages are read here. The first page decides: once it
 * answers, every later page and chunk reads the same column list (one
 * `decided` for every chunk). Any other error throws, as fetchByIds does.
 *
 * ADR 0024 steps 49 and 80 (P2-3): a preview moves no engagement value
 * ("last active") and no line of the Report Card: the read drops
 * `context_kind = 'preview'` rows, one decision for every chunk and page
 * (`previews`); on a database without 0107 the filter's missing-column error
 * reads today's select once (readWithContextFilter).
 *
 * ADR 0029, note of 2026-11-25, part 1: the manager's reminder reads the
 * named learners' rows on one course through this same read, narrowed to
 * the course's versions (`versionIds`, at most 100 a call beside at most 50
 * learners). For that caller an answer that is not a list is an error too
 * (`strict`): it decides who is mailed. The Report Card passes no versions
 * and reads as before. `countCall` (ADR 0029 rule FP2), when given, is
 * called before each call, every chunk, page and fallback included.
 */
async function fetchAttemptRows(svc: SupabaseClient, orgId: string, userIds: string[], countCall?: () => unknown, versionIds?: string[]): Promise<AttemptRow[]> {
  const strict = versionIds !== undefined;
  const out: AttemptRow[] = [];
  const decided: OptionalColumnState = { columns: null };
  const previews: ContextFilterState = { applies: null };
  for (const part of chunk([...new Set(userIds.filter(Boolean))], strict ? 50 : 150)) {
    for (const versions of strict ? chunk([...new Set(versionIds)], 100) : [null]) {
      const res = await readPagedWithOptionalColumn<unknown>(
        "is_revision",
        (cols, from, to): PromiseLike<{ data: unknown[] | null; error: PgError }> =>
          readWithContextFilter(previews, (apply) => {
            countCall?.();
            const q = withoutPreviews(svc.from("course_attempts").select(cols).in("user_id", part).eq("organization_id", orgId), apply);
            return (versions ? q.in("course_version_id", versions) : q).order("id").range(from, to);
          }),
        ATTEMPT_COLUMNS,
        { state: decided, nullIsError: strict }
      );
      if (res.error) throw new Error(`course_attempts: ${res.error.message ?? ""}`);
      out.push(...(res.data as AttemptRow[]));
    }
  }
  return out;
}

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
  // The catalog decides which courses and paths count (activeCourse,
  // activePath), so it is read in pages of 1,000 rows, the id breaking a
  // tie of titles, and no course or path is cut at the server's row cap.
  // Fail-soft, as before paging: a failed call reads as no rows (readAllSoft).
  const allCourses = await readAllSoft<{ id: string; title: string; is_active: boolean }>((from, to) =>
    svc.from("courses").select("id, title, is_active").eq("organization_id", orgId).order("title").order("id").range(from, to)
  );
  const courseTitle = new Map(allCourses.map((c) => [c.id, c.title]));
  const allPaths = await readAllSoft<{ id: string; name: string; is_active: boolean }>((from, to) =>
    svc.from("learning_paths").select("id, name, is_active").eq("organization_id", orgId).order("name").order("id").range(from, to)
  );
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
  // In the order they were made, in pages, as the catalog above.
  const programs = await readAllSoft<{ id: string; name: string; is_active: boolean; deadline_days?: number | null }>((from, to) =>
    svc.from("journey_programs").select("*").eq("organization_id", orgId).order("created_at").order("id").range(from, to)
  );
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
  const attempts = await fetchAttemptRows(svc, orgId, userIds);
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
      // `.in()` lists of 150 ids, pages of 1,000 rows; a failed call reads
      // as no groups, as the one unpaged call did (readByIdsSoft).
      const groupRows = await readByIdsSoft<GroupRow>(groupIds, (ids, from, to) =>
        svc.from("org_groups").select("id, organization_id, name, group_type, rules, is_active").in("id", ids).order("id").range(from, to)
      );
      const groups = groupRows.filter((g) => g.is_active !== false);
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
    "id, user_id, program_id, version_id, status, start_date, journey_versions!inner(days, days_total, count_sundays, unlock_mode)",
    "user_id", userIds, (q) => q.eq("organization_id", orgId).in("status", ["active", "completed"])
  ).catch(tolerateMissing<EnrRow>);
  // The credits by day id, through the one reader (ADR 0024 step 45). A
  // failed read throws, as every other read of the Report Card does: it is
  // never "no days done".
  const credits = await readJourneyCredits(svc, enrollments.map((e) => ({ id: e.id, version_id: e.version_id })));
  if (!credits.ok) throw new Error(`journey credits read failed: ${credits.error?.message ?? "no answer"}`);
  const journeysByUser = new Map<string, Array<JourneyInsight & { dayCompletions: string[]; courseIds: Set<string> }>>();
  for (const e of enrollments) {
    const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
    const prog = programById.get(e.program_id);
    if (!v || !prog || prog.is_active === false) continue;
    if (lensJourney && e.program_id !== lensJourney) continue;
    const rows = credits.rowsOf(e.id);
    // The credits' dates feed the period's activity and "last active"; the
    // days done are the twin's count, never the number of rows.
    const done = rows.map((r) => r.completed_at ?? "");
    const unlockMode: "calendar" | "progress" = v.unlock_mode === "progress" ? "progress" : "calendar";
    const state = computeJourneyState({
      startDate: e.start_date,
      today,
      creditedDays: creditedDaysFor({ days: v.days, days_total: v.days_total, day_ids: credits.dayIdsOf(e.version_id) }, rows),
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
      daysDone: state.completedCount,
      courseDays: courseDaysOf(v.days, v.days_total).length,
      nextModule,
      onTrack: !active || (behind === 0 && !overdueDeadline),
      daysInPeriod: 0, // per-period value is computed in the rollup
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
  // ADR 0014:188, strict: the grant links come from one strict bulk read,
  // because with them missing the chain is wrong, not empty. A failed read
  // never throws here (this also runs inside the 15-minute precompute,
  // cache.ts): it is logged once and every learner of the call degrades to
  // "History unavailable. Please reload." with no figure.
  // Any throw from this one read degrades, not only GrantReadError, so a
  // client-level failure cannot fail the page or the refresh either.
  const readGrants = async (): Promise<Map<string, GrantSnapshot> | null> => {
    try {
      return await grantSnapshotForUsers(svc, orgId, null, userIds);
    } catch (e) {
      console.warn(JSON.stringify({ event: "report_card_grants_unreadable", org_id: orgId, code: e instanceof GrantReadError ? e.code : null }));
      return null;
    }
  };
  const [policies, snapshots, passRequired, visits] = await Promise.all([
    resolvePolicies(svc, courseIdList),
    readGrants(),
    fetchPassRequired(svc, courseIdList),
    // "Last revisit" beside the inactive flag (ADR 0014:199), fail-soft.
    fetchRevisionVisitStats(svc, { orgId, userIds }),
  ]);
  const historyUnavailable = snapshots === null;
  // The reader pages oldest first, so a capped read lacks the newest visits:
  // "Last revisit" is then absent, like a failed read, never an older date.
  const lastRevisitByUser = new Map<string, string>();
  if (!visits.failed && !visits.capped) {
    for (const [k, s] of visits.byPair) {
      const uid = k.slice(0, k.indexOf(":"));
      const last = maxIso(lastRevisitByUser.get(uid) ?? null, s.last);
      if (last) lastRevisitByUser.set(uid, last);
    }
  }

  /* ---- org benchmark (nightly matview; fail-soft) ---- */
  const benchmark = await loadBenchmark(svc, courseIdList);

  /* ---- per-learner rollup (one data load, any number of period windows) ---- */
  const rollup = (periodDays: number | null): LearnerInsight[] => {
  const periodStart = periodDays === null ? null : new Date(nowMs - periodDays * DAY).toISOString();
  const prevStart = periodDays === null ? null : new Date(nowMs - 2 * periodDays * DAY).toISOString();
  const inPeriod = (iso: string | null) => !!iso && (periodStart === null || iso >= periodStart);
  void prevStart;

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
    // the manager is looking through. A revision visit's row moves no
    // engagement value (ADR 0014 step 12), so it is skipped.
    let lastActive: string | null = null;
    for (const a of my) {
      if (isRevisionAttempt(a)) continue;
      lastActive = maxIso(lastActive, maxIso(a.last_activity_at, maxIso(a.completed_at, a.started_at)));
    }
    for (const j of journeysByUser.get(uid) ?? []) for (const d of j.dayCompletions) lastActive = maxIso(lastActive, d || null);

    const courses: CourseLine[] = [];
    const stepDone = new Map<string, boolean>(); // official rule incl. pass_required, for path steps
    for (const cid of courseIds) {
      const list = byCourse.get(cid) ?? [];
      const info = assignedMap.get(cid);
      // ADR 0004 step 11: a reset (abandoned) attempt never dates the course:
      // "opened Nd ago" / idle days come from the live attempts only, so a
      // relaunch after a reset is not flagged stuck from the dead attempt's
      // start. Engagement (lastActive above) keeps every attempt but a
      // revision visit's. excludeAbandoned and attemptCounts drop revision
      // rows too (ADR 0014 steps 6 and 12).
      const tally = attemptCounts(list);
      let startedAt: string | null = null, lastActivity: string | null = null;
      for (const a of excludeAbandoned(list)) {
        startedAt = minIso(startedAt, a.started_at);
        lastActivity = maxIso(lastActivity, maxIso(a.last_activity_at, maxIso(a.completed_at, a.started_at)));
      }
      if (historyUnavailable) {
        // ADR 0014:188: the row shows only "History unavailable. Please
        // reload." No figure that needs the chain is computed; what needs
        // no grant stays as computed.
        stepDone.set(cid, false);
        courses.push({
          courseId: cid,
          title: courseTitle.get(cid) ?? "Untitled course",
          status: "unavailable",
          officialScore: null,
          attempts: tally.live,
          resetAttempts: tally.reset,
          progressPct: null,
          assignedAt: info?.assignedAt ?? null,
          dueAt: info?.due ?? null,
          overdue: false,
          startedAt,
          lastActivity,
          passedFirstTime: false,
          passRequiredUnmet: false,
          nudges: nudges.get(`${uid}:${cid}`) ?? 0,
          openGrant: false,
          limitReached: false,
          completedAt: null,
          done: false,
          isAssigned: assignedMap.has(cid),
          historyUnavailable: true,
        });
        continue;
      }
      const snapshot = snapshots?.get(`${uid}:${cid}`);
      const retakeIds = snapshot?.retakeIds ?? new Set<string>();
      // The one scoring of a course line (scoreLine), shared with the
      // manager's reminder.
      const { scorable, scoring, status } = scoreLine(list, policies.get(cid) ?? DEFAULT_POLICY, retakeIds);
      // A per-course display: the retake's progress while it runs. The path
      // steps below read officialDone, so a passed step stays done.
      const progress = courseProgress(list, unitCountByVersion, { retakeIds });
      // ADR 0014 step 7: the retake state and the result it replaces, from
      // the one chain (officialHistory + officialRetakeState).
      const history = officialHistory(scorable, snapshot?.rows ?? []);
      const retake = officialRetakeState(history);
      const replaced = retake.state === "in_progress" ? retake.current : retake.state === "completed" ? retake.previous : null;
      // The "stuck" clock (derive.ts: "opened Nd ago" under the progress
      // mark) of a granted retake starts when the retake opens, not at the
      // first attempt: the line reads in
      // progress and shows the retake's progress, so it is dated by the
      // retake's own start.
      const running = history.running;
      const runningRow = running ? list.find((a) => a.id === running.attemptId) : undefined;
      const openedAt = runningRow?.started_at ?? startedAt;
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
        // Admin tables show live attempts plus a "· N reset" suffix.
        attempts: tally.live,
        resetAttempts: tally.reset,
        progressPct: progress.done ? 100 : progress.pct,
        assignedAt: info?.assignedAt ?? null,
        dueAt: info?.due ?? null,
        overdue,
        startedAt: openedAt,
        lastActivity,
        passedFirstTime,
        passRequiredUnmet,
        nudges: nudges.get(`${uid}:${cid}`) ?? 0,
        openGrant: openGrants.has(`${uid}:${cid}`),
        limitReached: scoring.limitReached,
        completedAt: officialCompletedAt,
        done,
        isAssigned: assignedMap.has(cid),
        retakeState: retake.state,
        previousOfficial: replaced
          ? { score: replaced.score === null ? null : Math.round(replaced.score * 100), status: replaced.status, completedAt: replaced.completedAt }
          : null,
      });
    }
    courses.sort((a, b) => {
      const order = (c: CourseLine) => (c.status === "failed" || c.overdue ? 0 : c.status === "in_progress" ? 1 : c.status === "not_started" ? 2 : 3);
      return order(a) - order(b) || a.title.localeCompare(b.title);
    });

    const paths: PathLine[] = [];
    for (const [pid, info] of pathsByUser.get(uid) ?? new Map<string, { due: string | null; assignedAt: string | null }>()) {
      if (lensPath && pid !== lensPath) continue;
      if (lensCourse || lensJourney) continue;
      const steps = coursesOfPath.get(pid) ?? [];
      if (historyUnavailable) {
        // stepDone needs the chain (a step completed through a retake would
        // read incomplete and raise a false overdue): no step count, no overdue.
        paths.push({ pathId: pid, name: pathName.get(pid) ?? "Learning path", stepsTotal: steps.length, stepsDone: 0, dueAt: info.due, overdue: false, historyUnavailable: true });
        continue;
      }
      const doneN = steps.filter((c) => stepDone.get(c) === true).length;
      paths.push({ pathId: pid, name: pathName.get(pid) ?? "Learning path", stepsTotal: steps.length, stepsDone: doneN, dueAt: info.due, overdue: !!info.due && info.due < nowIso && doneN < steps.length });
    }

    const journeys = myJourneys.map(({ dayCompletions, courseIds: _c, ...j }) => { void _c; return { ...j, daysInPeriod: dayCompletions.filter((d) => inPeriod(d)).length }; });
    const derived = deriveLearner({ courses, paths, journeys, lastActive, periodDays, nowMs, historyUnavailable });

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
      lastActive,
      lastRevisitAt: lastRevisitByUser.get(uid) ?? null,
      journeys,
      courses,
      paths,
      ...derived,
      ...(historyUnavailable ? { historyUnavailable: true } : {}),
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

/** A named learner's line on the course, as the Report Card shows it: its status. */
export type ReminderLine = { status: CourseStatus };

/** The ids of a call's second `.in()` list, beside the learners' (at most 50): 150 ids a call in all. */
const IDS_BESIDE_LEARNERS = 100;

/**
 * The manager's "send reminder now" for a course (ADR 0029, note of
 * 2026-11-25, part 1): for each named learner, whether the course has a
 * line on their Report Card and that line's status, read only for those
 * learners and that one course. No entry: no line. It lives here, beside
 * computeLearnerInsights, because ADR 0024's guard admits no new file that
 * works out an official result (tests/unit/revision-listing.test.ts, part
 * (vii)); the status is scoreLine's, the Report Card's own.
 *
 * The rules are the Report Card's (computeLearnerInsights above):
 *   - a line exists when an assignment gives the learner the course, or the
 *     learner has any row on a version of it (a preview is not a row; an
 *     abandoned row and a revision visit's row are);
 *   - a course row counts only when it is released and the course is
 *     active; a person's row reaches that person, a team's its members, a
 *     group's its members while the group is active (a static group its
 *     rows, a dynamic group its rules over the active members' fields and a
 *     rule's teams), the organisation's everybody named;
 *   - a path gives the course when the path is active, the course is
 *     active, the step is released, and the path is assigned to the learner
 *     in any of the four ways (a path's row has no release of its own);
 *   - the status is scoreLine over the learner's rows with the retake ids of
 *     their approved grants, under DEFAULT_POLICY: since ADR 0014 step 9
 *     normalizePolicy clamps every stored rule to it, so no policy is read
 *     (officialFailedAttemptId leaves it out for the same reason), and no
 *     pass mark (it moves "done", not the status).
 *
 * The reads, in order, each one call, each counted (`countCall`) where it
 * is made; a learner who has a line needs no more, so the assignment steps
 * stop once every learner has one:
 *   a. the course's versions; b. the learners' rows on them (only when a
 *   version exists), through the file's one attempts read; then, for an
 *   active course only: c. the course's own rows for the learners without a
 *   line; d. its rows for a team, a group or the organisation; e. the path
 *   steps that hold it; f. those paths (released steps), the active ones of
 *   this organisation; g. those paths' own rows for the learners without a
 *   line; h. their rows for a team, a group or the organisation; i to l. one
 *   call of namedMembershipStrict (lib/org/groups.ts) for the teams and
 *   groups of d and h together, for the learners without a line; and m. the
 *   approved grants on the course of the learners who have a completed row
 *   (without one nobody has an official attempt, whatever the grants say).
 *   An inactive course makes a, b and m only. Pages of 1,000 rows; a longer
 *   list or a later page is a call more, and is counted.
 *
 * Every read is strict (stage 2's one rule): an error, a call that throws or
 * an answer that is not a list throws, and the caller answers 503 and sends
 * nothing. Tolerated, each read from its error's code: a database without
 * org_groups has no groups, one without attempt_requests no grants, and a
 * missing is_revision, context_kind, reissued_from or department column is
 * read without it (one call more).
 */
export async function readCourseReminderLines(
  svc: SupabaseClient,
  opts: { orgId: string; courseId: string; courseActive: boolean; userIds: string[]; countCall?: () => unknown; now?: Date }
): Promise<Map<string, ReminderLine>> {
  const { orgId, courseId } = opts;
  const count = opts.countCall;
  const gate = () => {
    count?.();
    return true as const;
  };
  const nowMs = (opts.now ?? new Date()).getTime();
  const users = [...new Set(opts.userIds.filter(Boolean))];
  const named = new Set(users);
  const hasLine = new Set<string>();
  const open = () => users.filter((u) => !hasLine.has(u));
  /** Every row of a strict paged read: a failed read throws, never "not assigned". */
  const all = async <T,>(what: string, page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    const rows = await readAllStrict<T>(page, gate);
    if (rows === "unreadable" || rows === "no_room") throw new Error(`${what}: the read failed`);
    return rows;
  };
  const teams = new Set<string>();
  const groups = new Set<string>();
  /** What one assignment row gives: a named person a line, a team or a group to read, the organisation everybody. */
  const reach = (r: AssigneeRow) => {
    if (r.assignee_type === "user") {
      if (r.user_id && named.has(r.user_id)) hasLine.add(r.user_id);
    } else if (r.assignee_type === "team") {
      if (r.team_id) teams.add(r.team_id);
    } else if (r.assignee_type === "group") {
      if (r.group_id) groups.add(r.group_id);
    } else if (r.assignee_type === "org") {
      for (const u of users) hasLine.add(u);
    }
  };

  // a. The course's versions.
  const versions = await all<{ id: string }>("course_versions", (from, to) =>
    svc.from("course_versions").select("id").eq("course_id", courseId).order("id").range(from, to)
  );
  // b. The learners' rows on them: any row gives a line (previews are not read).
  const rowsOf = new Map<string, AttemptRow[]>();
  if (versions.length > 0) {
    for (const r of await fetchAttemptRows(svc, orgId, users, count, versions.map((v) => v.id))) {
      if (!named.has(r.user_id)) continue;
      (rowsOf.get(r.user_id) ?? rowsOf.set(r.user_id, []).get(r.user_id)!).push(r);
      hasLine.add(r.user_id);
    }
  }

  // An inactive course's assignment rows count for nothing, as on the Report Card.
  if (opts.courseActive) {
    // c. The course's own rows of the learners without a line: released only.
    if (open().length > 0) {
      const who = open();
      const own = await all<{ user_id: string; release_at: string | null }>("course_assignments", (from, to) =>
        svc.from("course_assignments").select("user_id, release_at").eq("organization_id", orgId).eq("course_id", courseId).eq("assignee_type", "user").in("user_id", who).order("id").range(from, to)
      );
      for (const r of own) if (isReleased(r.release_at, nowMs)) reach({ assignee_type: "user", user_id: r.user_id });
    }
    // d. Its rows for a team, a group or the organisation ("*" keeps a database without group_id working): released only.
    if (open().length > 0) {
      const other = await all<AssigneeRow & { release_at?: string | null }>("course_assignments", (from, to) =>
        svc.from("course_assignments").select("*").eq("organization_id", orgId).eq("course_id", courseId).neq("assignee_type", "user").order("id").range(from, to)
      );
      for (const r of other) if (r.assignee_type !== "user" && isReleased(r.release_at ?? null, nowMs)) reach(r);
    }
    // e and f. The paths that give the course: a released step, an active path of this organisation.
    const paths: string[] = [];
    if (open().length > 0) {
      const steps = await all<{ path_id: string; release_at: string | null }>("learning_path_courses", (from, to) =>
        svc.from("learning_path_courses").select("path_id, release_at").eq("course_id", courseId).order("path_id").range(from, to)
      );
      const released = [...new Set(steps.filter((s) => isReleased(s.release_at, nowMs)).map((s) => s.path_id))];
      for (const part of chunk(released, 150)) {
        const rows = await all<{ id: string; is_active: boolean | null }>("learning_paths", (from, to) =>
          svc.from("learning_paths").select("id, is_active").eq("organization_id", orgId).in("id", part).order("id").range(from, to)
        );
        paths.push(...rows.filter((p) => p.is_active !== false).map((p) => p.id));
      }
    }
    // g. Those paths' own rows of the learners without a line (a path's row has no release of its own).
    if (paths.length > 0 && open().length > 0) {
      const who = open();
      for (const part of chunk(paths, IDS_BESIDE_LEARNERS)) {
        const own = await all<{ user_id: string }>("learning_path_assignments", (from, to) =>
          svc.from("learning_path_assignments").select("user_id").eq("organization_id", orgId).in("path_id", part).eq("assignee_type", "user").in("user_id", who).order("id").range(from, to)
        );
        for (const r of own) reach({ assignee_type: "user", user_id: r.user_id });
      }
    }
    // h. Their rows for a team, a group or the organisation.
    if (paths.length > 0 && open().length > 0) {
      for (const part of chunk(paths, 150)) {
        const other = await all<AssigneeRow>("learning_path_assignments", (from, to) =>
          svc.from("learning_path_assignments").select("*").eq("organization_id", orgId).in("path_id", part).neq("assignee_type", "user").order("id").range(from, to)
        );
        for (const r of other) if (r.assignee_type !== "user") reach(r);
      }
    }
    // i to l. Which of the learners still without a line the teams and groups of d and h hold now.
    if ((teams.size > 0 || groups.size > 0) && open().length > 0) {
      const held = await namedMembershipStrict(svc, orgId, { teamIds: teams, groupIds: groups, userIds: open() }, gate);
      if (held === "unreadable") throw new Error("team_members, org_groups: a team's or a group's members could not be read");
      for (const set of [...held.teams.values(), ...held.groups.values()]) for (const u of set) if (named.has(u)) hasLine.add(u);
    }
  }

  // m. The approved grants on the course, of the learners who have a completed row.
  const completed = [...rowsOf].filter(([, list]) => excludeAbandoned(list).some(isCompletedAttempt)).map(([u]) => u);
  const grants = completed.length > 0 ? await grantSnapshotForUsers(svc, orgId, [courseId], completed, undefined, count) : new Map<string, GrantSnapshot>();
  const lines = new Map<string, ReminderLine>();
  for (const u of users) {
    if (!hasLine.has(u)) continue;
    const mine = rowsOf.get(u) ?? [];
    const retakeIds = grants.get(`${u}:${courseId}`)?.retakeIds ?? new Set<string>();
    lines.set(u, { status: scoreLine(mine, DEFAULT_POLICY, retakeIds).status });
  }
  return lines;
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
