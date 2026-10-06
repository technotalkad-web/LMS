import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { loadManagerContext, teamsOf } from "@/lib/manager/access";
import { computeLearnerInsights } from "@/lib/manager/insights";
import { teamCards } from "@/lib/manager/report-card";
import { PERIODS } from "@/lib/manager/types";
import { Card, Dot, Pill } from "../_components/ui";
import { managerNames } from "../_components/names";

export const dynamic = "force-dynamic";

/**
 * Compare (§8): two or three teams of the viewer's hierarchy side by side —
 * the same four-signal report card plus exception counts. No charts, no
 * metric builder. ?teams=<managerId>,<managerId>[,<managerId>]
 */
export default async function CompareTeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ teams?: string; period?: string; content?: string }>;
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
  if (!ctx.isManager || ctx.scope.level < 2) notFound();

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const wanted = [...new Set(str(sp.teams).split(",").map((x) => x.trim()).filter(Boolean))];
  const all = teamsOf(ctx);
  // Only teams inside the viewer's hierarchy; an unknown id is simply dropped,
  // THEN the first three valid ones are compared.
  const teams = wanted.map((id) => all.find((t) => t.managerId === id)).filter((t): t is NonNullable<typeof t> => !!t).slice(0, 3);
  if (teams.length < 2) notFound();

  const period = PERIODS.find((p) => p.value === (str(sp.period) || "30")) ?? PERIODS[1];
  const content = str(sp.content);
  const { learners, today } = await computeLearnerInsights(svc, {
    orgId: org.id,
    orgSlug,
    userIds: [...new Set(teams.flatMap((t) => t.memberIds))],
    periodDays: period.days,
    content,
  });
  const names = await managerNames(svc, teams.map((t) => t.managerId));
  const byId = new Map(learners.map((l) => [l.userId, l]));
  const cards = teamCards(
    teams.map((t) => ({ ...t, managerName: t.isOwn ? "Your direct team" : `${names.get(t.managerId)?.name ?? "Manager"}'s team` })),
    byId,
    period.days
  ).sort((a, b) => wanted.indexOf(a.managerId) - wanted.indexOf(b.managerId));

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <Link href={`/${orgSlug}/team-performance`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">← Back to teams</Link>
      <header>
        <h1 className="serif text-4xl">Compare teams</h1>
        <p className="text-muted text-sm mt-1">Same four signals, side by side · {period.days ? `last ${period.days} days` : "all time"} for the counts{content ? " · narrowed to the selected content" : ""} · as of {today}.</p>
      </header>
      <div className={`grid grid-cols-1 gap-4 ${cards.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {cards.map((c) => (
          <Card key={c.managerId}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-semibold">
                <Link href={`/${orgSlug}/team-performance/team/${c.managerId}`} className="hover:underline">{c.managerName}</Link>
              </h2>
              <Pill tone={c.score.tone}>{c.score.score ?? "—"}</Pill>
            </div>
            <p className="text-xs text-muted mt-0.5">{c.size} {c.size === 1 ? "person" : "people"} · {c.score.label}</p>
            <ul className="mt-3 space-y-1.5 text-sm">
              {c.score.signals.map((s) => (
                <li key={s.key} className="flex items-baseline justify-between gap-3">
                  <span><Dot tone={s.tone} />{s.label}</span>
                  <span className="tabular-nums font-medium">{s.display}</span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5 mt-1.5">
                <span>Failed · Overdue · Behind</span>
                <span className="tabular-nums font-medium">{c.failed} · {c.overdue} · {c.behind}</span>
              </li>
              <li className="flex items-baseline justify-between gap-3">
                <span>Stuck · Not started · Inactive</span>
                <span className="tabular-nums font-medium">{c.stuck} · {c.notStarted} · {c.inactive}</span>
              </li>
              <li className="flex items-baseline justify-between gap-3">
                <span>Need support</span>
                <span className="tabular-nums font-medium">{c.needsSupport}</span>
              </li>
              <li className="flex items-baseline justify-between gap-3">
                <span>Completions vs previous period</span>
                <span className="tabular-nums font-medium">{c.completionsDelta === null ? "—" : `${c.completionsDelta >= 0 ? "+" : ""}${c.completionsDelta}`}</span>
              </li>
            </ul>
            {c.topFailed && <p className="text-xs text-muted mt-3">Most failed: {c.topFailed.title} ({c.topFailed.n})</p>}
          </Card>
        ))}
      </div>
    </div>
  );
}
