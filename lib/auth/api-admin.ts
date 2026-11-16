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

/** The answer when a check read failed: "try again", never "not an admin". */
export const CHECK_FAILED = "Could not check your access. Nothing was changed; try again.";

/**
 * The caller's own membership role in `orgId` ("" when there is none), or
 * null when the read failed.
 */
async function callerRole(
  supabase: ApiAdmin["supabase"],
  orgId: string,
  userId: string
): Promise<string | null> {
  const { data: membership, error } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return null;
  return (membership?.role as string | undefined) ?? "";
}

/**
 * Explicit role check for a route that already holds the caller's client and
 * user and knows the org by id (from a row it read), not by slug: true when
 * the caller is a super owner / owner / admin of that org, false when not,
 * null when the role read failed. Act on it as
 * `if (!admin) return <notAdminAnswer(admin)>`: a failed read is refused too,
 * with 503 "try again" instead of 403.
 */
export async function isOrgAdminCaller(
  supabase: ApiAdmin["supabase"],
  orgId: string,
  userId: string
): Promise<boolean | null> {
  const role = await callerRole(supabase, orgId, userId);
  return role === null ? null : isOrgAdminRole(role);
}

/** The refusal for an isOrgAdminCaller answer that is not true. */
export function notAdminAnswer(admin: false | null): { error: string; status: 403 | 503 } {
  return admin === null
    ? { error: CHECK_FAILED, status: 503 }
    : { error: "Forbidden: admins only", status: 403 };
}

/**
 * Route-handler guard: the caller must be signed in and a super owner /
 * owner / admin of the org named by `orgSlug`. Returns the caller-bound
 * Supabase client (RLS applies) plus the org row.
 *
 * A route that makes a service-role write, an auth admin call or an external
 * call for an org checks the caller's role with this (or isOrgAdminCaller)
 * first. Reading the org row on the caller's session is not a role check:
 * every member can read it. A failed org or role read answers 503 "try
 * again", never 404 or 403.
 */
export async function requireOrgAdminApi(
  orgSlug: string | null | undefined
): Promise<ApiAdmin | { error: string; status: 400 | 401 | 403 | 404 | 503 }> {
  if (!orgSlug) return { error: "Missing 'orgSlug'", status: 400 };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id, name, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (orgErr) return { error: CHECK_FAILED, status: 503 };
  if (!org) return { error: "Organization not found", status: 404 };
  const role = await callerRole(supabase, org.id as string, user.id);
  if (role === null) return { error: CHECK_FAILED, status: 503 };
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
