import Link from "next/link";
import { buildCommonStruggles, buildTeamExceptions, teamCards, teamScore, SEVERITY_META, type TeamInput } from "@/lib/manager/report-card";
import type { LearnerInsight } from "@/lib/manager/types";
import type { Catalog } from "@/lib/manager/insights";
import { Card, Dot, Pill, SEVERITY_TONE } from "./ui";
import { ActionButton, ComparePicker, ReportFilters } from "./report-card-client";
import { contentOptions } from "./l1-view";

/**
 * The L2 screen (§6): a score for everyone under the viewer, teams compared
 * worst first, team-level exceptions with a suggested step, and common
 * struggles across teams. Click a team → its report card (named people, all
 * inside this viewer's own hierarchy); click a person → their report.
 */
export type L2ViewProps = {
  orgSlug: string;
  title: string;
  subtitle: string;
  level: 2 | 3;
  teams: TeamInput[];
  learners: LearnerInsight[];
  /** People in scope whose L1 is outside the hierarchy (no team to sit under). */
  ungrouped: LearnerInsight[];
  catalog: Catalog;
  today: string;
  period: { value: string; days: number | null };
  content: string;
  managerEmail: (managerId: string) => string | null;
  /** Set when this screen is a drill-down from the L3 view (a city / L2 group). */
  backHref?: { href: string; label: string } | null;
  /** Narrowing params (city / l2 / vertical / branch / by) every filter change and compare must keep. */
  keep?: Record<string, string>;
};

