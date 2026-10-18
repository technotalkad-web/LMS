import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadEnrolledCourseStatus, userCourseKey } from "@/lib/scoring/status";

// =============================================================================
// /[org]/library/[courseId]/reports — full reports surface for a single course.
//
// §4.1 (Enrolled / Completed / In Progress / Not Started) is computed live
// from the attempts with the official-status rule, through the same counter
// as the Library course card (loadEnrolledCourseStatus), so the two pages always
// agree and a learner whose only attempts were reset (abandoned, ADR 0004
// step 11) reads as not started. mv_course_enrollment_status is not read
// here: before migration 0099 it counts any attempt as a start, and from
// 0099 on it is status-aware (a reset-only learner is not started), but this
// page keeps computing live (ADR 0009 Consequences).
//
// Reads from the materialized views shipped in migration 0031 (#175):
//   - mv_course_performance        → §4.2 (Completion Rate / Passed / Failed / Avg Score / Avg Time / Rating)
//
// The views refresh nightly at 03:30 UTC via /api/cron/refresh-report-views (#176).
// The page surfaces the most recent refreshed_at timestamp so admins know how
// fresh those numbers are.
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
  // This RLS-scoped query is the security gate: it confirms the course belongs
  // to the caller's org before we touch any matview by course_id.
  const { data: course } = await supabase
    .from("courses")
    .select("id, title, organization_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) redirect(`/${orgSlug}/library`);
  const c = course as Course;

  // Report matviews carry no RLS, so they are revoked from anon/authenticated
  // (migration 0049) and read with the service role. Safe here because access is
  // already gated above (requireOrgAccess + canManage + course-in-org) and every
  // matview read below is pinned to this org-verified course_id.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ---- §4.1 Enrollment & status (live) ----
  // Enrolled = direct, team and org-wide assignments; status = each
  // learner's OFFICIAL attempt (courseStatus: abandoned attempts never count
  // as a start). One loader with the Library course card (paged, chunked,
  // caller's client as the card; the page is admin-gated above), so the two
  // pages always agree.
  const { data: versionRows } = await supabase
    .from("course_versions")
    .select("id")
    .eq("course_id", c.id);
  const versionIds = ((versionRows ?? []) as Array<{ id: string }>).map((v) => v.id);
  const { enrolledUserIds, officialByUser, summary: enr } = await loadEnrolledCourseStatus(
    supabase,
    org.id,
    c.id,
    versionIds
  );
  // "Completed" keeps its meaning: an official result, passed or failed.
  const enrCompleted = enr.completed + enr.failed;
  // Not started although they launched once: every attempt was reset.
  let enrResetOnly = 0;
  for (const uid of enrolledUserIds) {
    if (officialByUser.get(userCourseKey(uid, c.id))?.status === "not_started") enrResetOnly++;
  }

  // ---- Read the performance matview ----
  const { data: perfRow } = await svc
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

  // ---- §4.3 — Per-question breakdown ----
  // Two matviews: one with correct/incorrect counts per question, one
  // with the top wrong responses per question (added in migration 0035).
  // Both are course-scoped so the row counts stay tiny per page render.
  const { data: interactionRows } = await svc
    .from("mv_course_interaction_breakdown")
    .select(
      "interaction_id, interaction_label, total_responses, distinct_learners, correct_count, incorrect_count, correct_rate"
    )
    .eq("course_id", c.id)
    .order("interaction_id", { ascending: true });

  const { data: topWrongRows } = await svc
    .from("mv_course_interaction_top_wrong")
    .select("interaction_id, rank, response, freq")
    .eq("course_id", c.id)
    .order("interaction_id", { ascending: true })
    .order("rank", { ascending: true });

  type InteractionRow = {
    interaction_id: string;
    interaction_label: string | null;
    total_responses: number;
    distinct_learners: number;
    correct_count: number;
    incorrect_count: number;
    correct_rate: number; // 0..1
  };
  type WrongRow = {
    interaction_id: string;
    rank: number;
    response: string;
    freq: number;
  };
  const interactions = (interactionRows ?? []) as InteractionRow[];
  const topWrongByInteraction = new Map<string, WrongRow[]>();
  for (const w of (topWrongRows ?? []) as WrongRow[]) {
    const list = topWrongByInteraction.get(w.interaction_id) ?? [];
    list.push(w);
    topWrongByInteraction.set(w.interaction_id, list);
  }

  // Refresh stamp of the performance view (the enrollment tiles are live).
  const lastRefreshed = perf.refreshed_at;
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
          Enrollment &amp; status is live · performance and question numbers
          refresh nightly at 03:30 UTC ·{" "}
          <span title={lastRefreshed}>last refreshed {refreshedAgo}</span>
        </p>
      </div>

      {/* §4.1 Enrollment & status */}
      <section>
        <h2 className="serif text-xl mb-3">Enrollment &amp; status</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <BigStat
            label="Total enrolled"
            value={enr.total.toLocaleString()}
            testId="enr-total"
          />
          <BigStat
            label="Completed"
            value={enrCompleted.toLocaleString()}
            tone="emerald"
            sub={enr.failed > 0 ? `incl. ${enr.failed.toLocaleString()} failed` : undefined}
            testId="enr-completed"
          />
          <BigStat
            label="In progress"
            value={enr.inProgress.toLocaleString()}
            tone="amber"
            testId="enr-in-progress"
          />
          <BigStat
            label="Not started"
            value={enr.notStarted.toLocaleString()}
            tone="muted"
            sub={
              enrResetOnly > 0
                ? `incl. ${enrResetOnly.toLocaleString()} whose attempts were reset`
                : undefined
            }
            testId="enr-not-started"
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
                : "Official scores · practice attempts excluded"
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

      {/* §4.3 Per-question breakdown */}
      <section>
        <h2 className="serif text-xl mb-3">Per-question breakdown</h2>
        {interactions.length === 0 ? (
          <div className="border border-dashed border-line rounded-2xl bg-paper p-6 text-sm text-muted">
            <strong className="text-ink">No question data yet.</strong>{" "}
            This section populates after learners submit quiz answers in a
            cmi5 or xAPI module. SCORM 1.2 packages don&apos;t emit xAPI statements
            so their per-question detail isn&apos;t aggregated here.
          </div>
        ) : (
          <div className="border border-line rounded-2xl bg-paper overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Question</th>
                  <th className="text-right px-4 py-2 font-medium">Responses</th>
                  <th className="text-right px-4 py-2 font-medium">Correct</th>
                  <th className="text-left px-4 py-2 font-medium">
                    Most common wrong answer
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {interactions.map((q) => {
                  const wrongs = topWrongByInteraction.get(q.interaction_id) ?? [];
                  const top = wrongs[0] ?? null;
                  const restCount = wrongs.slice(1).length;
                  const correctPct = (q.correct_rate * 100).toFixed(0);
                  const tone =
                    q.correct_rate >= 0.7
                      ? "text-emerald-700"
                      : q.correct_rate >= 0.4
                        ? "text-amber-700"
                        : "text-red-700";
                  return (
                    <tr key={q.interaction_id} className="hover:bg-canvas/40">
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium">
                          {q.interaction_label ?? q.interaction_id}
                        </div>
                        {q.interaction_label && (
                          <div className="text-[11px] text-muted mt-0.5">
                            <code>{q.interaction_id}</code>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums align-top">
                        {q.total_responses.toLocaleString()}
                        <div className="text-[11px] text-muted">
                          {q.distinct_learners.toLocaleString()}{" "}
                          {q.distinct_learners === 1 ? "learner" : "learners"}
                        </div>
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums font-semibold align-top ${tone}`}
                      >
                        {correctPct}%
                        <div className="text-[11px] text-muted font-normal">
                          {q.correct_count.toLocaleString()} /{" "}
                          {q.total_responses.toLocaleString()}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        {top ? (
                          <>
                            <div className="text-sm">
                              <span className="text-ink">{top.response}</span>
                              <span className="text-muted ml-2">
                                · {top.freq.toLocaleString()}{" "}
                                {top.freq === 1 ? "pick" : "picks"}
                              </span>
                            </div>
                            {restCount > 0 && (
                              <div className="text-[11px] text-muted mt-0.5">
                                + {restCount} other{" "}
                                {restCount === 1 ? "wrong answer" : "wrong answers"}
                              </div>
                            )}
                          </>
                        ) : q.incorrect_count > 0 ? (
                          <span className="text-xs text-muted italic">
                            No response text captured
                          </span>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted mt-2">
          Up to 3 wrong-answer variants are tracked per question. Free-text
          and select-all-that-apply questions often spread across several
          near-equal distractors — worth a click into the data when the top
          pick looks small.
        </p>
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
  sub,
  tone = "default",
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: StatTone;
  testId?: string;
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "red"
          ? "text-red-700"
          : tone === "muted"
            ? "text-muted"
            : "text-ink";
  return (
    <div className="border border-line rounded-xl bg-paper p-4">
      <div className="text-[10px] text-muted uppercase tracking-wide">
        {label}
      </div>
      <div className={`serif text-3xl mt-1 ${toneClass}`} data-testid={testId}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function humanizeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t === 0) return "never";
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return "just now";
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
