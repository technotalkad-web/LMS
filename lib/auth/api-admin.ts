import { createClient } from "@/lib/supabase/server";

export type ApiAdmin = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  org: { id: string; slug: string; name: string };
  userId: string;
  role: string;
};

/**
 * Route-handler guard: the caller must be signed in and a super owner /
 * owner / admin of the org named by `orgSlug`. Returns the caller-bound
 * Supabase client (RLS applies) plus the org row.
 */
export async function requireOrgAdminApi(
  orgSlug: string | null | undefined
): Promise<ApiAdmin | { error: string; status: 400 | 401 | 403 | 404 }> {
  if (!orgSlug) return { error: "Missing 'orgSlug'", status: 400 };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };
  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 };
  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (membership?.role as string | undefined) ?? "";
  if (role !== "super_owner" && role !== "owner" && role !== "admin") {
    return { error: "Forbidden: admins only", status: 403 };
  }
  return {
    supabase,
    org: org as { id: string; slug: string; name: string },
    userId: user.id,
    role,
  };
}
