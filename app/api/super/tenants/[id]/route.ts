import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/auth/require-platform-owner";

/**
 *   PATCH  /api/super/tenants/[id]   body: { action: "suspend" | "activate" | "restore" | "set_plan", plan_id? }
 *   DELETE /api/super/tenants/[id]   schedules deletion in 30 days (soft delete)
 *
 * Platform-owner-only. Verified by re-querying platform_owners with the
 * service-role client at the top of every handler — we don't trust the
 * client-bound session for this.
 */

const GRACE_PERIOD_DAYS = 30;

async function assertPlatformOwner(): Promise<
  { ok: true; userId: string } | { ok: false; res: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
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
    return {
      ok: false,
      res: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, userId: user.id };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;
  const { id: tenantId } = await params;

  const body = (await request.json().catch(() => ({}))) as {
    action?: "suspend" | "activate" | "restore" | "set_plan" | "update_org";
    plan_id?: string;
    // update_org payload
    name?: string;
    allowed_email_domains?: string[];
    custom_domain?: string | null;
  };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  if (body.action === "restore") {
    // Cancel a scheduled deletion AND re-activate the subscription.
    const { error: e1 } = await svc
      .from("organizations")
      .update({ scheduled_deletion_at: null })
      .eq("id", tenantId);
    if (e1) return NextResponse.json({ error: e1.message }, { status: 400 });
    const { error: e2 } = await svc
      .from("tenant_subscriptions")
      .update({
        billing_status: "active",
        suspended_at: null,
        // B4: clear the stale past_due marker AND advance the billing period,
        // otherwise the daily billing cron immediately re-flips the tenant to
        // past_due (current_period_end in the past) and re-suspends it.
        past_due_at: null,
        current_period_end: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", tenantId);
    if (e2) return NextResponse.json({ error: e2.message }, { status: 400 });
    await auditLog({
      actorUserId: guard.userId,
      action: "tenant.restore",
      targetType: "organization",
      targetId: tenantId,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "suspend") {
    const { error } = await svc
      .from("tenant_subscriptions")
      .upsert(
        {
          organization_id: tenantId,
          billing_status: "suspended",
          suspended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id" }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await auditLog({
      actorUserId: guard.userId,
      action: "tenant.suspend",
      targetType: "organization",
      targetId: tenantId,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "activate") {
    const { error } = await svc
      .from("tenant_subscriptions")
      .upsert(
        {
          organization_id: tenantId,
          billing_status: "active",
          suspended_at: null,
          past_due_at: null,
          // B4: advance the period so the billing cron doesn't re-flip to past_due.
          current_period_end: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000
          ).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id" }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await auditLog({
      actorUserId: guard.userId,
      action: "tenant.activate",
      targetType: "organization",
      targetId: tenantId,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "set_plan" && body.plan_id) {
    const { data: plan } = await svc
      .from("subscription_plans")
      .select("id, monthly_price_cents")
      .eq("id", body.plan_id)
      .maybeSingle();
    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }
    const { error } = await svc
      .from("tenant_subscriptions")
      .upsert(
        {
          organization_id: tenantId,
          plan_id: body.plan_id,
          mrr_cents: (plan as { monthly_price_cents: number })
            .monthly_price_cents,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id" }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await auditLog({
      actorUserId: guard.userId,
      action: "tenant.set_plan",
      targetType: "organization",
      targetId: tenantId,
      metadata: { plan_id: body.plan_id },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update_org") {
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      patch.name = body.name.trim();
    }
    if (Array.isArray(body.allowed_email_domains)) {
      patch.allowed_email_domains = body.allowed_email_domains
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
    }
    if (body.custom_domain !== undefined) {
      patch.custom_domain = body.custom_domain?.trim() || null;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }
    const { error } = await svc.from("organizations").update(patch).eq("id", tenantId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await auditLog({
      actorUserId: guard.userId,
      action: "tenant.update_org",
      targetType: "organization",
      targetId: tenantId,
      metadata: patch,
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;
  const { id: tenantId } = await params;

  const scheduled = new Date(
    Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { error: e1 } = await svc
    .from("organizations")
    .update({ scheduled_deletion_at: scheduled })
    .eq("id", tenantId)
    .is("deleted_at", null);
  if (e1) return NextResponse.json({ error: e1.message }, { status: 400 });

  // Also mark the subscription cancelled so the org doesn't keep accruing MRR.
  await svc
    .from("tenant_subscriptions")
    .upsert(
      {
        organization_id: tenantId,
        billing_status: "cancelled",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" }
    );

  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.delete_scheduled",
    targetType: "organization",
    targetId: tenantId,
    metadata: { scheduled_deletion_at: scheduled },
  });

  return NextResponse.json({ ok: true, scheduled_deletion_at: scheduled });
}
