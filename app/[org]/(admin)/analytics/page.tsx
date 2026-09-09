import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  AlertTriangle,
  Flame,
  Users,
  CheckCircle2,
  Clock,
  ArrowLeft,
  Activity,
} from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canViewReports } from "@/lib/auth/permissions";
import {
  fetchActiveMembers,
  resolveGroupMembers,
  type GroupRow,
} from "@/lib/org/groups";
import {
  computeJourneyState,
  courseDaysOf,
  dateOfDay,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";
import { AdminPageHeader, KpiCard, KpiStrip } from "@/components/admin";
import { Avatar } from "@/components/ui/avatar";
import { FilterBar, type FilterOption, type FilterState } from "./filter-bar";

/**
 * Learner Analytics & Performance — the centralized admin dashboard.
 *
 * One URL-driven page, two altitudes:
 *   - DASHBOARD: population KPIs, per-dimension impact tables (which
 *     team/branch/vertical/city is hurting), the at-risk list, and the full
 *     learner table — all under Team / Vertical / Branch / City / Manager /
 *     Cohort / Group / Content filters.
 *   - LEARNER 360 (?learner=<id>): everything the platform knows about one
 *     person — journeys with behind-schedule math, every course with scores
 *     and attempts, path progress, engagement, nudge history, risk reasons.
 *
 * All aggregation happens here at request time with the service-role client
 * (matviews are revoked from API roles by 0049; admin traffic is low, so the
 * Workers CPU rule for LEARNER surfaces doesn't apply). Reads are paged and
 * chunked to respect PostgREST's 1000-row cap.
 *
 * At-risk scoring (v1, deliberately simple and explainable):
 *   +3 journey ≥3 days behind (or past its deadline)   +1 if 1–2 days behind
 *   +2 per overdue assignment (capped at 3)
 *   +2 latest attempt on any course FAILED
 *   +2 inactive 14+ days (+1 more at 21+)
 *   +2 chronically nudged (3+ reminders on one course)
 * ≥5 = high risk, 3–4 = watch.
 */

export const dynamic = "force-dynamic";

/* ---------------- data helpers ---------------- */

function svcClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
type Svc = ReturnType<typeof svcClient>;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** .in() chunked at 150 + .range paged at 1000 — the PostgREST house rules.
 * `apply` is loosely typed on purpose: supabase-js builder generics explode
 * ("excessively deep") when threaded through helper signatures. */
/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchByIds<T>(
  svc: Svc,
  table: string,
  select: string,
  col: string,
  ids: string[],
  apply?: (q: any) => any
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk(ids, 150)) {
    for (let from = 0; ; from += 1000) {
      let q: any = svc.from(table).select(select).in(col, part).range(from, from + 999);
      if (apply) q = apply(q);
      const { data } = await q;
      const page = (data ?? []) as T[];
      out.push(...page);
      if (page.length < 1000) break;
    }
  }
  return out;
}

