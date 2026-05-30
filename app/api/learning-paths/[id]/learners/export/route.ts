import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";

/**
 *   GET /api/learning-paths/{pathId}/learners/export?orgSlug=...
 *
 * Mirrors /api/courses/{courseId}/learners/export (shipped in #155) for
 * the path-learners surface. Returns CSV of every enrolled learner with
 * per-course progress within the path.
 *
 * Columns: Employee ID, Email, First name, Last name, Status,
 * Courses done, Courses total, Last activity (ISO), Enrolled via.
 *
 * Admin-only, tenant-scoped. UTF-8 BOM for Excel encoding detection.
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
  { params }: { params: Promise<{ pathId: string }> }
) {
  const { pathId } = await params;
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

  const { data: pathRow } = await supabase
    .from("learning_paths")
    .select("id, name, organization_id")
    .eq("id", pathId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!pathRow) {
    return NextResponse.json({ error: "Path not found" }, { status: 404 });
  }
  const p = pathRow as { id: string; name: string; organization_id: string };

  const { data: stepRows } = await supabase
    .from("learning_path_courses")
    .select("course_id, step_number")
    .eq("path_id", p.id)
    .order("step_number", { ascending: true });
  const steps = (stepRows ?? []) as Array<{
    course_id: string;
    step_number: number;
  }>;
  const stepCourseIds = steps.map((s) => s.course_id);
  const coursesTotal = steps.length;

  const { data: assignmentRows } = await supabase
    .from("learning_path_assignments")
    .select("assignee_type, user_id, team_id")
    .eq("path_id", p.id);
  const assignments = (assignmentRows ?? []) as Array<{
    assignee_type: ViaKind;
    user_id: string | null;
    team_id: string | null;
  }>;

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
    for (const pr of (profileRows ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
    }>) {
      profileByUser.set(pr.id, {
        first_name: pr.first_name,
        last_name: pr.last_name,
      });
    }
  }

  const { data: versionRows } =
    stepCourseIds.length > 0
      ? await supabase
          .from("course_versions")
          .select("id, course_id")
          .in("course_id", stepCourseIds)
      : { data: [] };
  const versions = (versionRows ?? []) as Array<{
    id: string;
    course_id: string;
  }>;
  const courseByVersion = new Map(versions.map((v) => [v.id, v.course_id]));
  const versionIds = versions.map((v) => v.id);

  const { data: attemptRows } =
    enrolledUserIds.length && versionIds.length
      ? await supabase
          .from("course_attempts")
          .select(
            "user_id, course_version_id, completion_status, success_status, started_at, completed_at"
          )
          .in("user_id", enrolledUserIds)
          .in("course_version_id", versionIds)
      : { data: [] };
  const attempts = (attemptRows ?? []) as Array<{
    user_id: string;
    course_version_id: string;
    completion_status: string;
    success_status: string;
    started_at: string;
    completed_at: string | null;
  }>;
  const lastStepCourseId = steps[steps.length - 1]?.course_id ?? null;

  const header = [
    "Employee ID",
    "Email",
    "First name",
    "Last name",
    "Status",
    "Courses done",
    "Courses total",
    "Last activity (ISO)",
    "Enrolled via",
  ];
  const rows: string[][] = [header];

  for (const uid of enrolledUserIds) {
    const myAttempts = attempts.filter((a) => a.user_id === uid);
    const doneCourseIds = new Set<string>();
    for (const a of myAttempts) {
      const cid = courseByVersion.get(a.course_version_id);
      if (!cid) continue;
      if (
        a.completion_status === "completed" ||
        a.success_status === "passed"
      ) {
        doneCourseIds.add(cid);
      }
    }
    const coursesDone = stepCourseIds.filter((cid) =>
      doneCourseIds.has(cid)
    ).length;

    let status: Status;
    if (coursesDone === 0 && myAttempts.length === 0) {
      status = "not_started";
    } else if (coursesDone < coursesTotal) {
      status = "in_progress";
    } else {
      const finalAttempts = myAttempts.filter(
        (a) => courseByVersion.get(a.course_version_id) === lastStepCourseId
      );
      const latestFinal = finalAttempts
        .slice()
        .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))[0];
      if (latestFinal?.success_status === "passed") status = "passed";
      else if (latestFinal?.success_status === "failed") status = "failed";
      else status = "completed";
    }
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
      String(coursesDone),
      String(coursesTotal),
      lastTouched,
      via,
    ]);
  }

  const headerRow = rows[0];
  const body = rows.slice(1).sort((a, b) => a[1].localeCompare(b[1]));
  const ordered = [headerRow, ...body];

  const csv =
    "\uFEFF" +
    ordered.map((r) => r.map(csvEscape).join(",")).join("\r\n") +
    "\r\n";

  const safeName = p.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `path_learners_${safeName}_${stamp}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
