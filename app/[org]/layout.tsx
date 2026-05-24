// Outer org segment layout. Each route group ((learner) | (admin))
// supplies its own chrome — sidebar vs top nav — so this layout itself
// is just a pass-through. Per-page auth + role gating happens in the
// group layouts so they can redirect appropriately.
//
// We also use this layout to set per-tenant page metadata (favicon +
// page title). Because this layout wraps every route under /[org]/*,
// the browser tab shows the right tenant's branding everywhere from
// /[org]/login to /[org]/dashboard to /[org]/library, without having
// to add the metadata to each page individually.
//
// Routes OUTSIDE /[org]/* (the platform-level /login, /super/*,
// /invitations/[token], etc.) continue to use the static app/favicon.ico
// because they have no tenant context.

import type { Metadata } from "next";
import { createClient as createServiceClient } from "@supabase/supabase-js";

// Force per-request render so a tenant editing their branding sees the
// new favicon/title on the next page load instead of a cached one.
export const dynamic = "force-dynamic";

/**
 * Per-tenant page metadata.
 *
 * Looks up the org by slug (service-role read of public branding fields —
 * pre-auth safe, same pattern as /[org]/login already uses) and returns:
 *   - icons.icon / shortcut / apple → the org's logo_url, so the browser
 *     tab and bookmarks show the tenant's brand.
 *   - title.default → the org name, so a tab on /ambak/dashboard reads
 *     "Ambak University" instead of the generic platform name.
 *   - title.template → "%s · OrgName", so child pages that set their own
 *     <title> (e.g. "Profile") get "Profile · Ambak University".
 *
 * Falls back to platform defaults if the org doesn't exist or has no
 * logo configured (so a freshly-provisioned tenant without branding
 * uploads still gets a usable tab).
 *
 * NOTE: tenants whose main logo isn't square will see a slightly
 * stretched favicon — ticket #151 tracks adding a dedicated favicon_url
 * field with a square uploader.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string }>;
}): Promise<Metadata> {
  const { org: orgSlug } = await params;

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: org } = await svc
    .from("organizations")
    .select("name, logo_url")
    .eq("slug", orgSlug)
    .maybeSingle();

  // Bad/unknown slug → platform default. The actual 404 (notFound) is
  // handled by the child pages (e.g. /[org]/login already does this).
  if (!org) {
    return { title: "Mentora" };
  }

  const name = (org.name as string | null) ?? "Mentora";
  const logoUrl = (org.logo_url as string | null) ?? null;

  const meta: Metadata = {
    title: {
      template: `%s · ${name}`,
      default: name,
    },
  };

  if (logoUrl) {
    // Set icon, shortcut (legacy IE/Edge), and apple-touch (mobile home
    // screen). All three point at the same logo — browsers pick the
    // most appropriate per context.
    meta.icons = {
      icon: [{ url: logoUrl }],
      shortcut: [{ url: logoUrl }],
      apple: [{ url: logoUrl }],
    };
  }

  return meta;
}

export default function OrgLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
