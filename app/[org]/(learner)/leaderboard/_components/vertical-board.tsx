import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Building2, EyeOff, GitBranch, Lock, MapPin, Users } from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";

/**
 * Business-vertical performance board: City → Branch → Team Leader → Members.
 *
 * Everything derives live from the User Profile Database — hierarchy comes
 * from organization_members (business_vertical, city, branch,
 * line_manager_id) and identity from profiles, both read at render time so
 * profile edits reflect immediately. Cities that don't use branches render
 * as the plain three-level view. Only the per-learner course metrics
 * (assigned / completed / avg score) come from mv_learner_metrics,
 * precomputed on the 15-min gamification refresh (Workers CPU budget).
 *
 * Query discipline: non-admin viewers only ever render their own vertical,
 * so their member read is scoped by business_vertical (0056 index); admins
 * need the whole org for the picker + Unassigned bucket. Both paths paginate
 * past PostgREST's 1000-row response cap, and metrics/profiles/opt-out reads
 * are chunked .in() queries run in parallel.
 *
 * Access: learners see ONLY their own vertical, and only aggregate numbers
 * plus their own row. A team leader additionally sees the member rows of
 * their own reports (admin-toggleable via leaderboard_team_leader_view).
 * Admins see every vertical (picker), every level, every row. The
 * leaderboard opt-out is honored for non-admin viewers: opted-out learners
 * never appear as named rows (a "+N hidden" note keeps counts honest), and
 * one-person aggregates that would reveal an individual are masked.
 */

type Member = {
  user_id: string;
  business_vertical: string | null;
  city: string | null;
  branch: string | null;
  line_manager_id: string | null;
};
type Metric = {
  user_id: string;
  courses_assigned: number;
  courses_completed: number;
  avg_score: number | null;
  refreshed_at: string;
};
type Profile = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar_url: string | null;
};

const UNASSIGNED = "__unassigned__";
const PAGE = 1000; // PostgREST caps a single response at 1000 rows
const CHUNK = 150; // ids per .in() query (URL-length headroom)

