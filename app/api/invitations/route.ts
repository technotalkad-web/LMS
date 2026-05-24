import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkQuota } from "@/lib/billing/enforce-quota";

/**
 *   POST /api/invitations
 *   body: { orgSlug, email, role: "user" | "data_analyst" | "admin" }
 *
 * Creates a pending invitation, returns the share URL. Validates the
 * email's domain against the org's allowed_email_domains (when set).
 */
type InviteRole = "user" | "data_analyst" | "admin";
const INVITE_ROLES: InviteRole[] = ["user", "data_analyst", "admin"];

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    email?: string;
    role?: string;
  };
  const orgSlug = body.orgSlug?.trim();
  const email = body.email?.trim().toLowerCase();
  const role: InviteRole = INVITE_ROLES.includes(body.role as InviteRole)
    ? (body.role as InviteRole)
    : "user";

  if (!orgSlug || !email) {
    return NextResponse.json(
      { error: "orgSlug and email are required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug, allowed_email_domains")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  // Domain restriction.
  const allowed = ((org.allowed_email_domains ?? []) as string[])
    .map((d) => d.toLowerCase().trim())
    .filter(Boolean);
  if (allowed.length > 0) {
    const domain = email.split("@")[1] ?? "";
    if (!allowed.includes(domain)) {
      return NextResponse.json(
        {
          error: `Email domain "${domain}" is not allowed for this organization. Allowed: ${allowed.join(", ")}`,
        },
        { status: 400 }
      );
    }
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const callerRole = membership?.role as string | undefined;
  const canInvite =
    callerRole === "super_owner" ||
    callerRole === "owner" || // legacy compat
    callerRole === "admin";
  if (!canInvite) {
    return NextResponse.json(
      { error: "Only super owners and admins can invite users" },
      { status: 403 }
    );
  }

  // ---- Plan/quota enforcement (Phase 10b) ----
  // Invitations consume a future user seat — block when we're at cap.
  const quota = await checkQuota(org.id as string, "users");
  if (!quota.ok) {
    return NextResponse.json(
      { error: quota.message, reason: quota.reason },
      { status: 402 }
    );
  }

  const { data: inv, error } = await supabase
    .from("invitations")
    .insert({
      organization_id: org.id,
      email,
      role,
      invited_by: user.id,
    })
    .select("id, token, email, role, expires_at")
    .single();
  if (error || !inv) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create invitation" },
      { status: 400 }
    );
  }

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const acceptUrl = `${base}/invitations/${(inv as { token: string }).token}`;
  return NextResponse.json({
    id: (inv as { id: string }).id,
    email: (inv as { email: string }).email,
    role: (inv as { role: string }).role,
    expires_at: (inv as { expires_at: string }).expires_at,
    accept_url: acceptUrl,
  });
}
