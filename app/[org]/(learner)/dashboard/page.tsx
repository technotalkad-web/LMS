import Link from "next/link";
import {
  BookOpen,
  AlertTriangle,
  Clock,
  PlayCircle,
  Lock,
  ShieldAlert,
} from "lucide-react";
import { isReleased, laterOf } from "@/lib/learner/release";
import { LocalDateTime } from "@/components/ui/local-datetime";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import {
  AnnouncementsBanner,
  type Announcement,
} from "../_components/announcements-banner";
import { DashboardGrid, type GridCard } from "./dashboard-grid";
import {
  MotivationStrip,
  type MyGamification,
} from "./_components/motivation-strip";
import { DEFAULT_WELCOME_MESSAGE } from "@/lib/gamification/board-copy";
import { effectiveJourneyCopy } from "@/lib/journey/journey";

type Course = {
  id: string;
  title: string;
  description: string | null;
  current_version_id: string | null;
  updated_at: string;
  thumbnail_url: string | null;
  thumbnail_fit: string | null;
  thumbnail_pos_x: number | null;
  thumbnail_pos_y: number | null;
};

type Version = {
  id: string;
  course_id: string;
  version_number: number;
  manifest_type: "scorm12" | "cmi5";
};

type Assignment = {
  id: string;
  course_id: string;
  assignee_type: "user" | "org" | "team";
  user_id: string | null;
  team_id: string | null;
  due_at: string | null;
  release_at: string | null;
  assigned_at: string;
};

type Attempt = {
  id: string;
  course_version_id: string;
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  score: number | null;
  started_at: string;
  completed_at: string | null;
  learning_path_id: string | null;
};

type PathStepView = {
  course_id: string;
  title: string;
  step_number: number;
  state: "completed" | "current" | "locked" | "unreleased";
  releaseAt: string | null;
};

