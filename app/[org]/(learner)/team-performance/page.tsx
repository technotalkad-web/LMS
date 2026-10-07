import { Users } from "lucide-react";
import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canSeeEmail, l2GroupsOf, loadManagerContext, teamsOf } from "@/lib/manager/access";
import { computeLearnerInsights } from "@/lib/manager/insights";
import { loadScopedInsights } from "@/lib/manager/cache";
import { lensVisible, loadCoverage, scopeForManager } from "@/lib/manager/coverage";
import { PERIODS, type LearnerInsight } from "@/lib/manager/types";
import { L1View } from "./_components/l1-view";
import { L2View } from "./_components/l2-view";
import { L3View } from "./_components/l3-view";
import { managerNames } from "./_components/names";

export const dynamic = "force-dynamic";

/**
 * Team Performance — the Manager Report Card, at the viewer's level:
 *   - L1 (named as L1 only): their direct team (§4).
 *   - L2 (named as L2 by someone): teams compared across everyone under them
 *     (§6) — their own direct team is one of those teams. Clicking a team
 *     opens its L1 screen at /team-performance/team/[managerId].
 *   - L3 (named as L3 by someone): the organisation view (§7) — cities or L2
 *     groups compared and org-wide learning gaps, read from the 15-minute
 *     precompute (lib/manager/cache.ts) when fresh, else computed live.
 *     ?city= / ?l2= open that group as a teams-compared screen.
 *
 * Access and scope (decision 3): the server resolves the viewer's people from
 * the explicit L1/L2/L3 fields (lib/manager/access.ts) and reads only those
 * people; the old "team leaders see member details" toggle no longer applies
 * here (decision 10).
 *
 * Visibility (Phase 4c, addendum §6): content mapping + actual assignment +
 * reporting hierarchy. lib/manager/coverage.ts applies the mapping rule over
 * the insights (live or cached) and narrows the content lens; every number
 * on the card is computed over visible content only (decision 22).
 */
