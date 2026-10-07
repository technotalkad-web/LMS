import Link from "next/link";
import { buildOrgGaps, teamCards, teamScore, type TeamInput } from "@/lib/manager/report-card";
import type { LearnerInsight } from "@/lib/manager/types";
import type { Catalog } from "@/lib/manager/insights";
import { Card, Dot, Pill } from "./ui";
import { ComparePicker, RaiseTicketButton, ReportFilters, type ExtraFilter } from "./report-card-client";
import { contentOptions } from "./l1-view";

/**
 * The L3 screen (§7): a score for everyone under the national head, top and
 * weak teams, groups compared (by city or by L2 manager — click to open that
 * group as a teams-compared screen), and the major learning gaps across the
 * hierarchy. No individuals on this screen; names appear only after drilling
 * into a team, and only people mapped under this L3.
 */
export type L3ViewProps = {
  orgSlug: string;
  title: string;
  subtitle: string;
  teams: TeamInput[];
  /** L2 manager groups: id → { name, memberIds }. */
  l2Groups: Array<{ id: string; name: string; memberIds: string[] }>;
  learners: LearnerInsight[];
  catalog: Catalog;
  benchmark: Map<string, { failRate: number | null; enrolled: number }>;
  today: string;
  period: { value: string; days: number | null };
  content: string;
  filters: { city: string; vertical: string; branch: string; by: "city" | "l2" };
  options: { cities: string[]; verticals: string[]; branches: string[] };
  /** When the numbers came from the 15-minute precompute. */
  computedAt: string | null;
};

const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

