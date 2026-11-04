import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { LearnersFilters } from "./learners-filters";
import { attemptCounts, computeScoring, courseStatus, excludeAbandoned } from "@/lib/scoring/policy";
import {
  GrantReadError,
  grantSnapshotForUsers,
  readWithOptionalColumn,
  type GrantSnapshot,
} from "@/lib/scoring/attempt-kind";
import {
  officialHistory,
  officialRetakeState,
  type HistoryEntry,
  type HistoryGrantInfo,
  type OfficialHistory,
  type OfficialRetakeState,
} from "@/lib/scoring/official-history";
import { fetchRevisionVisitStats, type RevisionVisitStats } from "@/lib/attempts/revision-visits";
import { resolveEmails } from "@/lib/users/emails";
import { courseProgress, formatCourseProgress, type CourseProgressView } from "@/lib/courses/progress-view";
import { resolvePolicy } from "@/lib/scoring/resolve";

// =============================================================================
// Dedicated enrolled-learners page for an admin viewing one course.
//
// Why it exists:
//   The course detail page used to render the full enrolled-learners table
//   inline. At 1000+ learners the page became unusably long and pushed
//   important course settings (assignments, reminders) far below the fold.
//   This page splits the table off so the detail page stays a clean
//   "settings" surface and learners get their own dedicated, scalable view.
//
// Scale design:
//   Filters / search / sort / pagination are all driven by URL search
//   params (q, status, via, sort, page). The server renders the right
//   slice on every request, so:
//     - links to a specific filtered view are shareable / bookmarkable
//     - browser back/forward Just Works
//     - the page can render without client JS for the basic flow
//
//   For 10k users today: we still fetch the full enrolled set in memory
//   on each request (because computing "via" requires joining assignments
//   + team_members + org members), then filter + paginate in memory. At
//   ~10k users that's ~1MB of payload and sub-100ms compute — acceptable
//   for an admin page hit infrequently. For 100k+ users we'd want a
//   materialized view (course_id, user_id, last_status, last_score) kept
//   in sync by triggers — flagged as a follow-up post-launch task.
// =============================================================================

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type Course = {
  id: string;
  title: string;
  organization_id: string;
  current_version_id: string | null;
};

type Status =
  | "not_started"
  | "in_progress"
  | "completed"
  | "passed"
  | "failed";

type ViaKind = "user" | "team" | "org";

interface EnrichedLearner {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  employee_id: string | null;
  via: ViaKind[];
  status: Status;
  bestScore: number | null;
  /** Attempts that were not reset (ADR 0004 step 11). */
  attempts: number;
  /** Reset (abandoned) attempts, shown as "· N reset". */
  resetAttempts: number;
  /**
   * ADR 0014 step 8: an abandoned grant retake, no unexpired unused grant on
   * the course and no other retake id that is a non-abandoned row: the reset
   * count reads "· N reset (retake reset, no grant)".
   */
  resetNoGrant: boolean;
  lastTouched: string | null;
  /** 0075 progress % + screens; a running granted retake's own (ADR 0014 step 10). */
  progress: CourseProgressView;
  /** ADR 0014 step 7: the official-result chain, and its retake state. */
  history: OfficialHistory;
  retake: OfficialRetakeState;
}

