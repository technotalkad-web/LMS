import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { l2GroupsOf, loadManagerContext, teamsOf } from "@/lib/manager/access";
import { loadScopedInsights } from "@/lib/manager/cache";
import { teamCards, type TeamInput } from "@/lib/manager/report-card";
import { PERIODS } from "@/lib/manager/types";
import { Card, Dot, Pill } from "../_components/ui";
import { managerNames } from "../_components/names";

export const dynamic = "force-dynamic";

/**
 * Compare (§8): two or three groups of the viewer's hierarchy side by side —
 * the same four-signal report card plus exception counts. No charts, no
 * metric builder.
 *   ?teams=<managerId>&teams=<managerId>[&teams=…]   (L2 and L3; "a,b" also accepted)
 *   ?cities=<city>&cities=<city>[&cities=…]          (L3; repeated, a city name may contain a comma)
 *   ?l2s=<managerId>&l2s=<managerId>[&l2s=…]         (L3: L2 groups)
 * The id "org" in any list is "everyone under you" (the hierarchy average),
 * so a team or a city can be read against the whole. ?vertical= / ?branch=
 * narrow the people exactly as on the L3 screen that launched the compare.
 */
export default async function CompareTeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{
    teams?: string | string[]; cities?: string | string[]; l2s?: string | string[];
    period?: string; content?: string; vertical?: string; branch?: string;
  }>;
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
  const list = (v: unknown, split: boolean) => {
    const raw = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
    const parts = split ? raw.flatMap((x) => x.split(",")) : raw;
    return [...new Set(parts.map((x) => x.trim()).filter(Boolean))];
  };
  const mode: "teams" | "cities" | "l2s" = list(sp.cities, false).length ? "cities" : list(sp.l2s, true).length ? "l2s" : "teams";
  // City and L2-group comparison belong to the organisation view (L3).
  if (mode !== "teams" && ctx.scope.level < 3) notFound();
  // Ids (teams / L2 groups) may come comma-joined; city names are repeated params only.
  const wanted = list(sp[mode], mode !== "cities");
  const period = PERIODS.find((p) => p.value === (str(sp.period) || "30")) ?? PERIODS[1];
  const content = str(sp.content);
  const vertical = ctx.scope.level === 3 ? str(sp.vertical) : "";
  const branch = ctx.scope.level === 3 ? str(sp.branch) : "";

  const allTeams = teamsOf(ctx);
  const l2Groups = ctx.scope.level === 3 ? l2GroupsOf(ctx) : [];
  const names = await managerNames(svc, [...allTeams.map((t) => t.managerId), ...l2Groups.map((g) => g.id)]);

  // Resolve each wanted id to a group INSIDE the viewer's hierarchy; unknown
  // ids are dropped, THEN the first three valid ones are compared. Cities are
  // resolved after the people are loaded (they come from the insights).
  const resolveId = (id: string): TeamInput | null => {
    if (id === "org") return { managerId: "org", managerName: "Everyone under you", memberIds: ctx.allIds, isOwn: false };
    if (mode === "teams") {
      const t = allTeams.find((x) => x.managerId === id);
      return t ? { ...t, managerName: t.isOwn ? "Your direct team" : `${names.get(t.managerId)?.name ?? "Manager"}'s team` } : null;
    }
    if (mode === "l2s") {
      const g = l2Groups.find((x) => x.id === id);
      return g ? { managerId: g.id, managerName: `${names.get(g.id)?.name ?? "Manager"}'s group`, memberIds: g.memberIds, isOwn: false } : null;
    }
    return { managerId: id, managerName: id, memberIds: [], isOwn: false }; // city: filled below
  };
  const picked = wanted.map(resolveId).filter((g): g is TeamInput => !!g).slice(0, 3);
  if (mode !== "cities" && picked.length < 2) notFound();

  // People to compute: everyone under the viewer when a city / L2 group / the
  // hierarchy average / a people filter is involved; otherwise just the chosen teams.
  const needAll = mode !== "teams" || picked.some((g) => g.managerId === "org") || !!vertical || !!branch;
  const userIds = needAll ? ctx.allIds : [...new Set(picked.flatMap((g) => g.memberIds))];
  const { learners: all, today } = await loadScopedInsights(svc, {
    orgId: org.id, orgSlug, userIds, periodDays: period.days, content, useCache: needAll && ctx.scope.level === 3,
  });
  const learners = all.filter((l) => (!vertical || l.vertical === vertical) && (!branch || l.branch === branch));
  const byId = new Map(learners.map((l) => [l.userId, l]));
  const groups = picked
    .map((g) => (mode === "cities" && g.managerId !== "org" ? { ...g, memberIds: learners.filter((l) => (l.city ?? "No city") === g.managerId).map((l) => l.userId) } : g))
    .filter((g) => g.managerId === "org" || g.memberIds.some((id) => byId.has(id)));
  if (groups.length < 2) notFound();

  const cards = teamCards(groups, byId, period.days).sort((a, b) => wanted.indexOf(a.managerId) - wanted.indexOf(b.managerId));
  const back = new URLSearchParams();
  if (period.value !== "30") back.set("period", period.value);
  if (content) back.set("content", content);
  if (vertical) back.set("vertical", vertical);
  if (branch) back.set("branch", branch);
  if (mode === "l2s") back.set("by", "l2");
  const backQ = back.toString() ? `?${back.toString()}` : "";
  const href = (id: string) => {
    if (id === "org") return `/${orgSlug}/team-performance${backQ}`;
    if (mode === "teams") return `/${orgSlug}/team-performance/team/${id}${backQ}`;
    const q = new URLSearchParams(back);
    q.set(mode === "cities" ? "city" : "l2", id);
    return `/${orgSlug}/team-performance?${q.toString()}`;
  };
  const noun = mode === "teams" ? "teams" : mode === "cities" ? "cities" : "groups";

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <Link href={`/${orgSlug}/team-performance${backQ}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">← Back to {mode === "teams" ? "teams" : "the organisation view"}</Link>
      <header>
        <h1 className="serif text-4xl">Compare {noun}</h1>
        <p className="text-muted text-sm mt-1">Same four signals, side by side · {period.days ? `last ${period.days} days` : "all time"} for the counts{content ? " · narrowed to the selected content" : ""} · as of {today}.</p>
      </header>
      <div className={`grid grid-cols-1 gap-4 ${cards.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {cards.map((c) => (
          <Card key={c.managerId}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-semibold">
                <Link href={href(c.managerId)} className="hover:underline">{c.managerName}</Link>
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
