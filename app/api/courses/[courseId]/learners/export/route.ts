import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";

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
 * Performance: in-memory enrichment of the full enrolled set (same as the
 * page). At 10k learners that's ~1MB payload and sub-100ms compute — fine
 * for an admin export that runs infrequently.
 */

type ViaKind = "user" | "team" | "org";
type Status = "not_started" | "in_progress" | "completed" | "passed" | "failed";

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

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
    .select("id")
    .eq("course_id", c.id);
  const versionIds = ((versionRows ?? []) as Array<{ id: string }>).map(
    (v) => v.id
  );

  // ---- assignments ----
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select("assignee_type, user_id, team_id")
    .eq("course_id", c.id);
  const assignments = (assignmentRows ?? []) as Array<{
    assignee_type: ViaKind;
    user_id: string | null;
    team_id: string | null;
  }>;

  // ---- org members (for org-wide assignments + employee_id) ----
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id, employee_id")
    .eq("organization_id", org.id);
  const orgMembers = (memberRows ?? []) as Array<{
    user_id: string;
    employee_id: string | null;
  }>;
  const employeeIdByUser = new Map<string, string | null>();
  for (const m of orgMembers) employeeIdByUser.set(m.user_id, m.employee_id);

  // ---- team members ----
  const assignedTeamIds = assignments
    .filter((a) => a.assignee_type === "team" && a.team_id)
    .map((a) => a.team_id as string);
  const teamUserIds = new Map<string, Set<string>>();
  if (assignedTeamIds.length > 0) {
    const { data: teamMemberRows } = await supabase
      .from("team_members")
      .select("team_id, user_id")
      .in("team_id", assignedTeamIds);
    for (const r of (teamMemberRows ?? []) as Array<{
      team_id: string;
      user_id: string;
    }>) {
      const s = teamUserIds.get(r.team_id) ?? new Set<string>();
      s.add(r.user_id);
      teamUserIds.set(r.team_id, s);
    }
  }

  // ---- viaByUser + enrolledUserIds ----
  const viaByUser = new Map<string, Set<ViaKind>>();
  const addVia = (uid: string, v: ViaKind) => {
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
    }
  }
  const enrolledUserIds = Array.from(viaByUser.keys());

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
    const { data: profileRows } = await svc
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", enrolledUserIds);
    for (const p of (profileRows ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
    }>) {
      profileByUser.set(p.id, {
        first_name: p.first_name,
        last_name: p.last_name,
      });
    }
  }

  // ---- attempts ----
  const { data: attemptRows } =
    enrolledUserIds.length && versionIds.length
      ? await supabase
          .from("course_attempts")
          .select(
            "user_id, completion_status, success_status, score, started_at, completed_at"
          )
          .in("user_id", enrolledUserIds)
          .in("course_version_id", versionIds)
      : { data: [] };
  const attempts = (attemptRows ?? []) as Array<{
    user_id: string;
    completion_status: string;
    success_status: string;
    score: number | null;
    started_at: string;
    completed_at: string | null;
  }>;

  // ---- build CSV ----
  const header = [
    "Employee ID",
    "Email",
    "First name",
    "Last name",
    "Status",
    "Best score (%)",
    "Attempts",
    "Last activity (ISO)",
    "Enrolled via",
  ];
  const rows: string[][] = [header];

  for (const uid of enrolledUserIds) {
    const myAttempts = attempts.filter((a) => a.user_id === uid);
    const latest = myAttempts
      .slice()
      .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))[0];
    let status: Status = "not_started";
    if (latest) {
      if (latest.success_status === "passed") status = "passed";
      else if (latest.success_status === "failed") status = "failed";
      else if (latest.completion_status === "completed") status = "completed";
      else status = "in_progress";
    }
    const bestScore = myAttempts
      .map((a) => a.score)
      .filter((s): s is number => typeof s === "number")
      .reduce<number | null>(
        (best, s) => (best === null || s > best ? s : best),
        null
      );
    const lastTouched =
      myAttempts
        .map((a) => a.completed_at ?? a.started_at)
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? "";
    const profile = profileByUser.get(uid);
    const via = Array.from(viaByUser.get(uid) ?? []).join("+");

    rows.push([
      employeeIdByUser.get(uid) ?? "",
      emailByUser.get(uid) ?? uid.slice(0, 8),
      profile?.first_name ?? "",
      profile?.last_name ?? "",
      status,
      bestScore !== null ? String(Math.round(bestScore * 100)) : "",
      String(myAttempts.length),
      lastTouched,
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
  const filename = `learners_${safeTitle}_${stamp}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
