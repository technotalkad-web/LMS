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
import { JourneyIcon } from "@/components/ui/journey-icon";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { everyonePathStart } from "@/lib/auth/course-access";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveUserGroupIds } from "@/lib/org/groups";
import {
  AnnouncementsBanner,
  type Announcement,
} from "../_components/announcements-banner";
import { DashboardGrid, type GridCard } from "./dashboard-grid";
import {
  MotivationStrip,
  type MyGamification,
} from "./_components/motivation-strip";
import {
  DEFAULT_WELCOME_MESSAGE,
  effectiveScoreLabel,
} from "@/lib/gamification/board-copy";
import {
  computeJourneyState,
  courseDaysOf,
  creditedDaysFor,
  effectiveJourneyCopy,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";
import { readJourneyCredits } from "@/lib/journey/credits-read";
import { DashboardBackground } from "@/components/dashboard/dashboard-background";
import {
  normalizeBackground,
  pickActiveBackground,
  type DashboardBackground as DashboardBackgroundRow,
} from "@/lib/theme/dashboard-background";
import {
  DEFAULT_POLICY,
  computeScoring,
  courseStatus,
  hasLiveGrantedRetake,
  isRevisionAttempt,
  officialDone,
} from "@/lib/scoring/policy";
import { resolvePolicies } from "@/lib/scoring/resolve";
import { fetchPassRequired, readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import { pathDisplay, pathProgress, resolvedStepRule, type PathDisplayState } from "@/lib/paths/progress";
import {
  NO_PATH_TERMS,
  pathAttemptsOf,
  readGrantRows,
  readPathCompletions,
  readPathStepFacts,
  readPathTerms,
  retakeIdsByCourse,
} from "@/lib/paths/facts-read";

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
  manifest_type: "scorm12" | "cmi5" | "xapi";
};

type Assignment = {
  id: string;
  course_id: string;
  assignee_type: "user" | "org" | "team" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
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
  /** 0075 — undefined before the migration. */
  progress_pct?: number | null;
  /** ADR 0004 step 11: an abandoned (reset) attempt is never in progress. */
  status?: string | null;
  /** 0103 (ADR 0014): a revision visit's row; undefined before the migration (= false). */
  is_revision?: boolean | null;
};

/** A shown step of a path (pathDisplay; the owner's P2-Q1 answer): a step whose course is inactive is not one. */
type PathStepView = {
  course_id: string;
  title: string;
  step_number: number;
  /** Null when the path's progress could not be read (the tile is left out then). */
  state: PathDisplayState | null;
  done: boolean | null;
  releaseAt: string | null;
};

/** The tile's numbers, from pathProgress() and pathDisplay(); null when a read failed. */
type PathTile = {
  done: number;
  total: number;
  /** The stored completion only (P2-Q1), never the shown count. */
  completed: boolean;
  started: boolean;
  /** v_path_enrollment_terms' due date (decision A9); none without 0107. */
  dueAt: string | null;
};

type PathSummary = {
  id: string;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  steps: PathStepView[];
  tile: PathTile | null;
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

  // The organisation's gamification_settings row, read once: 0.15's journey
  // day maths takes its timezone and 0.2 its welcome line. select("*") on
  // purpose (house rule): naming per-migration columns here (0057
  // welcome_message, 0066 score_label) would error the whole query on a
  // database that hasn't run that migration yet.
  const { data: gsw } = await supabase
    .from("gamification_settings")
    .select("*")
    .eq("organization_id", org.id)
    .maybeSingle();

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
  // Focused dashboard (0064): while any RUNNING mandatory journey has focus
  // enabled, the course grid leads with the journey + pinned courses and
  // collapses the rest (collapse, never hide — deadlines stay reachable).
  let focusActive = false;
  const focusPinnedIds = new Set<string>();
  {
    const { data: jRows } = await supabase
      .from("journey_enrollments")
      .select(
        // name/icon live from the PROGRAM (cosmetic renames reach everyone
        // instantly); days_total pinned to the enrollment's version. `*` on
        // the program keeps this deploy-safe across program-column
        // migrations (0063's priority etc. arrive as undefined before it).
        "id, version_id, start_date, journey_versions!inner(days_total, days, count_sundays, unlock_mode), journey_programs!inner(*)"
      )
      .eq("organization_id", org.id)
      .eq("user_id", user.id)
      .eq("status", "active")
      .limit(10);
    type JProg = {
      is_active?: boolean;
      copy?: unknown;
      name?: string;
      icon?: string;
      priority?: number;
      is_mandatory?: boolean;
      focus_enabled?: boolean;
      focus_pinned?: unknown;
    };
    type JVer = { days_total: number; days: unknown; count_sundays: boolean; unlock_mode?: string | null };
    type JRow = {
      id: string;
      version_id: string;
      start_date: string;
      journey_versions: JVer | JVer[];
      journey_programs: JProg | JProg[];
    };
    // Highest-priority RUNNING journey (rank 1 first) leads the banner when
    // the learner holds several (multi-journey, 0063).
    const jCandidates = ((jRows ?? []) as JRow[])
      .map((row) => ({
        row,
        prog: (Array.isArray(row.journey_programs)
          ? row.journey_programs[0]
          : row.journey_programs) as JProg,
      }))
      .filter((c) => c.prog?.is_active !== false)
      .sort((a, b) => (a.prog.priority ?? 100) - (b.prog.priority ?? 100));
    const j = jCandidates[0]?.row;
    const jProg = jCandidates[0]?.prog;
    for (const c of jCandidates) {
      if (c.prog.focus_enabled === true && c.prog.is_mandatory !== false) {
        focusActive = true;
        if (Array.isArray(c.prog.focus_pinned)) {
          for (const id of c.prog.focus_pinned) {
            if (typeof id === "string") focusPinnedIds.add(id);
          }
        }
      }
    }
    // Deactivated journey (admin Settings → Active off) is hidden from
    // learners entirely — no banner, no nav (layout applies the same rule).
    if (j && jProg?.is_active !== false) {
      const ver = Array.isArray(j.journey_versions)
        ? j.journey_versions[0]
        : j.journey_versions;
      const jc = effectiveJourneyCopy(jProg?.copy);
      // The banner's day is the twin's open day (ADR 0024 step 45), the day
      // the journey page shows, read from the credits by day id; never the
      // row count plus one. A failed read hides the banner rather than show
      // a day on a guess.
      const credits = ver ? await readJourneyCredits(supabase, [{ id: j.id, version_id: j.version_id }]) : null;
      if (credits && !credits.ok) {
        console.warn(JSON.stringify({ event: "journey_credits_unreadable", where: "dashboard", code: credits.error?.code ?? null }));
      }
      if (ver && credits?.ok) {
        const tz = (gsw as { timezone?: string | null } | null)?.timezone || DEFAULT_JOURNEY_TZ;
        const state = computeJourneyState({
          startDate: j.start_date,
          today: todayStr(tz),
          creditedDays: creditedDaysFor(
            { days: ver.days, days_total: ver.days_total, day_ids: credits.dayIdsOf(j.version_id) },
            credits.rowsOf(j.id)
          ),
          daysTotal: ver.days_total,
          countSundays: ver.count_sundays === true,
          unlockMode: ver.unlock_mode === "progress" ? "progress" : "calendar",
          courseDays: courseDaysOf(ver.days, ver.days_total),
        });
        journey = {
          id: j.id,
          day: state.currentDay,
          total: ver.days_total,
          name: jProg?.name ?? "90-Day Yoddha Journey",
          icon: jProg?.icon ?? "🏹",
          line: jc.banner_line,
        };
      }
    }
  }

  // 0.2) Org-editable welcome line (migration 0057; members can read their
  // org's gamification_settings under RLS). Fail-soft to the default — a
  // pre-0057 database errors this select and we just keep the default.
  // (The settings row itself is read once, before 0.15.)
  let welcomeMessage = DEFAULT_WELCOME_MESSAGE;
  const gswRow = gsw as {
    welcome_message?: string | null;
    score_label?: string | null;
    score_description?: string | null;
  } | null;
  const customWelcome = gswRow?.welcome_message;
  if (typeof customWelcome === "string" && customWelcome.trim()) {
    welcomeMessage = customWelcome.trim();
  }
  const score = effectiveScoreLabel(gswRow);

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
    // Popups (0068) render as the full-screen overlay, never as a banner.
    .eq("kind", "standard")
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(5);
  const announcements = (annRows ?? []) as Announcement[];

  // 1) Course assignments. select("*") for 0069 deploy safety (group_id).
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select("*")
    .eq("organization_id", org.id);
  const assignments = (assignmentRows ?? []) as Assignment[];

  // Custom Group assignments (0069): which groups am I in, resolved LIVE —
  // joining a group grants learning instantly, leaving revokes it. Only
  // computed when a group assignment actually exists.
  let myGroupIds = new Set<string>();
  if (assignments.some((a) => a.assignee_type === "group")) {
    try {
      const svcGrp = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      );
      myGroupIds = await resolveUserGroupIds(svcGrp, org.id, user.id);
    } catch {
      /* pre-0067 or resolver issue — group assignments just don't match */
    }
  }

  const mine = assignments.filter(
    (a) => a.assignee_type === "user" && a.user_id === user.id
  );
  const mineTeams = assignments.filter(
    (a) =>
      a.assignee_type === "team" &&
      a.team_id &&
      myTeamIds.includes(a.team_id)
  );
  const mineGroups = assignments.filter(
    (a) => a.assignee_type === "group" && a.group_id && myGroupIds.has(a.group_id)
  );
  const orgWide = assignments.filter((a) => a.assignee_type === "org");

  const directCourseIds = Array.from(
    new Set([...mine, ...mineTeams, ...mineGroups, ...orgWide].map((a) => a.course_id))
  );

  // 2) Learning path assignments. select("*") for 0069 deploy safety.
  const { data: pathAssignRows } = await supabase
    .from("learning_path_assignments")
    .select("*")
    .eq("organization_id", org.id);
  const allPathAssigns = (pathAssignRows ?? []) as Array<{
    id: string;
    path_id: string;
    due_at: string | null;
    assignee_type: "user" | "org" | "team" | "group";
    user_id: string | null;
    team_id: string | null;
    group_id?: string | null;
  }>;
  if (myGroupIds.size === 0 && allPathAssigns.some((a) => a.assignee_type === "group")) {
    try {
      const svcGrp = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      );
      myGroupIds = await resolveUserGroupIds(svcGrp, org.id, user.id);
    } catch {
      /* group path assignments just don't match */
    }
  }
  const myPathAssigns = allPathAssigns.filter(
    (a) =>
      (a.assignee_type === "user" && a.user_id === user.id) ||
      a.assignee_type === "org" ||
      (a.assignee_type === "team" &&
        a.team_id &&
        myTeamIds.includes(a.team_id)) ||
      (a.assignee_type === "group" && a.group_id && myGroupIds.has(a.group_id))
  );

  const prec: Record<"user" | "team" | "org" | "group", number> = {
    user: 3,
    group: 2,
    team: 2,
    org: 1,
  };
  const pathSrcRank = new Map<string, number>();
  for (const a of myPathAssigns) {
    const rank = prec[a.assignee_type];
    if ((pathSrcRank.get(a.path_id) ?? 0) < rank) {
      pathSrcRank.set(a.path_id, rank);
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
    }
  }
  // Kept apart for the path-only cards' Start (10 below): the paths the
  // learner has an assignment row on, and the "Everyone" paths. After the
  // fold above pathSrcRank no longer tells them apart.
  const assignedPathIds = new Set(myPathAssigns.map((a) => a.path_id));
  const everyonePathIds = new Set(((orgPublicPathRows ?? []) as Array<{ id: string }>).map((r) => r.id));

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

  // Every step, an inactive course's included (the path rule counts it and
  // pathDisplay leaves it out), with the course's activity and rule and the
  // step's own rule (a 0107 column: the narrower-select fallback reads the
  // steps without it on a database that lacks it, and the course's rule
  // decides).
  const { data: stepRows, error: stepsErr } = myPathIds.length
    ? await readWithOptionalColumn<unknown[]>(
        "pass_required",
        (columns) =>
          supabase
            .from("learning_path_courses")
            .select(columns)
            .in("path_id", myPathIds)
            .order("step_number", { ascending: true }),
        "path_id, course_id, step_number, release_at, courses!inner(title, is_active, pass_required)"
      )
    : { data: [], error: null };
  type StepCourse = { title: string; is_active: boolean | null; pass_required: boolean | null };
  type StepRaw = {
    path_id: string;
    course_id: string;
    step_number: number;
    release_at: string | null;
    pass_required?: boolean | null;
    courses: StepCourse | StepCourse[];
  };
  const allPathSteps = ((stepRows ?? []) as StepRaw[]).map((s) => {
    const c = Array.isArray(s.courses) ? s.courses[0] : s.courses;
    return {
      path_id: s.path_id,
      course_id: s.course_id,
      step_number: s.step_number,
      release_at: s.release_at,
      title: c?.title ?? "Untitled",
      isActive: c?.is_active === true,
      passRequired: resolvedStepRule(s.pass_required, c?.pass_required),
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
  // Dashboard background theme (0074) — the enabled, in-window theme
  // updated most recently. Fail-soft: pre-migration or any error = none.
  let dashboardBackground: DashboardBackgroundRow | null = null;
  try {
    const { data: bgRows } = await supabase
      .from("dashboard_backgrounds")
      .select("*")
      .eq("organization_id", org.id)
      .eq("is_enabled", true);
    dashboardBackground = pickActiveBackground(
      ((bgRows ?? []) as unknown[])
        .map(normalizeBackground)
        .filter((b): b is DashboardBackgroundRow => !!b),
      Date.now()
    );
  } catch {
    dashboardBackground = null;
  }
  const backgroundLayer = dashboardBackground ? (
    <DashboardBackground
      url={dashboardBackground.asset_url}
      kind={dashboardBackground.asset_kind}
      fit={dashboardBackground.fit}
      opacity={dashboardBackground.opacity}
    />
  ) : null;

  if (allCourseIds.length === 0) {
    return (
      <div data-dashboard-root="" className="relative isolate">
        {backgroundLayer}
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
  const { data: versionRows, error: versionsErr } = await supabase
    .from("course_versions")
    .select("id, course_id, version_number, manifest_type")
    .in("course_id", allCourseIds);
  const versions = (versionRows ?? []) as Version[];
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // 7) Attempts.
  const versionIds = versions.map((v) => v.id);
  const { data: attemptRows, error: attemptsErr } = versionIds.length
    ? await supabase
        .from("course_attempts")
        // select("*") for 0075 deploy safety (progress_pct), and, for the
        // path tiles, 0107's context_kind where it exists (pathAttemptsOf).
        .select("*")
        .eq("user_id", user.id)
        .in("course_version_id", versionIds)
    : { data: [] as Attempt[], error: null };
  const attempts = (attemptRows ?? []) as Attempt[];
  // 0073 scoring rules per course (one RPC; fail-soft → defaults).
  const policies = await resolvePolicies(supabase, [
    ...new Set(versions.map((v) => v.course_id)),
  ]);

  // 8) Completed course set (GLOBAL; used for standalone course tiles +
  // deadlines). 0081 revision rule: only OFFICIAL attempts (inside the
  // scoring window) complete anything; revision runs never do. A failed
  // official attempt still counts as learning completed unless the module
  // is "pass required".
  const passRequired = await fetchPassRequired(supabase, [...new Set(versions.map((v) => v.course_id))]);
  // Consumed extra-attempt grants (Phase 2) widen a learner's official window
  // so a granted retake is scored and becomes official on every surface. One
  // read of the learner's approved grants on these courses, as rows: the
  // path tiles take the rows (pathProgress, strict: a failed read leaves the
  // tiles out), the course cards their consumed ids, empty on a failed read
  // as before (fetchGrantRetakeIds's reading).
  const grantsRead = await readGrantRows(supabase, user.id, [...new Set(versions.map((v) => v.course_id))]);
  const extraByCourse = grantsRead.ok ? retakeIdsByCourse(grantsRead.grants) : new Map<string, Set<string>>();
  // Completion follows the OFFICIAL attempt (officialDone), exactly as the CRM
  // feeds do — NOT "any attempt in the window", which diverged for a legacy
  // window >= 2 where the official (first) attempt failed but a later scored
  // attempt passed. The official attempt is the one officialDone judges.
  const completedCourseIds = new Set<string>();
  {
    const byCourse = new Map<string, typeof attempts>();
    for (const a of attempts) {
      const v = versionById.get(a.course_version_id);
      if (!v) continue;
      byCourse.set(v.course_id, [...(byCourse.get(v.course_id) ?? []), a]);
    }
    for (const [cid, list] of byCourse) {
      const s = computeScoring(list, policies.get(cid) ?? DEFAULT_POLICY, extraByCourse.get(cid) ?? []);
      if (officialDone(s, passRequired.has(cid))) completedCourseIds.add(cid);
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
  // Avg of OFFICIAL scores per completed course (0073 scoring rules —
  // practice attempts excluded), from the attempts already fetched.
  const completedScores = [...completedCourseIds]
    .map((cid) => officialScoreForCourse(cid))
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
  for (const a of [...mine, ...mineTeams, ...mineGroups, ...orgWide]) {
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

  // 9) Path summaries (ADR 0024 P2-7): each path through the path rule,
  // pathProgress() over the learner's path rows (the attempts above, by
  // context; pathAttemptsOf), the grant rows, the stored step facts (one
  // read for every path, O1-i), the stored completion and the enrolment
  // terms (read with a service client after requireOrgAccess, naming the
  // organisation and the learner: ruling (a), so a Custom Group's terms
  // are seen), then pathDisplay() (the owner's P2-Q1 answer and O5-d): a
  // step whose course is inactive is left out, and a path with no shown step
  // is left off the dashboard. When any of those reads fails the path keeps
  // its shown steps (the course cards and the path-only cards need them) but
  // no state, and its tile is left out rather than shown on a guess, as the
  // journey banner is on a failed credits read.
  const pathIds = pathsList.map((p) => p.id);
  const svcPaths = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const [factsRead, completionsRead, termsRead] = await Promise.all([
    readPathStepFacts(supabase, user.id, pathIds),
    readPathCompletions(supabase, user.id, pathIds),
    readPathTerms(svcPaths, org.id, user.id, pathIds),
  ]);
  const pathInputs =
    !stepsErr && !versionsErr && !attemptsErr && grantsRead.ok && factsRead.ok && completionsRead.ok && termsRead.ok
      ? {
          rows: pathAttemptsOf(attempts as unknown as Array<Record<string, unknown>>, new Map(versions.map((v) => [v.id, v.course_id]))),
          grants: grantsRead.grants,
          facts: factsRead.facts,
          completions: completionsRead.byPath,
          terms: termsRead.byPath,
        }
      : null;
  if (pathIds.length > 0 && pathInputs === null) {
    console.warn(JSON.stringify({ event: "path_progress_unreadable", where: "dashboard", user_id: user.id }));
  }
  const nowIso = new Date(nowMs).toISOString();
  const paths: PathSummary[] = pathsList
    .map((p) => {
      const steps = allPathSteps.filter((s) => s.path_id === p.id);
      const titleOf = new Map(steps.map((s) => [s.course_id.toLowerCase(), s.title]));
      if (pathInputs === null) {
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          thumbnail_url: p.thumbnail_url,
          steps: steps
            .filter((s) => s.isActive)
            .map((s) => ({ course_id: s.course_id, title: s.title, step_number: s.step_number, state: null, done: null, releaseAt: s.release_at })),
          tile: null,
        };
      }
      const key = p.id.toLowerCase();
      const progress = pathProgress({
        pathId: p.id,
        steps: steps.map((s) => ({ course_id: s.course_id, step_number: s.step_number, release_at: s.release_at, pass_required: s.passRequired })),
        attempts: pathInputs.rows,
        grants: pathInputs.grants,
        facts: pathInputs.facts,
        completion: pathInputs.completions.get(key) ?? null,
        terms: pathInputs.terms.get(key) ?? NO_PATH_TERMS,
        now: nowIso,
      });
      const display = pathDisplay(progress, steps.filter((s) => s.isActive).map((s) => s.course_id), p.sequence_mode);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        thumbnail_url: p.thumbnail_url,
        steps: display.steps.map((d) => ({
          course_id: d.course_id,
          title: titleOf.get(d.course_id.toLowerCase()) ?? "Untitled",
          step_number: d.step_number,
          state: d.state,
          done: d.done,
          releaseAt: d.release_at,
        })),
        tile: {
          done: display.done,
          total: display.total,
          completed: progress.completed,
          started: progress.status !== "not_started",
          dueAt: progress.due_at,
        },
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
  for (const a of [...mine, ...mineTeams, ...mineGroups, ...orgWide]) {
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
    // 0081 revision rule: the card follows the OFFICIAL attempt only. Sticky:
    // once the official attempt is complete the card never drags back to
    // "in progress" when a revision run opens, and a revision pass never
    // turns a failed module green.
    return courseStatus(scoringForCourse(courseId).scoring, courseAttempts);
  }

  // Official score under the course's scoring rule (0073). The card prop is
  // still called bestScore; practice attempts never feed it.
  function officialScoreForCourse(courseId: string): number | null {
    return scoringForCourse(courseId).scoring.officialScore;
  }

  // Scoring state for the card: how many scored attempts remain, and whether
  // further launches are review-only revision visits. ADR 0014 retired the
  // window and the block rule (step 9) and the card's revision line (step
  // 7). While a granted retake runs the card reads "in progress" through
  // courseStatus (step 10), so it must not also say "revision only"
  // (practiceMode false); the retake's open progress_pct then makes the
  // label "Resume".
  function scoringForCourse(courseId: string) {
    const my = attempts.filter((a) => {
      const v = versionById.get(a.course_version_id);
      return v?.course_id === courseId;
    });
    const policy = policies.get(courseId) ?? DEFAULT_POLICY;
    const scoring = computeScoring(my, policy, extraByCourse.get(courseId) ?? []);
    return {
      scoring,
      scoredLeft: Math.max(0, policy.max_scored_attempts + scoring.extraAttempts - scoring.scoredAttempts),
      practiceMode: scoring.practiceMode && !hasLiveGrantedRetake(my, scoring.retakeIds),
    };
  }

  // Progress of the learner's most recent open attempt (0075); null when
  // the package gives no progress signal. A revision visit's row never
  // supplies it (ADR 0014 step 12: the "latest in-progress row" pick).
  function progressForCourse(courseId: string): number | null {
    const open = attempts
      .filter((a) => {
        const v = versionById.get(a.course_version_id);
        return (
          v?.course_id === courseId &&
          a.completion_status === "in_progress" &&
          a.status !== "abandoned" &&
          !isRevisionAttempt(a)
        );
      })
      .sort((x, y) => (x.started_at < y.started_at ? 1 : -1))[0];
    return typeof open?.progress_pct === "number" ? open.progress_pct : null;
  }

  function attemptsLeftProps(courseId: string) {
    const s = scoringForCourse(courseId);
    return {
      scoredLeft: s.scoredLeft,
      practiceMode: s.practiceMode,
    };
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
      bestScore: officialScoreForCourse(course.id),
      ...attemptsLeftProps(course.id),
      progressPct: progressForCourse(course.id),
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
  // Group assignments render like team assignments (a group IS the audience).
  for (const a of mineGroups) pushCard(a, "team");
  for (const a of orgWide) pushCard(a, "org");
  // Include path-only courses (no direct course assignment).
  const sequenceModeByPath = new Map(pathsList.map((p) => [p.id, p.sequence_mode]));
  for (const [cid, pathName] of pathNameByCourseId) {
    if (seen.has(cid)) continue;
    const course = courseById.get(cid);
    if (!course) continue;
    let status = attemptStatusForCourse(cid);
    const releaseAt = effectiveReleaseFor(cid);
    if (releaseAt && status !== "completed" && status !== "passed") {
      status = "upcoming";
    }
    // A course the learner reaches only through an "Everyone" path with no
    // row of theirs: its Start carries that path's ?lp= (ADR 0024 ruling A3
    // enrols them at the launch; a plain Start is refused not_enrolled), and
    // the badge names the same path. No direct assignment reaches this card
    // (those have theirs above), and `paths` holds active paths only. Of
    // several "Everyone" paths, one whose step can launch now: the step
    // states above (9), the step's position and the path's order rank them
    // (no further read).
    const startPathId = everyonePathStart({
      courseIsEveryone: orgPublicCourseIds.includes(cid),
      directlyHeld: false,
      steps: paths.flatMap((p) =>
        p.steps
          .filter((s) => s.course_id === cid)
          .map((s) => ({
            pathId: p.id,
            everyone: everyonePathIds.has(p.id),
            enrolled: assignedPathIds.has(p.id),
            releaseAt: s.releaseAt,
            position: s.step_number,
            sequenceMode: sequenceModeByPath.get(p.id) ?? null,
            state: s.state,
          }))
      ),
      now: nowMs,
    });
    const startPathName = startPathId ? paths.find((p) => p.id === startPathId)?.name : undefined;
    cards.push({
      course_id: course.id,
      title: course.title,
      description: course.description,
      source: "user",
      status,
      releaseAt,
      isRevised: false,
      dueAt: null,
      bestScore: officialScoreForCourse(cid),
      ...attemptsLeftProps(cid),
      pathName: startPathName ?? pathName,
      startPathId,
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
  // The tile: "done of total" over the shown steps, "completed" from the
  // stored completion only (P2-Q1: a learner who finished every shown step
  // of a path with a hidden step reads "In progress"), started when the path
  // rule reads anything but not started (an open revision visit's row never
  // starts a path: pathProgress reads the official rows, ADR 0014 steps 6
  // and 12). It shows no step's state, so it calls no pathStepLabel (O4).
  const pathCards: GridCard[] = paths.flatMap((p) => {
    const t = p.tile;
    if (t === null) return [];
    return [{
      course_id: p.id,
      kind: "path" as const,
      title: p.name,
      description: p.description,
      source: "user" as const,
      status: t.completed
        ? ("completed" as const)
        : t.started
          ? ("in_progress" as const)
          : ("not_started" as const),
      isRevised: false,
      dueAt: t.dueAt,
      bestScore: null,
      progressDone: t.done,
      progressTotal: t.total,
      thumbnail_url: p.thumbnail_url,
    }];
  });
  // The ?locked= notice (P2-Q1): "Finish the earlier steps first." only when,
  // in some path of the learner that holds the course, a shown earlier step
  // is not done; otherwise (the only step in the way is hidden, or the
  // paths' progress could not be read) a line that names nothing.
  const lockedByShownStep = sp.locked
    ? paths.some((p) => {
        const at = p.steps.findIndex((s) => s.course_id.toLowerCase() === sp.locked!.toLowerCase());
        return at > 0 && p.steps.slice(0, at).some((s) => s.done === false);
      })
    : false;

  const lockedTitle = sp.locked
    ? courseById.get(sp.locked)?.title ?? null
    : null;
  const upcomingTitle = sp.upcoming
    ? courseById.get(sp.upcoming)?.title ?? null
    : null;
  const upcomingReleaseAt = sp.upcoming ? effectiveReleaseFor(sp.upcoming) : null;

  return (
    <div data-dashboard-root="" className="relative isolate space-y-8">
      {backgroundLayer}
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
            {!lockedByShownStep
              ? "That course is not open yet."
              : lockedTitle
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
            href={`/${orgSlug}/courses/${dueSoon[0].courseId}/launch?back=dashboard`}
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
      <MotivationStrip
        orgSlug={orgSlug}
        data={myGamification}
        avgScore={avgScore}
        scoreLabel={score.label}
        scoreDescription={score.description}
      />

      {/* Clickable status chips + filterable grid (paths render as labeled
          tiles ahead of the course cards; the chips filter both). While a
          mandatory focus journey runs (0064), pinned courses stay up front
          and everything else collapses into a closed disclosure — the
          journey banner above is the learner's real to-do. */}
      {focusActive ? (
        (() => {
          const allCards = [...pathCards, ...cards];
          const pinned = allCards.filter(
            (c) => (c.kind ?? "course") === "course" && focusPinnedIds.has(c.course_id)
          );
          const rest = allCards.filter((c) => !pinned.includes(c));
          return (
            <>
              <p className="text-xs text-muted">
                🎯 Focus mode — your journey above comes first
                {pinned.length > 0 ? ", along with these:" : "."}
              </p>
              {pinned.length > 0 && (
                <DashboardGrid cards={pinned} orgSlug={orgSlug} />
              )}
              {rest.length > 0 && (
                <details className="bg-paper border border-line rounded-2xl">
                  <summary className="px-5 py-3.5 text-sm font-medium cursor-pointer select-none text-muted hover:text-ink">
                    Other assigned learning ({rest.length})
                  </summary>
                  {/* DashboardGrid renders a fragment (chips + card section);
                      it inherits sibling spacing from its container. The main
                      dashboard gets that from the page's space-y-8 — inside
                      this collapsible we must provide it ourselves. */}
                  <div className="px-4 pb-4 pt-2 space-y-6">
                    <DashboardGrid cards={rest} orgSlug={orgSlug} />
                  </div>
                </details>
              )}
            </>
          );
        })()
      ) : (
        <DashboardGrid cards={[...pathCards, ...cards]} orgSlug={orgSlug} />
      )}
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
            <JourneyIcon icon={journey.icon} imgSize="h-4 w-4" /> {journey.name}
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
