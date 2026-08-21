import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { GamificationClient, type GamificationSettings, type BadgeRow } from "./gamification-client";

export const dynamic = "force-dynamic";

export default async function GamificationAdminPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) redirect(`/${orgSlug}/dashboard?denied=1`);

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: gsRow }, { data: badgeRows }, xpAgg, streaks, badges30, optOuts] =
    await Promise.all([
      svc
        .from("gamification_settings")
        .select("*")
        .eq("organization_id", org.id)
        .maybeSingle(),
      svc
        .from("gamification_badges")
        .select("*")
        .or(`organization_id.is.null,organization_id.eq.${org.id}`)
        .order("created_at", { ascending: true }),
      svc
        .from("xp_events")
        .select("xp")
        .eq("organization_id", org.id)
        .gte("created_at", monthAgo),
      svc
        .from("user_gamification")
        .select("user_id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .gt("current_streak_days", 0),
      svc
        .from("user_badges")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .gte("awarded_at", monthAgo),
      svc
        .from("user_gamification")
        .select("user_id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .eq("opted_out", true),
    ]);

  const xp30d = ((xpAgg.data ?? []) as Array<{ xp: number }>).reduce(
    (s, r) => s + r.xp,
    0
  );

  // Earned counts per badge slug for the catalog cards.
  const { data: earnedRows } = await svc
    .from("user_badges")
    .select("badge_slug")
    .eq("organization_id", org.id)
    .is("revoked_at", null);
  const earnedBySlug = new Map<string, number>();
  for (const r of (earnedRows ?? []) as Array<{ badge_slug: string }>) {
    earnedBySlug.set(r.badge_slug, (earnedBySlug.get(r.badge_slug) ?? 0) + 1);
  }

  const allBadges = ((badgeRows ?? []) as BadgeRow[]).map((b) => ({
    ...b,
    earned_count: earnedBySlug.get(b.slug) ?? 0,
  }));
  // Org override wins over the global row with the same slug.
  const bySlug = new Map<string, BadgeRow>();
  for (const b of allBadges) {
    const existing = bySlug.get(b.slug);
    if (!existing || (existing.organization_id === null && b.organization_id !== null)) {
      bySlug.set(b.slug, b);
    }
  }

  return (
    <GamificationClient
      orgSlug={orgSlug}
      settings={(gsRow ?? null) as GamificationSettings | null}
      badges={Array.from(bySlug.values())}
      kpis={{
        xp30d,
        activeStreaks: streaks.count ?? 0,
        badges30d: badges30.count ?? 0,
        optOuts: optOuts.count ?? 0,
      }}
    />
  );
}