export function L2View(p: L2ViewProps) {
  const { orgSlug, teams, learners } = p;
  const byId = new Map(learners.map((l) => [l.userId, l]));
  const cards = teamCards(teams, byId, p.period.days);
  const group = teamScore(learners);
  // One query string for every link, so a drilled-in page matches the card.
  const q = new URLSearchParams();
  if (p.period.value !== "30") q.set("period", p.period.value);
  if (p.content) q.set("content", p.content);
  for (const [k, v] of Object.entries(p.keep ?? {})) if (v) q.set(k, v);
  const query = q.toString() ? `?${q.toString()}` : "";
  const exceptions = buildTeamExceptions(cards, { orgSlug, managerEmail: p.managerEmail, query });
  const common = buildCommonStruggles(teams, byId);
  const contents = contentOptions(p.catalog);
  const current = { period: p.period.value, content: p.content, status: "" };
  const teamHref = (id: string) => `/${orgSlug}/team-performance/team/${id}${query}`;
  const inTeams = teams.reduce((n, t) => n + t.memberIds.filter((id) => byId.has(id)).length, 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

  return (
    <div data-dashboard-root="" className="max-w-6xl mx-auto space-y-6">
      {p.backHref && (
        <Link href={p.backHref.href} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          ← {p.backHref.label}
        </Link>
      )}
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="serif text-4xl">{p.title}</h1>
          <p className="text-muted text-sm mt-1">{p.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <ReportFilters orgSlug={orgSlug} basePath="team-performance" current={current} contents={contents} hideStatus keep={p.keep} />
          <ComparePicker orgSlug={orgSlug} query={query} teams={cards.map((c) => ({ managerId: c.managerId, name: c.isOwn ? "Your direct team" : `${c.managerName}'s team` }))} />
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card eyebrow={p.level === 3 ? "Organisation Learning Score" : "Group Learning Score"}>
          <div className="flex items-baseline gap-3">
            <span className="serif text-5xl font-semibold tabular-nums">{group.score ?? "—"}</span>
            <Pill tone={group.tone}>{group.label}</Pill>
          </div>
          <ul className="mt-3 space-y-1.5 text-sm">
            {group.signals.map((s) => (
              <li key={s.key} className="flex items-baseline justify-between gap-3" title={s.note ?? undefined}>
                <span><Dot tone={s.tone} />{s.label}</span>
                <span className="tabular-nums font-medium">{s.display}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted mt-3">{plural(inTeams, "person", "people")} in {plural(teams.length, "team", "teams")}{p.ungrouped.length ? ` + ${plural(p.ungrouped.length, "other", "others")}` : ""}. Same four signals as every team card.</p>
        </Card>

        <section className="bg-paper border border-line rounded-2xl overflow-hidden lg:col-span-2">
          <div className="px-5 pt-4 pb-2">
            <h2 className="font-semibold text-sm">Teams compared · worst first · click a team to open its report card</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
                  <th className="text-left font-semibold px-5 py-2">Team (L1 manager)</th>
                  <th className="text-right font-semibold px-3 py-2">Score</th>
                  <th className="text-right font-semibold px-3 py-2">Size</th>
                  <th className="text-right font-semibold px-3 py-2">Completion</th>
                  <th className="text-right font-semibold px-3 py-2">Journey on track</th>
                  <th className="text-right font-semibold px-3 py-2">Failed</th>
                  <th className="text-right font-semibold px-3 py-2">Overdue</th>
                  <th className="text-right font-semibold px-5 py-2">Completions trend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {cards.map((c) => {
                  const completion = c.score.signals.find((s) => s.key === "completion")?.value ?? null;
                  const journey = c.score.signals.find((s) => s.key === "journey")?.value ?? null;
                  return (
                    <tr key={c.managerId} className="hover:bg-canvas/60">
                      <td className="px-5 py-2.5 font-medium">
                        <Link href={teamHref(c.managerId)} className="hover:underline">{c.isOwn ? "Your direct team" : `${c.managerName}'s team`}</Link>
                      </td>
                      <td className="px-3 py-2.5 text-right"><Pill tone={c.score.tone}>{c.score.score ?? "—"}</Pill></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{c.size}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pct(completion)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pct(journey)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${c.failed ? "text-red-700 font-semibold" : ""}`}>{c.failed}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${c.overdue ? "text-red-700 font-semibold" : ""}`}>{c.overdue}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-xs">{c.completionsDelta === null ? "—" : `${c.completionsDelta >= 0 ? "+" : ""}${c.completionsDelta}`}</td>
                    </tr>
                  );
                })}
                {cards.length === 0 && <tr><td colSpan={8} className="px-5 py-6 text-sm text-muted text-center">No teams under you yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {p.ungrouped.length > 0 && (
            <p className="px-5 py-3 text-xs text-muted border-t border-line">
              {p.ungrouped.length} {p.ungrouped.length === 1 ? "person lists" : "people list"} you as L2/L3 but {p.ungrouped.length === 1 ? "has" : "have"} no L1 manager inside your reporting line — counted in the score above, no team row:{" "}
              {p.ungrouped.slice(0, 8).map((l, i) => (
                <span key={l.userId}>{i > 0 ? ", " : ""}<Link href={`/${orgSlug}/team-performance/${l.userId}`} className="hover:underline">{l.name}</Link></span>
              ))}
              {p.ungrouped.length > 8 ? ` +${p.ungrouped.length - 8}` : ""}.
            </p>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card eyebrow="What needs your attention">
          {exceptions.length === 0 ? (
            <p className="text-sm text-muted">Every team is on track.</p>
          ) : (
            <div className="space-y-3">
              {exceptions.map((e) => (
                <div key={e.managerId} className={`rounded-xl border-l-4 bg-canvas/60 p-3 ${e.severity === "critical" ? "border-red-500" : "border-amber-500"}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="font-semibold text-sm">{e.isOwn ? "Your direct team" : `${e.managerName}’s team`}</p>
                    <Pill tone={SEVERITY_TONE[e.severity]}>{SEVERITY_META[e.severity].label}</Pill>
                  </div>
                  <p className="text-xs text-muted mt-0.5">{e.summary}</p>
                  <p className="text-xs mt-1"><span className="text-muted">Suggested:</span> {e.suggestion}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {e.actions.map((a, i) => (
                      <ActionButton key={`${a.kind}:${a.label}`} orgSlug={orgSlug} action={a} primary={i === 0} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card eyebrow="Common struggles across teams">
          {common.length === 0 ? (
            <p className="text-sm text-muted">No module or journey day is holding several teams back.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {common.map((s) => {
                const parts = [
                  s.failed ? `${s.failed} failed` : "",
                  s.stuck ? `${s.stuck} stuck` : "",
                  s.notStarted ? `${s.notStarted} not started` : "",
                  s.overdue ? `${s.overdue} overdue` : "",
                  s.pending ? `${s.pending} pending` : "",
                ].filter(Boolean);
                return (
                  <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {s.kind === "course" ? <Link href={`/${orgSlug}/team-performance?content=course:${s.id}${p.period.value !== "30" ? `&period=${p.period.value}` : ""}`} className="hover:underline">{s.title}</Link> : s.title}
                    </span>
                    <span className="text-xs">
                      <Pill tone={s.teamsFailing ? "bad" : "warn"}>{s.kind === "course" ? (s.teamsFailing ? `Failing in ${s.teamsFailing} of ${s.teamsTotal} teams` : `Flagged in ${s.teamsAffected} of ${s.teamsTotal} teams`) : `Pending in ${s.teamsAffected} of ${s.teamsTotal} teams`}</Pill>
                      <span className="ml-2 text-muted">{parts.join(" · ")}</span>
                      {s.diagnosis === "content" && <span className="ml-2 text-muted">→ likely a content or training gap, not one manager</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[11px] text-muted mt-3">As of {p.today} (organisation calendar).</p>
        </Card>
      </div>
    </div>
  );
}
