import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchActiveMembers, resolveGroupMembers } from "@/lib/org/groups";
import {
  DEFAULT_JOURNEY_TZ,
  computeJourneyState,
  courseDaysOf,
  parseVersionDays,
  todayStr,
} from "@/lib/journey/journey";
import {
  DEFAULT_POLICY,
  computeScoring,
  type ScorableAttempt,
} from "@/lib/scoring/policy";
import { resolvePolicies } from "@/lib/scoring/resolve";

/**
 * Bulk learner progress for the integration API (the UpsideLMS "Progress
 * API" replacement). One org-wide pass per page of learners instead of the
 * per-employee round trips learner-summary makes, with the SAME status,
 * scoring, entitlement and journey rules, so both endpoints always agree.
 *
 *   loadMembers()            → every learner the key's org can report on
 *   usersMatchingAttempts()  → pre-selection when attempt-level filters are set
 *   buildProgress()          → the rows for one page of learners
 */

export type MemberRow = {
  user_id: string;
  employee_id: string | null;
  role: string;
  status: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

export type ProgressFilters = {
  employeeIds: string[];
  emails: string[];
  courseIds: string[];
  journeyIds: string[];
  completedFrom: string | null;
  completedTo: string | null;
  lastAccessFrom: string | null;
  lastAccessTo: string | null;
  includeInactive: boolean;
};

export type CourseProgress = {
  course_id: string;
  title: string;
  status: "not_started" | "in_progress" | "completed" | "passed";
  score: number | null;
  official_score: number | null;
  first_score: number | null;
  best_score: number | null;
  scored_attempts: number;
  practice_attempts: number;
  progress_pct: number | null;
  attempts: number;
  assigned_at: string | null;
  due_at: string | null;
  overdue: boolean;
  first_access: string | null;
  last_access: string | null;
  completed_at: string | null;
  target: string;
};

export type PathProgress = {
  path_id: string;
  title: string;
  status: "not_started" | "in_progress" | "completed";
  steps_total: number;
  steps_completed: number;
  progress_pct: number;
  assigned_at: string | null;
  due_at: string | null;
  overdue: boolean;
  completed_at: string | null;
  target: string;
};

export type JourneyProgress = {
  journey_id: string;
  enrollment_id: string;
  /** The published journey version this learner runs on. */
  version_id: string;
  title: string;
  status: "active" | "completed";
  start_date: string;
  day: number;
  days_total: number;
  days_completed: number;
  pending_days: number;
  behind_days: number;
  on_track: boolean;
  completed_at: string | null;
  /** Calendar used for the day maths: the organisation's time zone (Asia/Kolkata by default). */
  timezone: string;
  /** The mission the calendar puts on today; null before the start or after the finish. */
  today: {
    /** Today's date in `timezone`, YYYY-MM-DD. */
    date: string;
    day: number;
    course_id: string | null;
    title: string | null;
    rest_day: boolean;
    completed: boolean;
    completed_at: string | null;
  } | null;
  /** Every day of the programme with its course and completion, for day-wise dashboards. */
  days: Array<{
    day: number;
    course_id: string | null;
    title: string | null;
    rest_day: boolean;
    /** The calendar has reached this day (counted from start_date in `timezone`). */
    released: boolean;
    completed: boolean;
    completed_at: string | null;
  }>;
  target: string;
};

export type LearnerProgress = {
  employee_id: string | null;
  email: string | null;
  name: string | null;
  status: string;
  is_admin: boolean;
  courses: CourseProgress[];
  learning_paths: PathProgress[];
  journeys: JourneyProgress[];
  summary: { assigned: number; completed: number; overdue: number };
};

const PAGE = 1000;
const ADMIN_ROLES = ["super_owner", "owner", "admin"];

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Drain a PostgREST query past the 1000-row default by ranging. */
async function drain<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown }>
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const pct = (v: number | null) => (v !== null ? Math.round(v * 100) : null);
const minIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Every member of the org the integration can report on, sorted by employee number. */
export async function loadMembers(
  svc: SupabaseClient,
  orgId: string,
  f: Pick<ProgressFilters, "employeeIds" | "emails" | "includeInactive">
): Promise<MemberRow[]> {
  type M = { user_id: string; employee_id: string | null; role: string; status: string };
  const rows = await drain<M>((from, to) => {
    let q = svc
      .from("organization_members")
      .select("user_id, employee_id, role, status")
      .eq("organization_id", orgId);
    if (!f.includeInactive) q = q.eq("status", "active");
    if (f.employeeIds.length) q = q.in("employee_id", f.employeeIds);
    return q.order("user_id").range(from, to);
  });
  const profiles = new Map<string, { email: string | null; first_name: string | null; last_name: string | null }>();
  for (const ids of chunk(rows.map((r) => r.user_id), 500)) {
    const { data } = await svc
      .from("profiles")
      .select("id, email, first_name, last_name")
      .in("id", ids);
    for (const p of (data ?? []) as Array<{ id: string; email: string | null; first_name: string | null; last_name: string | null }>) {
      profiles.set(p.id, { email: p.email, first_name: p.first_name, last_name: p.last_name });
    }
  }
  const wantEmails = new Set(f.emails.map((e) => e.toLowerCase()));
  const members: MemberRow[] = [];
  for (const r of rows) {
    const p = profiles.get(r.user_id);
    const email = p?.email ?? null;
    if (wantEmails.size && !(email && wantEmails.has(email.toLowerCase()))) continue;
    members.push({
      user_id: r.user_id,
      employee_id: r.employee_id,
      role: r.role,
      status: r.status,
      email,
      first_name: p?.first_name ?? null,
      last_name: p?.last_name ?? null,
    });
  }
  members.sort((a, b) => {
    if (a.employee_id && b.employee_id) {
      const c = a.employee_id.localeCompare(b.employee_id, undefined, { numeric: true });
      if (c) return c;
    } else if (a.employee_id !== b.employee_id) return a.employee_id ? -1 : 1;
    return (a.email ?? "").localeCompare(b.email ?? "");
  });
  return members;
}

