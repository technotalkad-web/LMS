import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  AssignSection,
  type AssignmentRow,
  type AssignableMember,
  type AssignableTeam,
} from "./assign-section";
import { ReminderSection, type ReminderSettings } from "./reminder-section";
import { DetailsForm, type CourseDetails } from "./details-form";

type Version = {
  id: string;
  version_number: number;
  manifest_type: "scorm12" | "cmi5";
  launch_url: string;
  manifest_data: { title?: string; description?: string; masteryScore?: number };
  uploaded_at: string;
};

type Course = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  current_version_id: string | null;
  organization_id: string;
  duration_minutes: number | null;
  is_active: boolean;
  thumbnail_url: string | null;
};

type TeamRow = { id: string; name: string; slug: string };

export default async function AdminCourseDetailPage({
  params,
}: {
  params: Promise<{ org: string; courseId: string }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select(
      "id, slug, title, description, status, current_version_id, organization_id, duration_minutes, is_active, thumbnail_url"
    )
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) redirect(`/${orgSlug}/library`);
  const c = course as Course;

  const { data: versions } = await supabase
    .from("course_versions")
    .select(
      "id, version_number, manifest_type, launch_url, manifest_data, uploaded_at"
    )
    .eq("course_id", c.id)
    .order("version_number", { ascending: false });
  const list = (versions ?? []) as Version[];
  const current = list.find((v) => v.id === c.current_version_id) ?? list[0];

  // Assignments
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select("id, assignee_type, user_id, team_id, due_at, assigned_at")
    .eq("course_id", c.id);

  // Reminder settings
  const { data: reminderRow } = await supabase
    .from("course_reminder_settings")
    .select("enabled, cadence_days, cap_days")
    .eq("course_id", c.id)
    .maybeSingle();
  const reminderSettings: ReminderSettings = {
    enabled: (reminderRow?.enabled as boolean | undefined) ?? false,
    cadence_days: (reminderRow?.cadence_days as number | undefined) ?? 1,
    cap_days: (reminderRow?.cap_days as number | undefined) ?? 30,
  };
  const assignments = (assignmentRows ?? []) as AssignmentRow[];

  // employee_id is selected so the assignment combobox can let admins
  // search by it. The actual profile name (first_name/last_name) is
  // fetched separately below via the service-role client.
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id, role, employee_id")
    .eq("organization_id", org.id);

  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name, slug")
    .eq("organization_id", org.id);
  const teamList = (teamRows ?? []) as TeamRow[];

  const { data: teamMemberRows } = await supabase
    .from("team_members")
    .select("team_id, user_id")
    .in(
      "team_id",
      teamList.map((t) => t.id)
    );
  const teamMemberCounts = new Map<string, number>();
  const teamUserIds = new Map<string, Set<string>>();
  for (const r of teamMemberRows ?? []) {
    const tid = r.team_id as string;
    teamMemberCounts.set(tid, (teamMemberCounts.get(tid) ?? 0) + 1);
    const s = teamUserIds.get(tid) ?? new Set<string>();
    s.add(r.user_id as string);
    teamUserIds.set(tid, s);
  }

  const teams: AssignableTeam[] = teamList.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    member_count: teamMemberCounts.get(t.id) ?? 0,
  }));

  // Resolve emails for everyone we might mention.
  const allUserIds = new Set<string>();
  for (const m of memberRows ?? []) allUserIds.add(m.user_id);
  for (const a of assignments) if (a.user_id) allUserIds.add(a.user_id);

  const emailByUser = new Map<string, string>();
  // Profile rows so the assignment combobox can show real names + match
  // searches by first/last name (in addition to email/employee_id).
  // Note: profiles PK is `id` per migration 0027.
  const profileByUser = new Map<
    string,
    { first_name: string | null; last_name: string | null }
  >();
  if (allUserIds.size > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    // perPage bumped to 1500 (was 500) — at 500, large orgs would silently
    // miss recently-created users in the combobox candidate list. Their
    // membership row exists, but their email never gets mapped, so the
    // combobox renders them as a UUID prefix and search doesn't match.
    // 1500 covers single-tenant orgs up to ~Fortune-500 size; switch to
    // multi-page accumulation if a tenant ever exceeds that.
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1500 });
    for (const u of data?.users ?? []) {
      if (u.email && allUserIds.has(u.id)) emailByUser.set(u.id, u.email);
    }
    const userIdList = Array.from(allUserIds);
    const { data: profileRows } = await svc
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", userIdList);
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

  const normalizeRole = (raw: string) => {
    if (raw === "owner") return "super_owner";
    if (raw === "member") return "user";
    return raw;
  };

  const members: AssignableMember[] = (memberRows ?? []).map((m) => {
    const p = profileByUser.get(m.user_id as string);
    return {
      user_id: m.user_id as string,
      email: emailByUser.get(m.user_id as string) ?? (m.user_id as string).slice(0, 8),
      role: normalizeRole(m.role as string) as AssignableMember["role"],
      employee_id: (m.employee_id as string | null | undefined) ?? null,
      first_name: p?.first_name ?? null,
      last_name: p?.last_name ?? null,
    };
  });

  const teamNameById = new Map(teamList.map((t) => [t.id, t.name]));
  for (const a of assignments) {
    if (a.user_id) a.user_email = emailByUser.get(a.user_id) ?? null;
    if (a.team_id) a.team_name = teamNameById.get(a.team_id) ?? null;
  }

  // ----- Enrolled summary -----
  // Compute totals (total / done / in-progress / not-started) but do
  // NOT fetch every attempt row here — the full per-learner table now
  // lives at /[org]/library/[courseId]/learners so this page stays a
  // clean "settings" surface even at 10k+ enrollments.
  // Step 1: who's enrolled?
  const memberIds = (memberRows ?? []).map((m) => m.user_id as string);
  const enrolledUserIds = new Set<string>();
  for (const a of assignments) {
    if (a.assignee_type === "user" && a.user_id) enrolledUserIds.add(a.user_id);
    else if (a.assignee_type === "team" && a.team_id) {
      for (const uid of teamUserIds.get(a.team_id) ?? []) enrolledUserIds.add(uid);
    } else if (a.assignee_type === "org") {
      for (const uid of memberIds) enrolledUserIds.add(uid);
    }
  }

  // Step 2: pull attempts ONLY for enrolled users + the course's versions,
  // and just the fields we need for status classification. (10k users with
  // ~3 attempts each ≈ 30k rows × 3 columns ≈ ~1MB — fine for an admin
  // page. If this becomes a hotspot, switch to a materialized view of
  // last-attempt-per-user-per-course or a PG function returning counts.)
  const versionIds = list.map((v) => v.id);
  const enrolledIdArr = Array.from(enrolledUserIds);
  const { data: attemptRows } =
    enrolledIdArr.length && versionIds.length
      ? await supabase
          .from("course_attempts")
          .select("user_id, completion_status, success_status, started_at")
          .in("user_id", enrolledIdArr)
          .in("course_version_id", versionIds)
      : { data: [] };
  type SummaryAttempt = {
    user_id: string;
    completion_status: string;
    success_status: string;
    started_at: string;
  };
  const summaryAttempts = (attemptRows ?? []) as SummaryAttempt[];

  // Latest-per-user wins for status classification.
  const statusByUser = new Map<
    string,
    "passed" | "failed" | "completed" | "in_progress"
  >();
  for (const a of summaryAttempts) {
    const prevStartedAt = statusByUser.has(a.user_id)
      ? summaryAttempts
          .filter((x) => x.user_id === a.user_id)
          .reduce((latest, x) => (x.started_at > latest ? x.started_at : latest), "")
      : "";
    if (a.started_at !== prevStartedAt && statusByUser.has(a.user_id)) continue;
    if (a.success_status === "passed") statusByUser.set(a.user_id, "passed");
    else if (a.success_status === "failed") statusByUser.set(a.user_id, "failed");
    else if (a.completion_status === "completed")
      statusByUser.set(a.user_id, "completed");
    else statusByUser.set(a.user_id, "in_progress");
  }
  const enrSummary = {
    total: enrolledUserIds.size,
    completed: Array.from(statusByUser.values()).filter(
      (s) => s === "completed" || s === "passed"
    ).length,
    inProgress: Array.from(statusByUser.values()).filter(
      (s) => s === "in_progress"
    ).length,
    notStarted: enrolledUserIds.size - statusByUser.size,
  };

  const initialDetails: CourseDetails = {
    title: c.title,
    description: c.description ?? "",
    duration_minutes: c.duration_minutes,
    is_active: c.is_active,
    thumbnail_url: c.thumbnail_url,
  };

  return (
    <div className="max-w-4xl space-y-10">
      <div>
        <Link
          href={`/${orgSlug}/library`}
          className="text-muted text-sm hover:text-ink transition-colors"
        >
          ← Library
        </Link>

        <div className="flex items-baseline justify-between mt-2 mb-1 gap-4">
          <h1 className="serif text-5xl">{c.title}</h1>
          <div className="flex items-center gap-3 shrink-0">
            <Link
              href={`/${orgSlug}/courses/${c.id}`}
              className="px-3 py-2 text-sm border border-line rounded-lg hover:border-ink transition-colors"
            >
              View as learner
            </Link>
            {current && (
              <Link
                href={`/${orgSlug}/courses/${c.id}/launch`}
                className="px-5 py-2.5 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 transition-opacity"
              >
                Preview launch
              </Link>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-xs text-muted">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wide ${
              c.is_active
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-line bg-canvas text-muted"
            }`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                c.is_active ? "bg-emerald-500" : "bg-muted"
              }`}
            />
            {c.is_active ? "Active" : "Inactive"}
          </span>
          <span className="capitalize">{c.status}</span>
          {current && <span>· {current.manifest_type}</span>}
          {c.duration_minutes !== null && (
            <span>· {c.duration_minutes} min</span>
          )}
          <span>· {enrSummary.total.toLocaleString()} enrolled</span>
        </div>
      </div>

      {/* Editable details */}
      <DetailsForm orgSlug={orgSlug} courseId={c.id} initial={initialDetails} />

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Stat label="Status" value={c.is_active ? "Active" : "Inactive"} />
        <Stat label="Standard" value={current?.manifest_type ?? "—"} />
        <Stat
          label="Mastery"
          value={
            typeof current?.manifest_data?.masteryScore === "number"
              ? `${Math.round(current.manifest_data.masteryScore * 100)}%`
              : "—"
          }
        />
        <Stat
          label="Duration"
          value={
            c.duration_minutes !== null ? `${c.duration_minutes} min` : "—"
          }
        />
      </div>

      {/* Assignments */}
      <AssignSection
        orgSlug={orgSlug}
        courseId={c.id}
        isAdmin={true}
        assignments={assignments}
        members={members}
        teams={teams}
      />

      {/* Reminders */}
      <ReminderSection courseId={c.id} initial={reminderSettings} />

      {/* Enrolled learners — summary card.
          The full per-learner table (with search, filters, pagination,
          sort) lives at /[org]/library/[courseId]/learners. Keeping it
          off the detail page means course settings stay accessible
          regardless of how many learners are enrolled. */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-2xl">Enrolled learners</h2>
          <div className="flex items-center gap-2">
            <Link
              href={`/${orgSlug}/library/${c.id}/reports`}
              className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink transition-colors"
              title="Full performance report for this course"
            >
              View reports →
            </Link>
            <Link
              href={`/${orgSlug}/library/${c.id}/learners`}
              className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink transition-colors"
            >
              View all learners →
            </Link>
          </div>
        </div>
        {enrSummary.total === 0 ? (
          <div className="border border-line rounded-2xl bg-paper p-8 text-muted text-sm text-center">
            No learners are enrolled yet. Add some in the Assignments section
            above.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat
              label="Total enrolled"
              value={enrSummary.total.toLocaleString()}
            />
            <Stat
              label="Completed"
              value={enrSummary.completed.toLocaleString()}
            />
            <Stat
              label="In progress"
              value={enrSummary.inProgress.toLocaleString()}
            />
            <Stat
              label="Not started"
              value={enrSummary.notStarted.toLocaleString()}
            />
          </div>
        )}
      </section>

      {/* Versions */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-2xl">Versions</h2>
          <Link
            href={`/${orgSlug}/library/upload?courseId=${c.id}`}
            className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink"
          >
            Upload new version
          </Link>
        </div>
        <ul className="border border-line rounded-2xl bg-paper divide-y divide-line">
          {list.map((v) => (
            <li
              key={v.id}
              className="px-5 py-3 flex items-baseline justify-between gap-4"
            >
              <div>
                <div className="font-medium">v{v.version_number}</div>
                <div className="text-xs text-muted">
                  {v.manifest_type} - launch:{" "}
                  <span className="font-mono">{v.launch_url}</span>
                </div>
              </div>
              <div className="text-xs text-muted shrink-0">
                {v.id === c.current_version_id && (
                  <span className="px-2 py-0.5 bg-accent text-canvas rounded-full mr-2 uppercase tracking-wide text-[10px]">
                    current
                  </span>
                )}
                {new Date(v.uploaded_at).toISOString().slice(0, 10)}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line rounded-xl bg-paper p-4">
      <div className="text-[10px] text-muted uppercase tracking-wide">
        {label}
      </div>
      <div className="serif text-xl mt-1">{value}</div>
    </div>
  );
}