const MEMBER_COLS = "user_id, business_vertical, city, branch, line_manager_id";

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** Paginated members read — a single .eq() response silently caps at 1000. */
async function fetchMembers(
  svc: SupabaseClient,
  orgId: string,
  vertical?: string | null // undefined = whole org; null = unassigned bucket
): Promise<Member[]> {
  const rows: Member[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = svc
      .from("organization_members")
      .select(MEMBER_COLS)
      .eq("organization_id", orgId)
      .eq("status", "active")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (vertical !== undefined) {
      q = vertical === null ? q.is("business_vertical", null) : q.eq("business_vertical", vertical);
    }
    const { data } = await q;
    const page = (data ?? []) as Member[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

function nameOf(p: Profile | undefined, fallback = "Learner"): string {
  if (!p) return fallback;
  return (
    [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
    (p.email ?? "").split("@")[0] ||
    fallback
  );
}

type Rollup = {
  learners: number;
  assigned: number;
  completed: number;
  pending: number;
  avgScore: number | null;
};

function rollup(ids: string[], metrics: Map<string, Metric>): Rollup {
  let assigned = 0;
  let completed = 0;
  const scores: number[] = [];
  for (const id of ids) {
    const m = metrics.get(id);
    if (!m) continue;
    assigned += m.courses_assigned;
    completed += m.courses_completed;
    if (m.avg_score !== null) scores.push(Number(m.avg_score));
  }
  return {
    learners: ids.length,
    assigned,
    completed,
    pending: assigned - completed,
    avgScore: scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null,
  };
}

export async function VerticalBoard({
  orgId,
  orgSlug,
  viewerId,
  isAdminViewer,
  leaderViewEnabled,
  allowOptOut,
  requestedVertical,
}: {
  orgId: string;
  orgSlug: string;
  viewerId: string;
  isAdminViewer: boolean;
  leaderViewEnabled: boolean;
  allowOptOut: boolean;
  requestedVertical?: string;
}) {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ---- Which vertical is visible, and the members inside it ----
  let selected: string | null = null;
  let scope: Member[] = [];
  let verticals: string[] = [];
  let hasUnassigned = false;

  if (isAdminViewer) {
    const members = await fetchMembers(svc, orgId);
    verticals = Array.from(
      new Set(members.map((m) => m.business_vertical).filter((v): v is string => !!v))
    ).sort();
    hasUnassigned = members.some((m) => !m.business_vertical);
    selected =
      requestedVertical &&
      (verticals.includes(requestedVertical) || requestedVertical === UNASSIGNED)
        ? requestedVertical
        : verticals[0] ?? (hasUnassigned ? UNASSIGNED : null);
    scope = members.filter((m) =>
      selected === UNASSIGNED ? !m.business_vertical : m.business_vertical === selected
    );
  } else {
    const { data: me } = await svc
      .from("organization_members")
      .select("business_vertical")
      .eq("organization_id", orgId)
      .eq("user_id", viewerId)
      .eq("status", "active")
      .maybeSingle();
    selected = (me as { business_vertical?: string | null } | null)?.business_vertical ?? null;
    if (selected) scope = await fetchMembers(svc, orgId, selected);
  }

  if (!selected) {
    return (
      <div className="bg-paper border border-line rounded-2xl text-center py-14 px-6">
        <Building2 className="w-10 h-10 mx-auto text-muted opacity-40" />
        <h2 className="mt-4 font-semibold">
          {isAdminViewer
            ? "No business verticals in use yet"
            : "You're not assigned to a business vertical yet"}
        </h2>
        <p className="text-muted text-sm mt-1 max-w-md mx-auto">
          {isAdminViewer
            ? "Assign a Business Vertical (Retail, Institutional, Fulfillment) on user profiles — the board builds itself from those assignments."
            : "Once your administrator assigns your vertical, your team's performance appears here."}
        </p>
      </div>
    );
  }

  const scopeIds = scope.map((m) => m.user_id);
  const leaderIds = Array.from(
    new Set(scope.map((m) => m.line_manager_id).filter((x): x is string => !!x))
  );
  const idWant = Array.from(new Set([...scopeIds, ...leaderIds]));

  // Metrics + identity + opt-out in parallel, chunked past URL limits.
  const [metricRows, profRows, optRows] = await Promise.all([
    Promise.all(
      chunks(scopeIds, CHUNK).map(async (ids) => {
        const { data } = await svc
          .from("mv_learner_metrics")
          .select("user_id, courses_assigned, courses_completed, avg_score, refreshed_at")
          .eq("organization_id", orgId)
          .in("user_id", ids);
        return (data ?? []) as Metric[];
      })
    ).then((r) => r.flat()),
    Promise.all(
      chunks(idWant, CHUNK).map(async (ids) => {
        const { data } = await svc
          .from("profiles")
          .select("id, first_name, last_name, email, avatar_url")
          .in("id", ids);
        return (data ?? []) as Profile[];
      })
    ).then((r) => r.flat()),
    Promise.all(
      chunks(scopeIds, CHUNK).map(async (ids) => {
        const { data } = await svc
          .from("user_gamification")
          .select("user_id, opted_out")
          .eq("organization_id", orgId)
          .eq("opted_out", true)
          .in("user_id", ids);
        return (data ?? []) as Array<{ user_id: string }>;
      })
    ).then((r) => r.flat()),
  ]);
  const metrics = new Map(metricRows.map((m) => [m.user_id, m]));
  const profiles = new Map(profRows.map((p) => [p.id, p]));
  // Leaderboard privacy opt-out (0053): honored for non-admin viewers.
  const hidden = new Set(allowOptOut ? optRows.map((r) => r.user_id) : []);

  const viewerIsLeaderHere = scope.some((m) => m.line_manager_id === viewerId);
  const canSeeMembersOf = (leaderId: string | null) =>
    isAdminViewer || (leaderViewEnabled && leaderId === viewerId);

  // A one-person "aggregate" IS that person's individual performance —
  // mask it from viewers who aren't allowed to see the person's row.
  const maskedFor = (ids: string[], leaderId: string | null = null) =>
    !isAdminViewer &&
    !canSeeMembersOf(leaderId) &&
    ids.length === 1 &&
    ids[0] !== viewerId;

  // Team-leader groups for one city/branch slice (shared by both layouts).
  const renderLeaderGroups = (groupMembers: Member[]) => {
    const leaders = groupBy(groupMembers, (m) => m.line_manager_id ?? "");
    const leaderKeys = Array.from(leaders.keys()).sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return nameOf(profiles.get(a)).localeCompare(nameOf(profiles.get(b)));
    });
    return (
      <div className="divide-y divide-line">
        {leaderKeys.map((lk) => {
          const team = leaders.get(lk)!;
          const teamIds = team.map((m) => m.user_id);
          const teamRoll = rollup(teamIds, metrics);
          const leaderProfile = lk ? profiles.get(lk) : undefined;
          const showMembers = canSeeMembersOf(lk || null);
          const myRow = team.find((m) => m.user_id === viewerId);
          // Opted-out learners never render as named rows for non-admins —
          // not even for their team leader ("others can't see you").
          const visibleTeam = isAdminViewer
            ? team
            : team.filter((m) => !hidden.has(m.user_id) || m.user_id === viewerId);
          const hiddenCount = team.length - visibleTeam.length;

          return (
            <details
              key={lk || "none"}
              open={!isAdminViewer && lk === viewerId}
              className="group"
            >
              <summary className="px-4 sm:px-5 py-3 cursor-pointer list-none flex flex-wrap items-center justify-between gap-3 hover:bg-canvas/50">
                <span className="inline-flex items-center gap-3 min-w-0">
                  {lk ? (
                    <>
                      <Avatar
                        name={nameOf(leaderProfile)}
                        avatarUrl={leaderProfile?.avatar_url}
                        size="sm"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium truncate">
                          {nameOf(leaderProfile)}
                          {lk === viewerId && (
                            <span className="text-indigo-600 text-xs ml-1.5">(you)</span>
                          )}
                        </span>
                        <span className="block text-[11px] text-muted">
                          Team Leader · {team.length} member{team.length === 1 ? "" : "s"}
                        </span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-canvas border border-line shrink-0">
                        <Users className="w-4 h-4 text-muted" />
                      </span>
                      <span>
                        <span className="block font-medium">No team leader set</span>
                        <span className="block text-[11px] text-muted">
                          {team.length} member{team.length === 1 ? "" : "s"}
                        </span>
                      </span>
                    </>
                  )}
                </span>
                <MiniStats r={teamRoll} masked={maskedFor(teamIds, lk || null)} />
              </summary>

              {showMembers ? (
                <div>
                  <MemberTable
                    team={visibleTeam}
                    metrics={metrics}
                    profiles={profiles}
                    viewerId={viewerId}
                  />
                  {hiddenCount > 0 && (
                    <p className="px-4 sm:px-5 pb-3 -mt-2 text-xs text-muted inline-flex items-center gap-1.5">
                      <EyeOff className="w-3 h-3" />
                      {hiddenCount} member{hiddenCount === 1 ? "" : "s"} hidden by
                      leaderboard privacy settings.
                    </p>
                  )}
                </div>
              ) : (
                <div className="px-4 sm:px-5 pb-4">
                  {myRow && (
                    <MemberTable
                      team={[myRow]}
                      metrics={metrics}
                      profiles={profiles}
                      viewerId={viewerId}
                      caption="Your performance"
                    />
                  )}
                  <p className="text-xs text-muted inline-flex items-center gap-1.5 mt-2">
                    <Lock className="w-3 h-3" />
                    Member details are visible to the team leader and admins.
                  </p>
                </div>
              )}
            </details>
          );
        })}
      </div>
    );
  };

  // ---- City → branch → leader grouping (derived, nothing stored) ----
  const cities = groupBy(scope, (m) => m.city?.trim() || "No city set");
  const cityNames = Array.from(cities.keys()).sort((a, b) =>
    a === "No city set" ? 1 : b === "No city set" ? -1 : a.localeCompare(b)
  );

  const total = rollup(scopeIds, metrics);
  const refreshedAt = metricRows[0]?.refreshed_at ?? null;

  return (
    <div className="space-y-6">
      {/* Vertical picker (admins) / identity line (everyone) */}
      <div className="flex flex-wrap items-center gap-2">
        {isAdminViewer ? (
          <>
            {verticals.map((v) => (
              <Link
                key={v}
                href={`/${orgSlug}/leaderboard?board=vertical&v=${encodeURIComponent(v)}`}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  selected === v
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "border-line hover:border-ink"
                }`}
              >
                {v}
              </Link>
            ))}
            {hasUnassigned && (
              <Link
                href={`/${orgSlug}/leaderboard?board=vertical&v=${UNASSIGNED}`}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  selected === UNASSIGNED
                    ? "bg-slate-600 text-white border-slate-600"
                    : "border-line text-muted hover:border-ink"
                }`}
              >
                Unassigned
              </Link>
            )}
          </>
        ) : (
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm bg-indigo-50 text-indigo-700 font-medium">
            <Building2 className="w-4 h-4" />
            {selected} vertical
          </span>
        )}
        {viewerIsLeaderHere && !isAdminViewer && (
          <span className="text-xs text-muted">
            {leaderViewEnabled
              ? "As a team leader you can see your team members' performance."
              : "Member-level details are currently disabled by your administrator."}
          </span>
        )}
      </div>

      {/* Vertical totals */}
      <StatsRow
        r={total}
        prefixIcon={<Building2 className="w-4 h-4 text-indigo-600" />}
        label={selected === UNASSIGNED ? "Unassigned members" : `${selected} — overall`}
        big
      />

      {/* City → Branch → Team Leader → Members */}
      {cityNames.map((city) => {
        const cityMembers = cities.get(city)!;
        const cityIds = cityMembers.map((m) => m.user_id);
        const cityRoll = rollup(cityIds, metrics);

        const branches = groupBy(cityMembers, (m) => m.branch?.trim() || "");
        const branchNames = Array.from(branches.keys()).sort((a, b) => {
          if (!a) return 1;
          if (!b) return -1;
          return a.localeCompare(b);
        });
        // A city that doesn't use branches keeps the simple 3-level layout.
        const useBranchLayer = !(branchNames.length === 1 && branchNames[0] === "");

        return (
          <section key={city} className="bg-paper border border-line rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3 border-b border-line flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold inline-flex items-center gap-2">
                <MapPin className="w-4 h-4 text-indigo-600" />
                {city}
                {useBranchLayer && (
                  <span className="text-[11px] text-muted font-normal">
                    {branchNames.filter(Boolean).length} branch
                    {branchNames.filter(Boolean).length === 1 ? "" : "es"}
                  </span>
                )}
              </h2>
              <MiniStats r={cityRoll} masked={maskedFor(cityIds)} />
            </div>

            {useBranchLayer ? (
              branchNames.map((bn) => {
                const branchMembers = branches.get(bn)!;
                const branchIds = branchMembers.map((m) => m.user_id);
                const branchRoll = rollup(branchIds, metrics);
                return (
                  <div key={bn || "none"} className="border-b border-line last:border-b-0">
                    <div className="px-4 sm:px-5 py-2 bg-canvas/50 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold inline-flex items-center gap-2">
                        <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
                        {bn || "No branch set"}
                      </h3>
                      <MiniStats r={branchRoll} masked={maskedFor(branchIds)} />
                    </div>
                    {renderLeaderGroups(branchMembers)}
                  </div>
                );
              })
            ) : (
              renderLeaderGroups(cityMembers)
            )}
          </section>
        );
      })}

      {refreshedAt && (
        <p className="text-[11px] text-muted">
          Course metrics refresh every 15 minutes; names, photos, cities,
          branches, teams and verticals update immediately from user profiles.
        </p>
      )}
    </div>
  );
}

/* -------- presentational bits -------- */

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function StatsRow({
  r,
  label,
  prefixIcon,
  big,
}: {
  r: Rollup;
  label: string;
  prefixIcon?: React.ReactNode;
  big?: boolean;
}) {
  const cells: Array<[string, string]> = [
    ["Learners", String(r.learners)],
    ["Assigned", String(r.assigned)],
    ["Completed", String(r.completed)],
    ["Pending", String(r.pending)],
    ["Avg score", pct(r.avgScore)],
  ];
  return (
    <section className="bg-paper border border-line rounded-2xl overflow-hidden">
      <div className="px-4 sm:px-5 py-2.5 border-b border-line text-sm font-semibold inline-flex items-center gap-2 w-full">
        {prefixIcon}
        {label}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 divide-x divide-y sm:divide-y-0 divide-line">
        {cells.map(([l, v]) => (
          <div key={l} className="px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-muted font-bold">{l}</p>
            <p className={`${big ? "text-2xl" : "text-lg"} font-semibold tabular-nums mt-0.5`}>
              {v}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function MiniStats({ r, masked }: { r: Rollup; masked?: boolean }) {
  return (
    <span className="flex items-center gap-3 text-xs tabular-nums text-muted shrink-0">
      <span title="Learners" className="inline-flex items-center gap-1">
        <Users className="w-3.5 h-3.5" /> {r.learners}
      </span>
      {masked ? (
        // A single-person aggregate would reveal that person's numbers.
        <span title="Hidden to protect individual performance">—</span>
      ) : (
        <>
          <span title="Courses completed / assigned">
            <strong className="text-ink font-semibold">{r.completed}</strong>/{r.assigned} done
          </span>
          <span title="Courses pending" className="text-amber-700">{r.pending} pending</span>
          <span title="Average score" className="font-semibold text-ink">{pct(r.avgScore)}</span>
        </>
      )}
    </span>
  );
}

function MemberTable({
  team,
  metrics,
  profiles,
  viewerId,
  caption,
}: {
  team: Member[];
  metrics: Map<string, Metric>;
  profiles: Map<string, Profile>;
  viewerId: string;
  caption?: string;
}) {
  const rows = [...team].sort((a, b) => {
    const ma = metrics.get(a.user_id);
    const mb = metrics.get(b.user_id);
    return (mb?.courses_completed ?? 0) - (ma?.courses_completed ?? 0);
  });
  return (
    <div className="px-4 sm:px-5 pb-4 overflow-x-auto">
      {caption && (
        <p className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">{caption}</p>
      )}
      <table className="w-full text-sm min-w-[480px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted border-b border-line">
            <th className="py-2 pr-3">Learner</th>
            <th className="py-2 px-3 text-right">Assigned</th>
            <th className="py-2 px-3 text-right">Completed</th>
            <th className="py-2 px-3 text-right">Pending</th>
            <th className="py-2 pl-3 text-right">Avg score</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((m) => {
            const p = profiles.get(m.user_id);
            const met = metrics.get(m.user_id);
            const assigned = met?.courses_assigned ?? 0;
            const completed = met?.courses_completed ?? 0;
            return (
              <tr key={m.user_id} className={m.user_id === viewerId ? "bg-indigo-50/50" : ""}>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-2.5 min-w-0">
                    <Avatar name={nameOf(p)} avatarUrl={p?.avatar_url} size="sm" />
                    <span className="truncate font-medium">
                      {nameOf(p)}
                      {m.user_id === viewerId && (
                        <span className="text-indigo-600 text-xs ml-1.5">(you)</span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{assigned}</td>
                <td className="py-2 px-3 text-right tabular-nums text-emerald-700 font-semibold">
                  {completed}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-amber-700">
                  {assigned - completed}
                </td>
                <td className="py-2 pl-3 text-right tabular-nums font-semibold">
                  {pct(met?.avg_score !== null && met?.avg_score !== undefined ? Number(met.avg_score) : null)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
