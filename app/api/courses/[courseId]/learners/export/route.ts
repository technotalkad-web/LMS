import { NextResponse } from "next/server";
import { fetchReferenceCodes } from "@/lib/reference-codes";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { courseProgress } from "@/lib/courses/progress-view";
import { ENROLMENTS_VIEW, excludeAbandoned, officialStatuses, statusOf, userCourseKey } from "@/lib/scoring/status";
import { isReleased } from "@/lib/learner/release";
import {
  GrantReadError,
  grantSnapshotForUsers,
  readPagedWithOptionalColumn,
  type GrantSnapshot,
  type OptionalColumnState,
  type PgError,
} from "@/lib/scoring/attempt-kind";
import { individualContextOnly, type IndividualFilterState } from "@/lib/scoring/context-read";
import { chunk, fetchByIds } from "@/lib/db/chunked";
import { officialHistory, officialRetakeState, type OfficialRetakeState } from "@/lib/scoring/official-history";
import { fetchRevisionVisitStats } from "@/lib/attempts/revision-visits";
import { resolveEmails } from "@/lib/users/emails";
import { csvEscape } from "@/lib/util/csv";

/**
 * GET /api/courses/{courseId}/learners/export?orgSlug=...
 *
 * Returns a CSV of every enrolled learner for the given course along with
 * their progress (status, best score, attempts, last touched, employee_id,
 * via mechanism). Used by the "Download CSV" button on
 * /[org]/library/[courseId]/learners.
 *
 * Scope: admin-only (canManage), tenant-scoped (course must belong to the
 * org). The route duplicates the enrichment logic in
 * app/[org]/(admin)/library/[courseId]/learners/page.tsx — when a third
 * caller appears, extract to lib/learners/enrich.ts.
 *
 * Rows: exactly the enrolment view's set for the course
 * (v_course_enrollments_expanded, migration 0105, ADR 0020), as the page.
 * "Enrolled via" prints how each learner is reached: the released direct
 * rows (user, team, org, group), else path (a released step of an active
 * Learning Path), joined with "+".
 *
 * Performance: in-memory enrichment of the full enrolled set (same as the
 * page). At 10k learners that's ~1MB payload and sub-100ms compute — fine
 * for an admin export that runs infrequently.
 */

