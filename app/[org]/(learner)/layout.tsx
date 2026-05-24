import Link from "next/link";
import { BookOpen } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage, canViewReports, roleLabel } from "@/lib/auth/permissions";
import { ProfileDropdown } from "./_components/profile-dropdown";
import { MobileBottomNav } from "./_components/mobile-nav";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { PlatformBroadcastBanner } from "@/components/platform-broadcast-banner";

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

  return (
    <div
      className="min-h-screen flex flex-col bg-canvas"
      style={
        {
          "--brand-color": brandColor,
          fontFamily: fontStackFor(brandFont),
        } as React.CSSProperties
      }
    >
      {impersonation && (
        <ImpersonationBanner orgName={org.name} expiresAt={impersonation.expiresAt} />
      )}
      <PlatformBroadcastBanner />
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

            <nav className="hidden md:flex items-center gap-1 text-sm">
              <Link href={`/${org.slug}/dashboard`} className="px-3 py-2 rounded-lg text-muted hover:text-ink hover:bg-canvas transition-colors">Dashboard</Link>
              <Link href={`/${org.slug}/courses`} className="px-3 py-2 rounded-lg text-muted hover:text-ink hover:bg-canvas transition-colors">Courses</Link>
              <Link href={`/${org.slug}/support`} className="px-3 py-2 rounded-lg text-muted hover:text-ink hover:bg-canvas transition-colors">Help &amp; Support</Link>
            </nav>
          </div>

          <ProfileDropdown
            orgSlug={org.slug}
            email={user.email ?? "you"}
            roleLabel={roleLabel(role)}
            canSwitchToAdmin={canSwitch}
            brandColor={brandColor}
          />
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 md:pb-8">
        {children}
      </main>

      <MobileBottomNav orgSlug={org.slug} brandColor={brandColor} />
    </div>
  );
}