export default async function LearnersPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; courseId: string }>;
  searchParams: Promise<{
    q?: string;
    status?: string;
    via?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const sp = await searchParams;

  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  // ---- normalize search params (defensive, defaults applied) ----
  const q = (sp.q ?? "").trim();
  const statusParam = (sp.status ?? "all") as "all" | Status;
  const viaParam = (sp.via ?? "any") as "any" | ViaKind;
  const sort = (sp.sort ?? "last_desc") as
    | "last_desc"
    | "last_asc"
    | "email_asc"
    | "best_desc"
    | "attempts_desc";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  // ---- fetch course (verifies tenant scope) ----
  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select("id, title, organization_id, current_version_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) redirect(`/${orgSlug}/library`);
  const c = course as Course;

  // ---- fetch all versions for this course (for attempts join) ----
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

  // ---- fetch assignments + work out who's enrolled and how ----
  const { data: assignmentRows } = await supabase
    .from("course_assignments")
    .select("assignee_type, user_id, team_id")
    .eq("course_id", c.id);
  const assignments = (assignmentRows ?? []) as Array<{
    assignee_type: ViaKind;
    user_id: string | null;
    team_id: string | null;
  }>;

  // Org members (always need this for org-wide assignments + employee_id lookup)
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

  // Team members for any assigned teams.
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

  // Build viaByUser → who's enrolled, via what mechanism(s).
  const viaByUser = new Map<string, Set<ViaKind>>();
  function addVia(uid: string, v: ViaKind) {
    const s = viaByUser.get(uid) ?? new Set<ViaKind>();
    s.add(v);
    viaByUser.set(uid, s);
  }
  for (const a of assignments) {
    if (a.assignee_type === "user" && a.user_id) addVia(a.user_id, "user");
    else if (a.assignee_type === "team" && a.team_id) {
      for (const uid of teamUserIds.get(a.team_id) ?? []) addVia(uid, "team");
    } else if (a.assignee_type === "org") {
      for (const m of orgMembers) addVia(m.user_id, "org");
    }
  }
  const enrolledUserIds = Array.from(viaByUser.keys());

  // ---- resolve names + emails (service role for cross-table reads) ----
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
    // Auth users (for emails). listUsers pages at 1000 — call multiple
    // times for orgs over that size.
    let pageNum = 1;
    let fetched = 0;
    while (true) {
      const { data: authPage } = await svc.auth.admin.listUsers({
        page: pageNum,
        perPage: 1000,
      });
      const users = authPage?.users ?? [];
      for (const u of users) {
        if (u.email) emailByUser.set(u.id, u.email);
      }
      fetched += users.length;
      if (users.length < 1000) break;
      pageNum += 1;
      // Safety cap: don't loop forever if listUsers misbehaves.
      if (pageNum > 50) break;
    }
    void fetched;

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

  // ---- fetch attempts ----
  // ADR 0014 step 7: the select names is_revision through the narrower-select
  // fallback, so counts, dates, progress and the chain drop revision rows (a
  // database without 0103 has none and reads every row as unflagged).
  const ATTEMPT_COLUMNS =
    "id, user_id, course_version_id, status, completion_status, success_status, score, started_at, completed_at, progress_pct, units:cmi_data->cmi5->units";
  const { data: attemptRows } =
    enrolledUserIds.length && versionIds.length
      ? await readWithOptionalColumn<unknown[]>(
          "is_revision",
          (columns) =>
            supabase
              .from("course_attempts")
              .select(columns)
              .in("user_id", enrolledUserIds)
              .in("course_version_id", versionIds),
          ATTEMPT_COLUMNS
        )
      : { data: [] };
  type AttemptRow = {
    id: string;
    user_id: string;
    progress_pct?: number | null;
    units?: unknown;
    course_version_id: string;
    /** ADR 0004 step 11: courseStatus()/courseProgress() leave abandoned attempts out. */
    status: string | null;
    /** ADR 0014 (0103): a revision visit's row is never an attempt. */
    is_revision?: boolean | null;
    completion_status: string;
    success_status: string;
    score: number | null;
    started_at: string;
    completed_at: string | null;
  };
  const attempts = (attemptRows ?? []) as AttemptRow[];

  // 0073: this course's attempt scoring rule (fail-soft → default).
  const scoringPolicy = await resolvePolicy(supabase, c.id);
  // 0083 / ADR 0014 step 7 (strict reads): the grant links behind the
  // official-result chain, in one strict bulk read used two ways. On a failed
  // read the result columns keep a one-render fallback (no retake ids) while
  // the History cell reads "History unavailable. Please reload." (ADR
  // 0014:188). A missing relation is "no grants" inside the reader.
  let snapshots = new Map<string, GrantSnapshot>();
  let historyUnavailable = false;
  try {
    snapshots = await grantSnapshotForUsers(svc, org.id, [c.id], enrolledUserIds);
  } catch (e) {
    if (!(e instanceof GrantReadError)) throw e;
    console.warn("[learners] grant read failed:", e.code);
    historyUnavailable = true;
  }
  const noGrants: GrantSnapshot = { retakeIds: new Set<string>(), unusedGrant: null, rows: [] };

  // ---- enrich one row per enrolled user ----
  const enriched: EnrichedLearner[] = enrolledUserIds.map((uid) => {
    const myAttempts = attempts.filter((a) => a.user_id === uid);
    const latest = myAttempts
      .slice()
      .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))[0];
    // 0081 revision rule: status and score follow the OFFICIAL attempt (inside
    // the scoring window). ADR 0014: a revision visit neither changes the
    // verdict nor the score, and is counted in the Revisits column only.
    const snapshot = snapshots.get(`${uid}:${c.id}`) ?? noGrants;
    const scoring = computeScoring(myAttempts, scoringPolicy, snapshot.retakeIds);
    // ADR 0014 step 10: "in_progress" while a granted retake runs.
    const status: Status = latest ? courseStatus(scoring, myAttempts) : "not_started";
    const bestScore = scoring.officialScore;
    const history = officialHistory(myAttempts, snapshot.rows);
    const retake = officialRetakeState(history);
    // ADR 0014:186, verbatim: "an abandoned grant retake whose learner holds no
    // unexpired unused grant on the course and no other retake id that is a
    // non-abandoned row is labelled 'retake reset, no grant'". Every clause
    // reads the strict snapshot: its unusedGrant
    // is the oldest approved grant with used_at null and expires_at null or
    // in the future, so "holds no unexpired unused grant" is
    // `snapshot.unusedGrant === null`. Only when the history was read: a
    // failed read leaves the label absent, never wrong (ADR 0014:186).
    const resetNoGrant =
      !historyUnavailable &&
      history.reset.length > 0 &&
      snapshot.unusedGrant === null &&
      !myAttempts.some((a) => snapshot.retakeIds.has(a.id) && a.status !== "abandoned");
    // ADR 0004 step 11: a reset (abandoned) attempt is counted apart and
    // never dates the learner's last activity on the course.
    const counts = attemptCounts(myAttempts);
    const lastTouched =
      excludeAbandoned(myAttempts)
        .map((a) => a.completed_at ?? a.started_at)
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? null;
    const profile = profileByUser.get(uid);
    return {
      user_id: uid,
      email: emailByUser.get(uid) ?? uid.slice(0, 8),
      first_name: profile?.first_name ?? null,
      last_name: profile?.last_name ?? null,
      employee_id: employeeIdByUser.get(uid) ?? null,
      via: Array.from(viaByUser.get(uid) ?? []),
      status,
      bestScore,
      attempts: counts.live,
      resetAttempts: counts.reset,
      resetNoGrant,
      lastTouched,
      // A per-course display: the running retake's progress (ADR 0014 step 10).
      progress: courseProgress(myAttempts, unitCountByVersion, { retakeIds: snapshot.retakeIds }),
      history,
      retake,
    };
  });

  // ---- apply filters ----
  // q applies first (matches across name/email/employee_id), then via,
  // then status. We compute the status-chip counts AFTER q+via but
  // BEFORE status so chips show the live counts the user would see if
  // they clicked into each status.
  const qLower = q.toLowerCase();
  const afterQ = qLower
    ? enriched.filter((r) => {
        const haystack = [
          r.email,
          r.employee_id ?? "",
          r.first_name ?? "",
          r.last_name ?? "",
          `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        ]
          .map((s) => s.toLowerCase())
          .filter(Boolean);
        return haystack.some((s) => s.includes(qLower));
      })
    : enriched;

  const afterVia =
    viaParam === "any" ? afterQ : afterQ.filter((r) => r.via.includes(viaParam));

  const statusCounts = {
    all: afterVia.length,
    not_started: afterVia.filter((r) => r.status === "not_started").length,
    in_progress: afterVia.filter((r) => r.status === "in_progress").length,
    completed: afterVia.filter((r) => r.status === "completed").length,
    passed: afterVia.filter((r) => r.status === "passed").length,
    failed: afterVia.filter((r) => r.status === "failed").length,
  };

  const afterStatus =
    statusParam === "all"
      ? afterVia
      : afterVia.filter((r) => r.status === statusParam);

  // ---- sort ----
  const sorted = afterStatus.slice();
  switch (sort) {
    case "email_asc":
      sorted.sort((a, b) => a.email.localeCompare(b.email));
      break;
    case "best_desc":
      sorted.sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1));
      break;
    case "attempts_desc":
      sorted.sort((a, b) => b.attempts - a.attempts);
      break;
    case "last_asc":
      sorted.sort((a, b) =>
        (a.lastTouched ?? "").localeCompare(b.lastTouched ?? "")
      );
      break;
    case "last_desc":
    default:
      sorted.sort((a, b) =>
        (b.lastTouched ?? "").localeCompare(a.lastTouched ?? "")
      );
      break;
  }

  // ---- paginate ----
  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * PAGE_SIZE;
  const slice = sorted.slice(startIdx, startIdx + PAGE_SIZE);

  // ---- revision visits for this page's learners only (ADR 0014 step 7) ----
  // revision_visits is deny-all: service client. Bounded by PAGE_SIZE.
  const visits: RevisionVisitStats =
    slice.length > 0
      ? await fetchRevisionVisitStats(svc, { orgId: org.id, courseIds: [c.id], userIds: slice.map((r) => r.user_id) })
      : { byPair: new Map(), capped: false, failed: false };
  // The History cells' "Granted by <email>": the deciders on this page, one read.
  const deciderIds = new Set<string>();
  for (const r of slice) {
    for (const e of r.history.entries) if (e.grant?.decidedBy) deciderIds.add(e.grant.decidedBy);
    if (r.history.running?.grant?.decidedBy) deciderIds.add(r.history.running.grant.decidedBy);
    for (const x of r.history.reset) if (x.grant.decidedBy) deciderIds.add(x.grant.decidedBy);
  }
  const deciderEmail = deciderIds.size > 0 ? await resolveEmails(svc, deciderIds) : new Map<string, string>();
  const attemptHref = (attemptId: string) => `/${orgSlug}/courses/${c.id}/attempts/${attemptId}`;

  // ---- helpers to build URLs that preserve other params ----
  function hrefWith(updates: Record<string, string | number | null>) {
    const next = new URLSearchParams();
    const all: Record<string, string | number | null | undefined> = {
      q,
      status: statusParam,
      via: viaParam,
      sort,
      page: safePage,
      ...updates,
    };
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined || v === null || v === "") continue;
      const s = String(v);
      if (
        (k === "status" && s === "all") ||
        (k === "via" && s === "any") ||
        (k === "sort" && s === "last_desc") ||
        (k === "page" && s === "1")
      )
        continue;
      next.set(k, s);
    }
    const qs = next.toString();
    return qs
      ? `/${orgSlug}/library/${c.id}/learners?${qs}`
      : `/${orgSlug}/library/${c.id}/learners`;
  }

  function SortHeader({
    label,
    sortKey,
    align = "left",
  }: {
    label: string;
    sortKey: typeof sort;
    align?: "left" | "right";
  }) {
    const active = sort === sortKey;
    return (
      <th
        className={`px-4 py-2 font-medium ${
          align === "right" ? "text-right" : "text-left"
        }`}
      >
        <Link
          href={hrefWith({ sort: sortKey, page: 1 })}
          className={`hover:text-ink transition-colors ${
            active ? "text-ink" : ""
          }`}
        >
          {label}
          {active && <span className="ml-1 text-[10px]">▼</span>}
        </Link>
      </th>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <Link
          href={`/${orgSlug}/library/${c.id}`}
          className="text-muted text-sm hover:text-ink transition-colors"
        >
          ← {c.title}
        </Link>
        <div className="flex items-baseline justify-between mt-2 mb-1 gap-4 flex-wrap">
          <h1 className="serif text-4xl">Enrolled learners</h1>
          <div className="flex items-center gap-4">
            <a
              href={`/api/courses/${c.id}/learners/export?orgSlug=${encodeURIComponent(orgSlug)}`}
              className="text-sm text-ink border border-line rounded-md px-3 py-1.5 hover:bg-paper transition-colors inline-flex items-center gap-1.5"
              download
              title="Download all enrolled learners as CSV (includes filtered-out rows)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3.5 h-3.5"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download CSV
            </a>
            <div className="text-sm text-muted tabular-nums">
              {totalRows.toLocaleString()} total
              {totalRows !== enriched.length && (
                <> · {enriched.length.toLocaleString()} matching filters cleared</>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Filter UI (URL-driven client component). */}
      <LearnersFilters counts={statusCounts} />

      {/* Table */}
      {slice.length === 0 ? (
        <div className="border border-line rounded-2xl bg-paper p-12 text-muted text-sm text-center">
          {enriched.length === 0 ? (
            <>
              No learners are enrolled in this course yet. Add some in the{" "}
              <Link
                href={`/${orgSlug}/library/${c.id}`}
                className="text-ink underline-offset-4 hover:underline"
              >
                Assignments section
              </Link>
              .
            </>
          ) : (
            <>
              No learners match the current filters.{" "}
              <Link
                href={hrefWith({ q: null, status: null, via: null, page: 1 })}
                className="text-ink underline-offset-4 hover:underline"
              >
                Clear filters
              </Link>
              .
            </>
          )}
        </div>
      ) : (
        <div className="border border-line rounded-2xl bg-paper overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
              <tr>
                <SortHeader label="Learner" sortKey="email_asc" />
                <th className="text-left px-4 py-2 font-medium">Source</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Progress</th>
                <SortHeader label="Best" sortKey="best_desc" align="right" />
                <SortHeader
                  label="Attempts"
                  sortKey="attempts_desc"
                  align="right"
                />
                <th className="text-right px-4 py-2 font-medium" title="Revision visits (review only, never an attempt): count · last revisit">
                  Revisits
                </th>
                <SortHeader
                  label="Last activity"
                  sortKey="last_desc"
                  align="right"
                />
                <th className="text-left px-4 py-2 font-medium">History</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {slice.map((r) => {
                const name = [r.first_name, r.last_name]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={r.user_id} className="hover:bg-canvas/40">
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-ink truncate">
                        {name || r.email}
                      </div>
                      <div className="text-xs text-muted truncate flex items-center gap-2 mt-0.5">
                        {r.employee_id && (
                          <span className="bg-canvas border border-line rounded px-1.5 py-0.5 text-[10px] font-mono shrink-0">
                            {r.employee_id}
                          </span>
                        )}
                        {name && <span className="truncate">{r.email}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {r.via
                        .map((v) =>
                          v === "user"
                            ? "Direct"
                            : v === "team"
                              ? "Team"
                              : "Org-wide"
                        )
                        .join(" · ")}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums whitespace-nowrap">
                      {r.status === "not_started" ? "—" : formatCourseProgress(r.progress)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs tabular-nums whitespace-nowrap">
                      {/* ADR 0014 step 7: the standing result and the retake's state. */}
                      {r.retake.state === "in_progress" && r.retake.current
                        ? `${resultLabel(r.retake.current)} → retake in progress`
                        : r.retake.state === "completed" && r.retake.previous && r.retake.current
                          ? `${resultLabel(r.retake.previous)} → ${resultLabel(r.retake.current)}`
                          : r.bestScore !== null
                            ? `${(r.bestScore * 100).toFixed(0)}%`
                            : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-xs tabular-nums whitespace-nowrap">
                      {r.attempts}
                      {r.resetAttempts > 0 && (
                        <span className="text-muted" title="Attempts reset by a module update or language switch: never in progress, never official">
                          {" "}· {r.resetAttempts} reset{r.resetNoGrant ? " (retake reset, no grant)" : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-xs tabular-nums text-muted whitespace-nowrap">
                      {revisitsCell(visits, `${r.user_id}:${c.id}`)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted whitespace-nowrap">
                      {r.lastTouched
                        ? new Date(r.lastTouched).toISOString().slice(0, 10)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs align-top">
                      <HistoryCell
                        learner={r}
                        unavailable={historyUnavailable}
                        deciderEmail={deciderEmail}
                        attemptHref={attemptHref}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalRows > PAGE_SIZE && (
        <nav className="flex items-center justify-between text-sm text-muted">
          <div>
            Showing{" "}
            <span className="text-ink tabular-nums">
              {(startIdx + 1).toLocaleString()}–
              {Math.min(startIdx + PAGE_SIZE, totalRows).toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="text-ink tabular-nums">
              {totalRows.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {safePage > 1 ? (
              <Link
                href={hrefWith({ page: safePage - 1 })}
                className="px-3 py-1.5 border border-line rounded-lg hover:border-ink"
              >
                ← Previous
              </Link>
            ) : (
              <span className="px-3 py-1.5 border border-line rounded-lg opacity-50">
                ← Previous
              </span>
            )}
            <span className="text-xs tabular-nums">
              Page {safePage} of {totalPages}
            </span>
            {safePage < totalPages ? (
              <Link
                href={hrefWith({ page: safePage + 1 })}
                className="px-3 py-1.5 border border-line rounded-lg hover:border-ink"
              >
                Next →
              </Link>
            ) : (
              <span className="px-3 py-1.5 border border-line rounded-lg opacity-50">
                Next →
              </span>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const tones: Record<Status, string> = {
    not_started: "bg-canvas text-muted border-line",
    in_progress: "bg-amber-50 text-amber-800 border-amber-200",
    completed: "bg-indigo-50 text-indigo-800 border-indigo-200",
    passed: "bg-emerald-50 text-emerald-800 border-emerald-200",
    failed: "bg-red-50 text-red-800 border-red-200",
  };
  const label: Record<Status, string> = {
    not_started: "Not started",
    in_progress: "In progress",
    completed: "Completed",
    passed: "Passed",
    failed: "Failed",
  };
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border ${tones[status]}`}
    >
      {label[status]}
    </span>
  );
}

