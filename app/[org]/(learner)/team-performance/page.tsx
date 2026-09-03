import { Users, Target, Award, Trophy, MapPin } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { courseDaysOf } from "@/lib/journey/journey";

export const dynamic = "force-dynamic";

/**
 * Team Performance (Phase 4 of the Personalised Journeys program) — the
 * MANAGER-facing view, gated by the profile database's Line Manager mapping
 * (organization_members.line_manager_id — the same field that powers the
 * Verticals board and journey escalations). Product decisions (2026-09-03):
 *
 *   - L1 (has direct reports): own-team AGGREGATES — size, journey
 *     completion, courses completed, avg knowledge score. Member-level rows
 *     appear only when the org's existing "team leaders see member details"
 *     toggle allows it (gamification_settings.leaderboard_team_leader_view).
 *   - L2 (manages managers — L2 = the manager's manager, derived): a
 *     sub-team COMPARISON, aggregates only, never other teams' individuals.
 *   - City competition: teams led by same-city managers, ranked by journey
 *     completion — awareness between managers, not a public employee
 *     ranking.
 *
 * Reads run service-role after requireOrgAccess (RLS hides peers' member
 * rows from non-admins; same precedent as the leaderboard page) and every
 * gamification/journey read is fail-soft.
 */

type MemberRow = {
  user_id: string;
  line_manager_id: string | null;
  city: string | null;
  business_vertical: string | null;
  branch: string | null;
};

type TeamAgg = {
  size: number;
  journeyPct: number | null; // avg journey completion 0–100 across enrolled
  journeyEnrolled: number;
  journeyCompleted: number;
  coursesCompleted: number;
  avgScore: number | null; // 0–1
};

