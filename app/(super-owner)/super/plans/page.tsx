import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Database } from "lucide-react";
import { PlansEditor, type PlanRow } from "./plans-editor";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: plansRaw } = await svc
    .from("subscription_plans")
    .select(
      "id, slug, name, monthly_price_cents, max_users, max_storage_gb, max_courses, features, is_active, sort_order"
    )
    .order("sort_order");
  const { data: subs } = await svc
    .from("tenant_subscriptions")
    .select("plan_id, billing_status");

  const counts: Record<string, { total: number; active: number }> = {};
  for (const s of (subs ?? []) as Array<{ plan_id: string | null; billing_status: string }>) {
    if (!s.plan_id) continue;
    if (!counts[s.plan_id]) counts[s.plan_id] = { total: 0, active: 0 };
    counts[s.plan_id].total += 1;
    if (s.billing_status === "active") counts[s.plan_id].active += 1;
  }

  const plans: PlanRow[] = (plansRaw ?? []).map((p) => {
    const r = p as Record<string, unknown>;
    return {
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      monthly_price_cents: (r.monthly_price_cents as number) ?? 0,
      max_users: (r.max_users as number | null) ?? null,
      max_storage_gb: (r.max_storage_gb as number | null) ?? null,
      max_courses: (r.max_courses as number | null) ?? null,
      features: (r.features as Record<string, boolean>) ?? {},
      is_active: (r.is_active as boolean) ?? true,
      sort_order: (r.sort_order as number) ?? 0,
    };
  });

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-ink flex items-center gap-3">
          <Database className="w-7 h-7 text-accent" /> Plans &amp; Billing
        </h1>
        <p className="text-muted mt-1">
          Manage subscription tiers, pricing, quotas, and feature flags. Changes propagate to every tenant on save.
        </p>
      </header>
      <PlansEditor initialPlans={plans} counts={counts} />
    </div>
  );
}
