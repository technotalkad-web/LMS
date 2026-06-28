import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canViewReports } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  AlertTriangle,
  Award,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  GraduationCap,
  Map as MapIcon,
  TrendingUp,
  Users as UsersIcon,
} from "lucide-react";
import {
  AdminPageHeader,
  Card,
  EmptyState,
  KpiCard,
  KpiStrip,
  StatusPill,
} from "@/components/admin";
import { CsvButton } from "./_components/csv-button";

type Course = {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published" | "archived";
  current_version_id: string | null;
};

type Version = {
  id: string;
  course_id: string;
  manifest_type: "scorm12" | "cmi5";
};

type Attempt = {
  id: string;
  user_id: string;
  course_version_id: string;
  completion_status: "in_progress" | "completed";
  success_status: "unknown" | "passed" | "failed";
  score: number | null;
  started_at: string;
  completed_at: string | null;
};

type Assignment = {
  course_id: string;
  assignee_type: "user" | "team" | "org";
  user_id: string | null;
  team_id: string | null;
  due_at: string | null;
};

type Member = { user_id: string; role: string };
type Team = { id: string; name: string };
type TeamLink = { team_id: string; user_id: string };

interface CourseRow {
  course: Course;
  standard: string;
  attempts: number;
  learners: number;
  completed: number;
  passed: number;
  failed: number;
  inProgress: number;
  avgScore: number | null;
  lastActivity: string | null;
}

interface AtRiskRow {
  user_id: string;
  email: string;
  course_id: string;
  course_title: string;
  due_at: string;
  daysOverdue: number;
}

