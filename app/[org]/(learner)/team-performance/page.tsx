import Link from "next/link";
import { Users } from "lucide-react";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { loadManagerContext } from "@/lib/manager/access";
import { computeLearnerInsights } from "@/lib/manager/insights";
import {
  buildExceptions,
  buildStruggles,
  compareWorstFirst,
  matchesStatusFilter,
  periodSummary,
  teamScore,
} from "@/lib/manager/report-card";
import { PERIODS, SEVERITY_RANK, type LearnerInsight } from "@/lib/manager/types";
import { SEVERITY_META } from "@/lib/manager/report-card";
import { Card, Dot, Pill, SEVERITY_TONE, StatusPill, relativeDays } from "./_components/ui";
import { ActionButton, AssignCourseDialog, ReportFilters } from "./_components/report-card-client";

export const dynamic = "force-dynamic";

/**
 * Team Performance — the L1 Manager Report Card (Phase 1 of the approved
 * proposal). One screen, top to bottom: team score → four signals → what
 * needs your attention (≤5, severity first, one action each) → the team,
 * worst first → where the team struggles vs the organisation → this period.
 *
 * Access and scope (decision 3): the server resolves the viewer's people from
 * the explicit L1/L2/L3 fields (lib/manager/access.ts) and reads only those
 * people; the old "team leaders see member details" toggle no longer applies
 * here (decision 10). Computation is live — a team is small.
 */