export default async function TeamPerformancePage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Active members + hierarchy fields (paginate past PostgREST's 1000 cap).
  const members: MemberRow[] = [];
  for (let fromIdx = 0; ; fromIdx += 1000) {
    const { data } = await svc
      .from("organization_members")
      .select("user_id, line_manager_id, city, business_vertical, branch")
      .eq("organization_id", org.id)
      .eq("status", "active")
      .range(fromIdx, fromIdx + 999);
    const page = (data ?? []) as MemberRow[];
    members.push(...page);
    if (page.length < 1000) break;
  }
  const byId = new Map(members.map((m) => [m.user_id, m]));
  const reportsOf = (managerId: string) =>
    members.filter((m) => m.line_manager_id === managerId);

  const myReports = reportsOf(user.id);
  if (myReports.length === 0) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <Users className="w-10 h-10 mx-auto text-muted opacity-50" />
        <h1 className="mt-4 text-2xl font-semibold">No team mapped yet</h1>
        <p className="text-muted text-sm mt-2 max-w-md mx-auto">
          Team Performance appears once employees are mapped to you as their
          Line Manager in the user profiles. Ask your administrator to set
          the mapping.
        </p>
      </div>
    );
  }

  // ---- Org-wide raw stats, aggregated in JS (small orgs; all fail-soft) ---
  // Gamification per user: lifetime courses completed + avg score.
  const mvStats = new Map<string, { courses: number; score: number | null }>();
  try {
    const { data } = await svc
      .from("mv_leaderboard")
      .select("user_id, courses_completed, avg_score")
      .eq("organization_id", org.id);
    for (const r of (data ?? []) as Array<{
      user_id: string;
      courses_completed: number;
      avg_score: number | null;
    }>) {
      mvStats.set(r.user_id, { courses: r.courses_completed ?? 0, score: r.avg_score });
    }
  } catch {
    /* pre-0053 or refresh issues — cards show em-dashes */
  }

  // Journey completion per user across their enrollments (completed = 100%).
  const userJourney = new Map<string, { pctSum: number; n: number; completed: number }>();
  try {
    const { data: enrRows } = await svc
      .from("journey_enrollments")
      .select("id, user_id, status, journey_versions!inner(days, days_total)")
      .eq("organization_id", org.id)
      .in("status", ["active", "completed"])
      .limit(2000);
    const enrs = (enrRows ?? []) as Array<{
      id: string;
      user_id: string;
      status: string;
      journey_versions:
        | { days: unknown; days_total: number }
        | Array<{ days: unknown; days_total: number }>;
    }>;
    const doneByEnr = new Map<string, number>();
    const { data: progRows } = await svc
      .from("journey_day_progress")
      .select("enrollment_id")
      .eq("organization_id", org.id)
      .limit(5000);
    for (const r of (progRows ?? []) as Array<{ enrollment_id: string }>) {
      doneByEnr.set(r.enrollment_id, (doneByEnr.get(r.enrollment_id) ?? 0) + 1);
    }
    for (const e of enrs) {
      const v = Array.isArray(e.journey_versions)
        ? e.journey_versions[0]
        : e.journey_versions;
      const missions = v ? courseDaysOf(v.days, v.days_total).length : 0;
      const pct =
        e.status === "completed"
          ? 100
          : missions > 0
            ? Math.round(((doneByEnr.get(e.id) ?? 0) / missions) * 100)
            : 0;
      const cur = userJourney.get(e.user_id) ?? { pctSum: 0, n: 0, completed: 0 };
      cur.pctSum += pct;
      cur.n += 1;
      if (e.status === "completed") cur.completed += 1;
      userJourney.set(e.user_id, cur);
    }
  } catch {
    /* pre-0058 — journey columns show em-dashes */
  }

  const aggFor = (ids: string[]): TeamAgg => {
    let journeyPctSum = 0;
    let journeyEnrolled = 0;
    let journeyCompleted = 0;
    let coursesCompleted = 0;
    let scoreSum = 0;
    let scoreN = 0;
    for (const id of ids) {
      const j = userJourney.get(id);
      if (j && j.n > 0) {
        journeyEnrolled++;
        journeyPctSum += j.pctSum / j.n;
        if (j.completed > 0) journeyCompleted++;
      }
      const s = mvStats.get(id);
      if (s) {
        coursesCompleted += s.courses;
        if (typeof s.score === "number") {
          scoreSum += s.score;
          scoreN++;
        }
      }
    }
    return {
      size: ids.length,
      journeyPct: journeyEnrolled > 0 ? Math.round(journeyPctSum / journeyEnrolled) : null,
      journeyEnrolled,
      journeyCompleted,
      coursesCompleted,
      avgScore: scoreN > 0 ? scoreSum / scoreN : null,
    };
  };

  const myTeam = aggFor(myReports.map((m) => m.user_id));

  // L2: my direct reports who lead teams of their own.
  const subTeams = myReports
    .map((r) => ({ leaderId: r.user_id, memberIds: reportsOf(r.user_id).map((m) => m.user_id) }))
    .filter((t) => t.memberIds.length > 0)
    .map((t) => ({ ...t, agg: aggFor(t.memberIds) }))
    .sort((a, b) => (b.agg.journeyPct ?? -1) - (a.agg.journeyPct ?? -1));

  // City competition: teams led by managers in MY city.
  const myRow = byId.get(user.id);
  const myCity = myRow?.city ?? null;
  const leaderIds = [
    ...new Set(members.map((m) => m.line_manager_id).filter((x): x is string => !!x)),
  ].filter((id) => byId.has(id));
  const cityTeams = myCity
    ? leaderIds
        .filter((id) => byId.get(id)?.city === myCity)
        .map((id) => ({ leaderId: id, agg: aggFor(reportsOf(id).map((m) => m.user_id)) }))
        .sort((a, b) => (b.agg.journeyPct ?? -1) - (a.agg.journeyPct ?? -1))
    : [];

  // Names for every leader we display + own members (chunked).
  const nameIds = new Set<string>([user.id]);
  for (const t of subTeams) nameIds.add(t.leaderId);
  for (const t of cityTeams) nameIds.add(t.leaderId);
  for (const m of myReports) nameIds.add(m.user_id);
  const names = new Map<string, string>();
  const idList = [...nameIds];
  for (let i = 0; i < idList.length; i += 150) {
    const { data } = await svc
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", idList.slice(i, i + 150));
    for (const p of (data ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      names.set(
        p.id,
        [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
          (p.email ?? "").split("@")[0]
      );
    }
  }
  const nameOf = (id: string) => names.get(id) ?? "—";

  // Existing org privacy toggle: may leaders see their own members' rows?
  let showMembers = true;
  try {
    const { data: gs } = await svc
      .from("gamification_settings")
      .select("leaderboard_team_leader_view")
      .eq("organization_id", org.id)
      .maybeSingle();
    if ((gs as { leaderboard_team_leader_view?: boolean } | null)?.leaderboard_team_leader_view === false) {
      showMembers = false;
    }
  } catch {
    /* default: visible */
  }

  const pctLabel = (v: number | null) => (v === null ? "—" : `${v}%`);
  const scoreLabel = (v: number | null) =>
    v === null ? "—" : `${Math.round(v * 100)}%`;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="serif text-4xl">Team Performance</h1>
        <p className="text-muted text-sm mt-1">
          How your team is progressing — journeys, courses and knowledge
          scores, straight from the profile database mapping.
        </p>
      </header>

      {/* ---- L1: my team ---- */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi icon={<Users className="w-4 h-4 text-indigo-600" />} label="Team members" value={String(myTeam.size)} />
        <Kpi
          icon={<Target className="w-4 h-4 text-amber-600" />}
          label="Journey completion"
          value={pctLabel(myTeam.journeyPct)}
          sub={`${myTeam.journeyCompleted}/${myTeam.journeyEnrolled || "0"} finished`}
        />
        <Kpi icon={<Award className="w-4 h-4 text-emerald-600" />} label="Courses completed" value={String(myTeam.coursesCompleted)} />
        <Kpi icon={<Trophy className="w-4 h-4 text-slate-500" />} label="Avg knowledge score" value={scoreLabel(myTeam.avgScore)} />
      </section>

      {showMembers && (
        <section className="bg-paper border border-line rounded-2xl overflow-hidden">
          <h3 className="text-sm font-semibold px-5 pt-4 pb-2">Your team</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <th className="text-left font-semibold px-5 py-2">Member</th>
                <th className="text-right font-semibold px-3 py-2">Journey</th>
                <th className="text-right font-semibold px-3 py-2">Courses done</th>
                <th className="text-right font-semibold px-5 py-2">Avg score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {myReports.map((m) => {
                const j = userJourney.get(m.user_id);
                const jm = j && j.n > 0 ? Math.round(j.pctSum / j.n) : null;
                const s = mvStats.get(m.user_id);
                return (
                  <tr key={m.user_id}>
                    <td className="px-5 py-2.5 font-medium">{nameOf(m.user_id)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {jm === null ? (
                        <span className="text-muted">not enrolled</span>
                      ) : (
                        <span className={jm >= 100 ? "text-emerald-700 font-semibold" : ""}>{jm}%</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s?.courses ?? 0}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{scoreLabel(s?.score ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* ---- L2: sub-team comparison ---- */}
      {subTeams.length > 0 && (
        <section className="bg-paper border border-line rounded-2xl overflow-hidden">
          <div className="px-5 pt-4 pb-2">
            <h3 className="text-sm font-semibold">Teams under you</h3>
            <p className="text-xs text-muted">
              Aggregate comparison of the teams your managers lead —
              individual performance stays with each team&apos;s own leader.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <th className="text-left font-semibold px-5 py-2">Team</th>
                <th className="text-right font-semibold px-3 py-2">Members</th>
                <th className="text-right font-semibold px-3 py-2">Journey</th>
                <th className="text-right font-semibold px-5 py-2">Avg score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {subTeams.map((t) => (
                <tr key={t.leaderId}>
                  <td className="px-5 py-2.5 font-medium">{nameOf(t.leaderId)}&apos;s team</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{t.agg.size}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{pctLabel(t.agg.journeyPct)}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{scoreLabel(t.agg.avgScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ---- City competition ---- */}
      {myCity && cityTeams.length > 1 && (
        <section className="bg-paper border border-line rounded-2xl overflow-hidden">
          <div className="px-5 pt-4 pb-2">
            <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-indigo-600" /> {myCity} — team standings
            </h3>
            <p className="text-xs text-muted">
              Team-level journey completion across {myCity}. Friendly
              competition between teams — no individual rankings here.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <th className="text-left font-semibold px-5 py-2">#</th>
                <th className="text-left font-semibold px-3 py-2">Team</th>
                <th className="text-right font-semibold px-3 py-2">Members</th>
                <th className="text-right font-semibold px-5 py-2">Journey</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {cityTeams.map((t, i) => {
                const mine = t.leaderId === user.id;
                return (
                  <tr key={t.leaderId} className={mine ? "bg-indigo-50/60" : undefined}>
                    <td className="px-5 py-2.5 tabular-nums font-bold text-muted">
                      {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
                    </td>
                    <td className="px-3 py-2.5 font-medium">
                      {nameOf(t.leaderId)}&apos;s team
                      {mine && (
                        <span className="ml-2 text-[10px] font-bold uppercase bg-indigo-600 text-white px-1.5 py-0.5 rounded-full">
                          yours
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{t.agg.size}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums font-semibold">{pctLabel(t.agg.journeyPct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-paper border border-line rounded-2xl px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted font-bold inline-flex items-center gap-1.5">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-muted">{sub}</p>}
    </div>
  );
}