/** How a learner is reached: a released direct row of a kind, else a Learning Path (ADR 0020). */
type ViaKind = "user" | "team" | "org" | "group" | "path";
type Status = "not_started" | "in_progress" | "completed" | "passed" | "failed";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("orgSlug");
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();

  // ---- verify course is in this org ----
  const { data: course } = await supabase
    .from("courses")
    .select("id, title, organization_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const c = course as { id: string; title: string; organization_id: string };

  // ---- versions for attempts join ----
  const { data: versionRows } = await supabase
    .from("course_versions")
    .select("id, unit_count:manifest_data->unitCount")
    .eq("course_id", c.id);
  const versionIds = ((versionRows ?? []) as Array<{ id: string }>).map(
    (v) => v.id
  );
  const unitCountByVersion = new Map(
    ((versionRows ?? []) as Array<{ id: string; unit_count: number | null }>).map((v) => [
      v.id,
      typeof v.unit_count === "number" ? v.unit_count : null,
    ])
  );

  // ---- who's enrolled: the enrolment view (0105, ADR 0020), as the page ----
  // Read with this admin session (security_invoker; Custom Group membership
  // admits admins only), paged over user_id, unique per course.
  const enrolledSet = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(ENROLMENTS_VIEW)
      .select("user_id")
      .eq("course_id", c.id)
      .order("user_id")
      .range(from, from + 999);
    if (error) {
      console.warn("[learners-export] enrolments read failed:", error.message ?? "");
      break;
    }
    const viewRows = (data ?? []) as Array<{ user_id: string }>;
    for (const r of viewRows) enrolledSet.add(r.user_id);
    if (viewRows.length < 1000) break;
  }

  // ---- how each is reached: the released direct rows ----
  // Every direct-row read below is paged at the PostgREST row cap, as the
  // view read is: "path" goes to an enrolled learner no released direct row
  // reaches, so a truncated read would mislabel the learners past the cap.
  const assignmentRows: Array<{
    assignee_type: ViaKind;
    user_id: string | null;
    team_id: string | null;
    group_id: string | null;
    release_at: string | null;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("course_assignments")
      .select("assignee_type, user_id, team_id, group_id, release_at")
      .eq("course_id", c.id)
      .order("id")
      .range(from, from + 999);
    if (error) {
      console.warn("[learners-export] assignments read failed:", error.message ?? "");
      break;
    }
    const assignmentPage = (data ?? []) as typeof assignmentRows;
    assignmentRows.push(...assignmentPage);
    if (assignmentPage.length < 1000) break;
  }
  const assignments = assignmentRows.filter((a) => isReleased(a.release_at));

  // ---- org members (for org-wide assignments + employee_id) ----
  const orgMembers: Array<{ user_id: string; employee_id: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("organization_members")
      .select("user_id, employee_id")
      .eq("organization_id", org.id)
      .order("user_id")
      .range(from, from + 999);
    if (error) {
      console.warn("[learners-export] members read failed:", error.message ?? "");
      break;
    }
    const memberPage = (data ?? []) as typeof orgMembers;
    orgMembers.push(...memberPage);
    if (memberPage.length < 1000) break;
  }
  const employeeIdByUser = new Map<string, string | null>();
  for (const m of orgMembers) employeeIdByUser.set(m.user_id, m.employee_id);

  // ---- team members ----
  const assignedTeamIds = [
    ...new Set(assignments.filter((a) => a.assignee_type === "team" && a.team_id).map((a) => a.team_id as string)),
  ];
  const teamUserIds = new Map<string, Set<string>>();
  for (let i = 0; i < assignedTeamIds.length; i += 150) {
    const part = assignedTeamIds.slice(i, i + 150);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("team_members")
        .select("team_id, user_id")
        .in("team_id", part)
        .order("team_id")
        .order("user_id")
        .range(from, from + 999);
      if (error) {
        console.warn("[learners-export] team members read failed:", error.message ?? "");
        break;
      }
      const teamRows = (data ?? []) as Array<{ team_id: string; user_id: string }>;
      for (const r of teamRows) {
        const s = teamUserIds.get(r.team_id) ?? new Set<string>();
        s.add(r.user_id);
        teamUserIds.set(r.team_id, s);
      }
      if (teamRows.length < 1000) break;
    }
  }

  // ---- Custom Group members (v_group_members_expanded, 0105) ----
  // Before 0105 the relation is missing: the read fails soft and no learner
  // reads "group" (the 0031 view then counts no group learner either).
  const assignedGroupIds = [
    ...new Set(assignments.filter((a) => a.assignee_type === "group" && a.group_id).map((a) => a.group_id as string)),
  ];
  const groupUserIds = new Map<string, Set<string>>();
  for (let i = 0; i < assignedGroupIds.length; i += 150) {
    const part = assignedGroupIds.slice(i, i + 150);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("v_group_members_expanded")
        .select("group_id, user_id")
        .in("group_id", part)
        .order("group_id")
        .order("user_id")
        .range(from, from + 999);
      if (error) {
        console.warn("[learners-export] group members read failed:", error.message ?? "");
        break;
      }
      const groupRows = (data ?? []) as Array<{ group_id: string; user_id: string }>;
      for (const r of groupRows) {
        const s = groupUserIds.get(r.group_id) ?? new Set<string>();
        s.add(r.user_id);
        groupUserIds.set(r.group_id, s);
      }
      if (groupRows.length < 1000) break;
    }
  }

  // ---- viaByUser + enrolledUserIds ----
  // Only the view's set is listed, whatever the direct rows say; a learner no
  // released direct row reaches is enrolled through a Learning Path.
  const viaByUser = new Map<string, Set<ViaKind>>();
  const addVia = (uid: string, v: ViaKind) => {
    if (!enrolledSet.has(uid)) return;
    const s = viaByUser.get(uid) ?? new Set<ViaKind>();
    s.add(v);
    viaByUser.set(uid, s);
  };
  for (const a of assignments) {
    if (a.assignee_type === "user" && a.user_id) addVia(a.user_id, "user");
    else if (a.assignee_type === "team" && a.team_id) {
      for (const uid of teamUserIds.get(a.team_id) ?? []) addVia(uid, "team");
    } else if (a.assignee_type === "org") {
      for (const m of orgMembers) addVia(m.user_id, "org");
    } else if (a.assignee_type === "group" && a.group_id) {
      for (const uid of groupUserIds.get(a.group_id) ?? []) addVia(uid, "group");
    }
  }
  for (const uid of enrolledSet) if (!viaByUser.has(uid)) addVia(uid, "path");
  const enrolledUserIds = Array.from(enrolledSet);

  // ---- emails + profiles via service role ----
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const emailByUser = new Map<string, string>();
  const profileByUser = new Map<
    string,
    { first_name: string | null; last_name: string | null }
  >();
  if (enrolledUserIds.length > 0) {
    let pageNum = 1;
    while (true) {
      const { data: authPage } = await svc.auth.admin.listUsers({
        page: pageNum,
        perPage: 1000,
      });
      const users = authPage?.users ?? [];
      for (const u of users) if (u.email) emailByUser.set(u.id, u.email);
      if (users.length < 1000) break;
      pageNum += 1;
      if (pageNum > 50) break;
    }
    // The house rule (lib/db/chunked.ts): chunks of 150 ids, pages of 1,000
    // in id order. A failed read leaves the name columns empty.
    try {
      const profileRows = await fetchByIds<{
        id: string;
        first_name: string | null;
        last_name: string | null;
      }>(svc, "profiles", "id, first_name, last_name", "id", enrolledUserIds);
      for (const p of profileRows) {
        profileByUser.set(p.id, {
          first_name: p.first_name,
          last_name: p.last_name,
        });
      }
    } catch (e) {
      console.warn("[learners-export] profiles read failed:", e instanceof Error ? e.message : "");
    }
  }

  // ---- attempts ----
  // ADR 0014 step 7: the select names is_revision through the narrower-select
  // fallback, so every count, date and progress below drops revision rows (a
  // database without 0103 has none and reads every row as unflagged).
  // The house rule (lib/db/chunked.ts): the enrolled ids in chunks of 150,
  // each read in pages of 1,000 in id order, through
  // readPagedWithOptionalColumn (fetchByIds cannot tell a missing column from
  // another error). The first page decides the column list for every chunk
  // (one `decided`). A failed page is logged and the rows read so far are
  // kept, as the reads above do. ADR 0024 step 49: the CSV is the
  // Individual product, as the page is, so on a database with 0107 the read
  // takes the Individual context only (individualContextOnly, decided once
  // for every chunk: one `individual`).
  const ATTEMPT_COLUMNS =
    "id, user_id, course_version_id, status, completion_status, success_status, score, started_at, completed_at, progress_pct, units:cmi_data->cmi5->units";
  const attemptRows: unknown[] = [];
  if (enrolledUserIds.length && versionIds.length) {
    const decided: OptionalColumnState = { columns: null };
    const individual: IndividualFilterState = { applies: null };
    for (const part of chunk(enrolledUserIds, 150)) {
      const res = await readPagedWithOptionalColumn<unknown>(
        "is_revision",
        individualContextOnly(individual, (columns, from, to, only): PromiseLike<{ data: unknown[] | null; error: PgError }> => {
          const q = supabase
            .from("course_attempts")
            .select(columns)
            .in("user_id", part)
            .in("course_version_id", versionIds)
            .order("id")
            .range(from, to);
          return only ? q.eq("context_kind", "individual") : q;
        }),
        ATTEMPT_COLUMNS,
        { state: decided }
      );
      if (res.error) console.warn("[learners-export] attempts read failed:", res.error.message ?? "");
      attemptRows.push(...res.data);
    }
  }
  const attempts = attemptRows as Array<{
    id: string;
    user_id: string;
    course_version_id: string;
    progress_pct?: number | null;
    units?: unknown;
    /** ADR 0004 step 11: courseStatus()/courseProgress() leave abandoned attempts out. */
    status: string | null;
    /** ADR 0014 (0103): a revision visit's row is never an attempt. */
    is_revision?: boolean | null;
    completion_status: string;
    success_status: string;
    score: number | null;
    started_at: string;
    completed_at: string | null;
  }>;

  // ---- grant links: one strict bulk read (ADR 0014 step 7, strict reads) ----
  // The CSV carries the official-result chain (Official retake, Previous
  // official …, Granted …), which is wrong, not empty, with the links missing,
  // so a failed read answers 503 and writes no file (ADR 0014:188). A missing
  // relation is "no grants" inside grantSnapshotForUsers.
  let snapshots: Map<string, GrantSnapshot>;
  try {
    snapshots = await grantSnapshotForUsers(svc, org.id, [courseId], enrolledUserIds);
  } catch (e) {
    if (!(e instanceof GrantReadError)) throw e;
    console.warn("[learners-export] grant read failed:", e.code);
    return NextResponse.json({ error: "history_unavailable" }, { status: 503 });
  }
  const noGrants: GrantSnapshot = { retakeIds: new Set<string>(), unusedGrant: null, rows: [] };
  const snapshotOf = (uid: string) => snapshots.get(userCourseKey(uid, courseId)) ?? noGrants;
  const retakeIdsByPair = new Map<string, ReadonlySet<string>>([...snapshots].map(([k, s]) => [k, s.retakeIds]));

  // ---- revision visits (deny-all, service client; ADR 0014 step 7) ----
  // A failed read leaves both visit cells empty; past the page cap the count
  // is a floor, written "N+".
  const visits = await fetchRevisionVisitStats(svc, { orgId: org.id, courseIds: [courseId], userIds: enrolledUserIds });

  // ---- the chain per learner (officialHistory + officialRetakeState), and the deciders' emails ----
  const retakeByUser = new Map<string, OfficialRetakeState>();
  const deciderIds = new Set<string>();
  for (const uid of enrolledUserIds) {
    const history = officialHistory(
      attempts.filter((a) => a.user_id === uid),
      snapshotOf(uid).rows
    );
    const retake = officialRetakeState(history);
    retakeByUser.set(uid, retake);
    if (retake.grant?.decidedBy) deciderIds.add(retake.grant.decidedBy);
  }
  const deciderEmail = deciderIds.size > 0 ? await resolveEmails(svc, deciderIds) : new Map<string, string>();

  // ---- build CSV ----
  const header = [
    "Employee ID",
    "Email",
    "First name",
    "Last name",
    "Status",
    "Progress (%)",
    "Screens completed",
    "Screens total",
    "Official score (%)",
    "Attempts",
    "Last activity (ISO)",
    "Revisits",
    "Last revisit (ISO)",
    "Official retake",
    "Previous official score (%)",
    "Previous official status",
    "Granted by",
    "Granted at (ISO)",
    "Grant reason",
    "Enrolled via",
  ];
  const rows: string[][] = [header];

  // Decision 1 (Phase 0a): the CSV status is the OFFICIAL attempt's verdict,
  // identical to the learners page — never the latest attempt. ADR 0014: the
  // strict snapshot's retake ids replace the fail-soft grant read,
  // and the status reads "in_progress" while a granted retake runs (step 10).
  const official = await officialStatuses(
    svc,
    org.id,
    attempts.map((a) => ({ ...a, course_id: courseId })),
    { grants: retakeIdsByPair }
  );

  for (const uid of enrolledUserIds) {
    const myAttempts = attempts.filter((a) => a.user_id === uid);
    const status: Status = statusOf(official, uid, courseId);
    // The OFFICIAL score (same value the learners page shows), not the best
    // of every attempt including practice runs.
    const bestScore = official.get(userCourseKey(uid, courseId))?.scoring.officialScore ?? null;
    // Same numbers as the learners page: attempts and last activity count the
    // attempts that were not reset (ADR 0004 step 11) and are not revision
    // visits (ADR 0014 step 7; the select carries the flag).
    const liveAttempts = excludeAbandoned(myAttempts);
    const lastTouched =
      liveAttempts
        .map((a) => a.completed_at ?? a.started_at)
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? "";
    const profile = profileByUser.get(uid);
    const via = Array.from(viaByUser.get(uid) ?? []).join("+");

    // ADR 0014 step 10: a per-course display, so a running granted retake is
    // the source (its own progress, never 100 %).
    const progress = courseProgress(myAttempts, unitCountByVersion, { retakeIds: snapshotOf(uid).retakeIds });
    const visit = visits.failed ? null : visits.byPair.get(userCourseKey(uid, courseId)) ?? { count: 0, last: null };
    // officialRetakeState is the one reader of the retake state and the
    // previous result (ADR 0014 step 7); "Previous official …" is filled only
    // once a granted retake completed.
    const retake = retakeByUser.get(uid) ?? null;
    const previous = retake?.state === "completed" ? retake.previous : null;
    const grant = retake?.grant ?? null;
    rows.push([
      employeeIdByUser.get(uid) ?? "",
      emailByUser.get(uid) ?? uid.slice(0, 8),
      profile?.first_name ?? "",
      profile?.last_name ?? "",
      status,
      progress.pct !== null ? String(progress.pct) : "",
      progress.screensDone !== null ? String(progress.screensDone) : "",
      progress.screensTotal !== null ? String(progress.screensTotal) : "",
      bestScore !== null ? String(Math.round(bestScore * 100)) : "",
      String(liveAttempts.length),
      lastTouched,
      visit ? `${visit.count}${visits.capped ? "+" : ""}` : "",
      visit?.last ?? "",
      retake ? (retake.state === "in_progress" ? "in progress" : retake.state) : "none",
      previous && previous.score !== null ? String(Math.round(previous.score * 100)) : "",
      previous ? previous.status : "",
      grant ? (grant.decidedBy ? deciderEmail.get(grant.decidedBy) : undefined) ?? "a former administrator" : "",
      grant?.decidedAt ?? "",
      grant ? grant.decisionNote ?? grant.reason ?? "" : "",
      via,
    ]);
  }

  // Sort rows (skip header) by email asc for consistent CSV ordering
  const headerRow = rows[0];
  const body = rows
    .slice(1)
    .sort((a, b) => a[1].localeCompare(b[1]));
  const ordered = [headerRow, ...body];

  // UTF-8 BOM so Excel detects encoding correctly on Windows.
  const csv =
    "\uFEFF" +
    ordered.map((r) => r.map(csvEscape).join(",")).join("\r\n") +
    "\r\n";

  const safeTitle = c.title.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Human-readable code in the file name (learners_MOD0015_..., 0079), fail-soft before the migration.
  const exportCode = (await fetchReferenceCodes(supabase, "courses", [course.id])).get(course.id);
  const filename = `learners_${exportCode ? `${exportCode}_` : ""}${safeTitle}_${stamp}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
