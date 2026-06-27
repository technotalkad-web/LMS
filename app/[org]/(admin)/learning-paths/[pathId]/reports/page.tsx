import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

// =============================================================================
// /[org]/learning-paths/[pathId]/reports — Path Reports surface.
//
// Per the user's #193 ask: "the Learning Path should be treated as a
// completely separate module within the LMS and considered a distinct
// product" — reports on this page are scoped to attempts launched WITHIN
// the context of THIS path (course_attempts.learning_path_id = pathId,
// added by migration 0034). Standalone attempts on the same constituent
// courses are intentionally excluded so the path's metrics aren't
// contaminated by ad-hoc launches.
//
// Sections:
//   - Overall: total assigned learners, completion %, avg pass rate
//   - Per-step: each course in the path with completion %, pass rate,
//     avg score, avg time
//   - Per-learner: status table (Not started / In progress / Completed /
//     Passed / Failed) + steps completed of total
//
// This is the live-query implementation. If volume warrants, the same
// pattern can be moved behind a matview (mirror migration 0031) — but
// for tenants with ≤10k learners × ≤20 steps, the in-page roll-up
// performs fine on Supabase Postgres.
// =============================================================================

export const dynamic = "force-dynamic";

type Path = {
  id: string;
  name: string;
  organization_id: string;
  sequence_mode: "strict" | "random";
};

type Step = {
  course_id: string;
  step_number: number;
  course_title: string;
  version_ids: string[];
};

type Attempt = {
  user_id: string;
  course_version_id: string;
  completion_status: string;
  success_status: string;
  score: number | null;
  started_at: string;
  completed_at: string | null;
  learning_path_id: string;
};

type StepMetric = {
  step_number: number;
  course_id: string;
  course_title: string;
  learners_started: number;
  learners_completed: number;
  learners_passed: number;
  learners_failed: number;
  average_score: number | null;
  average_minutes: number | null;
};

type LearnerStatus = {
  user_id: string;
  email: string;
  steps_completed: number;
  steps_total: number;
  status: "not_started" | "in_progress" | "completed" | "passed" | "failed";
  last_activity: string | null;
};

