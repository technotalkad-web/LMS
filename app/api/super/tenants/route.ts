import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/auth/require-platform-owner";

/**
 *   POST /api/super/tenants
 *   body: {
 *     name, slug,
 *     plan_slug?: "basic" | "pro" | "enterprise"  (default "basic")
 *     admin_email?: string                         (optional initial admin to invite)
 *     allowed_email_domains?: string[]             (optional)
 *   }
 *
 * Provisions a brand-new tenant workspace from the super-owner console.
 * Slug uniqueness is enforced. We seed a tenant_subscriptions row on the
 * requested plan and, when admin_email is provided, drop an invitation
 * row tied to the new org with role=super_owner so the admin can sign in
 * and take over.
 */
async function assertPlatformOwner(): Promise<
  { ok: true; userId: string } | { ok: false; res: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: row } = await svc
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,40})?[a-z0-9]$/;

export async function POST(request: Request) {
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    slug?: string;
    plan_slug?: string;
    admin_email?: string;
    allowed_email_domains?: string[];
  };
  if (!body.name?.trim() || !body.slug?.trim()) {
    return NextResponse.json({ error: "name + slug required" }, { status: 400 });
  }
  const slug = body.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "Slug must be 3-42 chars, lowercase letters/digits/hyphens, not starting or ending with a hyphen" },
      { status: 400 }
    );
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Slug uniqueness check (also enforced by DB unique index).
  const { data: existing } = await svc
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "Slug already taken" }, { status: 409 });
  }

  // Resolve plan (default basic).
  const planSlug = body.plan_slug ?? "basic";
  const { data: plan } = await svc
    .from("subscription_plans")
    .select("id, monthly_price_cents")
    .eq("slug", planSlug)
    .maybeSingle();
  if (!plan) {
    return NextResponse.json({ error: `Unknown plan: ${planSlug}` }, { status: 400 });
  }

  // 1) Insert the org.
  const { data: orgRaw, error: orgErr } = await svc
    .from("organizations")
    .insert({
      name: body.name.trim(),
      slug,
      allowed_email_domains: body.allowed_email_domains ?? [],
    })
    .select("id, slug")
    .single();
  if (orgErr || !orgRaw) {
    return NextResponse.json(
      { error: orgErr?.message ?? "Could not create organization" },
      { status: 400 }
    );
  }
  const org = orgRaw as { id: string; slug: string };

  // 2) Seed the subscription row.
  await svc.from("tenant_subscriptions").insert({
    organization_id: org.id,
    plan_id: (plan as { id: string }).id,
    billing_status: "active",
    mrr_cents: (plan as { monthly_price_cents: number }).monthly_price_cents,
  });

  // 3) Optional: invite an initial super_owner admin so the new tenant
  //    isn't orphaned. We use the existing invitations flow so the
  //    user gets a normal accept-link.
  let inviteToken: string | null = null;
  if (body.admin_email?.trim()) {
    const email = body.admin_email.trim().toLowerCase();
    const { data: inv } = await svc
      .from("invitations")
      .insert({
        organization_id: org.id,
        email,
        role: "super_owner",
        invited_by: guard.userId,
      })
      .select("token")
      .single();
    inviteToken = (inv as { token: string } | null)?.token ?? null;
  }

  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.create",
    targetType: "organization",
    targetId: org.id,
    metadata: { slug: org.slug, plan: planSlug, admin_email: body.admin_email ?? null },
  });

  return NextResponse.json({
    ok: true,
    organization_id: org.id,
    slug: org.slug,
    invite_url: inviteToken
      ? `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/invitations/${inviteToken}`
      : null,
  });
}
