import Link from "next/link";
import { ScrollTabs } from "@/components/ui/scroll-tabs";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { adminHome, canManage, canViewReports, roleLabel } from "@/lib/auth/permissions";
import { ThemePill } from "./_components/theme-pill";
import { NavItem } from "./_components/nav-item";
import { Breadcrumbs } from "./_components/breadcrumbs";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { PlatformBroadcastBanner } from "@/components/platform-broadcast-banner";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { readTenantMailNotice, smtpSettingsPath, type TenantMailNotice } from "@/lib/notifications/smtp-state";

/**
 * The banner of section E (ADR 0029; rule FP4) for the organisation's
 * super owners and admins: its email is not set up or failing, or its
 * daily count is near the limit, past the line where routine mail stops,
 * or at the limit; or its limit is so low that routine mail never goes.
 * Fixed words, the count and the limit; no address.
 */
function tenantMailBanner(notice: TenantMailNotice | null): { tone: "critical" | "warning"; text: string } | null {
  if (!notice) return null;
  switch (notice.kind) {
    case "not_configured":
      return { tone: "critical", text: "Email is not set up for this organisation, so no email reaches your learners. Set up SMTP on the SMTP tab of Settings." };
    case "failing":
      return { tone: "critical", text: `Email is failing for this organisation${notice.lastErrorClass ? ` (last error: ${notice.lastErrorClass})` : ""}, so your learners' email is not being sent. Check the SMTP tab of Settings and send a test.` };
    case "limit_reached":
      return { tone: "critical", text: `All email has stopped: ${notice.sent24h} of the daily limit of ${notice.limit} were sent in the last 24 hours. Email starts again as the 24 hours move on.` };
    case "routine_stopped":
      return { tone: "critical", text: `Routine email has stopped for today: ${notice.sent24h} of the daily limit of ${notice.limit} were sent in the last 24 hours. Reset codes, sign-in links and welcome mail still go until the limit.` };
    case "routine_off":
      return { tone: "warning", text: `Routine email is off for this organisation: its daily limit of ${notice.limit} is no more than the part kept for reset codes, sign-in links and welcome mail, so reminders, announcements and assignment email are never sent. A platform owner sets the limit.` };
    case "near_limit":
      return { tone: "warning", text: `Email is near today's limit: ${notice.sent24h} of ${notice.limit} sent in the last 24 hours. Routine email stops before the limit.` };
  }
}

/**
 * Section eyebrow inside the admin sidebar. Hidden on mobile so the nav stays a
 * single flat horizontal scroll row there; on desktop it groups links into
 * People / Content / Engagement / Insights / Configure for faster scanning.
 */
function NavGroup({ label }: { label: string }) {
  return (
    <div className="hidden md:block px-3 pt-4 pb-1 text-[10px] uppercase tracking-wider text-muted first:pt-0">
      {label}
    </div>
  );
}

