import { createClient } from "@/lib/supabase/server";

export type ApiAdmin = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  org: { id: string; slug: string; name: string };
  userId: string;
  role: string;
};

/** The roles that may administer an org: the same list as is_org_admin (0056). */
export const ORG_ADMIN_ROLES = ["super_owner", "owner", "admin"] as const;

export function isOrgAdminRole(role: string | null | undefined): boolean {
  return (ORG_ADMIN_ROLES as readonly string[]).includes(role ?? "");
}

/** The caller's own membership role in `orgId` ("" when there is none). */
async function callerRole(
  supabase: ApiAdmin["supabase"],
  orgId: string,
  userId: string
): Promise<string> {
  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return (membership?.role as string | undefined) ?? "";
}

/**
 * Explicit role check for a route that already holds the caller's client and
 * user and knows the org by id (from a row it read), not by slug: true when
 * the caller is a super owner / owner / admin of that org.
 */
export async function isOrgAdminCaller(
  supabase: ApiAdmin["supabase"],
  orgId: string,
  userId: string
): Promise<boolean> {
  return isOrgAdminRole(await callerRole(supabase, orgId, userId));
}

/**
 * Route-handler guard: the caller must be signed in and a super owner /
 * owner / admin of the org named by `orgSlug`. Returns the caller-bound
 * Supabase client (RLS applies) plus the org row.
 *
 * A route that makes a service-role write, an auth admin call or an external
 * call for an org checks the caller's role with this (or isOrgAdminCaller)
 * first. Reading the org row on the caller's session is not a role check:
 * every member can read it.
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
  const role = await callerRole(supabase, org.id as string, user.id);
  if (!isOrgAdminRole(role)) {
    return { error: "Forbidden: admins only", status: 403 };
  }
  return {
    supabase,
    org: org as { id: string; slug: string; name: string },
    userId: user.id,
    role,
  };
}
