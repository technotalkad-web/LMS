import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

// =============================================================================
// /[org]/library/[courseId]/reports — full reports surface for a single course.
//
// Reads from the materialized views shipped in migration 0031 (#175):
//   - mv_course_enrollment_status  → §4.1 (Enrolled / Completed / In Progress / Not Started)
//   - mv_course_performance        → §4.2 (Completion Rate / Passed / Failed / Avg Score / Avg Time / Rating)
//
// Both views refresh nightly at 03:30 UTC via /api/cron/refresh-report-views (#176).
// The page surfaces the most recent refreshed_at timestamp so admins know how
// fresh the numbers are.
//
// Granular per-question breakdown (§4.3) is deferred to #179 — a separate tab
// on this page when shipped.
//
// CSV export is deferred to #182.
//
// Closes #177. RFC: docs/roadmap/analytics-and-reporting.md §5 Phase 2b.
// =============================================================================

export const dynamic = "force-dynamic";

type Course = {
  id: string;
  title: string;
  organization_id: string;
};

type EnrollmentRow = {
  course_id: string;
  total_enrolled: number;
  completed: number;
  in_progress: number;
  not_started: number;
  refreshed_at: string;
};

type PerformanceRow = {
  course_id: string;
  total_enrolled: number;
  total_completed: number;
  total_passed: number;
  total_failed: number;
  completion_rate: number; // 0..1
  average_score: number | null; // 0..1
  average_time_minutes: number | null;
  overall_rating: number | null; // 1..5
  rating_count: number;
  refreshed_at: string;
};

export default async function CourseReportsPage({
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

  // ---- Verify course is in this org ----
  const { data: course } = await supabase
    .from("courses")
    .select("id, title, organization_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) redirect(`/${orgSlug}/library`);
  const c = course as Course;

  // ---- Read the two matviews ----
  const { data: enrRow } = await supabase
    .from("mv_course_enrollment_status")
    .select("*")
    .eq("course_id", c.id)
    .maybeSingle();
  const enr = (enrRow as EnrollmentRow | null) ?? {
    course_id: c.id,
    total_enrolled: 0,
    completed: 0,
    in_progress: 0,
    not_started: 0,
    refreshed_at: new Date(0).toISOString(),
  };

  const { data: perfRow } = await supabase
    .from("mv_course_performance")
    .select("*")
    .eq("course_id", c.id)
    .maybeSingle();
  const perf = (perfRow as PerformanceRow | null) ?? {
    course_id: c.id,
    total_enrolled: 0,
    total_completed: 0,
    total_passed: 0,
    total_failed: 0,
    completion_rate: 0,
    average_score: null,
    average_time_minutes: null,
    overall_rating: null,
    rating_count: 0,
    refreshed_at: new Date(0).toISOString(),
  };

  // Use the most recent refresh stamp across the two views (they refresh
  // together in the cron but reading both makes the staleness display
  // robust to manual partial refreshes during debug).
  const lastRefreshed =
    enr.refreshed_at > perf.refreshed_at ? enr.refreshed_at : perf.refreshed_at;
  const refreshedAgo = humanizeAgo(lastRefreshed);

  // ---- Derived display values ----
  const completionPct = (perf.completion_rate * 100).toFixed(1);
  const avgScorePct =
    perf.average_score !== null ? (perf.average_score * 100).toFixed(1) : null;
  const avgTimeMin =
    perf.average_time_minutes !== null
      ? perf.average_time_minutes.toFixed(1)
      : null;
  const ratingDisplay =
    perf.overall_rating !== null ? perf.overall_rating.toFixed(2) : "—";

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <Link
          href={`/${orgSlug}/library/${c.id}`}
          className="text-muted text-sm hover:text-ink transition-colors"
        >
          ← {c.title}
        </Link>
        <div className="flex items-baseline justify-between mt-2 mb-1 gap-4 flex-wrap">
          <h1 className="serif text-4xl">Reports</h1>
          <div className="flex items-center gap-3">
            <Link
              href={`/${orgSlug}/library/${c.id}/learners`}
              className="text-sm text-ink border border-line rounded-md px-3 py-1.5 hover:bg-paper transition-colors"
              title="Drill down to per-learner status, search, and CSV export"
            >
              View all learners →
            </Link>
          </div>
        </div>
        <p className="text-xs text-muted mt-1">
          Numbers refresh nightly at 03:30 UTC ·{" "}
          <span title={lastRefreshed}>last refreshed {refreshedAgo}</span>
        </p>
      </div>

      {/* §4.1 Enrollment & status */}
      <section>
        <h2 className="serif text-xl mb-3">Enrollment &amp; status</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <BigStat
            label="Total enrolled"
            value={enr.total_enrolled.toLocaleString()}
          />
          <BigStat
            label="Completed"
            value={enr.completed.toLocaleString()}
            tone="emerald"
          />
          <BigStat
            label="In progress"
            value={enr.in_progress.toLocaleString()}
            tone="amber"
          />
          <BigStat
            label="Not started"
            value={enr.not_started.toLocaleString()}
            tone="muted"
          />
        </div>
      </section>

      {/* §4.2 Performance metrics */}
      <section>
        <h2 className="serif text-xl mb-3">Performance</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <BigStat
            label="Completion rate"
            value={`${completionPct}%`}
            tone={perf.completion_rate >= 0.7 ? "emerald" : "amber"}
          />
          <BigStat
            label="Total passed"
            value={perf.total_passed.toLocaleString()}
            tone="emerald"
          />
          <BigStat
            label="Total failed"
            value={perf.total_failed.toLocaleString()}
            tone={perf.total_failed === 0 ? "muted" : "red"}
          />
          <BigStat
            label="Average score"
            value={avgScorePct !== null ? `${avgScorePct}%` : "—"}
            sub={
              avgScorePct === null
                ? "No scored attempts yet"
                : undefined
            }
          />
          <BigStat
            label="Average time spent"
            value={avgTimeMin !== null ? `${avgTimeMin} min` : "—"}
            sub={
              avgTimeMin === null
                ? "No completed attempts yet"
                : undefined
            }
          />
          <BigStat
            label="Overall rating"
            value={ratingDisplay}
            sub={
              perf.rating_count === 0
                ? "No learner ratings yet"
                : `${perf.rating_count.toLocaleString()} ${
                    perf.rating_count === 1 ? "rating" : "ratings"
                  }`
            }
          />
        </div>
      </section>

      {/* Placeholder for §4.3 — coming in #179 */}
      <section className="border border-dashed border-line rounded-2xl bg-paper p-6 text-sm text-muted">
        <strong className="text-ink">Coming soon:</strong> per-question
        breakdown (§4.3) showing the % of attempts that answered each quiz
        question correctly, and the most common wrong answers. Tracked as
        #179.
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type StatTone = "default" | "emerald" | "amber" | "red" | "muted";

function BigStat({
  label,
  value,
  tone = "default",
  sub,
}: {
  label: string;
  value: string;
  tone?: StatTone;
  sub?: string;
}) {
  const toneClass: Record<StatTone, string> = {
    default: "text-ink",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    red: "text-red-700",
    muted: "text-muted",
  };
  return (
    <div className="border border-line rounded-2xl bg-paper p-5">
      <div className="text-xs uppercase tracking-wide text-muted mb-1">
        {label}
      </div>
      <div className={`text-3xl tabular-nums font-semibold ${toneClass[tone]}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

function humanizeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t || t === 0) return "never";
  const seconds = Math.floor((Date.now() - t) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
