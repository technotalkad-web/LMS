import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { getImpersonation } from "@/lib/auth/impersonation";
import { mustChangePassword } from "@/lib/auth/must-change-password";

export type OrgRole = "super_owner" | "admin" | "data_analyst" | "user";

function normalizeRole(raw: string): OrgRole {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw as OrgRole;
}

export async function requireOrgAccess(slug: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (await mustChangePassword(user.id)) {
    redirect("/change-password");
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug, logo_url, brand_color, brand_font, custom_domain")
    .eq("slug", slug)
    .maybeSingle();

  if (!org) redirect("/select-org");

  const impersonation = await getImpersonation();
  if (impersonation && impersonation.target_org_id === org.id) {
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

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
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

  return {
    user,
    org,
    role: normalizeRole(membership.role as string),
    impersonation: null,
  };
}