function fontStackFor(name: string | null | undefined): string {
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

export default async function AdminLayout({
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

  const manage = canManage(role);
  const reports = canViewReports(role);
  if (!manage && !reports) {
    redirect(`/${org.slug}/dashboard?denied=1`);
  }
  const brandColor = (org.brand_color as string | null) || "#4f46e5";
  // Only the roles that can act on it read and see the banner.
  const mailBanner = manage
    ? tenantMailBanner(
        await readTenantMailNotice(
          createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }),
          org.id
        )
      )
    : null;

  return (
    <div
      className="min-h-screen flex flex-col bg-canvas"
      style={
        {
          "--brand-color": brandColor,
          fontFamily: fontStackFor(org.brand_font),
        } as React.CSSProperties
      }
    >
      {impersonation && (
        <ImpersonationBanner orgName={org.name} expiresAt={impersonation.expiresAt} />
      )}
      <PlatformBroadcastBanner />
      {mailBanner && (
        <div
          role="alert"
          className={`px-4 py-2 text-sm border-b ${mailBanner.tone === "critical" ? "bg-red-50 text-red-800 border-red-200" : "bg-amber-50 text-amber-900 border-amber-200"}`}
        >
          {mailBanner.text}{" "}
          <Link href={smtpSettingsPath(org.slug)} className="underline font-medium">
            Open the SMTP settings
          </Link>
        </div>
      )}
      <div className="flex flex-col md:flex-row flex-1">
        <aside className="w-full md:w-64 md:min-h-screen border-b md:border-b-0 md:border-r border-line bg-paper px-4 py-4 flex flex-col">
          <Link
            href={`/${org.slug}/dashboard`}
            className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg border border-line text-sm hover:border-ink transition-colors group"
            title="Return to learner experience"
          >
            <svg className="h-4 w-4 text-muted group-hover:text-ink" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z" clipRule="evenodd" />
            </svg>
            <span>Return to Learner View</span>
          </Link>

          <Link href={`/${org.slug}/${adminHome(role)?.path ?? "analytics"}`} className="flex items-center gap-2 mb-6 px-3">
            {org.logo_url && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={org.logo_url} alt={org.name} className="h-10 w-auto max-w-[140px] object-contain" />
            )}
            <span className="serif text-2xl leading-none">{org.name}</span>
          </Link>

          <ScrollTabs className="flex-1 -mx-4 md:mx-0" innerClassName="px-4 md:px-0 md:overflow-visible">
          <nav className="md:space-y-1 text-sm flex md:block gap-1">
            {manage && <NavItem href={`/${org.slug}/attention`} label="Attention Center" />}

            {manage && <NavGroup label="People" />}
            {manage && <NavItem href={`/${org.slug}/users`} label="Users" />}
            {manage && <NavItem href={`/${org.slug}/teams`} label="Teams" />}

            {manage && <NavGroup label="Content" />}
            {manage && <NavItem href={`/${org.slug}/library`} label="Library" />}
            {manage && <NavItem href={`/${org.slug}/learning-paths`} label="Learning paths" />}

            {manage && <NavGroup label="Engagement" />}
            {manage && <NavItem href={`/${org.slug}/journey-admin`} label="Yoddha Journey" />}
            {manage && <NavItem href={`/${org.slug}/gamification`} label="Gamification" />}
            {manage && <NavItem href={`/${org.slug}/announcements`} label="Announcements" />}
            {manage && <NavItem href={`/${org.slug}/tickets`} label="Tickets" />}
            {manage && <NavItem href={`/${org.slug}/attempt-requests`} label="Attempt Requests" />}
            {manage && <NavItem href={`/${org.slug}/notifications`} label="Broadcast" />}

            {reports && <NavGroup label="Insights" />}
            {reports && <NavItem href={`/${org.slug}/analytics`} label="Learner Analytics" />}
            {reports && <NavItem href={`/${org.slug}/reports`} label="Reports" />}

            {manage && <NavGroup label="Configure" />}
            {manage && <NavItem href={`/${org.slug}/groups`} label="Custom Groups" />}
            {role === "super_owner" && (
              <NavItem href={`/${org.slug}/master-data`} label="Master data" />
            )}
            {role === "super_owner" && (
              <NavItem href={`/${org.slug}/integrations`} label="CRM & API" />
            )}
            {manage && <NavItem href={`/${org.slug}/settings`} label="Settings" />}
          </nav>
          </ScrollTabs>

          <div className="border-t border-line pt-4 mt-4 px-3 text-xs text-muted">
            <div className="break-all">{user.email}</div>
            <div className="flex items-center justify-between gap-2 mt-1">
              <span>{roleLabel(role)}</span>
              <ThemePill />
            </div>
          </div>
        </aside>

        <main className="flex-1 px-5 md:px-10 py-6 md:py-8 overflow-x-auto">
          <Breadcrumbs />
          {children}
        </main>
      </div>
    </div>
  );
}
