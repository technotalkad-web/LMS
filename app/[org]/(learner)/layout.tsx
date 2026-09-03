import Link from "next/link";
import { BookOpen } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage, canViewReports, roleLabel } from "@/lib/auth/permissions";
import { ProfileDropdown } from "./_components/profile-dropdown";
import { LearnerTopNav } from "./_components/learner-nav";
import { MobileBottomNav } from "./_components/mobile-nav";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { PlatformBroadcastBanner } from "@/components/platform-broadcast-banner";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveLearnerTheme } from "@/lib/theme/learner-themes";
import { resolveManyGroups } from "@/lib/org/groups";
import {
  PopupAnnouncement,
  type PopupData,
} from "./_components/popup-announcement";

function fontStackFor(name: string | null): string {
  switch (name) {
    case "inter":
      return "var(--font-inter), Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "poppins":
      return "var(--font-poppins), Poppins, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "jakarta":
      return "var(--font-jakarta), 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "roboto":
      return "var(--font-roboto), Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "merriweather":
      return "var(--font-merriweather), Merriweather, Georgia, 'Times New Roman', serif";
    case "system":
      return "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case "serif":
      return "var(--font-merriweather), Merriweather, Georgia, serif";
    case "mono":
      return "var(--font-geist-mono), ui-monospace, monospace";
    default:
      return "var(--font-inter), Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }
}

export default async function LearnerLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const orgData = (await requireOrgAccess(slug)) as Awaited<
    ReturnType<typeof requireOrgAccess>
  > & {
    org: {
      id: string;
      name: string;
      slug: string;
      logo_url?: string | null;
      brand_color?: string | null;
      brand_font?: string | null;
    };
  };
  const { org, user, role } = orgData;
  const impersonation = (orgData as { impersonation?: { expiresAt: string } | null }).impersonation;
  const canSwitch = canManage(role) || canViewReports(role);
  const brandColor = (org.brand_color as string | null) || "#4f46e5";
  const brandFont = (org.brand_font as string | null) || "inter";

  // Gamification: hide the Leaderboard nav item when boards are disabled.
  // One PK-indexed read (members can read their org's settings under RLS);
  // fail-open to visible — the page itself self-defends when disabled.
  // Profile (own-row RLS read) rides the same round trip for the nav's
  // display name + photo; both fail-soft to the email-only header.
  let showLeaderboard = true;
  let showJourney = false;
  let showTeamPerformance = false;
  let displayName = user.email ?? "you";
  let avatarUrl: string | null = null;
  let popup: PopupData | null = null;
  // Admin-chosen learner theme (0060): null = default look. Read fail-soft —
  // pre-migration the select errors and the theme simply stays default.
  let lmsTheme: { id: string; vars: Record<string, string> } | null = null;
  try {
    const supabase = await createClient();
    const [{ data: gs }, { data: prof }, { data: journeyRows }, { data: themeRow }] = await Promise.all([
      supabase
        .from("gamification_settings")
        .select("enabled, leaderboard_enabled")
        .eq("organization_id", org.id)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("first_name, last_name, avatar_url")
        .eq("id", user.id)
        .maybeSingle(),
      // Yoddha journey (0058): nav item only for enrolled learners, and only
      // while the program is active — deactivating the journey in the admin
      // Settings hides it from learners entirely (dashboard banner applies
      // the same rule). Fail-soft — pre-migration this select errors and
      // the nav item stays hidden.
      supabase
        .from("journey_enrollments")
        .select("id, journey_programs!inner(is_active)")
        .eq("organization_id", org.id)
        .eq("user_id", user.id)
        .in("status", ["active", "completed"])
        .eq("journey_programs.is_active", true)
        .limit(1),
      supabase
        .from("organizations")
        .select("learner_theme, learner_theme_custom")
        .eq("id", org.id)
        .maybeSingle(),
    ]);
    showJourney = (journeyRows ?? []).length > 0;
    lmsTheme = resolveLearnerTheme(
      themeRow?.learner_theme,
      themeRow?.learner_theme_custom
    );
    // Team Performance nav (Phase 4): only for people who MANAGE someone.
    // RLS hides peers' member rows, so this one count runs service-role
    // (read-only, org+manager scoped). Fail-soft to hidden.
    const svcNav = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { count: reportCount } = await svcNav
      .from("organization_members")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .eq("line_manager_id", user.id)
      .eq("status", "active");
    showTeamPerformance = (reportCount ?? 0) > 0;

    // Full-screen popup announcements (0068). Fail-soft: pre-migration the
    // kind filter errors and no popup renders. Eligibility: active + inside
    // its schedule window + audience match (Custom Group; null = everyone) +
    // frequency (once = never seen; daily = not seen today; always = every
    // visit). Newest eligible wins.
    const nowIso = new Date().toISOString();
    const { data: popRows } = await supabase
      .from("org_announcements")
      .select(
        "id, title, body, media_landscape_url, media_portrait_url, cta_label, cta_href, duration_seconds, frequency, audience_group_id, starts_at"
      )
      .eq("organization_id", org.id)
      .eq("is_active", true)
      .eq("kind", "popup")
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(5);
    const popCandidates = (popRows ?? []) as Array<
      PopupData & { frequency: string; audience_group_id: string | null; starts_at: string | null }
    >;
    if (popCandidates.length > 0) {
      const ids = popCandidates.map((p) => p.id);
      const { data: impRows } = await supabase
        .from("announcement_impressions")
        .select("announcement_id, shown_at")
        .eq("user_id", user.id)
        .in("announcement_id", ids)
        .order("shown_at", { ascending: false })
        .limit(200);
      const lastShown = new Map<string, string>();
      for (const r of (impRows ?? []) as Array<{ announcement_id: string; shown_at: string }>) {
        if (!lastShown.has(r.announcement_id)) lastShown.set(r.announcement_id, r.shown_at);
      }
      const todayUtc = nowIso.slice(0, 10);
      for (const p of popCandidates) {
        const seen = lastShown.get(p.id);
        if (p.frequency === "once" && seen) continue;
        if (p.frequency === "daily" && seen && seen.slice(0, 10) === todayUtc) continue;
        if (p.audience_group_id) {
          const audience = await resolveManyGroups(svcNav, org.id, [p.audience_group_id]);
          if (!audience.has(user.id)) continue;
        }
        popup = {
          id: p.id,
          title: p.title,
          body: p.body,
          media_landscape_url: p.media_landscape_url,
          media_portrait_url: p.media_portrait_url,
          cta_label: p.cta_label,
          cta_href: p.cta_href,
          duration_seconds: p.duration_seconds ?? 15,
        };
        break;
      }
    }
    if (gs && (gs.enabled === false || gs.leaderboard_enabled === false)) {
      showLeaderboard = false;
    }
    if (prof) {
      const name = [prof.first_name, prof.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (name) displayName = name;
      avatarUrl = (prof.avatar_url as string | null) ?? null;
    }
  } catch {
    // fail-open
  }

  return (
    <div
      data-lms-root=""
      data-lms-theme={lmsTheme?.id}
      className="min-h-screen flex flex-col bg-canvas"
      style={
        {
          "--brand-color": brandColor,
          fontFamily: fontStackFor(brandFont),
          ...(lmsTheme?.vars ?? {}),
        } as React.CSSProperties
      }
    >
      {impersonation && (
        <ImpersonationBanner orgName={org.name} expiresAt={impersonation.expiresAt} />
      )}
      <PlatformBroadcastBanner />
      {popup && <PopupAnnouncement orgSlug={org.slug} popup={popup} />}
      <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-[68px] gap-3">
          <div className="flex items-center gap-6">
            <Link href={`/${org.slug}/dashboard`} className="flex items-center gap-2">
              {org.logo_url ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={org.logo_url} alt={org.name} className="h-11 w-auto max-w-[180px] object-contain" />
              ) : (
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shadow-sm" style={{ background: brandColor }}>
                  <BookOpen className="w-5 h-5 text-white" />
                </div>
              )}
              <span className="font-semibold text-lg tracking-tight">{org.name}</span>
            </Link>

            <LearnerTopNav
              orgSlug={org.slug}
              showLeaderboard={showLeaderboard}
              showJourney={showJourney}
              showTeamPerformance={showTeamPerformance}
            />
          </div>

          <ProfileDropdown
            orgSlug={org.slug}
            email={user.email ?? "you"}
            displayName={displayName}
            avatarUrl={avatarUrl}
            roleLabel={roleLabel(role)}
            canSwitchToAdmin={canSwitch}
            brandColor={brandColor}
          />
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 md:pb-8">
        {children}
      </main>

      <MobileBottomNav
        orgSlug={org.slug}
        brandColor={brandColor}
        showLeaderboard={showLeaderboard}
      />
    </div>
  );
}