export function hasAttemptFilters(f: ProgressFilters): boolean {
  return (
    f.courseIds.length > 0 ||
    !!f.completedFrom ||
    !!f.completedTo ||
    !!f.lastAccessFrom ||
    !!f.lastAccessTo
  );
}

/**
 * Users with at least one attempt matching EVERY attempt-level filter
 * (course, completion window, last-access window). Mirrors the Upside
 * Progress API, where a filtered call returns only learners with a
 * matching record.
 */
export async function usersMatchingAttempts(
  svc: SupabaseClient,
  orgId: string,
  f: ProgressFilters
): Promise<Set<string>> {
  let verIds: string[] | null = null;
  if (f.courseIds.length) {
    const { data } = await svc
      .from("course_versions")
      .select("id, course_id")
      .in("course_id", f.courseIds);
    verIds = ((data ?? []) as Array<{ id: string }>).map((v) => v.id);
    if (verIds.length === 0) return new Set();
  }
  const out = new Set<string>();
  for (const vers of verIds ? chunk(verIds, 200) : [null]) {
    const rows = await drain<{ user_id: string }>((from, to) => {
      let q = svc.from("course_attempts").select("user_id").eq("organization_id", orgId);
      if (vers) q = q.in("course_version_id", vers);
      if (f.completedFrom) q = q.gte("completed_at", f.completedFrom);
      if (f.completedTo) q = q.lte("completed_at", f.completedTo);
      if (f.lastAccessFrom) q = q.gte("last_activity_at", f.lastAccessFrom);
      if (f.lastAccessTo) q = q.lte("last_activity_at", f.lastAccessTo);
      return q.order("id").range(from, to);
    });
    for (const r of rows) out.add(r.user_id);
  }
  return out;
}

/** Users enrolled (active or completed) in any of the given journey programmes. */
export async function usersEnrolledIn(
  svc: SupabaseClient,
  orgId: string,
  journeyIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  if (journeyIds.length === 0) return out;
  try {
    const rows = await drain<{ user_id: string }>((from, to) =>
      svc
        .from("journey_enrollments")
        .select("user_id")
        .eq("organization_id", orgId)
        .in("program_id", journeyIds)
        .in("status", ["active", "completed"])
        .order("id")
        .range(from, to)
    );
    for (const r of rows) out.add(r.user_id);
  } catch {
    /* pre-journey database */
  }
  return out;
}

type Assign = {
  course_id?: string;
  path_id?: string;
  assignee_type: string;
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
  due_at: string | null;
  release_at?: string | null;
  assigned_at: string | null;
};