async function fetchAll<T>(
  svc: Svc,
  table: string,
  select: string,
  apply: (q: any) => any
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await apply(
      svc.from(table).select(select).range(from, from + 999)
    );
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ---------------- types ---------------- */

type AttemptRow = {
  user_id: string;
  course_version_id: string;
  completion_status: "in_progress" | "completed" | null;
  success_status: "unknown" | "passed" | "failed" | null;
  score: number | null;
  started_at: string | null;
  completed_at: string | null;
  last_activity_at: string | null;
};

type CourseAssign = {
  course_id: string;
  assignee_type: "user" | "org" | "team" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
  due_at: string | null;
  release_at: string | null;
};
type PathAssign = {
  path_id: string;
  assignee_type: "user" | "org" | "team" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
  due_at: string | null;
};

type LearnerStat = {
  userId: string;
  name: string;
  email: string;
  designation: string | null;
  branch: string | null;
  city: string | null;
  vertical: string | null;
  managerId: string | null;
  teamNames: string[];
  cohort: string | null;
  assigned: number;
  completed: number;
  pct: number; // 0-100, or -1 when nothing assigned
  avgScore: number | null;
  attempts: number;
  xp: number;
  streak: number;
  lastActive: string | null; // ISO date
  overdue: number;
  behindDays: number; // worst across journeys
  journeyLabel: string | null; // "Day 4/30 · 3 behind"
  maxNudges: number;
  failedLatest: boolean;
  risk: number;
  reasons: string[];
  // Content-lens extras
  lens: string | null;
};

/* ---------------- page ---------------- */

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canViewReports(role)) redirect(`/${orgSlug}/dashboard?denied=1`);

  const svc = svcClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const filters: FilterState = {
    team: sp.team ?? "",
    vertical: sp.vertical ?? "",
    branch: sp.branch ?? "",
    city: sp.city ?? "",
    manager: sp.manager ?? "",
    cohort: sp.cohort ?? "",
    group: sp.group ?? "",
    content: sp.content ?? "",
  };
  const learnerParam = sp.learner ?? "";

  /* ---- population + org structure ---- */
  const members = await fetchActiveMembers(svc, org.id);
  const memberById = new Map(members.map((m) => [m.user_id, m]));

  const { data: teamRows } = await svc
    .from("teams")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name");
  const teams = (teamRows ?? []) as Array<{ id: string; name: string }>;
  const teamNameById = new Map(teams.map((t) => [t.id, t.name]));
  const teamMemberRows = teams.length
    ? await fetchByIds<{ team_id: string; user_id: string }>(
        svc, "team_members", "team_id, user_id", "team_id", teams.map((t) => t.id)
      )
    : [];
  const teamsOfUser = new Map<string, string[]>();
  const teamUserIds = new Map<string, Set<string>>();
  for (const r of teamMemberRows) {
    teamsOfUser.set(r.user_id, [...(teamsOfUser.get(r.user_id) ?? []), r.team_id]);
    const s = teamUserIds.get(r.team_id) ?? new Set<string>();
    s.add(r.user_id);
    teamUserIds.set(r.team_id, s);
  }

  const { data: groupRows } = await svc
    .from("org_groups")
    .select("id, organization_id, name, group_type, rules, is_active")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .order("name");
  const groups = (groupRows ?? []) as GroupRow[];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  // Resolve each group's member set ONCE (shared member cache) — used by both
  // the Group filter and group-assignment expansion below.
  const groupMemberCache = new Map<string, Set<string>>();
  async function membersOfGroup(groupId: string): Promise<Set<string>> {
    const hit = groupMemberCache.get(groupId);
    if (hit) return hit;
    const g = groupById.get(groupId);
    const set = g ? new Set(await resolveGroupMembers(svc, g, members)) : new Set<string>();
    groupMemberCache.set(groupId, set);
    return set;
  }

  /* ---- apply population filters ---- */
  let scoped = members;
  if (filters.vertical) scoped = scoped.filter((m) => m.business_vertical === filters.vertical);
  if (filters.branch) scoped = scoped.filter((m) => m.branch === filters.branch);
  if (filters.city) scoped = scoped.filter((m) => m.city === filters.city);
  if (filters.manager) scoped = scoped.filter((m) => m.line_manager_id === filters.manager);
  if (filters.cohort)
    scoped = scoped.filter((m) => (m.date_of_joining ?? "").startsWith(filters.cohort));
  if (filters.team)
    scoped = scoped.filter((m) => (teamsOfUser.get(m.user_id) ?? []).includes(filters.team));
  if (filters.group) {
    const set = await membersOfGroup(filters.group);
    scoped = scoped.filter((m) => set.has(m.user_id));
  }
  const scopedIds = scoped.map((m) => m.user_id);
  const scopedSet = new Set(scopedIds);

  /* ---- filter options (from the FULL population, so narrowing never
          hides the way back out) ---- */
  const distinct = (vals: Array<string | null>) =>
    Array.from(new Set(vals.filter((v): v is string => !!v))).sort();
  const managerIds = distinct(members.map((m) => m.line_manager_id));
  const cohortMonths = distinct(
    members.map((m) => (m.date_of_joining ? m.date_of_joining.slice(0, 7) : null))
  ).reverse();

  /* ---- names (scope + managers + drill target) ---- */
  const nameIds = Array.from(new Set([...scopedIds, ...managerIds, learnerParam].filter(Boolean)));
  const profRows = await fetchByIds<{
    id: string; first_name: string | null; last_name: string | null; email: string | null;
  }>(svc, "profiles", "id, first_name, last_name, email", "id", nameIds);
  const profById = new Map(profRows.map((p) => [p.id, p]));
  const nameOf = (id: string) => {
    const p = profById.get(id);
    return (
      [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim() ||
      p?.email?.split("@")[0] ||
      id.slice(0, 8)
    );
  };
  const emailOf = (id: string) => profById.get(id)?.email ?? "";

  /* ---- content catalog ---- */
  const { data: courseRows } = await svc
    .from("courses")
    .select("id, title")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .order("title");
  const courses = (courseRows ?? []) as Array<{ id: string; title: string }>;
  const courseTitle = new Map(courses.map((c) => [c.id, c.title]));

  const { data: pathRows } = await svc
    .from("learning_paths")
    .select("id, name")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .order("name");
  const paths = (pathRows ?? []) as Array<{ id: string; name: string }>;
  const pathName = new Map(paths.map((p) => [p.id, p.name]));
  const pathCourseRows = paths.length
    ? await fetchByIds<{ path_id: string; course_id: string }>(
        svc, "learning_path_courses", "path_id, course_id", "path_id", paths.map((p) => p.id)
      )
    : [];
  const coursesOfPath = new Map<string, string[]>();
  for (const r of pathCourseRows) {
    coursesOfPath.set(r.path_id, [...(coursesOfPath.get(r.path_id) ?? []), r.course_id]);
  }

  const { data: progRows } = await svc
    .from("journey_programs")
    .select("*")
    .eq("organization_id", org.id);
  const programs = (progRows ?? []) as Array<{
    id: string; name: string; is_active: boolean;
    deadline_days?: number | null;
  }>;
  const programById = new Map(programs.map((p) => [p.id, p]));

  /* ---- learning data for the scope ---- */
  const attempts = scopedIds.length
    ? await fetchByIds<AttemptRow>(
        svc,
        "course_attempts",
        "user_id, course_version_id, completion_status, success_status, score, started_at, completed_at, last_activity_at",
        "user_id",
        scopedIds,
        (q) => q.eq("organization_id", org.id)
      )
    : [];
  const versionIds = Array.from(new Set(attempts.map((a) => a.course_version_id)));
  const versionRows = versionIds.length
    ? await fetchByIds<{ id: string; course_id: string }>(
        svc, "course_versions", "id, course_id", "id", versionIds
      )
    : [];
  const courseOfVersion = new Map(versionRows.map((v) => [v.id, v.course_id]));

  const gamRows = scopedIds.length
    ? await fetchByIds<{
        user_id: string; total_xp: number; current_streak_days: number;
        longest_streak_days: number; last_active_day: string | null;
      }>(
        svc, "user_gamification",
        "user_id, total_xp, current_streak_days, longest_streak_days, last_active_day",
        "user_id", scopedIds, (q) => q.eq("organization_id", org.id)
      )
    : [];
  const gamByUser = new Map(gamRows.map((g) => [g.user_id, g]));

  const nudgeRows = scopedIds.length
    ? await fetchByIds<{ user_id: string; course_id: string; nudge_count: number }>(
        svc, "reminder_state", "user_id, course_id, nudge_count", "user_id",
        scopedIds, (q) => q.eq("organization_id", org.id)
      )
    : [];
  const nudgesByUser = new Map<string, Array<{ course_id: string; nudge_count: number }>>();
  for (const n of nudgeRows) {
    nudgesByUser.set(n.user_id, [...(nudgesByUser.get(n.user_id) ?? []), n]);
  }

  // Journeys — behind-schedule math identical to the nudges cron.
  const { data: gsRow } = await svc
    .from("gamification_settings")
    .select("timezone")
    .eq("organization_id", org.id)
    .maybeSingle();
  const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
  const today = todayStr(tz);
  type EnrRow = {
    id: string; user_id: string; program_id: string; status: string; start_date: string;
    journey_versions:
      | { days: unknown; days_total: number; count_sundays: boolean }
      | Array<{ days: unknown; days_total: number; count_sundays: boolean }>;
  };
  const enrollments = scopedIds.length
    ? await fetchByIds<EnrRow>(
        svc, "journey_enrollments",
        "id, user_id, program_id, status, start_date, journey_versions!inner(days, days_total, count_sundays)",
        "user_id", scopedIds, (q) => q.eq("organization_id", org.id)
      )
    : [];
  const progressRows = enrollments.length
    ? await fetchByIds<{ enrollment_id: string }>(
        svc, "journey_day_progress", "enrollment_id", "enrollment_id",
        enrollments.map((e) => e.id)
      )
    : [];
  const progressCount = new Map<string, number>();
  for (const r of progressRows) {
    progressCount.set(r.enrollment_id, (progressCount.get(r.enrollment_id) ?? 0) + 1);
  }
  type JourneyView = {
    userId: string; programId: string; programName: string; status: string;
    day: number; total: number; behind: number; overdueDeadline: boolean;
  };
  const journeyViews: JourneyView[] = [];
  for (const e of enrollments) {
    const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
    const prog = programById.get(e.program_id);
    if (!v || !prog || prog.is_active === false) continue;
    const state = computeJourneyState({
      startDate: e.start_date,
      today,
      completedCount: progressCount.get(e.id) ?? 0,
      daysTotal: v.days_total,
      countSundays: v.count_sundays === true,
      courseDays: courseDaysOf(v.days, v.days_total),
    });
    const deadline =
      typeof prog.deadline_days === "number" && prog.deadline_days > 0
        ? dateOfDay(e.start_date, prog.deadline_days, v.count_sundays === true)
        : null;
    journeyViews.push({
      userId: e.user_id,
      programId: e.program_id,
      programName: prog.name,
      status: e.status,
      day: state.currentDay,
      total: state.daysTotal,
      behind: e.status === "active" && !state.finished ? state.behindDays : 0,
      overdueDeadline:
        e.status === "active" && deadline !== null && today > deadline,
    });
  }
  const journeysByUser = new Map<string, JourneyView[]>();
  for (const j of journeyViews) {
    journeysByUser.set(j.userId, [...(journeysByUser.get(j.userId) ?? []), j]);
  }

  /* ---- assignment expansion → per-user assigned set + due dates ---- */
  const courseAssigns = await fetchAll<CourseAssign>(
    svc, "course_assignments", "*", (q) => q.eq("organization_id", org.id)
  );
  const pathAssigns = await fetchAll<PathAssign>(
    svc, "learning_path_assignments", "*", (q) => q.eq("organization_id", org.id)
  );
  for (const a of [...courseAssigns, ...pathAssigns]) {
    if (a.assignee_type === "group" && a.group_id) await membersOfGroup(a.group_id);
  }
  const targetsOf = (a: CourseAssign | PathAssign): Iterable<string> => {
    if (a.assignee_type === "user" && a.user_id) return scopedSet.has(a.user_id) ? [a.user_id] : [];
    if (a.assignee_type === "team" && a.team_id) {
      return [...(teamUserIds.get(a.team_id) ?? [])].filter((u) => scopedSet.has(u));
    }
    if (a.assignee_type === "group" && a.group_id) {
      return [...(groupMemberCache.get(a.group_id) ?? [])].filter((u) => scopedSet.has(u));
    }
    if (a.assignee_type === "org") return scopedIds;
    return [];
  };
  // course_id -> earliest due per user; released assignments only.
  const assignedByUser = new Map<string, Map<string, string | null>>();
  for (const a of courseAssigns) {
    if (a.release_at && new Date(a.release_at).getTime() > nowMs) continue;
    for (const uid of targetsOf(a)) {
      const m = assignedByUser.get(uid) ?? new Map<string, string | null>();
      const prev = m.get(a.course_id);
      if (prev === undefined || (a.due_at && (!prev || a.due_at < prev))) {
        m.set(a.course_id, a.due_at ?? prev ?? null);
      }
      assignedByUser.set(uid, m);
    }
  }
  const pathsByUser = new Map<string, Map<string, string | null>>();
  for (const a of pathAssigns) {
    for (const uid of targetsOf(a)) {
      const m = pathsByUser.get(uid) ?? new Map<string, string | null>();
      const prev = m.get(a.path_id);
      if (prev === undefined || (a.due_at && (!prev || a.due_at < prev))) {
        m.set(a.path_id, a.due_at ?? prev ?? null);
      }
      pathsByUser.set(uid, m);
      // Path membership also entitles the path's courses.
      const cm = assignedByUser.get(uid) ?? new Map<string, string | null>();
      for (const cid of coursesOfPath.get(a.path_id) ?? []) {
        if (!cm.has(cid)) cm.set(cid, null);
      }
      assignedByUser.set(uid, cm);
    }
  }

  /* ---- per-learner rollup ---- */
  const attemptsByUser = new Map<string, AttemptRow[]>();
  for (const a of attempts) {
    attemptsByUser.set(a.user_id, [...(attemptsByUser.get(a.user_id) ?? []), a]);
  }
  const completedOf = (uid: string): Set<string> => {
    const done = new Set<string>();
    for (const a of attemptsByUser.get(uid) ?? []) {
      const cid = courseOfVersion.get(a.course_version_id);
      if (!cid) continue;
      if (a.completion_status === "completed" || a.success_status === "passed") done.add(cid);
    }
    return done;
  };

  const lensCourse = filters.content.startsWith("course:") ? filters.content.slice(7) : null;
  const lensPath = filters.content.startsWith("path:") ? filters.content.slice(5) : null;
  const lensJourney = filters.content.startsWith("journey:") ? filters.content.slice(8) : null;

  const stats: LearnerStat[] = scoped.map((m) => {
    const uid = m.user_id;
    const my = attemptsByUser.get(uid) ?? [];
    const done = completedOf(uid);
    const assignedMap = assignedByUser.get(uid) ?? new Map();
    const assigned = assignedMap.size;
    const completed = [...assignedMap.keys()].filter((c) => done.has(c)).length;
    const scores = my.map((a) => a.score).filter((s): s is number => typeof s === "number");
    const avgScore = scores.length
      ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 100)
      : null;

    const gam = gamByUser.get(uid);
    let lastActive: string | null = gam?.last_active_day ?? null;
    for (const a of my) {
      const t = a.last_activity_at ?? a.completed_at ?? a.started_at;
      if (t && (!lastActive || t > lastActive)) lastActive = t;
    }

    let overdue = 0;
    for (const [cid, due] of assignedMap) {
      if (due && due < nowIso && !done.has(cid)) overdue++;
    }
    for (const [pid, due] of pathsByUser.get(uid) ?? new Map()) {
      if (!due || due >= nowIso) continue;
      const pcs = coursesOfPath.get(pid) ?? [];
      if (pcs.length > 0 && !pcs.every((c) => done.has(c))) overdue++;
    }

    const myJourneys = journeysByUser.get(uid) ?? [];
    const worst = myJourneys.reduce(
      (acc, j) => ({
        behind: Math.max(acc.behind, j.behind),
        overdueDeadline: acc.overdueDeadline || j.overdueDeadline,
      }),
      { behind: 0, overdueDeadline: false }
    );
    const activeJourney = myJourneys.find((j) => j.status === "active");

    const latestByCourse = new Map<string, AttemptRow>();
    for (const a of my) {
      const cid = courseOfVersion.get(a.course_version_id);
      if (!cid) continue;
      const t = a.last_activity_at ?? a.completed_at ?? a.started_at ?? "";
      const prev = latestByCourse.get(cid);
      const pt = prev ? prev.last_activity_at ?? prev.completed_at ?? prev.started_at ?? "" : "";
      if (!prev || t > pt) latestByCourse.set(cid, a);
    }
    const failedLatest = [...latestByCourse.values()].some(
      (a) => a.success_status === "failed" && a.completion_status !== "completed"
    );
    const maxNudges = Math.max(0, ...(nudgesByUser.get(uid) ?? []).map((n) => n.nudge_count));

    const inactiveDays = lastActive
      ? Math.floor((nowMs - new Date(lastActive).getTime()) / 86400000)
      : null;

    let risk = 0;
    const reasons: string[] = [];
    if (worst.behind >= 3 || worst.overdueDeadline) {
      risk += 3;
      reasons.push(worst.overdueDeadline ? "journey past deadline" : `journey ${worst.behind}d behind`);
    } else if (worst.behind >= 1) {
      risk += 1;
      reasons.push(`journey ${worst.behind}d behind`);
    }
    if (overdue > 0) {
      risk += Math.min(overdue, 3) * 2;
      reasons.push(`${overdue} overdue`);
    }
    if (failedLatest) {
      risk += 2;
      reasons.push("failed attempt");
    }
    if (inactiveDays !== null && inactiveDays >= 14) {
      risk += inactiveDays >= 21 ? 3 : 2;
      reasons.push(`inactive ${inactiveDays}d`);
    } else if (inactiveDays === null && assigned > 0) {
      risk += 2;
      reasons.push("never started");
    }
    if (maxNudges >= 3) {
      risk += 2;
      reasons.push(`${maxNudges} reminders`);
    }

    // Content lens value for the learner table.
    let lens: string | null = null;
    if (lensCourse) {
      const a = latestByCourse.get(lensCourse);
      lens = done.has(lensCourse)
        ? `Completed${a?.score != null ? ` · ${Math.round(a.score * 100)}%` : ""}`
        : a
          ? "In progress"
          : assignedMap.has(lensCourse)
            ? "Not started"
            : "—";
    } else if (lensPath) {
      const pcs = coursesOfPath.get(lensPath) ?? [];
      lens = pcs.length ? `${pcs.filter((c) => done.has(c)).length}/${pcs.length} steps` : "—";
    } else if (lensJourney) {
      const j = myJourneys.find((x) => x.programId === lensJourney);
      lens = j
        ? j.status === "completed"
          ? "Completed"
          : `Day ${j.day}/${j.total}${j.behind ? ` · ${j.behind}d behind` : ""}`
        : "—";
    }

    return {
      userId: uid,
      name: nameOf(uid),
      email: emailOf(uid),
      designation: m.designation,
      branch: m.branch,
      city: m.city,
      vertical: m.business_vertical,
      managerId: m.line_manager_id,
      teamNames: (teamsOfUser.get(uid) ?? []).map((t) => teamNameById.get(t) ?? ""),
      cohort: m.date_of_joining ? m.date_of_joining.slice(0, 7) : null,
      assigned,
      completed,
      pct: assigned > 0 ? Math.round((completed / assigned) * 100) : -1,
      avgScore,
      attempts: my.length,
      xp: gam?.total_xp ?? 0,
      streak: gam?.current_streak_days ?? 0,
      lastActive,
      overdue,
      behindDays: worst.behind,
      journeyLabel: activeJourney
        ? `Day ${activeJourney.day}/${activeJourney.total}`
        : null,
      maxNudges,
      failedLatest,
      risk,
      reasons,
      lens,
    };
  });

  // Content lens narrows the population too: only learners for whom the
  // selected content is relevant (assigned/enrolled/attempted).
  const visible = filters.content
    ? stats.filter((s) => s.lens !== "—" && s.lens !== null)
    : stats;

  /* ---- aggregates ---- */
  const withAssignments = visible.filter((s) => s.pct >= 0);
  const avgCompletion = withAssignments.length
    ? Math.round(withAssignments.reduce((x, s) => x + s.pct, 0) / withAssignments.length)
    : 0;
  const overdueLearners = visible.filter((s) => s.overdue > 0).length;
  const atRisk = visible.filter((s) => s.risk >= 5);
  const watch = visible.filter((s) => s.risk >= 3 && s.risk < 5);
  const active7d = visible.filter(
    (s) => s.lastActive && nowMs - new Date(s.lastActive).getTime() <= 7 * 86400000
  ).length;

  type DimRow = { key: string; n: number; pct: number; overdue: number; risk: number };
  const byDim = (pick: (s: LearnerStat) => Array<string | null>): DimRow[] => {
    const acc = new Map<string, { n: number; pctSum: number; pctN: number; overdue: number; risk: number }>();
    for (const s of visible) {
      for (const raw of pick(s)) {
        if (!raw) continue;
        const a = acc.get(raw) ?? { n: 0, pctSum: 0, pctN: 0, overdue: 0, risk: 0 };
        a.n++;
        if (s.pct >= 0) { a.pctSum += s.pct; a.pctN++; }
        if (s.overdue > 0) a.overdue++;
        if (s.risk >= 5) a.risk++;
        acc.set(raw, a);
      }
    }
    return [...acc.entries()]
      .map(([key, a]) => ({
        key, n: a.n,
        pct: a.pctN ? Math.round(a.pctSum / a.pctN) : 0,
        overdue: a.overdue, risk: a.risk,
      }))
      .sort((x, y) => y.risk - x.risk || x.pct - y.pct)
      .slice(0, 8);
  };
  const impact = [
    { title: "By team", rows: byDim((s) => (s.teamNames.length ? s.teamNames : [null])) },
    { title: "By vertical", rows: byDim((s) => [s.vertical]) },
    { title: "By branch", rows: byDim((s) => [s.branch]) },
    { title: "By city", rows: byDim((s) => [s.city]) },
  ];

  /* ---- question-level (course lens only) ---- */
  type QRow = {
    interaction_id: string; interaction_label: string | null;
    total_responses: number; distinct_learners: number;
    correct_count: number; incorrect_count: number; correct_rate: number;
  };
  let questions: Array<QRow & { topWrong: string[] }> = [];
  if (lensCourse) {
    const { data: qRows } = await svc
      .from("mv_course_interaction_breakdown")
      .select("interaction_id, interaction_label, total_responses, distinct_learners, correct_count, incorrect_count, correct_rate")
      .eq("course_id", lensCourse)
      .order("correct_rate", { ascending: true })
      .limit(10);
    const qs = (qRows ?? []) as QRow[];
    const { data: wRows } = qs.length
      ? await svc
          .from("mv_course_interaction_top_wrong")
          .select("interaction_id, rank, response")
          .eq("course_id", lensCourse)
          .in("interaction_id", qs.map((q) => q.interaction_id))
          .order("rank")
      : { data: [] };
    const wrongBy = new Map<string, string[]>();
    for (const w of (wRows ?? []) as Array<{ interaction_id: string; response: string }>) {
      wrongBy.set(w.interaction_id, [...(wrongBy.get(w.interaction_id) ?? []), w.response]);
    }
    questions = qs.map((q) => ({ ...q, topWrong: wrongBy.get(q.interaction_id) ?? [] }));
  }

  /* ---- filter options for the bar ---- */
  const opt = (v: string): FilterOption => ({ value: v, label: v });
  const filterProps = {
    orgSlug,
    current: filters,
    teams: teams.map((t) => ({ value: t.id, label: t.name })),
    verticals: distinct(members.map((m) => m.business_vertical)).map(opt),
    branches: distinct(members.map((m) => m.branch)).map(opt),
    cities: distinct(members.map((m) => m.city)).map(opt),
    managers: managerIds.map((id) => ({ value: id, label: nameOf(id) })),
    cohorts: cohortMonths.map(opt),
    groups: groups.map((g) => ({ value: g.id, label: g.name })),
    contents: [
      { label: "Journeys", options: programs.filter((p) => p.is_active !== false).map((p) => ({ value: `journey:${p.id}`, label: p.name })) },
      { label: "Learning paths", options: paths.map((p) => ({ value: `path:${p.id}`, label: p.name })) },
      { label: "Courses", options: courses.map((c) => ({ value: `course:${c.id}`, label: c.title })) },
    ],
  };

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const baseQuery = qs.toString();
  const drillHref = (uid: string) =>
    `/${orgSlug}/analytics?${baseQuery ? `${baseQuery}&` : ""}learner=${uid}`;

  const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
  const riskPill = (s: LearnerStat) =>
    s.risk >= 5 ? (
      <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800 text-[11px] font-bold">high</span>
    ) : s.risk >= 3 ? (
      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-bold">watch</span>
    ) : (
      <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold">ok</span>
    );

  /* ================= LEARNER 360 ================= */
  const learner360 = learnerParam ? stats.find((s) => s.userId === learnerParam) ?? null : null;
  if (learnerParam && !learner360) {
    // Learner exists but falls outside the current filters — clear filters hint.
    return (
      <div>
        <AdminPageHeader title="Learner Analytics" />
        <p className="text-sm text-muted">
          This learner is outside the current filters (or inactive).{" "}
          <Link href={`/${orgSlug}/analytics?learner=${learnerParam}`} className="underline">
            View without filters
          </Link>{" "}
          ·{" "}
          <Link href={`/${orgSlug}/analytics`} className="underline">
            Back to dashboard
          </Link>
        </p>
      </div>
    );
  }

  if (learner360) {
    const s = learner360;
    const myJourneys = journeysByUser.get(s.userId) ?? [];
    const done = completedOf(s.userId);
    const assignedMap = assignedByUser.get(s.userId) ?? new Map<string, string | null>();
    const my = attemptsByUser.get(s.userId) ?? [];
    const perCourse = new Map<string, { attempts: number; best: number | null; last: string | null; status: string }>();
    for (const [cid] of assignedMap) {
      perCourse.set(cid, { attempts: 0, best: null, last: null, status: "Not started" });
    }
    for (const a of my) {
      const cid = courseOfVersion.get(a.course_version_id);
      if (!cid) continue;
      const row = perCourse.get(cid) ?? { attempts: 0, best: null, last: null, status: "Not started" };
      row.attempts++;
      if (typeof a.score === "number" && (row.best === null || a.score > row.best)) row.best = a.score;
      const t = a.last_activity_at ?? a.completed_at ?? a.started_at;
      if (t && (!row.last || t > row.last)) row.last = t;
      perCourse.set(cid, row);
    }
    for (const [cid, row] of perCourse) {
      row.status = done.has(cid)
        ? "Completed"
        : row.attempts > 0
          ? "In progress"
          : "Not started";
      void cid;
    }
    const courseRowsSorted = [...perCourse.entries()].sort((a, b) => {
      const order = (st: string) => (st === "In progress" ? 0 : st === "Not started" ? 1 : 2);
      return order(a[1].status) - order(b[1].status);
    });
    const myPaths = [...(pathsByUser.get(s.userId) ?? new Map<string, string | null>())];
    const myNudges = (nudgesByUser.get(s.userId) ?? []).filter((n) => n.nudge_count > 0);
    const backHref = `/${orgSlug}/analytics${baseQuery ? `?${baseQuery}` : ""}`;

    return (
      <div className="space-y-6">
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          <ArrowLeft className="w-4 h-4" /> Back to dashboard
        </Link>

        <div className="bg-paper border border-line rounded-2xl p-6 flex flex-wrap items-center gap-5">
          <Avatar name={s.name} avatarUrl={null} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="serif text-3xl leading-tight">{s.name}</h1>
            <p className="text-sm text-muted mt-0.5">
              {[s.designation, s.branch].filter(Boolean).join(" · ") || "—"}
              {s.email ? ` · ${s.email}` : ""}
            </p>
            <p className="text-xs text-muted mt-1">
              {[
                s.vertical,
                s.city,
                s.teamNames.length ? `Team: ${s.teamNames.join(", ")}` : null,
                s.managerId ? `Manager: ${nameOf(s.managerId)}` : null,
                s.cohort ? `Joined ${s.cohort}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="text-right">
            {riskPill(s)}
            {s.reasons.length > 0 && (
              <p className="text-[11px] text-muted mt-1 max-w-[220px]">{s.reasons.join(" · ")}</p>
            )}
          </div>
        </div>

        <KpiStrip>
          <KpiCard label="Completion" value={s.pct >= 0 ? `${s.pct}%` : "—"} trend={`${s.completed}/${s.assigned} assigned`} icon={<CheckCircle2 className="w-5 h-5" />} accent="text-emerald-600" />
          <KpiCard label="Avg score" value={s.avgScore !== null ? `${s.avgScore}%` : "—"} trend={`${s.attempts} attempts`} icon={<Activity className="w-5 h-5" />} accent="text-indigo-600" />
          <KpiCard label="XP" value={s.xp} icon={<Flame className="w-5 h-5" />} accent="text-amber-600" trend={`streak ${s.streak}d`} />
          <KpiCard label="Overdue" value={s.overdue} icon={<Clock className="w-5 h-5" />} accent={s.overdue ? "text-red-600" : "text-muted"} />
          <KpiCard label="Last active" value={fmtDate(s.lastActive)} icon={<Users className="w-5 h-5" />} />
        </KpiStrip>

        {myJourneys.length > 0 && (
          <section className="bg-paper border border-line rounded-2xl p-5">
            <h2 className="font-semibold mb-3">Journeys</h2>
            <ul className="space-y-2">
              {myJourneys.map((j) => (
                <li key={j.programId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{j.programName}</span>
                  <span className="text-muted">
                    {j.status === "completed" ? "Completed 🎉" : `Day ${j.day} of ${j.total}`}
                    {j.behind > 0 && (
                      <strong className="text-red-700"> · {j.behind}d behind</strong>
                    )}
                    {j.overdueDeadline && <strong className="text-red-700"> · past deadline</strong>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="bg-paper border border-line rounded-2xl overflow-hidden">
          <h2 className="font-semibold px-5 pt-4 pb-2">Courses ({courseRowsSorted.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line">
                  <th className="px-5 py-2">Course</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Best score</th>
                  <th className="px-4 py-2">Attempts</th>
                  <th className="px-4 py-2">Due</th>
                  <th className="px-4 py-2">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {courseRowsSorted.map(([cid, r]) => {
                  const due = assignedMap.get(cid) ?? null;
                  const isOver = !!due && due < nowIso && r.status !== "Completed";
                  return (
                    <tr key={cid} className="border-b border-line last:border-0">
                      <td className="px-5 py-2.5 font-medium">{courseTitle.get(cid) ?? cid.slice(0, 8)}</td>
                      <td className="px-4 py-2.5">{r.status}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.best !== null ? `${Math.round(r.best * 100)}%` : "—"}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.attempts}</td>
                      <td className={`px-4 py-2.5 ${isOver ? "text-red-700 font-semibold" : "text-muted"}`}>
                        {due ? `${fmtDate(due)}${isOver ? " · overdue" : ""}` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{fmtDate(r.last)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {myPaths.length > 0 && (
          <section className="bg-paper border border-line rounded-2xl p-5">
            <h2 className="font-semibold mb-3">Learning paths</h2>
            <ul className="space-y-2 text-sm">
              {myPaths.map(([pid, due]) => {
                const pcs = coursesOfPath.get(pid) ?? [];
                const doneN = pcs.filter((c) => done.has(c)).length;
                const over = !!due && due < nowIso && doneN < pcs.length;
                return (
                  <li key={pid} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{pathName.get(pid) ?? pid.slice(0, 8)}</span>
                    <span className={over ? "text-red-700 font-semibold" : "text-muted"}>
                      {doneN}/{pcs.length} steps{due ? ` · due ${fmtDate(due)}` : ""}
                      {over ? " · overdue" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {myNudges.length > 0 && (
          <section className="bg-paper border border-line rounded-2xl p-5">
            <h2 className="font-semibold mb-2">Reminder history</h2>
            <ul className="text-sm text-muted space-y-1">
              {myNudges.map((n) => (
                <li key={n.course_id}>
                  {courseTitle.get(n.course_id) ?? n.course_id.slice(0, 8)} —{" "}
                  <strong className="text-ink">{n.nudge_count}</strong>{" "}
                  {n.nudge_count === 1 ? "reminder" : "reminders"} sent
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  /* ================= DASHBOARD ================= */
  const atRiskSorted = [...atRisk, ...watch].sort((a, b) => b.risk - a.risk).slice(0, 20);
  const tableRows = [...visible]
    .sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name))
    .slice(0, 200);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Learner Analytics"
        description="Who is behind, where the gap is, and which team, branch, or vertical is impacted. Click any learner for their 360° view."
      />

      <FilterBar {...filterProps} />

      <KpiStrip>
        <KpiCard label="Learners in view" value={visible.length} icon={<Users className="w-5 h-5" />} accent="text-indigo-600" />
        <KpiCard label="Avg completion" value={`${avgCompletion}%`} trend={`${withAssignments.length} with assignments`} icon={<CheckCircle2 className="w-5 h-5" />} accent="text-emerald-600" />
        <KpiCard label="Overdue" value={overdueLearners} trend="learners with overdue items" icon={<Clock className="w-5 h-5" />} accent={overdueLearners ? "text-red-600" : "text-muted"} />
        <KpiCard label="At risk" value={atRisk.length} trend={`${watch.length} on watch`} icon={<AlertTriangle className="w-5 h-5" />} accent={atRisk.length ? "text-red-600" : "text-muted"} />
        <KpiCard label="Active last 7d" value={visible.length ? `${Math.round((active7d / visible.length) * 100)}%` : "—"} icon={<Flame className="w-5 h-5" />} accent="text-amber-600" />
      </KpiStrip>

      {/* Impact: which slice of the org is hurting */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {impact
          .filter((d) => d.rows.length > 0)
          .map((d) => (
            <section key={d.title} className="bg-paper border border-line rounded-2xl overflow-hidden">
              <h2 className="font-semibold px-4 pt-3 pb-1 text-sm">{d.title}</h2>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                    <th className="px-4 py-1.5 font-semibold">Segment</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Learners</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Completion</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Overdue</th>
                    <th className="px-4 py-1.5 text-right font-semibold">At risk</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.key} className="border-t border-line">
                      <td className="px-4 py-1.5 font-medium truncate max-w-[140px]">{r.key}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.n}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.pct}%</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${r.overdue ? "text-red-700 font-semibold" : "text-muted"}`}>{r.overdue}</td>
                      <td className={`px-4 py-1.5 text-right tabular-nums ${r.risk ? "text-red-700 font-semibold" : "text-muted"}`}>{r.risk}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
      </div>

      {/* At-risk intervention list */}
      <section className="bg-paper border border-line rounded-2xl overflow-hidden">
        <div className="px-5 pt-4 pb-2 flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">Needs attention</h2>
          <span className="text-xs text-muted">
            risk = journeys behind + overdue + failures + inactivity + chronic reminders
          </span>
        </div>
        {atRiskSorted.length === 0 ? (
          <p className="px-5 pb-4 text-sm text-muted">Nobody in this view needs intervention. 🎉</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line">
                  <th className="px-5 py-2">Learner</th>
                  <th className="px-4 py-2">Risk</th>
                  <th className="px-4 py-2">Why</th>
                  <th className="px-4 py-2">Manager</th>
                  <th className="px-4 py-2">Last active</th>
                </tr>
              </thead>
              <tbody>
                {atRiskSorted.map((s) => (
                  <tr key={s.userId} className="border-b border-line last:border-0 hover:bg-canvas/50">
                    <td className="px-5 py-2.5">
                      <Link href={drillHref(s.userId)} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <span className="block text-[11px] text-muted">
                        {[s.designation, s.branch].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">{riskPill(s)}</td>
                    <td className="px-4 py-2.5 text-xs text-muted max-w-[260px]">{s.reasons.join(" · ")}</td>
                    <td className="px-4 py-2.5 text-xs text-muted">{s.managerId ? nameOf(s.managerId) : "—"}</td>
                    <td className="px-4 py-2.5 text-xs text-muted">{fmtDate(s.lastActive)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Question-level performance — course lens only */}
      {lensCourse && (
        <section className="bg-paper border border-line rounded-2xl overflow-hidden">
          <div className="px-5 pt-4 pb-2">
            <h2 className="font-semibold">
              Hardest questions — {courseTitle.get(lensCourse) ?? "course"}
            </h2>
            <p className="text-xs text-muted">
              Lowest correct-rate first, with the most common wrong answers. Org-wide data, refreshed nightly.
            </p>
          </div>
          {questions.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted">
              No question-level data yet — this course's package hasn't reported answer interactions.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line">
                    <th className="px-5 py-2">Question</th>
                    <th className="px-4 py-2 text-right">Correct rate</th>
                    <th className="px-4 py-2 text-right">Learners</th>
                    <th className="px-4 py-2">Most common wrong answers</th>
                  </tr>
                </thead>
                <tbody>
                  {questions.map((q) => (
                    <tr key={q.interaction_id} className="border-b border-line last:border-0">
                      <td className="px-5 py-2.5 max-w-[280px]">
                        {q.interaction_label ?? q.interaction_id.split("/").pop()}
                      </td>
                      <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${Number(q.correct_rate) < 0.5 ? "text-red-700" : ""}`}>
                        {Math.round(Number(q.correct_rate) * 100)}%
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted">{q.distinct_learners}</td>
                      <td className="px-4 py-2.5 text-xs text-muted max-w-[260px] truncate">
                        {q.topWrong.join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Full learner table */}
      <section className="bg-paper border border-line rounded-2xl overflow-hidden">
        <div className="px-5 pt-4 pb-2 flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">All learners ({visible.length})</h2>
          {visible.length > 200 && (
            <span className="text-xs text-muted">showing first 200 — narrow the filters to see everyone</span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <th className="px-5 py-2">Learner</th>
                {filters.content ? (
                  <th className="px-4 py-2">{lensJourney ? "Journey" : lensPath ? "Path progress" : "Course status"}</th>
                ) : (
                  <th className="px-4 py-2">Completion</th>
                )}
                <th className="px-4 py-2 text-right">Avg score</th>
                <th className="px-4 py-2 text-right">XP</th>
                <th className="px-4 py-2 text-right">Streak</th>
                <th className="px-4 py-2 text-right">Overdue</th>
                <th className="px-4 py-2">Journey</th>
                <th className="px-4 py-2">Risk</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((s) => (
                <tr key={s.userId} className="border-b border-line last:border-0 hover:bg-canvas/50">
                  <td className="px-5 py-2.5">
                    <Link href={drillHref(s.userId)} className="font-medium hover:underline">
                      {s.name}
                    </Link>
                    <span className="block text-[11px] text-muted">
                      {[s.designation, s.branch].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  {filters.content ? (
                    <td className="px-4 py-2.5">{s.lens}</td>
                  ) : (
                    <td className="px-4 py-2.5 tabular-nums">
                      {s.pct >= 0 ? `${s.pct}%` : "—"}
                      <span className="text-muted text-xs"> ({s.completed}/{s.assigned})</span>
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-right tabular-nums">{s.avgScore !== null ? `${s.avgScore}%` : "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{s.xp}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{s.streak}d</td>
                  <td className={`px-4 py-2.5 text-right tabular-nums ${s.overdue ? "text-red-700 font-semibold" : "text-muted"}`}>{s.overdue}</td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {s.journeyLabel ?? "—"}
                    {s.behindDays > 0 && <strong className="text-red-700"> · {s.behindDays}d behind</strong>}
                  </td>
                  <td className="px-4 py-2.5">{riskPill(s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