interface TeamSummary {
  team_id: string;
  team_name: string;
  members: number;
  attempts: number;
  learnersActive: number;
  completed: number;
  passed: number;
  completionRate: number;
}

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);

  if (!canViewReports(role)) {
    redirect(`/${orgSlug}/dashboard`);
  }

  const supabase = await createClient();

  const { data: courseRows } = await supabase
    .from("courses")
    .select("id, title, slug, status, current_version_id")
    .eq("organization_id", org.id)
    .order("updated_at", { ascending: false });
  const courses = (courseRows ?? []) as Course[];

  const courseIds = courses.map((c) => c.id);
  const { data: versionRows } = courseIds.length
    ? await supabase
        .from("course_versions")
        .select("id, course_id, manifest_type")
        .in("course_id", courseIds)
    : { data: [] };
  const versions = (versionRows ?? []) as Version[];

  // Paginate the unbounded reads. Supabase caps a single response at 1000 rows,
  // which silently truncated every KPI once an org crossed ~1000 attempts /
  // members / assignments — wrong numbers with no error. (C1) Aggregation stays
  // in JS; for very large tenants the next optimization is the per-course
  // matviews (mv_course_*, refreshed by the now-working cron).
  const fetchAll = async <T,>(
    make: (from: number, to: number) => PromiseLike<{ data: T[] | null }>
  ): Promise<T[]> => {
    const PAGE = 1000;
    let from = 0;
    const all: T[] = [];
    for (;;) {
      const { data } = await make(from, from + PAGE - 1);
      const rows = data ?? [];
      all.push(...rows);
      if (rows.length < PAGE) break;
      from += PAGE;
      if (from >= 500_000) break; // safety ceiling
    }
    return all;
  };

  const attempts = await fetchAll<Attempt>((f, t) =>
    supabase
      .from("course_attempts")
      .select(
        "id, user_id, course_version_id, completion_status, success_status, score, started_at, completed_at"
      )
      .eq("organization_id", org.id)
      .range(f, t)
  );

  const members = await fetchAll<Member>((f, t) =>
    supabase
      .from("organization_members")
      .select("user_id, role")
      .eq("organization_id", org.id)
      .range(f, t)
  );

  const assignments = courseIds.length
    ? await fetchAll<Assignment>((f, t) =>
        supabase
          .from("course_assignments")
          .select("course_id, assignee_type, user_id, team_id, due_at")
          .eq("organization_id", org.id)
          .range(f, t)
      )
    : [];

  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name")
    .eq("organization_id", org.id);
  const teams = (teamRows ?? []) as Team[];

  const { data: teamMemberRows } = teams.length
    ? await supabase
        .from("team_members")
        .select("team_id, user_id")
        .in(
          "team_id",
          teams.map((t) => t.id)
        )
    : { data: [] };
  const teamLinks = (teamMemberRows ?? []) as TeamLink[];

  const userIdSet = new Set<string>();
  for (const m of members) userIdSet.add(m.user_id);
  for (const a of attempts) userIdSet.add(a.user_id);
  for (const a of assignments) if (a.user_id) userIdSet.add(a.user_id);
  const emailByUser = new Map<string, string>();
  if (userIdSet.size > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1500 });
    for (const u of data?.users ?? []) {
      if (u.email && userIdSet.has(u.id)) emailByUser.set(u.id, u.email);
    }
  }

  const versionsByCourse = new Map<string, Version[]>();
  const versionById = new Map<string, Version>();
  for (const v of versions) {
    versionById.set(v.id, v);
    const arr = versionsByCourse.get(v.course_id) ?? [];
    arr.push(v);
    versionsByCourse.set(v.course_id, arr);
  }
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const memberIds = new Set(members.map((m) => m.user_id));
  const teamUserIds = new Map<string, Set<string>>();
  for (const tl of teamLinks) {
    const s = teamUserIds.get(tl.team_id) ?? new Set<string>();
    s.add(tl.user_id);
    teamUserIds.set(tl.team_id, s);
  }

  const rows: CourseRow[] = courses.map((c) => {
    const courseVersions = versionsByCourse.get(c.id) ?? [];
    const versionIds = new Set(courseVersions.map((v) => v.id));
    const myAttempts = attempts.filter((a) => versionIds.has(a.course_version_id));
    // "Completed" = completion_status completed OR success_status passed —
    // passing a graded module is a successful completion. Unified across all
    // reporting surfaces (product decision R1); matches the report matviews.
    const completed = myAttempts.filter(
      (a) => a.completion_status === "completed" || a.success_status === "passed"
    ).length;
    const passed = myAttempts.filter((a) => a.success_status === "passed").length;
    const failed = myAttempts.filter((a) => a.success_status === "failed").length;
    const inProgress = myAttempts.filter(
      (a) => a.completion_status !== "completed" && a.success_status !== "passed"
    ).length;
    const scored = myAttempts.filter((a) => typeof a.score === "number");
    const avgScore =
      scored.length === 0
        ? null
        : scored.reduce((s, a) => s + (a.score ?? 0), 0) / scored.length;
    const lastActivity =
      myAttempts
        .map((a) => a.completed_at ?? a.started_at)
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? null;

    const currentVersion = c.current_version_id
      ? versionById.get(c.current_version_id)
      : courseVersions[0];

    return {
      course: c,
      standard: currentVersion?.manifest_type ?? "-",
      attempts: myAttempts.length,
      learners: new Set(myAttempts.map((a) => a.user_id)).size,
      completed,
      passed,
      failed,
      inProgress,
      avgScore,
      lastActivity,
    };
  });

  const now = Date.now();
  const courseCompletedBy = new Map<string, Set<string>>();
  for (const a of attempts) {
    if (a.completion_status === "completed" || a.success_status === "passed") {
      const v = versionById.get(a.course_version_id);
      if (!v) continue;
      const s = courseCompletedBy.get(v.course_id) ?? new Set<string>();
      s.add(a.user_id);
      courseCompletedBy.set(v.course_id, s);
    }
  }

  type Pair = { user_id: string; course_id: string; due_at: string };
  const dueByPair = new Map<string, Pair>();
  function offer(user_id: string, course_id: string, due_at: string | null) {
    if (!due_at) return;
    const key = `${user_id}|${course_id}`;
    const cur = dueByPair.get(key);
    if (!cur || cur.due_at > due_at) dueByPair.set(key, { user_id, course_id, due_at });
  }
  for (const a of assignments) {
    if (!a.due_at) continue;
    if (a.assignee_type === "user" && a.user_id) {
      offer(a.user_id, a.course_id, a.due_at);
    } else if (a.assignee_type === "team" && a.team_id) {
      const teamUsers = teamUserIds.get(a.team_id) ?? new Set<string>();
      for (const uid of teamUsers) offer(uid, a.course_id, a.due_at);
    } else if (a.assignee_type === "org") {
      for (const uid of memberIds) offer(uid, a.course_id, a.due_at);
    }
  }
  const atRisk: AtRiskRow[] = [];
  for (const p of dueByPair.values()) {
    const dueTime = new Date(p.due_at).getTime();
    if (dueTime >= now) continue;
    const done = courseCompletedBy.get(p.course_id)?.has(p.user_id) ?? false;
    if (done) continue;
    const course = courseById.get(p.course_id);
    if (!course) continue;
    atRisk.push({
      user_id: p.user_id,
      email: emailByUser.get(p.user_id) ?? p.user_id.slice(0, 8),
      course_id: p.course_id,
      course_title: course.title,
      due_at: p.due_at,
      daysOverdue: Math.floor((now - dueTime) / (1000 * 60 * 60 * 24)),
    });
  }
  atRisk.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const teamSummaries: TeamSummary[] = teams.map((t) => {
    const memberSet = teamUserIds.get(t.id) ?? new Set<string>();
    const teamAttempts = attempts.filter((a) => memberSet.has(a.user_id));
    const completed = teamAttempts.filter(
      (a) => a.completion_status === "completed" || a.success_status === "passed"
    ).length;
    const passed = teamAttempts.filter(
      (a) => a.success_status === "passed"
    ).length;
    const learnersActive = new Set(teamAttempts.map((a) => a.user_id)).size;
    const completionRate =
      teamAttempts.length === 0 ? 0 : completed / teamAttempts.length;
    return {
      team_id: t.id,
      team_name: t.name,
      members: memberSet.size,
      attempts: teamAttempts.length,
      learnersActive,
      completed,
      passed,
      completionRate,
    };
  });

  const totals = {
    courses: courses.length,
    coursesWithActivity: rows.filter((r) => r.attempts > 0).length,
    attempts: attempts.length,
    learnersWithActivity: new Set(attempts.map((a) => a.user_id)).size,
    totalUsers: members.length,
    completed: attempts.filter(
      (a) => a.completion_status === "completed" || a.success_status === "passed"
    ).length,
    passed: attempts.filter((a) => a.success_status === "passed").length,
  };
  const completionRate =
    totals.attempts === 0 ? 0 : totals.completed / totals.attempts;
  const passRate = totals.attempts === 0 ? 0 : totals.passed / totals.attempts;

  const scoredAll = attempts.filter((a) => typeof a.score === "number");
  const avgScoreOverall =
    scoredAll.length === 0
      ? null
      : scoredAll.reduce((s, a) => s + (a.score ?? 0), 0) / scoredAll.length;

  const courseCsvRows = rows.map((r) => [
    r.course.title,
    r.standard,
    r.attempts,
    r.learners,
    r.completed,
    r.passed,
    r.failed,
    r.avgScore === null ? "" : (r.avgScore * 100).toFixed(2) + "%",
    r.lastActivity ? new Date(r.lastActivity).toISOString().slice(0, 10) : "",
  ]);
  const atRiskCsvRows = atRisk.map((r) => [
    r.email,
    r.course_title,
    new Date(r.due_at).toISOString().slice(0, 10),
    r.daysOverdue,
  ]);
  const teamCsvRows = teamSummaries.map((t) => [
    t.team_name,
    t.members,
    t.attempts,
    t.learnersActive,
    t.completed,
    t.passed,
    (t.completionRate * 100).toFixed(1) + "%",
  ]);

  const recent = [...attempts]
    .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))
    .slice(0, 20);

  const reportModules: Array<{
    title: string;
    description: string;
    icon: React.ReactNode;
    href: string;
    badge?: string;
  }> = [
    {
      title: "Course performance",
      description: "Per-course attempts, learners, pass/fail breakdowns.",
      icon: <BookOpen className="w-5 h-5" />,
      href: `#per-course`,
      badge: `${rows.length}`,
    },
    {
      title: "Team breakdown",
      description: "Compare engagement and completion across teams.",
      icon: <UsersIcon className="w-5 h-5" />,
      href: `#per-team`,
      badge: `${teamSummaries.length}`,
    },
    {
      title: "At-risk learners",
      description: "Members overdue on at least one assigned course.",
      icon: <AlertTriangle className="w-5 h-5" />,
      href: `#at-risk`,
      badge: `${atRisk.length}`,
    },
    {
      title: "Recent attempts",
      description: "Live feed of the latest course launches and results.",
      icon: <TrendingUp className="w-5 h-5" />,
      href: `#recent`,
    },
    {
      title: "Learning paths",
      description: "Track progress through multi-course curricula.",
      icon: <MapIcon className="w-5 h-5" />,
      href: `/${orgSlug}/learning-paths`,
    },
    {
      title: "Certificates",
      description: "Issued certificates and learner credentials.",
      icon: <Award className="w-5 h-5" />,
      href: `/${orgSlug}/library`,
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Reports"
        description={`Track learner progress and engagement across ${org.name}.`}
      />

      <KpiStrip>
        <KpiCard
          label="Active learners"
          value={totals.learnersWithActivity}
          icon={<GraduationCap className="w-4 h-4" />}
        />
        <KpiCard
          label="Completions"
          value={totals.completed}
          icon={<CheckCircle2 className="w-4 h-4" />}
          accent="text-emerald-600"
        />
        <KpiCard
          label="Avg score"
          value={avgScoreOverall === null ? "-" : fmtPct(avgScoreOverall)}
          icon={<BarChart3 className="w-4 h-4" />}
        />
        <KpiCard
          label="Pass rate"
          value={fmtPct(passRate)}
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <KpiCard
          label="Overdue"
          value={atRisk.length}
          icon={<AlertTriangle className="w-4 h-4" />}
          accent={atRisk.length > 0 ? "text-red-600" : undefined}
        />
      </KpiStrip>

      <h2 className="serif text-xl mb-3 text-ink">Report modules</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-10">
        {reportModules.map((m) => (
          <Link
            key={m.title}
            href={m.href}
            className="group bg-paper border border-line rounded-xl p-4 transition-all hover:border-ink/30 hover:shadow-sm flex items-start gap-3"
          >
            <div className="shrink-0 w-10 h-10 rounded-lg bg-canvas border border-line flex items-center justify-center text-ink">
              {m.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="serif text-lg text-ink truncate">{m.title}</h3>
                {m.badge && (
                  <span className="text-[11px] font-semibold text-muted bg-canvas border border-line px-1.5 py-0.5 rounded-full tabular-nums">
                    {m.badge}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted mt-0.5">{m.description}</p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted group-hover:text-ink shrink-0 mt-2 transition-colors" />
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
        <KpiCard label="Total users" value={totals.totalUsers} />
        <KpiCard
          label="Active courses"
          value={`${totals.coursesWithActivity} / ${totals.courses}`}
        />
        <KpiCard label="Attempts" value={totals.attempts} />
        <KpiCard label="Completion rate" value={fmtPct(completionRate)} />
      </div>

      <section id="at-risk" className="mb-10 scroll-mt-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-xl text-ink">At-risk learners</h2>
          <CsvButton
            filename="at-risk.csv"
            header={["Learner", "Course", "Due", "Days overdue"]}
            rows={atRiskCsvRows}
          />
        </div>
        {atRisk.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={<CheckCircle2 className="w-5 h-5" />}
              title="Nobody is overdue"
              description="All assigned courses are on track. Nice work."
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wide text-muted sticky top-0 z-10">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Learner</th>
                  <th className="text-left px-4 py-2 font-medium">Course</th>
                  <th className="text-right px-4 py-2 font-medium">Due</th>
                  <th className="text-right px-4 py-2 font-medium">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {atRisk.slice(0, 50).map((r, i) => (
                  <tr key={i} className="hover:bg-canvas/50">
                    <td className="px-4 py-3 text-xs">{r.email}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/${orgSlug}/library/${r.course_id}`}
                        className="hover:underline"
                      >
                        {r.course_title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted whitespace-nowrap">
                      {new Date(r.due_at).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-red-700 font-medium">
                      {r.daysOverdue}d
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {atRisk.length > 50 && (
              <div className="px-4 py-2 text-xs text-muted text-center bg-canvas border-t border-line">
                Showing 50 of {atRisk.length}. Use CSV download for the full list.
              </div>
            )}
          </Card>
        )}
      </section>

      <section id="per-course" className="mb-10 scroll-mt-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-xl text-ink">Per course</h2>
          <CsvButton
            filename="per-course.csv"
            header={[
              "Course",
              "Standard",
              "Attempts",
              "Learners",
              "Completed",
              "Passed",
              "Failed",
              "Avg score",
              "Last activity",
            ]}
            rows={courseCsvRows}
          />
        </div>
        {rows.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={<BookOpen className="w-5 h-5" />}
              title="No courses yet"
              description="Once courses get attempts, data lands here."
            />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wide text-muted sticky top-0 z-10">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Course</th>
                  <th className="text-left px-4 py-2 font-medium">Std</th>
                  <th className="text-right px-4 py-2 font-medium">Attempts</th>
                  <th className="text-right px-4 py-2 font-medium">Learners</th>
                  <th className="text-right px-4 py-2 font-medium">Completed</th>
                  <th className="text-right px-4 py-2 font-medium">Passed</th>
                  <th className="text-right px-4 py-2 font-medium">Failed</th>
                  <th className="text-right px-4 py-2 font-medium">Avg score</th>
                  <th className="text-right px-4 py-2 font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.course.id} className="hover:bg-canvas/50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/${orgSlug}/library/${r.course.id}`}
                        className="text-ink hover:underline"
                      >
                        {r.course.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{r.standard}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.attempts}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.learners}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.completed}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-emerald-700">
                      {r.passed}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-red-700">
                      {r.failed}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.avgScore === null ? "-" : fmtPct(r.avgScore)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted whitespace-nowrap">
                      {r.lastActivity
                        ? new Date(r.lastActivity).toISOString().slice(0, 10)
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        )}
      </section>

      <section id="per-team" className="mb-10 scroll-mt-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-xl text-ink">Per team</h2>
          <CsvButton
            filename="per-team.csv"
            header={[
              "Team",
              "Members",
              "Attempts",
              "Active learners",
              "Completed",
              "Passed",
              "Completion rate",
            ]}
            rows={teamCsvRows}
          />
        </div>
        {teamSummaries.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={<UsersIcon className="w-5 h-5" />}
              title="No teams yet"
              description="Create teams to compare engagement across departments."
            />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wide text-muted sticky top-0 z-10">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Team</th>
                  <th className="text-right px-4 py-2 font-medium">Members</th>
                  <th className="text-right px-4 py-2 font-medium">Attempts</th>
                  <th className="text-right px-4 py-2 font-medium">Active</th>
                  <th className="text-right px-4 py-2 font-medium">Completed</th>
                  <th className="text-right px-4 py-2 font-medium">Passed</th>
                  <th className="text-right px-4 py-2 font-medium">Completion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {teamSummaries.map((t) => (
                  <tr key={t.team_id} className="hover:bg-canvas/50">
                    <td className="px-4 py-3">{t.team_name}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{t.members}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{t.attempts}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {t.learnersActive}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{t.completed}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-emerald-700">
                      {t.passed}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {fmtPct(t.completionRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        )}
      </section>

      <section id="recent" className="scroll-mt-6">
        <h2 className="serif text-xl text-ink mb-3">Recent attempts</h2>
        {recent.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={<TrendingUp className="w-5 h-5" />}
              title="No attempts yet"
              description="Launches and completions will appear here in real time."
            />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wide text-muted sticky top-0 z-10">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">When</th>
                  <th className="text-left px-4 py-2 font-medium">Learner</th>
                  <th className="text-left px-4 py-2 font-medium">Course</th>
                  <th className="text-left px-4 py-2 font-medium">Result</th>
                  <th className="text-right px-4 py-2 font-medium">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recent.map((a) => {
                  const v = versionById.get(a.course_version_id);
                  const course = v ? courseById.get(v.course_id) : null;
                  const detailHref = course
                    ? `/${orgSlug}/courses/${course.id}/attempts/${a.id}`
                    : null;
                  return (
                    <tr key={a.id} className="hover:bg-canvas/50">
                      <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                        {detailHref ? (
                          <Link href={detailHref} className="hover:underline">
                            {new Date(a.started_at)
                              .toISOString()
                              .slice(0, 16)
                              .replace("T", " ")}
                          </Link>
                        ) : (
                          new Date(a.started_at)
                            .toISOString()
                            .slice(0, 16)
                            .replace("T", " ")
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {emailByUser.get(a.user_id) ?? a.user_id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        {course ? (
                          <Link
                            href={`/${orgSlug}/library/${course.id}`}
                            className="hover:underline"
                          >
                            {course.title}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <ResultPill
                          completion={a.completion_status}
                          success={a.success_status}
                        />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {detailHref ? (
                          <Link href={detailHref} className="hover:underline">
                            {a.score === null ? "-" : fmtPct(a.score)}
                          </Link>
                        ) : a.score === null ? (
                          "-"
                        ) : (
                          fmtPct(a.score)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}

function ResultPill({
  completion,
  success,
}: {
  completion: "in_progress" | "completed";
  success: "unknown" | "passed" | "failed";
}) {
  if (success === "passed") {
    return <StatusPill tone="success">Passed</StatusPill>;
  }
  if (success === "failed") {
    return <StatusPill tone="suspended">Failed</StatusPill>;
  }
  if (completion === "completed") {
    return <StatusPill tone="neutral">Completed</StatusPill>;
  }
  return <StatusPill tone="warning">In progress</StatusPill>;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
