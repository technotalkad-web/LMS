import { createClient } from "@/lib/supabase/server";
import { ADMIN_ROLES, resolveOrgMembership } from "@/lib/auth/org-membership";

export type ApiAdmin = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  org: { id: string; slug: string; name: string };
  userId: string;
  role: string;
};

/** The roles that may administer an org: the same list as is_org_admin (0056). */
export const ORG_ADMIN_ROLES = ADMIN_ROLES;

export function isOrgAdminRole(role: string | null | undefined): boolean {
  return (ORG_ADMIN_ROLES as readonly string[]).includes(role ?? "");
}

/** The answer when a check read failed: "try again", never "not an admin". */
export const CHECK_FAILED = "Could not check your access. Nothing was changed; try again.";

/**
 * The caller's own role in `orgId` from a membership that counts (ADR 0030:
 * active, in an organisation that is not deleted); "" when there is none, or
 * null when a read failed.
 */
async function callerRole(
  supabase: ApiAdmin["supabase"],
  orgId: string,
  userId: string
): Promise<string | null> {
  const m = await resolveOrgMembership(supabase, { id: orgId }, userId);
  if (m === "unreadable") return null;
  return m === "none" ? "" : m.role;
}

/**
 * Explicit role check for a route that already holds the caller's client and
 * user and knows the org by id (from a row it read), not by slug: true when
 * the caller is a super owner / owner / admin of that org through a
 * membership that counts, false when not (no row, a row that is not active,
 * a deleted org), null when a read failed. Act on it as
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
 * owner / admin of the org named by `orgSlug`, through a membership that
 * counts (ADR 0030). Returns the caller-bound Supabase client (RLS applies)
 * plus the org row.
 *
 * A route that makes a service-role write, an auth admin call or an external
 * call for an org checks the caller's role with this (or isOrgAdminCaller)
 * first. Reading the org row on the caller's session is not a role check:
 * every member can read it. A caller whose membership does not count (none,
 * inactive, suspended, a deleted or unknown org) gets the answer a signed-in
 * non-member gets: 404. A failed org or role read answers 503 "try again",
 * never 404 or 403.
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
  const m = await resolveOrgMembership<{ id: string; name: string; slug: string }>(
    supabase,
    { slug: orgSlug },
    user.id,
    "id, name, slug"
  );
  if (m === "unreadable") return { error: CHECK_FAILED, status: 503 };
  if (m === "none") return { error: "Organization not found", status: 404 };
  if (!isOrgAdminRole(m.role)) {
    return { error: "Forbidden: admins only", status: 403 };
  }
  return {
    supabase,
    org: { id: m.org.id, slug: m.org.slug, name: m.org.name },
    userId: user.id,
    role: m.role,
  };
}
