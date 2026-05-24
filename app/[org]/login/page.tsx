import { notFound } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { BrandedLogin } from "./branded-login";

export const dynamic = "force-dynamic";

const DEFAULT_TITLE =
  "Build the skills your team needs to ship faster.";
const DEFAULT_SUBTITLE =
  "Assign courses, track completions, and keep learners on the path with a clean, professional experience.";

export default async function OrgLoginPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;

  // Service role lookup — pre-auth page needs to read public-ish branding
  // fields without an authenticated user.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: org } = await svc
    .from("organizations")
    .select(
      "name, logo_url, brand_color, login_hero_image_url, login_hero_title, login_hero_subtitle"
    )
    .eq("slug", orgSlug)
    .maybeSingle();

  if (!org) {
    notFound();
  }

  return (
    <BrandedLogin
      orgSlug={orgSlug}
      orgName={(org.name as string) ?? orgSlug}
      logoUrl={(org.logo_url as string | null) ?? null}
      brandColor={(org.brand_color as string | null) ?? "#4f46e5"}
      heroImageUrl={(org.login_hero_image_url as string | null) ?? null}
      heroTitle={(org.login_hero_title as string | null) || DEFAULT_TITLE}
      heroSubtitle={
        (org.login_hero_subtitle as string | null) || DEFAULT_SUBTITLE
      }
    />
  );
}