// -----------------------------------------------------------------------------
// ADR 0014 step 7: the result cell's retake marker, the Revisits column and the
// per-learner History expander (server-rendered <details>: no client
// component, no route, no folder). Scores are 0..1.
// -----------------------------------------------------------------------------

function isoDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—";
}

const resultWord = (e: HistoryEntry) =>
  e.status === "passed" ? "Passed" : e.status === "failed" ? "Not passed" : "Completed";

/** "Passed 85 %", "Not passed 60 %", "Completed". */
function resultLabel(e: HistoryEntry): string {
  return e.score !== null ? `${resultWord(e)} ${Math.round(e.score * 100)} %` : resultWord(e);
}

/** "3 · 2026-10-28"; "N+" past the read cap; "—" when none or the read failed. */
function revisitsCell(visits: RevisionVisitStats, key: string): string {
  if (visits.failed) return "—";
  const v = visits.byPair.get(key);
  if (!v || v.count === 0) return "—";
  return `${v.count}${visits.capped ? "+" : ""}${v.last ? ` · ${isoDate(v.last)}` : ""}`;
}

/**
 * "Granted by <email> on <date>: <reason>", from the grant originally
 * approved (followed through reissued_from), plus "re-issued on <date> after
 * a module update" for a re-issue (ADR 0014:185).
 */
