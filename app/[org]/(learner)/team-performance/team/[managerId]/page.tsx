import { notFound } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { loadManagerContext, teamOf } from "@/lib/manager/access";
import { computeLearnerInsights } from "@/lib/manager/insights";
import { lensVisible, loadCoverage, scopeForManager } from "@/lib/manager/coverage";
import { PERIODS } from "@/lib/manager/types";
import { L1View } from "../../_components/l1-view";
import { managerNames } from "../../_components/names";

export const dynamic = "force-dynamic";

/**
 * A team's report card, opened from the L2/L3 screen (§6): the L1 screen for
 * the team led by [managerId], with named people — only for a team inside the
 * viewer's own hierarchy (the viewer's own direct team included). Anything
 * else is not found, never a leak.
 */
export default async function TeamDrillDownPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; managerId: string }>;
  searchParams?: Promise<{ period?: string; content?: string; status?: string }>;
}) {
  const { org: orgSlug, managerId } = await params;
  const sp = (await searchParams) ?? {};
  const { user, org } = await requireOrgAccess(orgSlug);
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const ctx = await loadManagerContext(svc, org.id, user.id);
  const team = ctx.isManager ? teamOf(ctx, managerId) : null;
  if (!team) notFound();

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const period = PERIODS.find((p) => p.value === (str(sp.period) || "30")) ?? PERIODS[1];
  const content = str(sp.content);
  const statusFilter = str(sp.status);
  const nowMs = Date.now();
  // Phase 4c: the viewer's coverage decides which content counts; a lens on hidden content is ignored.
  const coverage = await loadCoverage(svc, org.id, user.id);
  const load = async (lens: string) => {
    const raw = await computeLearnerInsights(svc, { orgId: org.id, orgSlug, userIds: team.memberIds, periodDays: period.days, content: lens });
    const scoped = await scopeForManager(svc, { orgId: org.id, viewerId: user.id, learners: raw.learners, catalog: raw.catalog, periodDays: period.days, nowMs, coverage });
    return { raw, scoped };
  };
  let { raw, scoped } = await load(content);
  const lensOk = lensVisible(scoped.visible, content);
  if (!lensOk) ({ raw, scoped } = await load(""));
  const { learners, catalog } = scoped;
  const names = await managerNames(svc, [managerId]);
  const managerName = team.isOwn ? "Your direct team" : `${names.get(managerId)?.name ?? "Manager"}'s team`;
  return (
    <L1View
      orgSlug={orgSlug}
      basePath={`team-performance/team/${managerId}`}
      title={managerName}
      subtitle={`${learners.length} ${learners.length === 1 ? "person" : "people"}${team.isOwn ? "" : " · inside your reporting line"}${coverage.hasVertical ? ` · within ${coverage.label}` : ""}`}
      note={coverage.hasVertical ? null : "Your Business Vertical is not set, so no mapped content is visible. Ask your administrator to set your vertical and department."}
      backHref={{ href: `/${orgSlug}/team-performance`, label: "Back to teams" }}
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
