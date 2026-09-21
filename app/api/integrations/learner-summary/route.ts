import { NextResponse } from "next/server";
import { authenticateApiKey, resolveMember } from "@/lib/integrations/auth";
import { resolveUserGroupIds } from "@/lib/org/groups";
import {
  computeJourneyState,
  courseDaysOf,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";
import {
  DEFAULT_POLICY,
  computeScoring,
  type ScorableAttempt,
} from "@/lib/scoring/policy";
import { resolvePolicies } from "@/lib/scoring/resolve";

/**
 * One call, everything the CRM needs to render an employee's learning card:
 *
 *   GET /api/integrations/learner-summary?employee_id=...  (or ?email=...)
 *   Authorization: Bearer ambk_...
 *
 * Returns assigned courses with status/score/due, learning paths with step
 * progress, journeys with day + behind-schedule, and engagement (XP, streak,
 * last activity). Entitlements expand user/org/team/group assignments through
 * the same resolvers the learner dashboard uses, so the CRM card and the LMS
 * always agree. Include `target` fields to feed straight into sso-link.
 */
export async function GET(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) {
    return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  }
  const url = new URL(request.url);
  const member = await resolveMember(auth.svc, auth.orgId, {
    employee_id: url.searchParams.get("employee_id"),
    email: url.searchParams.get("email"),
  });
  if (!member) {
    return NextResponse.json(
      { error: "No active LMS account for this employee" },
      { status: 404 }
    );
  }
  const { svc, orgId, orgSlug } = auth;
  const uid = member.userId;

  // ---- identity ----
  const { data: prof } = await svc
    .from("profiles")
    .select("first_name, last_name, email")
    .eq("id", uid)
    .maybeSingle();
  const p = prof as { first_name?: string | null; last_name?: string | null; email?: string | null } | null;

  // ---- entitlement inputs: teams + groups ----
  const { data: tmRows } = await svc
    .from("team_members")
    .select("team_id, teams!inner(organization_id)")
    .eq("user_id", uid);
  const myTeamIds = ((tmRows ?? []) as Array<{
    team_id: string;
    teams: { organization_id: string } | Array<{ organization_id: string }>;
  }>)
    .filter((r) => {
      const t = Array.isArray(r.teams) ? r.teams[0] : r.teams;
      return t?.organization_id === orgId;
    })
    .map((r) => r.team_id);
  let myGroupIds = new Set<string>();
  try {
    myGroupIds = await resolveUserGroupIds(svc, orgId, uid);
  } catch {
    /* pre-0067 */
  }
  const mine = (a: {
    assignee_type: string;
    user_id: string | null;
    team_id: string | null;
    group_id?: string | null;
  }) =>
    (a.assignee_type === "user" && a.user_id === uid) ||
    a.assignee_type === "org" ||
    (a.assignee_type === "team" && !!a.team_id && myTeamIds.includes(a.team_id)) ||
    (a.assignee_type === "group" && !!a.group_id && myGroupIds.has(a.group_id));

  // ---- course entitlements + due dates ----
  const { data: caRows } = await svc
    .from("course_assignments")
    .select("*")
    .eq("organization_id", orgId);
  type Assign = {
    course_id: string;
    assignee_type: string;
    user_id: string | null;
    team_id: string | null;
    group_id?: string | null;
    due_at: string | null;
    release_at: string | null;
  };
  const nowIso = new Date().toISOString();
  const dueByCourse = new Map<string, string | null>();
  for (const a of (caRows ?? []) as Assign[]) {
    if (!mine(a)) continue;
    if (a.release_at && a.release_at > nowIso) continue;
    const prev = dueByCourse.get(a.course_id);
    if (prev === undefined || (a.due_at && (!prev || a.due_at < prev))) {
      dueByCourse.set(a.course_id, a.due_at ?? prev ?? null);
    }
  }

  // ---- paths + their courses ----
  const { data: paRows } = await svc
    .from("learning_path_assignments")
    .select("*")
    .eq("organization_id", orgId);
  const myPathDue = new Map<string, string | null>();
  for (const a of (paRows ?? []) as Array<Assign & { path_id: string }>) {
    if (!mine(a)) continue;
    const prev = myPathDue.get(a.path_id);
    if (prev === undefined || (a.due_at && (!prev || a.due_at < prev))) {
      myPathDue.set(a.path_id, a.due_at ?? prev ?? null);
    }
  }
  const pathIds = [...myPathDue.keys()];
  const { data: pcRows } = pathIds.length
    ? await svc
        .from("learning_path_courses")
        .select("path_id, course_id")
        .in("path_id", pathIds)
    : { data: [] };
  const coursesOfPath = new Map<string, string[]>();
  for (const r of (pcRows ?? []) as Array<{ path_id: string; course_id: string }>) {
    coursesOfPath.set(r.path_id, [...(coursesOfPath.get(r.path_id) ?? []), r.course_id]);
    if (!dueByCourse.has(r.course_id)) dueByCourse.set(r.course_id, null);
  }

  // ---- attempts → status/score per course ----
  const { data: atRows } = await svc
    .from("course_attempts")
    // select("*") for 0075 deploy safety (progress_pct).
    .select("*")
    .eq("organization_id", orgId)
    .eq("user_id", uid);
  type Att = {
    id: string;
    course_version_id: string;
    completion_status: string | null;
    success_status: string | null;
    score: number | null;
    started_at: string | null;
    completed_at: string | null;
    last_activity_at: string | null;
    progress_pct?: number | null;
  };
  const attempts = (atRows ?? []) as Att[];
  const verIds = [...new Set(attempts.map((a) => a.course_version_id))];
  const { data: verRows } = verIds.length
    ? await svc.from("course_versions").select("id, course_id").in("id", verIds)
    : { data: [] };
  const courseOfVer = new Map(
    ((verRows ?? []) as Array<{ id: string; course_id: string }>).map((v) => [v.id, v.course_id])
  );
  const byCourse = new Map<string, { status: string; attempts: number; list: ScorableAttempt[]; progress: number | null; progressAt: string }>();
  let lastActive: string | null = null;
  for (const a of attempts) {
    const cid = courseOfVer.get(a.course_version_id);
    const t = a.last_activity_at ?? a.completed_at ?? a.started_at;
    if (t && (!lastActive || t > lastActive)) lastActive = t;
    if (!cid) continue;
    const row = byCourse.get(cid) ?? { status: "not_started", attempts: 0, list: [], progress: null, progressAt: "" };
    row.attempts++;
    // Progress of the most recent open attempt (0075).
    if (a.completion_status === "in_progress" && (a.started_at ?? "") >= row.progressAt) {
      row.progressAt = a.started_at ?? "";
      row.progress = typeof a.progress_pct === "number" ? a.progress_pct : null;
    }
    row.list.push({
      id: a.id,
      score: a.score,
      started_at: a.started_at ?? "",
      completed_at: a.completed_at,
      completion_status: a.completion_status,
      success_status: a.success_status,
    });
    if (a.success_status === "passed") row.status = "passed";
    else if (a.completion_status === "completed" && row.status !== "passed") row.status = "completed";
    else if (row.status === "not_started") row.status = "in_progress";
    byCourse.set(cid, row);
  }
  // 0073: scores follow each module's admin-configured attempt rules.
  const policies = await resolvePolicies(svc, [...byCourse.keys()]);

  // ---- course titles (active only) ----
  const allCourseIds = [...dueByCourse.keys()];
  const { data: cRows } = allCourseIds.length
    ? await svc
        .from("courses")
        .select("id, title, is_active")
        .in("id", allCourseIds)
        .eq("is_active", true)
    : { data: [] };
  const pct = (v: number | null) => (v !== null ? Math.round(v * 100) : null);
  const courses = ((cRows ?? []) as Array<{ id: string; title: string }>).map((cr) => {
    const st = byCourse.get(cr.id) ?? { status: "not_started", attempts: 0, list: [], progress: null, progressAt: "" };
    const sc = computeScoring(st.list, policies.get(cr.id) ?? DEFAULT_POLICY);
    const due = dueByCourse.get(cr.id) ?? null;
    const done = st.status === "completed" || st.status === "passed";
    return {
      course_id: cr.id,
      title: cr.title,
      status: st.status,
      // `score` is the OFFICIAL score under the module's attempt rules.
      score: pct(sc.officialScore),
      official_score: pct(sc.officialScore),
      first_score: pct(sc.firstScore),
      best_score: pct(sc.bestScore),
      scored_attempts: sc.scoredAttempts,
      practice_attempts: sc.practiceAttempts,
      // How far through the module the open attempt is (0–99); 100 when
      // complete; null when the package gives no progress signal.
      progress_pct: done ? 100 : st.progress,
      attempts: st.attempts,
      due_at: due,
      overdue: !!due && due < nowIso && !done,
      // Feed straight into sso-link's `target`.
      target: `/${orgSlug}/courses/${cr.id}/launch`,
    };
  });

  const doneSet = new Set(courses.filter((cs) => cs.status === "completed" || cs.status === "passed").map((cs) => cs.course_id));
  const { data: pnRows } = pathIds.length
    ? await svc.from("learning_paths").select("id, name, is_active").in("id", pathIds)
    : { data: [] };
  const paths = ((pnRows ?? []) as Array<{ id: string; name: string; is_active: boolean }>)
    .filter((pr) => pr.is_active !== false)
    .map((pr) => {
      const steps = coursesOfPath.get(pr.id) ?? [];
      return {
        path_id: pr.id,
        name: pr.name,
        steps_total: steps.length,
        steps_completed: steps.filter((cid) => doneSet.has(cid)).length,
        due_at: myPathDue.get(pr.id) ?? null,
        target: `/${orgSlug}/paths/${pr.id}`,
      };
    });

  // ---- journeys (behind-schedule math, same as the nudge engine) ----
  const journeys: Array<{
    name: string;
    status: string;
    day: number;
    days_total: number;
    behind_days: number;
    target: string;
  }> = [];
  try {
    const { data: gsRow } = await svc
      .from("gamification_settings")
      .select("timezone")
      .eq("organization_id", orgId)
      .maybeSingle();
    const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
    const today = todayStr(tz);
    const { data: enrRows } = await svc
      .from("journey_enrollments")
      .select(
        "id, status, start_date, journey_versions!inner(days, days_total, count_sundays), journey_programs!inner(name, is_active)"
      )
      .eq("organization_id", orgId)
      .eq("user_id", uid)
      .in("status", ["active", "completed"]);
    for (const e of (enrRows ?? []) as Array<{
      id: string;
      status: string;
      start_date: string;
      journey_versions: { days: unknown; days_total: number; count_sundays: boolean } | Array<{ days: unknown; days_total: number; count_sundays: boolean }>;
      journey_programs: { name: string; is_active: boolean } | Array<{ name: string; is_active: boolean }>;
    }>) {
      const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
      const prog = Array.isArray(e.journey_programs) ? e.journey_programs[0] : e.journey_programs;
      if (!v || !prog || prog.is_active === false) continue;
      const { count } = await svc
        .from("journey_day_progress")
        .select("id", { count: "exact", head: true })
        .eq("enrollment_id", e.id);
      const state = computeJourneyState({
        startDate: e.start_date,
        today,
        completedCount: count ?? 0,
        daysTotal: v.days_total,
        countSundays: v.count_sundays === true,
        courseDays: courseDaysOf(v.days, v.days_total),
      });
      journeys.push({
        name: prog.name,
        status: e.status,
        day: state.currentDay,
        days_total: state.daysTotal,
        behind_days: e.status === "active" && !state.finished ? state.behindDays : 0,
        target: `/${orgSlug}/journey`,
      });
    }
  } catch {
    /* pre-journey database */
  }

  // ---- engagement ----
  let xp = 0;
  let streak = 0;
  try {
    const { data: gam } = await svc
      .from("user_gamification")
      .select("total_xp, current_streak_days, last_active_day")
      .eq("organization_id", orgId)
      .eq("user_id", uid)
      .maybeSingle();
    const g = gam as { total_xp?: number; current_streak_days?: number; last_active_day?: string | null } | null;
    xp = g?.total_xp ?? 0;
    streak = g?.current_streak_days ?? 0;
    if (g?.last_active_day && (!lastActive || g.last_active_day > lastActive)) {
      lastActive = g.last_active_day;
    }
  } catch {
    /* pre-gamification */
  }

  return NextResponse.json({
    employee_id: member.employeeId,
    email: p?.email ?? null,
    name: [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim() || null,
    courses,
    paths,
    journeys,
    engagement: { xp, streak_days: streak, last_active: lastActive },
    summary: {
      assigned: courses.length,
      completed: courses.filter((cs) => cs.status === "completed" || cs.status === "passed").length,
      overdue: courses.filter((cs) => cs.overdue).length,
    },
  });
}