type Att = {
  id: string;
  user_id: string;
  course_version_id: string;
  completion_status: string | null;
  success_status: string | null;
  score: number | null;
  started_at: string | null;
  completed_at: string | null;
  last_activity_at: string | null;
  progress_pct?: number | null;
};

/** Progress rows for ONE page of members (≤ 100), org-wide batch loads. */
export async function buildProgress(
  svc: SupabaseClient,
  orgId: string,
  orgSlug: string,
  members: MemberRow[],
  f: ProgressFilters
): Promise<LearnerProgress[]> {
  if (members.length === 0) return [];
  const uids = members.map((m) => m.user_id);
  const nowIso = new Date().toISOString();

  // ---- attempts (select * for deploy safety across 0073/0075 columns) ----
  const attempts = await drain<Att>((from, to) =>
    svc
      .from("course_attempts")
      .select("*")
      .eq("organization_id", orgId)
      .in("user_id", uids)
      .order("id")
      .range(from, to)
  );
  const verIds = [...new Set(attempts.map((a) => a.course_version_id))];
  const courseOfVer = new Map<string, string>();
  for (const ids of chunk(verIds, 300)) {
    const { data } = await svc.from("course_versions").select("id, course_id").in("id", ids);
    for (const v of (data ?? []) as Array<{ id: string; course_id: string }>) courseOfVer.set(v.id, v.course_id);
  }

  // ---- entitlements: assignments, teams, groups ----
  const caRows = await drain<Assign>((from, to) =>
    svc.from("course_assignments").select("*").eq("organization_id", orgId).order("id").range(from, to)
  );
  const paRows = await drain<Assign>((from, to) =>
    svc.from("learning_path_assignments").select("*").eq("organization_id", orgId).order("id").range(from, to)
  );
  const { data: tmRows } = await svc
    .from("team_members")
    .select("user_id, team_id, teams!inner(organization_id)")
    .in("user_id", uids);
  const teamsOf = new Map<string, Set<string>>();
  for (const r of (tmRows ?? []) as Array<{ user_id: string; team_id: string; teams: { organization_id: string } | Array<{ organization_id: string }> }>) {
    const t = Array.isArray(r.teams) ? r.teams[0] : r.teams;
    if (t?.organization_id !== orgId) continue;
    teamsOf.set(r.user_id, (teamsOf.get(r.user_id) ?? new Set()).add(r.team_id));
  }
  const groupIds = [...new Set([...caRows, ...paRows].map((a) => a.group_id).filter((g): g is string => !!g))];
  const groupMembers = new Map<string, Set<string>>();
  if (groupIds.length) {
    try {
      const { data: gRows } = await svc
        .from("org_groups")
        .select("id, organization_id, group_type, rules, is_active")
        .eq("organization_id", orgId)
        .in("id", groupIds);
      const cache = await fetchActiveMembers(svc, orgId);
      for (const g of (gRows ?? []) as Array<{ id: string; organization_id: string; group_type: "static" | "dynamic"; rules: unknown; is_active: boolean }>) {
        if (g.is_active === false) continue;
        const ids = await resolveGroupMembers(svc, g as Parameters<typeof resolveGroupMembers>[1], cache);
        groupMembers.set(g.id, new Set(ids));
      }
    } catch {
      /* pre-0067 */
    }
  }
  const mine = (uid: string, a: Assign) =>
    (a.assignee_type === "user" && a.user_id === uid) ||
    a.assignee_type === "org" ||
    (a.assignee_type === "team" && !!a.team_id && (teamsOf.get(uid)?.has(a.team_id) ?? false)) ||
    (a.assignee_type === "group" && !!a.group_id && (groupMembers.get(a.group_id)?.has(uid) ?? false));

  // ---- paths and their courses ----
  const pathIds = [...new Set(paRows.map((a) => a.path_id).filter((p): p is string => !!p))];
  const coursesOfPath = new Map<string, string[]>();
  const pathName = new Map<string, string>();
  for (const ids of chunk(pathIds, 300)) {
    const { data: pc } = await svc
      .from("learning_path_courses")
      .select("path_id, course_id, step_number")
      .in("path_id", ids)
      .order("step_number");
    for (const r of (pc ?? []) as Array<{ path_id: string; course_id: string }>) {
      coursesOfPath.set(r.path_id, [...(coursesOfPath.get(r.path_id) ?? []), r.course_id]);
    }
    const { data: pn } = await svc.from("learning_paths").select("id, name, is_active").in("id", ids);
    for (const p of (pn ?? []) as Array<{ id: string; name: string; is_active: boolean | null }>) {
      if (p.is_active !== false) pathName.set(p.id, p.name);
    }
  }

  // ---- journeys ----
  type Enr = {
    id: string;
    user_id: string;
    program_id: string;
    version_id: string;
    status: string;
    start_date: string;
    completed_at: string | null;
    journey_versions: { days: unknown; days_total: number; count_sundays: boolean } | Array<{ days: unknown; days_total: number; count_sundays: boolean }>;
    journey_programs: { name: string; is_active: boolean } | Array<{ name: string; is_active: boolean }>;
  };
  let enrollments: Enr[] = [];
  const dayDone = new Map<string, Map<number, string>>(); // enrollment → day → completed_at
  let tz = DEFAULT_JOURNEY_TZ;
  try {
    const { data: gs } = await svc
      .from("gamification_settings")
      .select("timezone")
      .eq("organization_id", orgId)
      .maybeSingle();
    tz = (gs as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
    enrollments = await drain<Enr>((from, to) =>
      svc
        .from("journey_enrollments")
        .select(
          "id, user_id, program_id, version_id, status, start_date, completed_at, journey_versions!inner(days, days_total, count_sundays), journey_programs!inner(name, is_active)"
        )
        .eq("organization_id", orgId)
        .in("user_id", uids)
        .in("status", ["active", "completed"])
        .order("id")
        .range(from, to)
    );
    for (const ids of chunk(enrollments.map((e) => e.id), 300)) {
      const rows = await drain<{ enrollment_id: string; day_number: number; completed_at: string }>((from, to) =>
        svc
          .from("journey_day_progress")
          .select("enrollment_id, day_number, completed_at")
          .in("enrollment_id", ids)
          .order("id")
          .range(from, to)
      );
      for (const r of rows) {
        const m = dayDone.get(r.enrollment_id) ?? new Map<number, string>();
        if (!m.has(r.day_number) || r.completed_at < (m.get(r.day_number) as string)) m.set(r.day_number, r.completed_at);
        dayDone.set(r.enrollment_id, m);
      }
    }
  } catch {
    /* pre-journey database */
  }
  const today = todayStr(tz);

  // ---- course titles (active only) ----
  const courseIdSet = new Set<string>();
  for (const a of attempts) {
    const c = courseOfVer.get(a.course_version_id);
    if (c) courseIdSet.add(c);
  }
  for (const a of caRows) if (a.course_id) courseIdSet.add(a.course_id);
  for (const list of coursesOfPath.values()) for (const c of list) courseIdSet.add(c);
  for (const e of enrollments) {
    const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
    for (const d of parseVersionDays(v?.days).values()) if (d.course_id) courseIdSet.add(d.course_id);
  }
  const courseTitle = new Map<string, string>();
  for (const ids of chunk([...courseIdSet], 300)) {
    const { data } = await svc.from("courses").select("id, title, is_active").in("id", ids).eq("is_active", true);
    for (const c of (data ?? []) as Array<{ id: string; title: string }>) courseTitle.set(c.id, c.title);
  }
  const policies = await resolvePolicies(svc, [...courseTitle.keys()]);

  // ---- per learner ----
  const attemptsOf = new Map<string, Att[]>();
  for (const a of attempts) attemptsOf.set(a.user_id, [...(attemptsOf.get(a.user_id) ?? []), a]);
  const wantCourse = f.courseIds.length ? new Set(f.courseIds) : null;
  const wantJourney = f.journeyIds.length ? new Set(f.journeyIds) : null;
  // Compare instants, not strings: PostgREST prints "+00:00", the filters "Z".
  const inWindow = (v: string | null, from: string | null, to: string | null) => {
    if (!from && !to) return true;
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) && (!from || t >= Date.parse(from)) && (!to || t <= Date.parse(to));
  };

  const out: LearnerProgress[] = [];
  for (const m of members) {
    const uid = m.user_id;
    const dueByCourse = new Map<string, string | null>();
    const assignedByCourse = new Map<string, string | null>();
    for (const a of caRows) {
      if (!a.course_id || !mine(uid, a)) continue;
      if (a.release_at && a.release_at > nowIso) continue;
      const prev = dueByCourse.get(a.course_id);
      if (prev === undefined || (a.due_at && (!prev || a.due_at < prev))) dueByCourse.set(a.course_id, a.due_at ?? prev ?? null);
      assignedByCourse.set(a.course_id, minIso(assignedByCourse.get(a.course_id) ?? null, a.assigned_at));
    }
    const myPathDue = new Map<string, string | null>();
    const myPathAssigned = new Map<string, string | null>();
    for (const a of paRows) {
      if (!a.path_id || !mine(uid, a) || !pathName.has(a.path_id)) continue;
      const prev = myPathDue.get(a.path_id);
      if (prev === undefined || (a.due_at && (!prev || a.due_at < prev))) myPathDue.set(a.path_id, a.due_at ?? prev ?? null);
      myPathAssigned.set(a.path_id, minIso(myPathAssigned.get(a.path_id) ?? null, a.assigned_at));
      for (const c of coursesOfPath.get(a.path_id) ?? []) if (!dueByCourse.has(c)) dueByCourse.set(c, null);
    }

    type Row = { status: CourseProgress["status"]; n: number; list: ScorableAttempt[]; progress: number | null; progressAt: string; first: string | null; last: string | null; done: string | null };
    const byCourse = new Map<string, Row>();
    for (const a of attemptsOf.get(uid) ?? []) {
      const cid = courseOfVer.get(a.course_version_id);
      if (!cid) continue;
      const row = byCourse.get(cid) ?? { status: "not_started", n: 0, list: [], progress: null, progressAt: "", first: null, last: null, done: null };
      row.n++;
      if (a.completion_status === "in_progress" && (a.started_at ?? "") >= row.progressAt) {
        row.progressAt = a.started_at ?? "";
        row.progress = typeof a.progress_pct === "number" ? a.progress_pct : null;
      }
      row.list.push({ id: a.id, score: a.score, started_at: a.started_at ?? "", completed_at: a.completed_at, completion_status: a.completion_status, success_status: a.success_status });
      row.first = minIso(row.first, a.started_at);
      row.last = maxIso(row.last, a.last_activity_at ?? a.completed_at ?? a.started_at);
      if (a.completion_status === "completed" || a.success_status === "passed") row.done = minIso(row.done, a.completed_at);
      if (a.success_status === "passed") row.status = "passed";
      else if (a.completion_status === "completed" && row.status !== "passed") row.status = "completed";
      else if (row.status === "not_started") row.status = "in_progress";
      byCourse.set(cid, row);
    }

    const courseIds = [...new Set([...dueByCourse.keys(), ...byCourse.keys()])].filter((c) => courseTitle.has(c));
    const courses: CourseProgress[] = [];
    for (const cid of courseIds) {
      const st = byCourse.get(cid) ?? { status: "not_started" as const, n: 0, list: [], progress: null, progressAt: "", first: null, last: null, done: null };
      const sc = computeScoring(st.list, policies.get(cid) ?? DEFAULT_POLICY);
      const due = dueByCourse.get(cid) ?? null;
      const done = st.status === "completed" || st.status === "passed";
      const row: CourseProgress = {
        course_id: cid,
        title: courseTitle.get(cid) as string,
        status: st.status,
        score: pct(sc.officialScore),
        official_score: pct(sc.officialScore),
        first_score: pct(sc.firstScore),
        best_score: pct(sc.bestScore),
        scored_attempts: sc.scoredAttempts,
        practice_attempts: sc.practiceAttempts,
        progress_pct: done ? 100 : st.progress,
        attempts: st.n,
        assigned_at: assignedByCourse.get(cid) ?? null,
        due_at: due,
        overdue: !!due && due < nowIso && !done,
        first_access: st.first,
        last_access: st.last,
        completed_at: done ? st.done : null,
        target: `/${orgSlug}/courses/${cid}/launch`,
      };
      if (wantCourse && !wantCourse.has(cid)) continue;
      if (!inWindow(row.completed_at, f.completedFrom, f.completedTo)) continue;
      if (!inWindow(row.last_access, f.lastAccessFrom, f.lastAccessTo)) continue;
      courses.push(row);
    }
    courses.sort((a, b) => a.title.localeCompare(b.title));
    if (hasAttemptFilters(f) && courses.length === 0) continue;

    const doneSet = new Set<string>();
    const doneAt = new Map<string, string | null>();
    for (const [cid, r] of byCourse) if (r.status === "completed" || r.status === "passed") { doneSet.add(cid); doneAt.set(cid, r.done); }
    const learning_paths: PathProgress[] = [];
    for (const [pid, due] of myPathDue) {
      const steps = coursesOfPath.get(pid) ?? [];
      const doneSteps = steps.filter((c) => doneSet.has(c));
      const started = steps.some((c) => byCourse.has(c));
      const complete = steps.length > 0 && doneSteps.length === steps.length;
      let completedAt: string | null = null;
      if (complete) for (const c of doneSteps) completedAt = maxIso(completedAt, doneAt.get(c) ?? null);
      learning_paths.push({
        path_id: pid,
        title: pathName.get(pid) as string,
        status: complete ? "completed" : started || doneSteps.length ? "in_progress" : "not_started",
        steps_total: steps.length,
        steps_completed: doneSteps.length,
        progress_pct: steps.length ? Math.round((doneSteps.length / steps.length) * 100) : 0,
        assigned_at: myPathAssigned.get(pid) ?? null,
        due_at: due,
        overdue: !!due && due < nowIso && !complete,
        completed_at: completedAt,
        target: `/${orgSlug}/paths/${pid}`,
      });
    }

    const journeys: JourneyProgress[] = [];
    for (const e of enrollments) {
      if (e.user_id !== uid) continue;
      if (wantJourney && !wantJourney.has(e.program_id)) continue;
      const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
      const prog = Array.isArray(e.journey_programs) ? e.journey_programs[0] : e.journey_programs;
      if (!v || !prog || prog.is_active === false) continue;
      const days = parseVersionDays(v.days);
      const done = dayDone.get(e.id) ?? new Map<number, string>();
      const state = computeJourneyState({
        startDate: e.start_date,
        today,
        completedCount: done.size,
        daysTotal: v.days_total,
        countSundays: v.count_sundays === true,
        courseDays: courseDaysOf(v.days, v.days_total),
      });
      const active = e.status === "active" && !state.finished;
      const dayRow = (d: number) => {
        const entry = days.get(d);
        const cid = entry?.course_id ?? null;
        const completedAt = done.get(d) ?? null;
        return {
          day: d,
          course_id: cid,
          title: cid ? courseTitle.get(cid) ?? entry?.mission_title ?? null : entry?.mission_title ?? null,
          rest_day: !cid,
          released: d <= state.allowedDay,
          completed: !cid || !!completedAt,
          completed_at: completedAt,
        };
      };
      let todayBlock: JourneyProgress["today"] = null;
      if (active && state.allowedDay >= 1) {
        const row = dayRow(state.allowedDay);
        todayBlock = {
          date: today,
          day: row.day,
          course_id: row.course_id,
          title: row.title,
          rest_day: row.rest_day,
          completed: row.completed,
          completed_at: row.completed_at,
        };
      }
      const dayRows: JourneyProgress["days"] = [];
      for (let d = 1; d <= v.days_total; d++) dayRows.push(dayRow(d));
      journeys.push({
        journey_id: e.program_id,
        enrollment_id: e.id,
        version_id: e.version_id,
        title: prog.name,
        status: e.status === "completed" || state.finished ? "completed" : "active",
        start_date: e.start_date,
        day: state.currentDay,
        days_total: state.daysTotal,
        days_completed: done.size,
        pending_days: active ? state.pendingDays : 0,
        behind_days: active ? state.behindDays : 0,
        on_track: !active || state.pendingDays === 0,
        completed_at: e.completed_at,
        timezone: tz,
        today: todayBlock,
        days: dayRows,
        target: `/${orgSlug}/journey`,
      });
    }

    out.push({
      employee_id: m.employee_id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(" ").trim() || null,
      status: m.status,
      is_admin: ADMIN_ROLES.includes(m.role),
      courses,
      learning_paths,
      journeys,
      summary: {
        assigned: courses.length,
        completed: courses.filter((c) => c.status === "completed" || c.status === "passed").length,
        overdue: courses.filter((c) => c.overdue).length,
      },
    });
  }
  return out;
}