type PathSummary = {
  id: string;
  name: string;
  description: string | null;
  dueAt: string | null;
  thumbnail_url: string | null;
  steps: PathStepView[];
};

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ locked?: string; denied?: string; upcoming?: string }>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  const { user, org, role } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();

  // 0.1) Own profile for the personalized welcome — "First Last", or the
  // email when no name is set (own-row RLS read).
  const { data: profRow } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .maybeSingle();
  const displayName =
    [profRow?.first_name, profRow?.last_name].filter(Boolean).join(" ").trim() ||
    user.email ||
    "";

  // 0.15) Yoddha journey banner data (0058) — fail-soft: pre-migration the
  // select errors, journey stays null, banner hidden.
  let journey: {
    id: string;
    day: number;
    total: number;
    name: string;
    icon: string;
    line: string;
  } | null = null;
  {
    const { data: jRows } = await supabase
      .from("journey_enrollments")
      .select(
        "id, start_date, journey_versions!inner(name, icon, days_total), journey_programs!inner(is_active, copy)"
      )
      .eq("organization_id", org.id)
      .eq("user_id", user.id)
      .eq("status", "active")
      .limit(1);
    const j = (jRows ?? [])[0] as
      | {
          id: string;
          start_date: string;
          journey_versions:
            | { name: string; icon: string; days_total: number }
            | Array<{ name: string; icon: string; days_total: number }>;
          journey_programs:
            | { is_active: boolean; copy: unknown }
            | Array<{ is_active: boolean; copy: unknown }>;
        }
      | undefined;
    if (j) {
      const ver = Array.isArray(j.journey_versions)
        ? j.journey_versions[0]
        : j.journey_versions;
      const prog = Array.isArray(j.journey_programs)
        ? j.journey_programs[0]
        : j.journey_programs;
      const jc = effectiveJourneyCopy(prog?.copy);
      const { count } = await supabase
        .from("journey_day_progress")
        .select("id", { count: "exact", head: true })
        .eq("enrollment_id", j.id);
      journey = {
        id: j.id,
        day: Math.min(ver?.days_total ?? 90, (count ?? 0) + 1),
        total: ver?.days_total ?? 90,
        name: ver?.name ?? "90-Day Yoddha Journey",
        icon: ver?.icon ?? "🏹",
        line: prog?.is_active === false ? jc.paused_title.toLowerCase() : jc.banner_line,
      };
    }
  }

  // 0.2) Org-editable welcome line (migration 0057; members can read their
  // org's gamification_settings under RLS). Fail-soft to the default — a
  // pre-0057 database errors this select and we just keep the default.
  let welcomeMessage = DEFAULT_WELCOME_MESSAGE;
  const { data: gsw } = await supabase
    .from("gamification_settings")
    .select("welcome_message")
    .eq("organization_id", org.id)
    .maybeSingle();
  const customWelcome = (gsw as { welcome_message?: string | null } | null)
    ?.welcome_message;
  if (typeof customWelcome === "string" && customWelcome.trim()) {
    welcomeMessage = customWelcome.trim();
  }

  // 0) Teams this user is on.
  const { data: myTeamRows } = await supabase
    .from("team_members")
    .select("team_id, teams!inner(organization_id)")
    .eq("user_id", user.id);
  const myTeamIds = ((myTeamRows ?? []) as Array<{
    team_id: string;
    teams: { organization_id: string } | Array<{ organization_id: string }>;
  }>)
    .filter((r) => {
      const t = Array.isArray(r.teams) ? r.teams[0] : r.teams;
      return t?.organization_id === org.id;
    })
    .map((r) => r.team_id);

  // 0.5) Announcements.
  const { data: annRows } = await supabase
    .from("org_announcements")
    .select("id, title, body, tone")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(5);
  const announcements = (annRows ?? []) as Announcement[];

  // 1) Course assignments.
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select(
      "id, course_id, assignee_type, user_id, team_id, due_at, release_at, assigned_at"
    )
    .eq("organization_id", org.id);
  const assignments = (assignmentRows ?? []) as Assignment[];

  const mine = assignments.filter(
    (a) => a.assignee_type === "user" && a.user_id === user.id
  );
  const mineTeams = assignments.filter(
    (a) =>
      a.assignee_type === "team" &&
      a.team_id &&
      myTeamIds.includes(a.team_id)
  );
  const orgWide = assignments.filter((a) => a.assignee_type === "org");

  const directCourseIds = Array.from(
    new Set([...mine, ...mineTeams, ...orgWide].map((a) => a.course_id))
  );

  // 2) Learning path assignments.
  const { data: pathAssignRows } = await supabase
    .from("learning_path_assignments")
    .select("id, path_id, due_at, assignee_type, user_id, team_id")
    .eq("organization_id", org.id);
  const allPathAssigns = (pathAssignRows ?? []) as Array<{
    id: string;
    path_id: string;
    due_at: string | null;
    assignee_type: "user" | "org" | "team";
    user_id: string | null;
    team_id: string | null;
  }>;
  const myPathAssigns = allPathAssigns.filter(
    (a) =>
      (a.assignee_type === "user" && a.user_id === user.id) ||
      a.assignee_type === "org" ||
      (a.assignee_type === "team" &&
        a.team_id &&
        myTeamIds.includes(a.team_id))
  );

  const prec: Record<"user" | "team" | "org", number> = {
    user: 3,
    team: 2,
    org: 1,
  };
  const pathSrcRank = new Map<string, number>();
  const pathDueAt = new Map<string, string | null>();
  for (const a of myPathAssigns) {
    const rank = prec[a.assignee_type];
    if ((pathSrcRank.get(a.path_id) ?? 0) < rank) {
      pathSrcRank.set(a.path_id, rank);
      pathDueAt.set(a.path_id, a.due_at);
    }
  }

  // 2.5) Org-public visibility (#visibility). Every org member sees
  // org_public courses + paths on their dashboard regardless of any
  // explicit assignment. We fold the path ids into pathSrcRank with
  // the 'org' tier so they're picked up by the existing step / title
  // pull-through logic. The course ids are stored separately and
  // unioned into allCourseIds below.
  const { data: orgPublicCourseRows } = await supabase
    .from("courses")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .eq("visibility", "org_public");
  const orgPublicCourseIds = ((orgPublicCourseRows ?? []) as Array<{
    id: string;
  }>).map((r) => r.id);

  const { data: orgPublicPathRows } = await supabase
    .from("learning_paths")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_active", true)
    .eq("visibility", "org_public");
  for (const r of (orgPublicPathRows ?? []) as Array<{ id: string }>) {
    if (!pathSrcRank.has(r.id)) {
      pathSrcRank.set(r.id, prec.org);
      pathDueAt.set(r.id, null);
    }
  }

  const myPathIds = Array.from(pathSrcRank.keys());

  // 3) Path metadata + steps + course titles (active only).
  const { data: pathRows } = myPathIds.length
    ? await supabase
        .from("learning_paths")
        .select("id, name, description, thumbnail_url, sequence_mode")
        .eq("is_active", true)
        .in("id", myPathIds)
    : { data: [] };
  const pathsList = (pathRows ?? []) as Array<{
    id: string;
    name: string;
    description: string | null;
    thumbnail_url: string | null;
    sequence_mode: "strict" | "random" | null;
  }>;

  const { data: stepRows } = myPathIds.length
    ? await supabase
        .from("learning_path_courses")
        .select("path_id, course_id, step_number, release_at, courses!inner(title)")
        .in("path_id", myPathIds)
        .order("step_number", { ascending: true })
    : { data: [] };
  type StepRaw = {
    path_id: string;
    course_id: string;
    step_number: number;
    release_at: string | null;
    courses: { title: string } | { title: string }[];
  };
  const allPathSteps = ((stepRows ?? []) as StepRaw[]).map((s) => {
    const c = Array.isArray(s.courses) ? s.courses[0] : s.courses;
    return {
      path_id: s.path_id,
      course_id: s.course_id,
      step_number: s.step_number,
      release_at: s.release_at,
      title: c?.title ?? "Untitled",
    };
  });
  const pathCourseIds = Array.from(
    new Set(allPathSteps.map((s) => s.course_id))
  );

  // 4) Combined course universe. orgPublicCourseIds is fetched above (3.5)
  //    and folded in so every member of the org sees those courses too.
  const allCourseIds = Array.from(
    new Set([...directCourseIds, ...pathCourseIds, ...orgPublicCourseIds])
  );
  if (allCourseIds.length === 0) {
    return (
      <div>
        <AnnouncementsBanner
          announcements={announcements}
          orgSlug={orgSlug}
        />
        {/* A learner with NOTHING assigned is exactly who hits a denied deep
            link (e.g. scanning a QR for an unassigned course) — the flash
            banner must show on the empty dashboard too, not just the grid. */}
        {sp.denied && <DeniedBanner denied={sp.denied} className="mb-6" />}
        {/* New joiners often have ONLY the journey — the banner must show
            on the empty dashboard too, or their one task is invisible. */}
        {journey && (
          <div className="mb-6">
            <JourneyBanner orgSlug={orgSlug} journey={journey} />
          </div>
        )}
        <EmptyDashboard
          orgName={org.name}
          role={role}
          displayName={displayName}
        />
      </div>
    );
  }

  // 5) Courses (active only — inactive ones are hidden from learners).
  const { data: courseRows } = await supabase
    .from("courses")
    .select(
      "id, title, description, current_version_id, updated_at, thumbnail_url, thumbnail_fit, thumbnail_pos_x, thumbnail_pos_y"
    )
    .eq("is_active", true)
    .in("id", allCourseIds);
  const courses = (courseRows ?? []) as Course[];
  const courseById = new Map(courses.map((c) => [c.id, c]));

  // 6) Versions.
  const { data: versionRows } = await supabase
    .from("course_versions")
    .select("id, course_id, version_number, manifest_type")
    .in("course_id", allCourseIds);
  const versions = (versionRows ?? []) as Version[];
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // 7) Attempts.
  const versionIds = versions.map((v) => v.id);
  const { data: attemptRows } = versionIds.length
    ? await supabase
        .from("course_attempts")
        .select(
          "id, course_version_id, completion_status, success_status, score, started_at, completed_at, learning_path_id"
        )
        .eq("user_id", user.id)
        .in("course_version_id", versionIds)
    : { data: [] as Attempt[] };
  const attempts = (attemptRows ?? []) as Attempt[];

  // 8) Completed course set (GLOBAL — any completion; used for standalone
  // course tiles + deadlines).
  const completedCourseIds = new Set<string>();
  // Path step progress counts ONLY path-context attempts (learning_path_id),
  // per product decision L2 — a standalone completion doesn't advance a path.
  const pathDoneByPath = new Map<string, Set<string>>();
  for (const a of attempts) {
    const v = versionById.get(a.course_version_id);
    if (!v) continue;
    const done =
      a.completion_status === "completed" || a.success_status === "passed";
    if (!done) continue;
    completedCourseIds.add(v.course_id);
    if (a.learning_path_id) {
      const set = pathDoneByPath.get(a.learning_path_id) ?? new Set<string>();
      set.add(v.course_id);
      pathDoneByPath.set(a.learning_path_id, set);
    }
  }

  // 8.2) Gamification: own stats in one RPC round trip (fail-soft — the
  // dashboard renders fine without the strip if the engine is unavailable).
  let myGamification: MyGamification | null = null;
  try {
    const { data: g } = await supabase.rpc("get_my_gamification", {
      p_org: org.id,
    });
    myGamification = (g as MyGamification | null) ?? null;
  } catch {
    myGamification = null;
  }
  // Avg score from the attempts already fetched — no extra query.
  const completedScores = attempts
    .filter(
      (a) => a.completion_status === "completed" || a.success_status === "passed"
    )
    .map((a) => a.score)
    .filter((s): s is number => typeof s === "number");
  const avgScore = completedScores.length
    ? completedScores.reduce((x, y) => x + y, 0) / completedScores.length
    : null;

  // 8.5) 48-hour deadline list (overdue + due-within-48h, not yet completed).
  const nowMs = Date.now();
  const horizon = nowMs + 48 * 60 * 60 * 1000;
  type Deadline = {
    courseId: string;
    courseTitle: string;
    dueAt: string;
    overdue: boolean;
    hoursLeft: number;
  };
  const dueSoon: Deadline[] = [];
  const seenForDeadline = new Set<string>();
  for (const a of [...mine, ...mineTeams, ...orgWide]) {
    if (!a.due_at) continue;
    if (seenForDeadline.has(a.course_id)) continue;
    if (completedCourseIds.has(a.course_id)) continue;
    // Unreleased content never belongs in the urgency callout — its launch
    // CTA would just bounce to "coming soon".
    if (!isReleased(a.release_at, nowMs)) continue;
    const dueTime = new Date(a.due_at).getTime();
    if (dueTime >= horizon) continue;
    const course = courseById.get(a.course_id);
    if (!course) continue;
    seenForDeadline.add(a.course_id);
    dueSoon.push({
      courseId: a.course_id,
      courseTitle: course.title,
      dueAt: a.due_at,
      overdue: dueTime < Date.now(),
      hoursLeft: Math.round((dueTime - Date.now()) / (1000 * 60 * 60)),
    });
  }
  dueSoon.sort((a, b) => (a.dueAt > b.dueAt ? 1 : -1));

  // 9) Path summaries. Scheduled release: an unreleased step renders
  // "unreleased"; in STRICT mode it consumes the "current" slot (learner is
  // waiting), in RANDOM mode the pointer skips it. Completed always wins.
  const paths: PathSummary[] = pathsList
    .map((p) => {
      const steps = allPathSteps.filter((s) => s.path_id === p.id);
      const pathDone = pathDoneByPath.get(p.id) ?? new Set<string>();
      const strictMode = p.sequence_mode !== "random";
      let currentSet = false;
      const stepViews: PathStepView[] = steps.map((s) => {
        let state: PathStepView["state"];
        if (pathDone.has(s.course_id)) {
          state = "completed";
        } else if (!isReleased(s.release_at, nowMs)) {
          state = "unreleased";
          if (strictMode && !currentSet) currentSet = true;
        } else if (!currentSet) {
          state = "current";
          currentSet = true;
        } else {
          state = "locked";
        }
        return {
          course_id: s.course_id,
          title: s.title,
          step_number: s.step_number,
          state,
          releaseAt: s.release_at,
        };
      });
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        dueAt: pathDueAt.get(p.id) ?? null,
        thumbnail_url: p.thumbnail_url,
        steps: stepViews,
      };
    })
    .filter((p) => p.steps.length > 0);

  // 10) Build GridCards for the course grid. User > team > org precedence.
  // Also tag the card with a path name if the course is part of a path
  // the user is on.
  const pathNameByCourseId = new Map<string, string>();
  for (const p of paths) {
    for (const s of p.steps) {
      if (!pathNameByCourseId.has(s.course_id)) {
        pathNameByCourseId.set(s.course_id, p.name);
      }
    }
  }

  // Scheduled-release gates for grid cards (mirrors the launch page):
  // - assignment gate: open when ANY applicable row is released (null/past),
  //   else the earliest future release_at. Uses ALL applicable rows, not just
  //   the precedence winner. org_public courses are always open.
  // - path gate: the LATEST future step release_at across the user's paths
  //   (launch blocks while any enforced path is unreleased).
  const assignmentGateByCourse = new Map<string, string | null>(); // null = open
  for (const a of [...mine, ...mineTeams, ...orgWide]) {
    const prev = assignmentGateByCourse.get(a.course_id);
    if (prev === null) continue; // already open
    if (isReleased(a.release_at, nowMs)) {
      assignmentGateByCourse.set(a.course_id, null);
    } else if (
      prev === undefined ||
      new Date(a.release_at!).getTime() < new Date(prev).getTime()
    ) {
      assignmentGateByCourse.set(a.course_id, a.release_at);
    }
  }
  for (const cid of orgPublicCourseIds) assignmentGateByCourse.set(cid, null);

  const pathGateByCourse = new Map<string, string>();
  for (const s of allPathSteps) {
    if (!s.release_at || isReleased(s.release_at, nowMs)) continue;
    const prev = pathGateByCourse.get(s.course_id);
    if (!prev || new Date(s.release_at).getTime() > new Date(prev).getTime()) {
      pathGateByCourse.set(s.course_id, s.release_at);
    }
  }

  /** Future release time gating this course for this learner, or null if open. */
  function effectiveReleaseFor(courseId: string): string | null {
    return laterOf(
      assignmentGateByCourse.get(courseId) ?? null,
      pathGateByCourse.get(courseId) ?? null
    );
  }

  const cards: GridCard[] = [];
  const seen = new Set<string>();

  function attemptStatusForCourse(courseId: string): GridCard["status"] {
    const courseAttempts = attempts.filter((a) => {
      const v = versionById.get(a.course_version_id);
      return v?.course_id === courseId;
    });
    if (courseAttempts.length === 0) return "not_started";
    // Sticky completion: once a learner has ever passed or completed a course
    // it stays in the Completed bucket forever. Relaunching opens a fresh
    // in-progress attempt, which must NOT drag the card back to "in progress".
    // Derive from the best terminal outcome across ALL attempts (mirrors the
    // `completedCourseIds` logic). Priority: passed > completed > failed.
    if (courseAttempts.some((a) => a.success_status === "passed")) return "passed";
    if (
      courseAttempts.some(
        (a) => a.completion_status === "completed" && a.success_status !== "failed"
      )
    )
      return "completed";
    if (courseAttempts.some((a) => a.success_status === "failed")) return "failed";
    return "in_progress";
  }

  function bestScoreForCourse(courseId: string): number | null {
    const my = attempts.filter((a) => {
      const v = versionById.get(a.course_version_id);
      return v?.course_id === courseId;
    });
    return my
      .map((a) => a.score)
      .filter((s): s is number => typeof s === "number")
      .reduce<number | null>(
        (best, s) => (best === null || s > best ? s : best),
        null
      );
  }

  function pushCard(a: Assignment, source: "user" | "team" | "org") {
    if (seen.has(a.course_id)) return;
    const course = courseById.get(a.course_id);
    if (!course) return;
    let status = attemptStatusForCourse(a.course_id);
    const releaseAt = effectiveReleaseFor(a.course_id);
    // Completed/passed never regresses to "Coming soon".
    if (releaseAt && status !== "completed" && status !== "passed") {
      status = "upcoming";
    }
    cards.push({
      course_id: course.id,
      title: course.title,
      description: course.description,
      source,
      status,
      releaseAt,
      isRevised: false,
      dueAt: a.due_at,
      bestScore: bestScoreForCourse(course.id),
      pathName: pathNameByCourseId.get(course.id) ?? null,
      thumbnail_url: course.thumbnail_url,
      thumbnail_fit: course.thumbnail_fit,
      thumbnail_pos_x: course.thumbnail_pos_x,
      thumbnail_pos_y: course.thumbnail_pos_y,
    });
    seen.add(a.course_id);
  }

  for (const a of mine) pushCard(a, "user");
  for (const a of mineTeams) pushCard(a, "team");
  for (const a of orgWide) pushCard(a, "org");
  // Include path-only courses (no direct course assignment).
  for (const [cid, pathName] of pathNameByCourseId) {
    if (seen.has(cid)) continue;
    const course = courseById.get(cid);
    if (!course) continue;
    let status = attemptStatusForCourse(cid);
    const releaseAt = effectiveReleaseFor(cid);
    if (releaseAt && status !== "completed" && status !== "passed") {
      status = "upcoming";
    }
    cards.push({
      course_id: course.id,
      title: course.title,
      description: course.description,
      source: "user",
      status,
      releaseAt,
      isRevised: false,
      dueAt: null,
      bestScore: bestScoreForCourse(cid),
      pathName,
      thumbnail_url: course.thumbnail_url,
      thumbnail_fit: course.thumbnail_fit,
      thumbnail_pos_x: course.thumbnail_pos_x,
      thumbnail_pos_y: course.thumbnail_pos_y,
    });
    seen.add(cid);
  }

  // 11) Learning paths join the course grid as labeled tiles (one card per
  // path) instead of rendering as a separate section above it. They filter
  // and count with everything else.
  const pathCards: GridCard[] = paths.map((p) => {
    const total = p.steps.length;
    const done = p.steps.filter((s) => s.state === "completed").length;
    const started =
      done > 0 ||
      attempts.some(
        (a) =>
          a.learning_path_id === p.id && a.completion_status !== "completed"
      );
    return {
      course_id: p.id,
      kind: "path" as const,
      title: p.name,
      description: p.description,
      source: "user" as const,
      status:
        total > 0 && done >= total
          ? ("completed" as const)
          : started
            ? ("in_progress" as const)
            : ("not_started" as const),
      isRevised: false,
      dueAt: p.dueAt,
      bestScore: null,
      progressDone: done,
      progressTotal: total,
      thumbnail_url: p.thumbnail_url,
    };
  });

  const lockedTitle = sp.locked
    ? courseById.get(sp.locked)?.title ?? null
    : null;
  const upcomingTitle = sp.upcoming
    ? courseById.get(sp.upcoming)?.title ?? null
    : null;
  const upcomingReleaseAt = sp.upcoming ? effectiveReleaseFor(sp.upcoming) : null;

  return (
    <div className="space-y-8">
      <AnnouncementsBanner
        announcements={announcements}
        orgSlug={orgSlug}
      />

      {/* Welcome header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            Welcome back{displayName ? `, ${displayName}` : ""}.
          </h1>
          <p className="text-muted mt-1 text-sm">{welcomeMessage}</p>
        </div>
      </header>

      {/* Flash banners */}
      {sp.denied && <DeniedBanner denied={sp.denied} />}
      {sp.locked && (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            <strong>Locked.</strong>{" "}
            {lockedTitle
              ? `"${lockedTitle}" is part of a learning path. Finish the earlier steps first.`
              : "That course is part of a learning path. Finish the earlier steps first."}
          </span>
        </div>
      )}
      {sp.upcoming && (
        <div className="border border-sky-200 bg-sky-50 text-sky-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <Clock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            <strong>Coming soon.</strong>{" "}
            {upcomingTitle ? `"${upcomingTitle}"` : "That course"} hasn&apos;t
            been released yet
            {upcomingReleaseAt ? (
              <>
                {" "}
                — it unlocks <LocalDateTime iso={upcomingReleaseAt} />
              </>
            ) : null}
            .
          </span>
        </div>
      )}

      {/* 48-hour urgent callout */}
      {dueSoon.length > 0 && (
        <div
          className={`rounded-2xl p-4 sm:p-5 shadow-sm border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            dueSoon.some((d) => d.overdue)
              ? "border-red-200 bg-red-50"
              : "border-amber-200 bg-amber-50"
          }`}
        >
          <div className="flex items-start sm:items-center gap-3">
            <div
              className={`p-2 rounded-full ${
                dueSoon.some((d) => d.overdue)
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3
                className={`font-bold ${
                  dueSoon.some((d) => d.overdue)
                    ? "text-red-900"
                    : "text-amber-900"
                }`}
              >
                {dueSoon.some((d) => d.overdue)
                  ? "Urgent: Course Overdue"
                  : "Urgent: Course Expiring Soon"}
              </h3>
              <p
                className={`text-sm mt-0.5 ${
                  dueSoon.some((d) => d.overdue)
                    ? "text-red-700"
                    : "text-amber-700"
                }`}
              >
                {dueSoon.length === 1 ? (
                  <>
                    &ldquo;<strong>{dueSoon[0].courseTitle}</strong>&rdquo;
                    {dueSoon[0].overdue ? (
                      <>
                        {" "}is{" "}
                        <strong>
                          {Math.abs(dueSoon[0].hoursLeft) >= 24
                            ? Math.ceil(Math.abs(dueSoon[0].hoursLeft) / 24) +
                              " days"
                            : Math.abs(dueSoon[0].hoursLeft) + " hours"}
                        </strong>{" "}
                        overdue.
                      </>
                    ) : (
                      <>
                        {" "}is due in{" "}
                        <strong>
                          {dueSoon[0].hoursLeft <= 0
                            ? "less than an hour"
                            : `${dueSoon[0].hoursLeft} hours`}
                        </strong>
                        .
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <strong>{dueSoon.length} courses</strong> need your
                    attention in the next 48 hours.
                  </>
                )}
              </p>
            </div>
          </div>
          <Link
            href={`/${orgSlug}/courses/${dueSoon[0].courseId}/launch`}
            className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-sm transition shadow-sm whitespace-nowrap ${
              dueSoon.some((d) => d.overdue)
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-amber-600 hover:bg-amber-700 text-white"
            }`}
          >
            <PlayCircle className="w-4 h-4" />
            Start Course Now
          </Link>
        </div>
      )}

      {/* Yoddha journey banner — mandatory onboarding outranks gamification. */}
      {journey && <JourneyBanner orgSlug={orgSlug} journey={journey} />}

      {/* Personal gamification strip (rank / XP / level / streak / avg score).
          Sits below the urgency callout — deadlines outrank gamification. */}
      <MotivationStrip orgSlug={orgSlug} data={myGamification} avgScore={avgScore} />

      {/* Clickable status chips + filterable grid (paths render as labeled
          tiles ahead of the course cards; the chips filter both). */}
      <DashboardGrid cards={[...pathCards, ...cards]} orgSlug={orgSlug} />
    </div>
  );
}

