import { Users } from "lucide-react";
import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canSeeEmail, loadManagerContext, teamsOf } from "@/lib/manager/access";
import { computeLearnerInsights } from "@/lib/manager/insights";
import { PERIODS } from "@/lib/manager/types";
import { L1View } from "./_components/l1-view";
import { L2View } from "./_components/l2-view";
import { managerNames } from "./_components/names";

export const dynamic = "force-dynamic";

/**
 * Team Performance — the Manager Report Card, at the viewer's level:
 *   - L1 (named as L1 only): their direct team (§4).
 *   - L2 / L3 (named higher by someone): teams compared across everyone under
 *     them (§6) — their own direct team is one of those teams. Clicking a team
 *     opens its L1 screen at /team-performance/team/[managerId].
 *
 * Access and scope (decision 3): the server resolves the viewer's people from
 * the explicit L1/L2/L3 fields (lib/manager/access.ts) and reads only those
 * people; the old "team leaders see member details" toggle no longer applies
 * here (decision 10). Computation is live.
 */
export default async function TeamPerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams?: Promise<{ period?: string; content?: string; status?: string; team?: string }>;
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

  if (ctx.scope.level === 1) {
    const { learners, catalog, benchmark, today } = await computeLearnerInsights(svc, {
      orgId: org.id,
      orgSlug,
      userIds: ctx.directIds,
      periodDays: period.days,
      content,
    });
    return (
      <L1View
        orgSlug={orgSlug}
        basePath="team-performance"
        title="Team Performance"
        subtitle={`${firstName ? `${firstName}'s team` : "Your team"} · ${learners.length} ${learners.length === 1 ? "person" : "people"}`}
        learners={learners}
        catalog={catalog}
        benchmark={benchmark}
        today={today}
        period={period}
        content={content}
        statusFilter={statusFilter}
        nowMs={nowMs}
      />
    );
  }

  // L2 / L3: everyone under the viewer, grouped by L1 team.
  const teams = teamsOf(ctx);
  const { learners, catalog, today } = await computeLearnerInsights(svc, {
    orgId: org.id,
    orgSlug,
    userIds: ctx.allIds,
    periodDays: period.days,
    content,
  });
  const names = await managerNames(svc, teams.map((t) => t.managerId));
  const byId = new Map(learners.map((l) => [l.userId, l]));
  const level = ctx.scope.level === 3 ? 3 : 2;
  return (
    <L2View
      orgSlug={orgSlug}
      title="Team Performance"
      subtitle={`${firstName ? `${firstName}'s` : "Your"} teams · ${teams.length} team${teams.length === 1 ? "" : "s"} · ${learners.length} people${level === 3 ? " · you are mapped as an L3 manager — the city/region grouping arrives in the next release" : ""}`}
      level={level}
      teams={teams.map((t) => ({ ...t, managerName: t.isOwn ? firstName ?? "You" : names.get(t.managerId)?.name ?? "Manager" }))}
      learners={learners}
      ungrouped={[...ctx.scope.ungrouped].map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l)}
      catalog={catalog}
      today={today}
      period={period}
      content={content}
      // §12: an email only for an L1 manager who is the viewer's own direct report.
      managerEmail={(id) => (canSeeEmail(ctx, id) ? names.get(id)?.email ?? null : null)}
    />
  );
}
