import Link from "next/link";
import {
  buildExceptions,
  buildStruggles,
  compareWorstFirst,
  matchesStatusFilter,
  periodSummary,
  teamScore,
  SEVERITY_META,
} from "@/lib/manager/report-card";
import { SEVERITY_RANK, type LearnerInsight } from "@/lib/manager/types";
import type { Catalog } from "@/lib/manager/insights";
import { Card, Dot, Pill, SEVERITY_TONE, StatusPill, relativeDays } from "./ui";
import { ActionButton, RaiseTicketButton, ReportFilters } from "./report-card-client";

/**
 * The L1 screen (§4), as a component so it serves both the manager's own team
 * (/team-performance) and any team an L2/L3 drills into
 * (/team-performance/team/[managerId]). Everything is computed by the caller;
 * this only renders. `basePath` keeps filters and links on the right page.
 */
export type L1ViewProps = {
  orgSlug: string;
  /** e.g. "team-performance" or "team-performance/team/<id>" */
  basePath: string;
  title: string;
  subtitle: string;
  backHref?: { href: string; label: string } | null;
  learners: LearnerInsight[];
  catalog: Catalog;
  benchmark: Map<string, { failRate: number | null; enrolled: number }>;
  today: string;
  period: { value: string; days: number | null };
  content: string;
  statusFilter: string;
  nowMs: number;
  /** Header line for a viewer who is also mapped higher up (own-team view only). */
  note?: string | null;
};

export function contentOptions(catalog: Catalog) {
  return [
    { label: "Journeys", options: catalog.journeys.map((j) => ({ value: `journey:${j.id}`, label: j.title })) },
    { label: "Learning paths", options: catalog.paths.map((p) => ({ value: `path:${p.id}`, label: p.title })) },
    { label: "Courses", options: catalog.courses.map((c) => ({ value: `course:${c.id}`, label: c.title })) },
  ];
}

export function L1View(p: L1ViewProps) {
  const { orgSlug, basePath, learners, benchmark, period, statusFilter, nowMs } = p;
  const score = teamScore(learners);
  const exceptions = buildExceptions(learners, { orgSlug });
  const struggles = buildStruggles(learners, benchmark);
  const summary = periodSummary(learners, period.days);
  const roster = [...learners].sort(compareWorstFirst).filter((l) => matchesStatusFilter(l, statusFilter));
  const contents = contentOptions(p.catalog);
  const current = { period: period.value, content: p.content, status: statusFilter };
  const team = learners.map((l) => ({ userId: l.userId, name: l.name }));
  const here = `/${orgSlug}/${basePath}`;
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
  // Exception links are built for the own-team path; re-root them here.
  const reroot = (href: string) => href.replace(`/${orgSlug}/team-performance?`, `${here}?`);

  return (
    // data-dashboard-root: the learner shell animates `main > *` with a
    // transform, which would turn this page's fixed-position dialog into a
    // locally positioned box; the root stays static and its children rise in.
    <div data-dashboard-root="" className="max-w-6xl mx-auto space-y-6">
      {p.backHref && (
        <Link href={p.backHref.href} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">← {p.backHref.label}</Link>
      )}
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="serif text-4xl">{p.title}</h1>
          <p className="text-muted text-sm mt-1">
            {p.subtitle}
            {p.note && <span className="ml-2 text-xs">· {p.note}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <ReportFilters orgSlug={orgSlug} basePath={basePath} current={current} contents={contents} />
          <RaiseTicketButton orgSlug={orgSlug} label="Raise a support ticket" category="other" people={[]} team={team} content={null} exception={null} origin={basePath} />
        </div>
      </header>

      {learners.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">Nobody in this team yet.</p>
        </Card>
      ) : (
        <>
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
                <p className="text-sm text-muted">Nothing needs attention right now — everyone is on track.</p>
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
                          {g.people.map((x) => x.name).join(", ")}
                          {g.count > g.people.length ? ` +${g.count - g.people.length}` : ""}
                          {g.content ? ` · ${g.content.title}` : ""}
                        </p>
                        <p className="text-xs mt-1"><span className="text-muted">Suggested:</span> {g.suggestion}</p>
                        {g.actions.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {g.actions.map((a, i) => (
                              <ActionButton key={`${a.kind}:${a.label}`} orgSlug={orgSlug} action={a.kind === "link" ? { ...a, href: reroot(a.href) } : a} primary={i === 0} />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </Card>
          </div>

          <section className="bg-paper border border-line rounded-2xl overflow-hidden">
            <div className="px-5 pt-4 pb-2 flex items-baseline justify-between gap-3">
              <h2 className="font-semibold text-sm">{p.basePath === "team-performance" ? "Your team" : "The team"} · click a name for their report</h2>
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card eyebrow="Where the team struggles">
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
                            <Link href={`${here}?content=course:${s.id}`} className="hover:underline">{s.title}</Link>
                          ) : s.title}
                        </span>
                        <span className="text-xs">
                          <Pill tone={tone}>{parts.join(" · ")}</Pill>
                          {s.teamFailRate !== null && s.failed > 0 && (
                            <span className="ml-2 text-muted">
                              team {s.teamFailRate}% fail{s.orgFailRate !== null ? ` · org ${s.orgFailRate}%` : ""}
                              {s.diagnosis === "content" ? " — likely a content gap, not the team" : s.diagnosis === "team" ? " — a team problem" : ""}
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
              <p className="text-[11px] text-muted mt-3">As of {p.today} (organisation calendar).</p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