/* -------- subcomponents -------- */

function JourneyBanner({
  orgSlug,
  journey,
}: {
  orgSlug: string;
  journey: {
    id: string;
    day: number;
    total: number;
    name: string;
    icon: string;
    line: string;
  };
}) {
  return (
    <Link
      href={`/${orgSlug}/journey`}
      className="block rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-5 py-4 shadow-sm hover:from-indigo-700 hover:to-violet-700 transition-colors"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] font-bold opacity-80">
            {journey.icon} {journey.name}
          </p>
          <p className="text-lg font-semibold mt-0.5">
            Day {journey.day} of {journey.total} — {journey.line}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 bg-white/15 rounded-lg px-4 py-2 text-sm font-semibold">
          Continue journey →
        </span>
      </div>
      <div className="mt-3 h-1.5 bg-white/20 rounded-full overflow-hidden">
        <div
          className="h-full bg-white rounded-full"
          style={{ width: `${Math.round(((journey.day - 1) / journey.total) * 100)}%` }}
        />
      </div>
    </Link>
  );
}

function EmptyDashboard({
  orgName,
  role,
  displayName,
}: {
  orgName: string;
  role: OrgRole;
  displayName: string;
}) {
  const canUpload = role === "super_owner" || role === "admin";
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
        Welcome to {orgName}{displayName ? `, ${displayName}` : ""}.
      </h1>
      <p className="text-muted mt-1 text-sm mb-8">
        Nothing&apos;s been assigned to you yet.
      </p>
      <div className="border border-line rounded-2xl bg-paper p-8">
        <BookOpen className="w-8 h-8 text-muted mb-4" />
        <h2 className="text-xl font-semibold mb-2">Nothing here yet</h2>
        <p className="text-muted text-sm leading-relaxed max-w-xl">
          {canUpload
            ? "Upload a course in the admin Library, then assign it to specific learners, teams, or everyone in the org. Once assigned, courses appear on your learner dashboard."
            : "Ask an admin to assign you a course. Once they do, it will show up here automatically."}
        </p>
      </div>
    </div>
  );
}

/**
 * Flash banner for entitlement bounces. `denied=course|path` come from the
 * access gates on those pages (including QR-code deep links); any other value
 * keeps the historical generic copy. Rendered on both the populated grid and
 * the empty dashboard.
 */
function DeniedBanner({
  denied,
  className = "",
}: {
  denied: string;
  className?: string;
}) {
  return (
    <div
      className={`border border-red-200 bg-red-50 text-red-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2 ${className}`}
    >
      <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
      <span>
        {denied === "course" ? (
          <>
            <strong>Not assigned.</strong> This course is not assigned to you — please
            contact your admin.
          </>
        ) : denied === "path" ? (
          <>
            <strong>Not assigned.</strong> This learning path is not assigned to you —
            please contact your admin.
          </>
        ) : (
          <>
            <strong>Access denied.</strong> You don&apos;t have permission to view that page.
          </>
        )}
      </span>
    </div>
  );
}