export function L3View(p: L3ViewProps) {
  const { orgSlug, learners } = p;
  const byId = new Map(learners.map((l) => [l.userId, l]));
  const org = teamScore(learners);
  const cards = teamCards(p.teams, byId, p.period.days);
  const scored = cards.filter((c) => c.score.score !== null);
  const top = [...scored].sort((a, b) => (b.score.score ?? 0) - (a.score.score ?? 0)).slice(0, 3);
  const weak = scored.filter((c) => c.score.tone !== "ok").slice(0, 3);

  // Groups compared: by city (people's own city) or by L2 manager.
  const groups: TeamInput[] =
    p.filters.by === "l2"
      ? p.l2Groups.map((g) => ({ managerId: `l2:${g.id}`, managerName: g.name, memberIds: g.memberIds, isOwn: false }))
      : [...new Set(learners.map((l) => l.city ?? "No city"))].map((city) => ({
          managerId: `city:${city}`,
          managerName: city,
          memberIds: learners.filter((l) => (l.city ?? "No city") === city).map((l) => l.userId),
          isOwn: false,
        }));
  const groupCards = teamCards(groups, byId, p.period.days);
  const groupOf = (l: LearnerInsight) => (p.filters.by === "l2" ? p.l2Groups.find((g) => g.memberIds.includes(l.userId))?.id ?? null : l.city ?? "No city");
  const gaps = buildOrgGaps(learners, p.benchmark, groupOf, groups.length);

  // One query string carries period/content/people filters into every link.
  const q = new URLSearchParams();
  if (p.period.value !== "30") q.set("period", p.period.value);
  if (p.content) q.set("content", p.content);
  if (p.filters.vertical) q.set("vertical", p.filters.vertical);
  if (p.filters.branch) q.set("branch", p.filters.branch);
  if (p.filters.by === "l2") q.set("by", "l2");
  const base = q.toString();
  const withQ = (extra: Record<string, string>) => {
    const qq = new URLSearchParams(base);
    for (const [k, v] of Object.entries(extra)) if (v) qq.set(k, v);
    const s = qq.toString();
    return s ? `?${s}` : "";
  };
  const groupHref = (id: string) =>
    id.startsWith("city:") ? `/${orgSlug}/team-performance${withQ({ city: id.slice(5) })}` : `/${orgSlug}/team-performance${withQ({ l2: id.slice(3) })}`;
  const teamHref = (id: string) => `/${orgSlug}/team-performance/team/${id}${withQ({})}`;
  const current = { period: p.period.value, content: p.content, status: "" };
  const extras: ExtraFilter[] = [
    { key: "by", label: "Group by", value: p.filters.by, options: [{ value: "city", label: "City" }, { value: "l2", label: "L2 manager" }] },
    { key: "city", label: "City", value: p.filters.city, options: [{ value: "", label: "All cities" }, ...p.options.cities.map((c) => ({ value: c, label: c }))] },
    ...(p.options.verticals.length ? [{ key: "vertical", label: "Vertical", value: p.filters.vertical, options: [{ value: "", label: "All verticals" }, ...p.options.verticals.map((v) => ({ value: v, label: v }))] }] : []),
    ...(p.options.branches.length ? [{ key: "branch", label: "Branch", value: p.filters.branch, options: [{ value: "", label: "All branches" }, ...p.options.branches.map((v) => ({ value: v, label: v }))] }] : []),
  ];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div data-dashboard-root="" className="max-w-6xl mx-auto space-y-6">
      <header className="flex flex-col xl:flex-row xl:items-end justify-between gap-3">
        <div>
          <h1 className="serif text-4xl">{p.title}</h1>
          <p className="text-muted text-sm mt-1">{p.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <ReportFilters orgSlug={orgSlug} basePath="team-performance" current={current} contents={contentOptions(p.catalog)} hideStatus extras={extras} />
          <ComparePicker
            orgSlug={orgSlug}
            query={withQ({})}
            label={p.filters.by === "l2" ? "Compare groups" : "Compare cities"}
            param={p.filters.by === "l2" ? "l2s" : "cities"}
            teams={[
              ...groupCards.map((c) => ({ managerId: c.managerId.replace(/^(city|l2):/, ""), name: c.managerName })),
              { managerId: "org", name: "Everyone under you (average)" },
            ]}
          />
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card eyebrow="Organisation Learning Score">
          <div className="flex items-baseline gap-3">
            <span className="serif text-5xl font-semibold tabular-nums">{org.score ?? "—"}</span>
            <Pill tone={org.tone}>{org.label}</Pill>
          </div>
          <ul className="mt-3 space-y-1.5 text-sm">
            {org.signals.map((s) => (
              <li key={s.key} className="flex items-baseline justify-between gap-3" title={s.note ?? undefined}>
                <span><Dot tone={s.tone} />{s.label}</span>
                <span className="tabular-nums font-medium">{s.display}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted mt-3">
            {plural(learners.length, "person", "people")} in {plural(p.teams.length, "team", "teams")}.
            {p.computedAt ? ` Numbers as of ${p.computedAt.slice(11, 16)} UTC (refreshed every 15 minutes).` : " Computed live."}
          </p>
        </Card>
        <Card eyebrow="Top teams">
          {top.length === 0 ? <p className="text-sm text-muted">No scored teams yet.</p> : (
            <ul className="space-y-1.5 text-sm">
              {top.map((c) => (
                <li key={c.managerId} className="flex items-baseline justify-between gap-3">
                  <Link href={teamHref(c.managerId)} className="hover:underline">{c.isOwn ? "Your direct team" : `${c.managerName}'s team`}</Link>
                  <Pill tone={c.score.tone}>{c.score.score}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card eyebrow="Teams needing support">
          {weak.length === 0 ? <p className="text-sm text-muted">Every scored team is in the green.</p> : (
            <ul className="space-y-1.5 text-sm">
              {weak.map((c) => (
                <li key={c.managerId} className="flex items-baseline justify-between gap-3">
                  <Link href={teamHref(c.managerId)} className="hover:underline">{c.isOwn ? "Your direct team" : `${c.managerName}'s team`}</Link>
                  <span className="text-xs text-muted">{c.failed ? `${c.failed} failed · ` : ""}{c.overdue ? `${c.overdue} overdue · ` : ""}<Pill tone={c.score.tone}>{c.score.score}</Pill></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-paper border border-line rounded-2xl overflow-hidden">
          <div className="px-5 pt-4 pb-2">
            <h2 className="font-semibold text-sm">{p.filters.by === "l2" ? "L2 groups" : "Cities"} compared · worst first · click to open</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
                  <th className="text-left font-semibold px-5 py-2">{p.filters.by === "l2" ? "L2 manager" : "City"}</th>
                  <th className="text-right font-semibold px-3 py-2">Score</th>
                  <th className="text-right font-semibold px-3 py-2">People</th>
                  <th className="text-right font-semibold px-3 py-2">Journey on track</th>
                  <th className="text-right font-semibold px-3 py-2">Overdue</th>
                  <th className="text-right font-semibold px-5 py-2">Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {groupCards.map((c) => {
                  const journey = c.score.signals.find((s) => s.key === "journey")?.value ?? null;
                  return (
                    <tr key={c.managerId} className="hover:bg-canvas/60">
                      <td className="px-5 py-2.5 font-medium"><Link href={groupHref(c.managerId)} className="hover:underline">{c.managerName}</Link></td>
                      <td className="px-3 py-2.5 text-right"><Pill tone={c.score.tone}>{c.score.score ?? "—"}</Pill></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{c.size}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pct(journey)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${c.overdue ? "text-red-700 font-semibold" : ""}`}>{c.overdue}</td>
                      <td className={`px-5 py-2.5 text-right tabular-nums ${c.failed ? "text-red-700 font-semibold" : ""}`}>{c.failed}</td>
                    </tr>
                  );
                })}
                {groupCards.length === 0 && <tr><td colSpan={6} className="px-5 py-6 text-sm text-muted text-center">Nobody matches these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <Card eyebrow="Major learning gaps (across everyone under you)">
          {gaps.length === 0 ? (
            <p className="text-sm text-muted">No module or journey day is holding the organisation back right now.</p>
          ) : (
            <ul className="space-y-2.5 text-sm">
              {gaps.map((g) => (
                <li key={g.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {g.kind === "course" ? <Link href={`/${orgSlug}/team-performance${withQ({ content: `course:${g.id}` })}`} className="hover:underline">{g.title}</Link> : g.title}
                    </span>
                    <Pill tone={g.failed || g.overdue ? "bad" : "warn"}>
                      {g.kind !== "course"
                        ? `${g.pending} pending`
                        : g.failed
                          ? g.failRate ? `${g.failRate}% fail rate` : `${g.failed} failed`
                          : g.notStarted
                            ? g.notStartedRate ? `${g.notStartedRate}% not started` : `${g.notStarted} not started`
                            : `${g.learners} flagged`}
                    </Pill>
                  </div>
                  <p className="text-xs text-muted mt-0.5">
                    {g.advice}
                    {g.kind === "course" && g.orgFailRate !== null ? ` · org benchmark ${g.orgFailRate}%` : ""}
                  </p>
                  {g.kind === "course" && (
                    <div className="mt-1.5">
                      <RaiseTicketButton orgSlug={orgSlug} label="Raise ticket · content problem" category="content_issue" people={[]} content={{ kind: "course", id: g.id, title: g.title }} exception={g.failed ? "failed" : g.notStarted ? "not_started" : null} origin="team-performance" />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted mt-3">As of {p.today} (organisation calendar). Content-level only — people appear once you open a team.</p>
        </Card>
      </div>
    </div>
  );
}
