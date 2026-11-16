import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog, requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";

/**
 *   GET    /api/super/plans                 — list plans
 *   POST   /api/super/plans                 — create plan
 *   PATCH  /api/super/plans                 — body: { id, ...fields }
 *   DELETE /api/super/plans?id=…            — delete plan (only if 0 tenants on it)
 *
 * Platform-owner-only. Service-role for writes.
 */
function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

type PlanInput = {
  slug?: string;
  name?: string;
  monthly_price_cents?: number;
  max_users?: number | null;
  max_storage_gb?: number | null;
  max_courses?: number | null;
  features?: Record<string, boolean>;
  is_active?: boolean;
  sort_order?: number;
};

export async function GET() {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { data } = await svc()
    .from("subscription_plans")
    .select("*")
    .order("sort_order");
  return NextResponse.json({ plans: data ?? [] });
}

export async function POST(request: Request) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = (await request.json().catch(() => ({}))) as PlanInput;
  if (!body.slug || !body.name) {
    return NextResponse.json({ error: "slug + name required" }, { status: 400 });
  }
  const { data, error } = await svc()
    .from("subscription_plans")
    .insert({
      slug: body.slug,
      name: body.name,
      monthly_price_cents: body.monthly_price_cents ?? 0,
      max_users: body.max_users ?? null,
      max_storage_gb: body.max_storage_gb ?? null,
      max_courses: body.max_courses ?? null,
      features: body.features ?? {},
      is_active: body.is_active ?? true,
      sort_order: body.sort_order ?? 99,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "plan.create",
    targetType: "subscription_plan",
    targetId: (data as { id: string }).id,
    metadata: { slug: body.slug },
  });
  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}

export async function PATCH(request: Request) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = (await request.json().catch(() => ({}))) as PlanInput & { id?: string };
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const update: Record<string, unknown> = {};
  for (const k of [
    "slug",
    "name",
    "monthly_price_cents",
    "max_users",
    "max_storage_gb",
    "max_courses",
    "features",
    "is_active",
    "sort_order",
  ] as const) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  const { error } = await svc()
    .from("subscription_plans")
    .update(update)
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "plan.update",
    targetType: "subscription_plan",
    targetId: body.id,
    metadata: update,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Refuse delete if any tenant is still on this plan.
  const { count } = await svc()
    .from("tenant_subscriptions")
    .select("organization_id", { count: "exact", head: true })
    .eq("plan_id", id);
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `Cannot delete — ${count} tenants are on this plan` },
      { status: 409 }
    );
  }

  const { error } = await svc().from("subscription_plans").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "plan.delete",
    targetType: "subscription_plan",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
