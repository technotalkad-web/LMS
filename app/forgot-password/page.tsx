import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { ForgotPasswordClient } from "./forgot-password-client";

export const dynamic = "force-dynamic";

/**
 * Standalone /forgot-password route (ADR 0029 section D). Signed-in users get
 * bounced to /select-org (which routes them onward); they don't need this page.
 *
 * The organisation comes from `?org=<slug>` only (the "Forgot password?" link
 * of /<slug>/login). With one that names an organisation, the form shows its
 * name and asks for a code on its behalf. With none, or a slug that names
 * none, it is the form with no organisation, which serves platform owners and
 * administrators, with the one fixed line for learners. Either way the
 * request route answers every address alike, and the code step follows.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string | string[] }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/select-org");

  const raw = (await searchParams).org;
  const slug = typeof raw === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(raw.trim()) ? raw.trim() : null;
  let org: { slug: string; name: string } | null = null;
  if (slug) {
    // Service role: the page has no session, and reads the organisation's
    // public name only, as /<slug>/login does.
    const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const { data } = await svc.from("organizations").select("slug, name").eq("slug", slug).maybeSingle();
    const row = data as { slug?: string | null; name?: string | null } | null;
    if (row?.slug) org = { slug: row.slug, name: row.name || row.slug };
  }

  return (
    <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <ForgotPasswordClient org={org} />
      </div>
    </main>
  );
}
