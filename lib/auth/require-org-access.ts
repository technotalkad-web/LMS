import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { getImpersonation } from "@/lib/auth/impersonation";
import { mustChangePassword } from "@/lib/auth/must-change-password";
import { resolveOrgMembership } from "@/lib/auth/org-membership";

export type OrgRole = "super_owner" | "admin" | "data_analyst" | "user";

/** The organisation row the guard answers with. */
export type OrgAccessOrg = {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  brand_color: string | null;
  brand_font: string | null;
  custom_domain: string | null;
};

const ORG_COLUMNS = "id, name, slug, logo_url, brand_color, brand_font, custom_domain";

/** Thrown when the membership check could not be read: the page is refused, never let in and never treated as "no membership". */
export const ACCESS_UNREADABLE = "Could not check your access to this workspace. Please try again.";

/** The error requireOrgAccess throws when the membership check could not be read. */
export class AccessUnreadableError extends Error {
  constructor() {
    super(ACCESS_UNREADABLE);
    this.name = "AccessUnreadableError";
  }
}

/**
 * For a route handler that calls requireOrgAccess:
 * `await requireOrgAccess(slug).catch(accessUnreadableAnswer)`. An unreadable
 * check becomes a 503 "try again" answer; anything else (a redirect) is
 * thrown on unchanged.
 */
export function accessUnreadableAnswer(e: unknown): NextResponse {
  if (e instanceof AccessUnreadableError) return NextResponse.json({ error: ACCESS_UNREADABLE }, { status: 503 });
  throw e;
}

function normalizeRole(raw: string): OrgRole {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw as OrgRole;
}

/**
 * Page guard (ADR 0030): the caller must be signed in and hold a membership
 * that counts in the organisation named by `slug` (an active row, in an
 * organisation that is not deleted), read now, on every request.
 *
 *   - none (no row, inactive, suspended, a deleted or unknown organisation:
 *     one answer): a platform owner goes to /super/organizations, anyone
 *     else to /select-org, as a non-member always has;
 *   - unreadable: refused with AccessUnreadableError ("try again"): a page
 *     shows its error boundary, a route handler answers 503 through
 *     accessUnreadableAnswer;
 *   - a counting membership: its role, normalised. The impersonation answer
 *     (super_owner) is given only on top of a membership that counts.
 */
export async function requireOrgAccess(slug: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (await mustChangePassword(user.id)) {
    redirect("/change-password");
  }

  const membership = await resolveOrgMembership<OrgAccessOrg>(supabase, { slug }, user.id, ORG_COLUMNS);
  if (membership === "unreadable") throw new AccessUnreadableError();

  if (membership === "none") {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data: po } = await svc
      .from("platform_owners")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (po) redirect("/super/organizations");
    redirect("/select-org");
  }

  const { org } = membership;

  // getImpersonation() answers only the platform owner who started the
  // session; the actor comparison here repeats that check at the use site.
  // It is read only after the owner's own membership is found to count.
  const impersonation = await getImpersonation();
  if (
    impersonation &&
    impersonation.actor_user_id === user.id &&
    impersonation.target_org_id === org.id
  ) {
    return {
      user,
      org,
      role: "super_owner" as OrgRole,
      impersonation: {
        actorUserId: impersonation.actor_user_id,
        expiresAt: impersonation.expires_at,
      },
    };
  }

  return {
    user,
    org,
    role: normalizeRole(membership.role),
    impersonation: null,
  };
}