export default async function PathReportsPage({
  params,
}: {
  params: Promise<{ org: string; pathId: string }>;
}) {
  const { org: orgSlug, pathId } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();

  // ---- Verify path is in this org ----
  const { data: pathRow } = await supabase
    .from("learning_paths")
    .select("id, name, organization_id, sequence_mode")
    .eq("id", pathId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!pathRow) redirect(`/${orgSlug}/learning-paths`);
  const path = pathRow as Path;

  // ---- Steps + course titles + version ids per step ----
  const { data: stepRows } = await supabase
    .from("learning_path_courses")
    .select("course_id, step_number, courses!inner(title)")
    .eq("path_id", pathId)
    .order("step_number", { ascending: true });
  type StepRaw = {
    course_id: string;
    step_number: number;
    courses: { title: string } | { title: string }[];
  };
  const rawSteps = (stepRows ?? []) as StepRaw[];
  const stepCourseIds = rawSteps.map((s) => s.course_id);

  const { data: versionRows } = stepCourseIds.length
    ? await supabase
        .from("course_versions")
        .select("id, course_id")
        .in("course_id", stepCourseIds)
    : { data: [] };
  const versionsByCourse = new Map<string, string[]>();
  for (const v of (versionRows ?? []) as Array<{
    id: string;
    course_id: string;
  }>) {
    const list = versionsByCourse.get(v.course_id) ?? [];
    list.push(v.id);
    versionsByCourse.set(v.course_id, list);
  }
  const steps: Step[] = rawSteps.map((s) => {
    const c = Array.isArray(s.courses) ? s.courses[0] : s.courses;
    return {
      course_id: s.course_id,
      step_number: s.step_number,
      course_title: c?.title ?? "Untitled",
      version_ids: versionsByCourse.get(s.course_id) ?? [],
    };
  });
  const allVersionIds = steps.flatMap((s) => s.version_ids);

  // ---- Assigned learners (direct user + team + org) ----
  const { data: paRows } = await supabase
    .from("learning_path_assignments")
    .select("assignee_type, user_id, team_id")
    .eq("path_id", pathId);
  const pathAssigns = (paRows ?? []) as Array<{
    assignee_type: "user" | "team" | "org";
    user_id: string | null;
    team_id: string | null;
  }>;

  const orgMemberIds = new Set<string>();
  const { data: orgMemberRows } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id);
  for (const r of (orgMemberRows ?? []) as Array<{ user_id: string }>) {
    orgMemberIds.add(r.user_id);
  }

  const teamIds = pathAssigns
    .filter((a) => a.assignee_type === "team" && a.team_id)
    .map((a) => a.team_id as string);
  const teamMemberIds = new Set<string>();
  if (teamIds.length > 0) {
    const { data: tmRows } = await supabase
      .from("team_members")
      .select("user_id")
      .in("team_id", teamIds);
    for (const r of (tmRows ?? []) as Array<{ user_id: string }>) {
      teamMemberIds.add(r.user_id);
    }
  }

  const assignedUserIds = new Set<string>();
  for (const a of pathAssigns) {
    if (a.assignee_type === "user" && a.user_id) {
      assignedUserIds.add(a.user_id);
    } else if (a.assignee_type === "org") {
      for (const uid of orgMemberIds) assignedUserIds.add(uid);
    }
  }
  for (const uid of teamMemberIds) assignedUserIds.add(uid);
  const assignedIdArr = Array.from(assignedUserIds);

  // ---- Path-context attempts only (the key separation from course-level reports) ----
  const { data: attemptRows } =
    assignedIdArr.length && allVersionIds.length
      ? await supabase
          .from("course_attempts")
          .select(
            "user_id, course_version_id, completion_status, success_status, score, started_at, completed_at, learning_path_id"
          )
          .eq("learning_path_id", pathId)
          .in("user_id", assignedIdArr)
          .in("course_version_id", allVersionIds)
      : { data: [] };
  const attempts = (attemptRows ?? []) as Attempt[];

  // Index attempts STICKILY per (user_id, course_id): a step is "done" if ANY
  // attempt completed/passed. Previously the LATEST attempt won, so re-launching
  // a passed step (which creates a fresh in-progress attempt) regressed the
  // learner from passed → in_progress. Mirrors the dashboard's sticky rule. (#L4)
  const versionToCourse = new Map<string, string>();
  for (const s of steps) {
    for (const vid of s.version_ids) versionToCourse.set(vid, s.course_id);
  }
  type CourseAgg = {
    touched: boolean;
    done: boolean; // any attempt completed or passed
    passed: boolean; // any attempt passed
    failed: boolean; // any attempt failed
    bestScore: number | null;
    firstStarted: string | null;
    lastCompleted: string | null;
    lastActivity: string | null;
  };
  const aggByUserCourse = new Map<string, CourseAgg>(); // key: `${uid}::${courseId}`
  for (const a of attempts) {
    const cid = versionToCourse.get(a.course_version_id);
    if (!cid) continue;
    const key = `${a.user_id}::${cid}`;
    const cur: CourseAgg = aggByUserCourse.get(key) ?? {
      touched: false,
      done: false,
      passed: false,
      failed: false,
      bestScore: null,
      firstStarted: null,
      lastCompleted: null,
      lastActivity: null,
    };
    cur.touched = true;
    if (a.completion_status === "completed" || a.success_status === "passed") cur.done = true;
    if (a.success_status === "passed") cur.passed = true;
    if (a.success_status === "failed") cur.failed = true;
    if (typeof a.score === "number" && (cur.bestScore === null || a.score > cur.bestScore)) {
      cur.bestScore = a.score;
    }
    if (a.started_at && (!cur.firstStarted || a.started_at < cur.firstStarted)) {
      cur.firstStarted = a.started_at;
    }
    if (a.completed_at && (!cur.lastCompleted || a.completed_at > cur.lastCompleted)) {
      cur.lastCompleted = a.completed_at;
    }
    const act = a.completed_at ?? a.started_at ?? null;
    if (act && (!cur.lastActivity || act > cur.lastActivity)) cur.lastActivity = act;
    aggByUserCourse.set(key, cur);
  }

  // ---- Per-step metrics ----
  const stepMetrics: StepMetric[] = steps.map((s) => {
    let started = 0;
    let completed = 0;
    let passed = 0;
    let failed = 0;
    const scores: number[] = [];
    const minutes: number[] = [];
    for (const uid of assignedUserIds) {
      const agg = aggByUserCourse.get(`${uid}::${s.course_id}`);
      if (!agg || !agg.touched) continue;
      started += 1;
      if (agg.passed) passed += 1;
      else if (agg.failed) failed += 1;
      if (agg.done) completed += 1;
      if (typeof agg.bestScore === "number") scores.push(agg.bestScore);
      if (agg.firstStarted && agg.lastCompleted) {
        const ms =
          new Date(agg.lastCompleted).getTime() -
          new Date(agg.firstStarted).getTime();
        if (ms > 0) minutes.push(ms / 60000);
      }
    }
    return {
      step_number: s.step_number,
      course_id: s.course_id,
      course_title: s.course_title,
      learners_started: started,
      learners_completed: completed,
      learners_passed: passed,
      learners_failed: failed,
      average_score:
        scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : null,
      average_minutes:
        minutes.length > 0
          ? minutes.reduce((a, b) => a + b, 0) / minutes.length
          : null,
    };
  });

  // ---- Per-learner status ----
  const stepCount = steps.length;
  // The final step is the one with the highest step_number — NOT the step whose
  // number equals stepCount, which breaks when step numbers are non-contiguous
  // (e.g. 1,2,4 after edits). (#L3)
  const finalStep = steps.reduce(
    (max, s) => (s.step_number > max.step_number ? s : max),
    steps[0]
  );
  const finalStepCourseId = finalStep?.course_id ?? null;
  const perLearner: LearnerStatus[] = [];
  for (const uid of assignedUserIds) {
    let stepsDone = 0;
    let anyTouched = false;
    let lastActivity: string | null = null;
    let finalSuccessful: boolean | null = null;
    for (const s of steps) {
      const agg = aggByUserCourse.get(`${uid}::${s.course_id}`);
      if (!agg || !agg.touched) continue;
      anyTouched = true;
      if (agg.lastActivity && (!lastActivity || agg.lastActivity > lastActivity)) {
        lastActivity = agg.lastActivity;
      }
      if (agg.done) stepsDone += 1;
      if (s.course_id === finalStepCourseId) {
        if (agg.passed) finalSuccessful = true;
        else if (agg.failed) finalSuccessful = false;
      }
    }
    let status: LearnerStatus["status"];
    if (!anyTouched) status = "not_started";
    else if (stepsDone < stepCount) status = "in_progress";
    else if (finalSuccessful === true) status = "passed";
    else if (finalSuccessful === false) status = "failed";
    else status = "completed";
    perLearner.push({
      user_id: uid,
      email: uid.slice(0, 8), // hydrated below
      steps_completed: stepsDone,
      steps_total: stepCount,
      status,
      last_activity: lastActivity,
    });
  }

  // ---- Hydrate emails (service-role, paginated as in /users) ----
  if (perLearner.length > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const emailByUser = new Map<string, string>();
    let pageNum = 1;
    while (pageNum <= 50) {
      const { data } = await svc.auth.admin.listUsers({
        page: pageNum,
        perPage: 1500,
      });
      const users = data?.users ?? [];
      for (const u of users) {
        if (u.email && assignedUserIds.has(u.id)) emailByUser.set(u.id, u.email);
      }
      if (users.length < 1500) break;
      pageNum += 1;
    }
    for (const l of perLearner) {
      const e = emailByUser.get(l.user_id);
      if (e) l.email = e;
    }
  }
  perLearner.sort((a, b) => a.email.localeCompare(b.email));

  // ---- Overall metrics ----
  const totals = {
    assigned: assignedUserIds.size,
    completed: perLearner.filter(
      (l) => l.status === "completed" || l.status === "passed"
    ).length,
    inProgress: perLearner.filter((l) => l.status === "in_progress").length,
    notStarted: perLearner.filter((l) => l.status === "not_started").length,
    passed: perLearner.filter((l) => l.status === "passed").length,
    failed: perLearner.filter((l) => l.status === "failed").length,
  };
  const completionPct =
    totals.assigned > 0 ? totals.completed / totals.assigned : 0;
  const passRate =
    totals.passed + totals.failed > 0
      ? totals.passed / (totals.passed + totals.failed)
      : null;

  // ---- Render ----
  return (
    <div className="max-w-5xl space-y-8">
      {/* Header */}
      <div>
        <Link
          href={`/${orgSlug}/learning-paths`}
          className="text-muted text-sm hover:text-ink transition-colors"
        >
          ← Learning paths
        </Link>
        <div className="flex items-baseline justify-between gap-4 mt-2 mb-1">
          <h1 className="serif text-4xl">{path.name}</h1>
          <span className="text-xs px-2.5 py-1 rounded-full bg-canvas border border-line text-muted uppercase tracking-wide">
            Path reports
          </span>
        </div>
        <p className="text-sm text-muted">
          Path-context attempts only. Standalone launches of the same
          courses are excluded so this surface reflects the path as a
          distinct product. Sequence:{" "}
          <span className="font-medium text-ink">
            {path.sequence_mode === "strict"
              ? "Strict (in order)"
              : "Random (any order)"}
          </span>
          .
        </p>
      </div>

      {/* §1 Overall */}
      <section>
        <h2 className="serif text-2xl mb-3">Overall</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <BigStat
            label="Assigned learners"
            value={totals.assigned.toLocaleString()}
          />
          <BigStat
            label="Completed"
            value={`${(completionPct * 100).toFixed(0)}%`}
            sub={`${totals.completed.toLocaleString()} of ${totals.assigned.toLocaleString()}`}
            tone={completionPct >= 0.7 ? "good" : completionPct >= 0.4 ? "warn" : "bad"}
          />
          <BigStat
            label="In progress"
            value={totals.inProgress.toLocaleString()}
          />
          <BigStat
            label="Not started"
            value={totals.notStarted.toLocaleString()}
            tone={totals.notStarted === 0 ? "good" : "warn"}
          />
        </div>
        {passRate !== null && (
          <p className="text-xs text-muted mt-3">
            Final-step pass rate:{" "}
            <span className="text-ink font-medium">
              {(passRate * 100).toFixed(0)}%
            </span>{" "}
            ({totals.passed.toLocaleString()} passed,{" "}
            {totals.failed.toLocaleString()} failed)
          </p>
        )}
      </section>

      {/* §2 Per step */}
      <section>
        <h2 className="serif text-2xl mb-3">Per step</h2>
        <div className="border border-line rounded-2xl bg-paper overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">#</th>
                <th className="text-left px-4 py-2 font-medium">Course</th>
                <th className="text-right px-4 py-2 font-medium">Started</th>
                <th className="text-right px-4 py-2 font-medium">Completed</th>
                <th className="text-right px-4 py-2 font-medium">Passed / Failed</th>
                <th className="text-right px-4 py-2 font-medium">Avg score</th>
                <th className="text-right px-4 py-2 font-medium">Avg time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {stepMetrics.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-6 text-center text-muted"
                  >
                    This path has no steps yet.
                  </td>
                </tr>
              )}
              {stepMetrics.map((s) => (
                <tr key={s.course_id}>
                  <td className="px-4 py-3 text-muted">{s.step_number}</td>
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/${orgSlug}/library/${s.course_id}/reports`}
                      className="hover:underline"
                    >
                      {s.course_title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.learners_started}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.learners_completed}
                    <span className="text-xs text-muted ml-1">
                      (
                      {totals.assigned > 0
                        ? Math.round(
                            (s.learners_completed / totals.assigned) * 100
                          )
                        : 0}
                      %)
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-xs">
                    <span className="text-emerald-700">{s.learners_passed}</span>
                    <span className="text-muted"> / </span>
                    <span className="text-red-700">{s.learners_failed}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.average_score !== null
                      ? `${(s.average_score * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.average_minutes !== null
                      ? `${Math.round(s.average_minutes)}m`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* §3 Per learner */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="serif text-2xl">Per learner</h2>
          <Link
            href={`/${orgSlug}/learning-paths/${pathId}/learners`}
            className="text-xs text-muted hover:text-ink"
          >
            Open filterable learners view →
          </Link>
        </div>
        <div className="border border-line rounded-2xl bg-paper overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Learner</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Progress</th>
                <th className="text-right px-4 py-2 font-medium">
                  Last activity
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {perLearner.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-muted"
                  >
                    No learners are assigned to this path yet.
                  </td>
                </tr>
              )}
              {perLearner.slice(0, 200).map((l) => (
                <tr key={l.user_id} className="hover:bg-canvas/40">
                  <td className="px-4 py-3 font-medium">{l.email}</td>
                  <td className="px-4 py-3">
                    <StatusPill status={l.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {l.steps_completed} / {l.steps_total}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted">
                    {l.last_activity
                      ? new Date(l.last_activity).toISOString().slice(0, 10)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {perLearner.length > 200 && (
          <p className="text-xs text-muted mt-2">
            Showing first 200 of {perLearner.length.toLocaleString()}. Use the
            filterable learners view for full pagination.
          </p>
        )}
      </section>
    </div>
  );
}

function BigStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "bad"
          ? "text-red-700"
          : "text-ink";
  return (
    <div className="border border-line rounded-xl bg-paper p-4">
      <div className="text-[10px] text-muted uppercase tracking-wide">
        {label}
      </div>
      <div className={`serif text-2xl mt-1 ${toneClass}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: LearnerStatus["status"] }) {
  const map: Record<
    LearnerStatus["status"],
    { label: string; cls: string }
  > = {
    not_started: {
      label: "Not started",
      cls: "bg-canvas text-muted border-line",
    },
    in_progress: {
      label: "In progress",
      cls: "bg-amber-50 text-amber-800 border-amber-200",
    },
    completed: {
      label: "Completed",
      cls: "bg-ink text-canvas border-ink",
    },
    passed: {
      label: "Passed",
      cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
    },
    failed: {
      label: "Failed",
      cls: "bg-red-100 text-red-800 border-red-200",
    },
  };
  const m = map[status];
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide border ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
