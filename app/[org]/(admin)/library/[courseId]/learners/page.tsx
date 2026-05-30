import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { LearnersFilters } from "./learners-filters";

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
  attempts: number;
  lastTouched: string | null;
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
    .select("id")
    .eq("course_id", c.id);
  const versionIds = ((versionRows ?? []) as Array<{ id: string }>).map(
    (v) => v.id
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
  const { data: attemptRows } =
    enrolledUserIds.length && versionIds.length
      ? await supabase
          .from("course_attempts")
          .select(
            "user_id, course_version_id, completion_status, success_status, score, started_at, completed_at"
          )
          .in("user_id", enrolledUserIds)
          .in("course_version_id", versionIds)
      : { data: [] };
  type AttemptRow = {
    user_id: string;
    course_version_id: string;
    completion_status: string;
    success_status: string;
    score: number | null;
    started_at: string;
    completed_at: string | null;
  };
  const attempts = (attemptRows ?? []) as AttemptRow[];

  // ---- enrich one row per enrolled user ----
  const enriched: EnrichedLearner[] = enrolledUserIds.map((uid) => {
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
      attempts: myAttempts.length,
      lastTouched,
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
                <SortHeader label="Best" sortKey="best_desc" align="right" />
                <SortHeader
                  label="Attempts"
                  sortKey="attempts_desc"
                  align="right"
                />
                <SortHeader
                  label="Last activity"
                  sortKey="last_desc"
                  align="right"
                />
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
                    <td className="px-4 py-3 text-right text-xs tabular-nums">
                      {r.bestScore !== null
                        ? `${(r.bestScore * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-xs tabular-nums">
                      {r.attempts}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted whitespace-nowrap">
                      {r.lastTouched
                        ? new Date(r.lastTouched).toISOString().slice(0, 10)
                        : "—"}
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