export default async function TeamPerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ period?: string; content?: string; status?: string }>;
}) {
  const { org: orgSlug } = await params;
  const sp = (await searchParams) ?? {};
  const { user, org } = await requireOrgAccess(orgSlug);
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const ctx = await loadManagerContext(svc, org.id, user.id);

  if (!ctx.isManager) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <Users className="w-10 h-10 mx-auto text-muted opacity-50" />
        <h1 className="mt-4 text-2xl font-semibold">No team mapped yet</h1>
        <p className="text-muted text-sm mt-2 max-w-md mx-auto">
          Team Performance appears once employees are mapped to you as their manager in the reporting line. Ask your
          administrator to set the mapping.
        </p>
      </div>
    );
  }

  // searchParams can repeat a key (?content=a&content=b → array): take strings only.
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const period = PERIODS.find((p) => p.value === (str(sp.period) || "30")) ?? PERIODS[1];
  const content = str(sp.content);
  const statusFilter = str(sp.status);
  const current = { period: period.value, content, status: statusFilter };
  const nowMs = Date.now();

  const { learners, catalog, benchmark, today } = await computeLearnerInsights(svc, {
    orgId: org.id,
    orgSlug,
    userIds: ctx.directIds,
    periodDays: period.days,
    content,
  });
  const score = teamScore(learners);
  const exceptions = buildExceptions(learners, { orgSlug });
  const struggles = buildStruggles(learners, benchmark);
  const summary = periodSummary(learners, period.days);
  const roster = [...learners].sort(compareWorstFirst).filter((l) => matchesStatusFilter(l, statusFilter));

  const { data: me } = await svc.from("profiles").select("first_name").eq("id", user.id).maybeSingle();
  const firstName = (me as { first_name?: string | null } | null)?.first_name ?? null;
  const contents = [
    { label: "Journeys", options: catalog.journeys.map((j) => ({ value: `journey:${j.id}`, label: j.title })) },
    { label: "Learning paths", options: catalog.paths.map((p) => ({ value: `path:${p.id}`, label: p.title })) },
    { label: "Courses", options: catalog.courses.map((c) => ({ value: `course:${c.id}`, label: c.title })) },
  ];
  const team = learners.map((l) => ({ userId: l.userId, name: l.name }));
  const journeyLabel = (l: LearnerInsight) => {
    const j = l.journeys.find((x) => x.status === "active") ?? l.journeys[0];
    if (!j) return "—";
    if (j.status === "completed") return "Completed";
    return `Day ${j.day}/${j.total}${j.behind ? ` · ${j.behind} behind` : j.overdueDeadline ? " · past deadline" : " · on track"}`;
  };
  const flagsLabel = (l: LearnerInsight) => {
    const kinds = [...new Set(l.flags.filter((f) => f.kind !== "needs_support").map((f) => f.kind))];
    return kinds.length ? kinds.map((k) => ({ failed: "Failed", overdue: "Overdue", behind: "Behind", stuck: "Stuck", not_started: "Not started", inactive: "Inactive", needs_support: "" } as Record<string, string>)[k]).join(" · ") : "—";
  };

  return (
    // data-dashboard-root: the learner shell animates `main > *` with a
    // transform, which would turn this page's fixed-position dialog into a
    // locally positioned box; the root stays static and its children rise in.
    <div data-dashboard-root="" className="max-w-6xl mx-auto space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="serif text-4xl">Team Performance</h1>
          <p className="text-muted text-sm mt-1">
            {firstName ? `${firstName}'s team` : "Your team"} · {learners.length} {learners.length === 1 ? "person" : "people"}
            {ctx.scope.level > 1 && (
              <span className="ml-2 text-xs">· you are also mapped as an L{ctx.scope.level} manager — the team-of-teams view is coming next</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <ReportFilters orgSlug={orgSlug} basePath="team-performance" current={current} contents={contents} />
          <AssignCourseDialog orgSlug={orgSlug} courses={contents[2].options.map((o) => ({ value: o.value.slice(7), label: o.label }))} team={team} />
        </div>
      </header>

      {learners.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            Nobody lists you as their L1 manager yet. {ctx.scope.all.size > 0 ? `${ctx.scope.all.size} people are mapped under you at L2/L3; that view arrives in the next release.` : ""}
          </p>
        </Card>
      ) : (
        <>
          {/* Score + what needs attention */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card eyebrow="Team Learning Score">
              <div className="flex items-baseline gap-3">
                <span className="serif text-5xl font-semibold tabular-nums">{score.score ?? "—"}</span>
                <Pill tone={score.tone}>{score.label}</Pill>
              </div>
              <ul className="mt-3 space-y-1.5 text-sm">
                {score.signals.map((s) => (
                  <li key={s.key} className="flex items-baseline justify-between gap-3" title={s.note ?? undefined}>
                    <span><Dot tone={s.tone} />{s.label}</span>
                    <span className="tabular-nums font-medium">{s.display}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted mt-3">Weights 35 · 25 · 25 · 15. Status flags are always current; the period filter only changes the counts below.</p>
            </Card>

            <Card eyebrow="What needs your attention" className="lg:col-span-2">
              {exceptions.length === 0 ? (
                <p className="text-sm text-muted">Nothing needs your attention right now — everyone is on track.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {exceptions
                    .slice()
                    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
                    .map((g) => (
                      <div key={g.kind} className={`rounded-xl border-l-4 bg-canvas/60 p-3 ${g.severity === "critical" ? "border-red-500" : "border-amber-500"}`}>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="font-semibold text-sm">{g.title}</p>
                          <Pill tone={SEVERITY_TONE[g.severity]}>{SEVERITY_META[g.severity].label}</Pill>
                        </div>
                        <p className="text-xs text-muted mt-0.5">
                          {g.people.map((p) => p.name).join(", ")}
                          {g.count > g.people.length ? ` +${g.count - g.people.length}` : ""}
                          {g.content ? ` · ${g.content.title}` : ""}
                        </p>
                        <p className="text-xs mt-1"><span className="text-muted">Suggested:</span> {g.suggestion}</p>
                        {g.actions.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {g.actions.map((a, i) => (
                              <ActionButton key={`${a.kind}:${a.label}`} orgSlug={orgSlug} action={a} primary={i === 0} />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </Card>
          </div>

          {/* Roster */}
          <section className="bg-paper border border-line rounded-2xl overflow-hidden">
            <div className="px-5 pt-4 pb-2 flex items-baseline justify-between gap-3">
              <h2 className="font-semibold text-sm">Your team · click a name for their report</h2>
              <span className="text-xs text-muted">{roster.length} of {learners.length}{statusFilter ? " match the filter" : " · worst first"}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
                    <th className="text-left font-semibold px-5 py-2">Employee</th>
                    <th className="text-left font-semibold px-3 py-2">Status</th>
                    <th className="text-right font-semibold px-3 py-2">Completion</th>
                    <th className="text-right font-semibold px-3 py-2">Avg score</th>
                    <th className="text-left font-semibold px-3 py-2">Journey</th>
                    <th className="text-left font-semibold px-3 py-2">Last active</th>
                    <th className="text-left font-semibold px-5 py-2">Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {roster.map((l) => (
                    <tr key={l.userId} className="hover:bg-canvas/60">
                      <td className="px-5 py-2.5 font-medium">
                        <Link href={`/${orgSlug}/team-performance/${l.userId}`} className="hover:underline">{l.name}</Link>
                        {l.designation && <span className="block text-[11px] text-muted font-normal">{l.designation}</span>}
                      </td>
                      <td className="px-3 py-2.5"><StatusPill status={l.status} /></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{l.completionPct === null ? <span className="text-muted">—</span> : `${l.completionPct}%`}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{l.avgScore === null ? <span className="text-muted">—</span> : l.avgScore}</td>
                      <td className="px-3 py-2.5 text-xs">{journeyLabel(l)}</td>
                      <td className="px-3 py-2.5 text-xs text-muted">{relativeDays(l.lastActive, nowMs)}</td>
                      <td className="px-5 py-2.5 text-xs text-muted">{flagsLabel(l)}</td>
                    </tr>
                  ))}
                  {roster.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-6 text-sm text-muted text-center">Nobody matches this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Struggles + period */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card eyebrow="Where your team struggles">
              {struggles.length === 0 ? (
                <p className="text-sm text-muted">No course or journey day is holding the team back right now.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {struggles.map((s) => {
                    const parts = [
                      s.failed ? `${s.failed} failed` : "",
                      s.stuck ? `${s.stuck} stuck` : "",
                      s.notStarted ? `${s.notStarted} not started` : "",
                      s.overdue ? `${s.overdue} overdue` : "",
                      s.pending ? `${s.pending} pending` : "",
                    ].filter(Boolean);
                    const tone = s.failed || s.overdue ? "bad" : "warn";
                    return (
                      <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {s.kind === "course" ? (
                            <Link href={`/${orgSlug}/team-performance?content=course:${s.id}`} className="hover:underline">{s.title}</Link>
                          ) : s.title}
                        </span>
                        <span className="text-xs">
                          <Pill tone={tone}>{parts.join(" · ")}</Pill>
                          {s.teamFailRate !== null && s.failed > 0 && (
                            <span className="ml-2 text-muted">
                              your team {s.teamFailRate}% fail{s.orgFailRate !== null ? ` · org ${s.orgFailRate}%` : ""}
                              {s.diagnosis === "content" ? " — likely a content gap, not your team" : s.diagnosis === "team" ? " — a team problem" : ""}
                            </span>
                          )}
                          {s.orgFailRate === null && s.failed > 0 && <span className="ml-2 text-muted">no org benchmark yet</span>}
                          {s.diagnosis === "timing" && <span className="ml-2 text-muted">recently assigned — nudge, don&rsquo;t escalate</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {struggles.some((s) => s.orgFailRate !== null) && (
                <p className="text-[11px] text-muted mt-3">Org fail rate = learners whose official attempt failed, over everyone assigned the course (refreshed nightly; custom-group assignments not included).</p>
              )}
            </Card>
            <Card eyebrow={period.days ? `Last ${period.days} days` : "All time"}>
              <ul className="space-y-1.5 text-sm">
                <li className="flex justify-between"><span>Courses completed</span><span className="tabular-nums font-medium">{summary.coursesCompleted}{summary.completionsDelta !== null ? <span className={`ml-2 text-xs ${summary.completionsDelta >= 0 ? "text-emerald-700" : "text-red-700"}`}>{summary.completionsDelta >= 0 ? "+" : ""}{summary.completionsDelta} vs previous</span> : null}</span></li>
                <li className="flex justify-between"><span>Assessments passed first time</span><span className="tabular-nums font-medium">{summary.passedFirstTime}{period.days ? "" : ` / ${summary.assessmentsWithResult}`}</span></li>
                <li className="flex justify-between"><span>Journey missions done</span><span className="tabular-nums font-medium">{summary.journeyMissions}</span></li>
                <li className="flex justify-between"><span>Active this week</span><span className="tabular-nums font-medium">{learners.filter((l) => l.activeLast7d).length} / {learners.length}</span></li>
              </ul>
              <p className="text-[11px] text-muted mt-3">As of {today} (organisation calendar).</p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