function grantLine(g: HistoryGrantInfo, deciderEmail: Map<string, string>): string {
  const who = (g.decidedBy ? deciderEmail.get(g.decidedBy) : undefined) ?? "a former administrator";
  const why = g.decisionNote ?? g.reason;
  const reissued = g.reissuedAt ? ` · re-issued on ${isoDate(g.reissuedAt)} after a module update` : "";
  return `Granted by ${who}${g.decidedAt ? ` on ${isoDate(g.decidedAt)}` : ""}${why ? `: ${why}` : ""}${reissued}`;
}

function HistoryCell({
  learner,
  unavailable,
  deciderEmail,
  attemptHref,
}: {
  learner: EnrichedLearner;
  unavailable: boolean;
  deciderEmail: Map<string, string>;
  attemptHref: (attemptId: string) => string;
}) {
  // ADR 0014:188: with the grant links unread the chain would be wrong, not
  // empty, so nothing but the text is shown.
  if (unavailable) return <span className="text-amber-800">History unavailable. Please reload.</span>;
  const { history } = learner;
  type Line = { key: string; at: number; attemptId: string; text: string; grant: HistoryGrantInfo | null };
  const lines: Line[] = [];
  const entryById = new Map(history.entries.map((e) => [e.attemptId, e]));
  for (const e of history.entries) {
    const head = `${isoDate(e.completedAt)} · ${e.score !== null ? `${Math.round(e.score * 100)} % · ` : ""}${resultWord(e)}`;
    const next = e.supersededBy ? entryById.get(e.supersededBy) : undefined;
    lines.push({
      key: e.attemptId,
      at: Date.parse(e.completedAt),
      attemptId: e.attemptId,
      text: next ? `${head} · Replaced by a granted retake on ${isoDate(next.completedAt)}` : `${head} · Official result`,
      grant: e.grant,
    });
  }
  for (const x of history.reset) {
    lines.push({
      key: `reset:${x.attemptId}`,
      at: Date.parse(x.startedAt),
      attemptId: x.attemptId,
      text: `${isoDate(x.startedAt)} · Granted retake, reset by a module update`,
      grant: x.grant,
    });
  }
  // Newest first; the running retake, the chain's open end, on top.
  lines.sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0));
  if (history.running) {
    const pct = learner.progress.pct;
    lines.unshift({
      key: `running:${history.running.attemptId}`,
      at: Number.POSITIVE_INFINITY,
      attemptId: history.running.attemptId,
      text: `Official retake in progress${pct !== null ? ` · ${pct} %` : ""}`,
      grant: history.running.grant,
    });
  }
  if (lines.length === 0) return <span className="text-muted">—</span>;
  return (
    <details>
      <summary className="cursor-pointer text-ink whitespace-nowrap">History</summary>
      <ul className="mt-2 space-y-1.5 min-w-[18rem]">
        {lines.map((l) => (
          <li key={l.key}>
            <Link href={attemptHref(l.attemptId)} className="text-ink hover:underline">
              {l.text}
            </Link>
            {l.grant && <div className="text-muted">{grantLine(l.grant, deciderEmail)}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}