const noVerticalNote = "Your Business Vertical is not set, so no mapped content is visible. Ask your administrator to set your vertical and department.";
export default async function TeamPerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{
    period?: string; content?: string; status?: string; team?: string;
    city?: string; l2?: string; vertical?: string; branch?: string; by?: string;
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
  const nowMs = Date.now();
  // ?team=<managerId> (the §9 Team filter) is the drill-down.
  if (str(sp.team)) {
    const q = new URLSearchParams();
    if (period.value !== "30") q.set("period", period.value);
    if (content) q.set("content", content);
    const s = q.toString();
    redirect(`/${orgSlug}/team-performance/team/${encodeURIComponent(str(sp.team))}${s ? `?${s}` : ""}`);
  }

  const { data: me } = await svc.from("profiles").select("first_name").eq("id", user.id).maybeSingle();
  const firstName = (me as { first_name?: string | null } | null)?.first_name ?? null;
  // The manager's coverage decides which content counts (rule 1); a lens on hidden content is ignored.
  const coverage = await loadCoverage(svc, org.id, user.id);
  const withinLabel = coverage.hasVertical ? ` · within ${coverage.label}` : "";

  if (ctx.scope.level === 1) {
    const raw = await computeLearnerInsights(svc, { orgId: org.id, orgSlug, userIds: ctx.directIds, periodDays: period.days, content });
    const scoped = await scopeForManager(svc, { orgId: org.id, viewerId: user.id, learners: raw.learners, catalog: raw.catalog, periodDays: period.days, nowMs, coverage });
    const lensOk = lensVisible(scoped.visible, content);
    const { learners, catalog } = lensOk ? scoped : await (async () => {
      const again = await computeLearnerInsights(svc, { orgId: org.id, orgSlug, userIds: ctx.directIds, periodDays: period.days });
      return scopeForManager(svc, { orgId: org.id, viewerId: user.id, learners: again.learners, catalog: again.catalog, periodDays: period.days, nowMs, coverage });
    })();
    return (
      <L1View
        orgSlug={orgSlug}
        basePath="team-performance"
        title="Team Performance"
        subtitle={`${firstName ? `${firstName}'s team` : "Your team"} · ${learners.length} ${learners.length === 1 ? "person" : "people"}${withinLabel}`}
        note={coverage.hasVertical ? null : noVerticalNote}
        learners={learners}
        catalog={catalog}
        benchmark={raw.benchmark}
        today={raw.today}
        period={period}
        content={lensOk ? content : ""}
        statusFilter={statusFilter}
        nowMs={nowMs}
      />
    );
  }

  // L2 / L3: everyone under the viewer. The L3 view reads the 15-minute
  // precompute when it is fresh and no content lens is applied; otherwise
  // (and always for L2) the numbers are computed live.
  const allTeams = teamsOf(ctx);
  const level = ctx.scope.level === 3 ? 3 : 2;
  const cityParam = level === 3 ? str(sp.city) : "";
  const l2Param = level === 3 ? str(sp.l2) : "";
  const vertical = level === 3 ? str(sp.vertical) : "";
  const branch = level === 3 ? str(sp.branch) : "";
  const by = str(sp.by) === "l2" ? "l2" : "city";
  // Rule 1 over everyone under the viewer (cached rows included), then the content lens.
  const loadAll = async (lens: string) => {
    const loaded = await loadScopedInsights(svc, {
      orgId: org.id, orgSlug, userIds: ctx.allIds, periodDays: period.days, content: lens, useCache: level === 3,
    });
    const scopedAll = await scopeForManager(svc, { orgId: org.id, viewerId: user.id, learners: loaded.learners, catalog: loaded.catalog, periodDays: period.days, nowMs, coverage });
    return { loaded, scopedAll };
  };
  let { loaded, scopedAll } = await loadAll(content);
  const lensOk = lensVisible(scopedAll.visible, content);
  // A lens on hidden content is ignored: reload without it (this also restores the L3 cache path).
  if (!lensOk) ({ loaded, scopedAll } = await loadAll(""));
  const contentLens = lensOk ? content : "";
  const { learners, catalog } = scopedAll;
  const { benchmark, today, computedAt } = loaded;
  const l2GroupsAll = level === 3 ? l2GroupsOf(ctx) : [];
  const names = await managerNames(svc, [...allTeams.map((t) => t.managerId), ...l2GroupsAll.map((g) => g.id)]);
  const nameOf = (id: string, own: boolean) => (own ? firstName ?? "You" : names.get(id)?.name ?? "Manager");

  // People filters (§9, L3 only): narrow the population, then the teams to those people.
  const keep = (l: LearnerInsight) =>
    (!vertical || l.vertical === vertical) && (!branch || l.branch === branch) && (!cityParam || (l.city ?? "No city") === cityParam);
  const l2Group = l2Param ? l2GroupsAll.find((g) => g.id === l2Param) ?? null : null;
  const l2Members = l2Group ? new Set(l2Group.memberIds) : null;
  const population = learners.filter((l) => keep(l) && (!l2Members || l2Members.has(l.userId)));
  const popIds = new Set(population.map((l) => l.userId));
  const teams = allTeams
    .map((t) => ({ ...t, memberIds: t.memberIds.filter((id) => popIds.has(id)), managerName: nameOf(t.managerId, t.isOwn) }))
    .filter((t) => t.memberIds.length > 0);
  const byId = new Map(population.map((l) => [l.userId, l]));
  const narrowed = !!cityParam || !!l2Group;
  const lens = `${vertical ? ` · ${vertical}` : ""}${branch ? ` · ${branch}` : ""}`;

  if (level === 2 || narrowed) {
    const scopeLabel = cityParam ? cityParam : l2Group ? `${nameOf(l2Group.id, false)}'s group` : `${firstName ? `${firstName}'s` : "Your"} teams`;
    const back = new URLSearchParams();
    if (period.value !== "30") back.set("period", period.value);
    if (contentLens) back.set("content", contentLens);
    if (vertical) back.set("vertical", vertical);
    if (branch) back.set("branch", branch);
    if (by === "l2") back.set("by", "l2");
    const backQ = back.toString();
    // The narrowing survives every filter change / compare inside the drill-down.
    const keep = narrowed ? { city: cityParam, l2: l2Group?.id ?? "", vertical, branch, by: by === "l2" ? "l2" : "" } : undefined;
    return (
      <L2View
        orgSlug={orgSlug}
        title={narrowed ? scopeLabel : "Team Performance"}
        subtitle={`${narrowed ? "Teams in this group" : scopeLabel} · ${teams.length} team${teams.length === 1 ? "" : "s"} · ${population.length} people${lens}${withinLabel}${coverage.hasVertical ? "" : ` · ${noVerticalNote}`}`}
        level={level}
        teams={teams}
        learners={population}
        ungrouped={[...ctx.scope.ungrouped].map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l)}
        catalog={catalog}
        today={today}
        period={period}
        content={contentLens}
        backHref={narrowed ? { href: `/${orgSlug}/team-performance${backQ ? `?${backQ}` : ""}`, label: "Back to the organisation view" } : null}
        keep={keep}
        // §12: an email only for an L1 manager who is the viewer's own direct report.
        managerEmail={(id) => (canSeeEmail(ctx, id) ? names.get(id)?.email ?? null : null)}
      />
    );
  }

  const l2Groups = l2GroupsAll
    .map((g) => ({ id: g.id, name: `${nameOf(g.id, false)}'s group`, memberIds: g.memberIds.filter((id) => popIds.has(id)) }))
    .filter((g) => g.memberIds.length > 0);
  const distinct = (vals: Array<string | null>) => [...new Set(vals.filter((v): v is string => !!v))].sort();
  return (
    <L3View
      orgSlug={orgSlug}
      title="Team Performance"
      subtitle={`Everyone under ${firstName ?? "you"} · ${population.length} ${population.length === 1 ? "person" : "people"} · ${teams.length} team${teams.length === 1 ? "" : "s"}${lens}${withinLabel}${coverage.hasVertical ? "" : ` · ${noVerticalNote}`}`}
      teams={teams}
      l2Groups={l2Groups}
      learners={population}
      catalog={catalog}
      benchmark={benchmark}
      today={today}
      period={period}
      content={contentLens}
      filters={{ city: cityParam, vertical, branch, by }}
      // The vertical filter narrows people INSIDE the coverage; it never widens it.
      options={{ cities: distinct(learners.map((l) => l.city)), verticals: distinct(learners.map((l) => l.vertical)).filter((v) => !coverage.hasVertical || coverage.pairs.some((p) => p.vertical.toLowerCase() === v.toLowerCase())), branches: distinct(learners.map((l) => l.branch)) }}
      computedAt={computedAt}
    />
  );
}
