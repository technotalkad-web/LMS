import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Building2 } from "lucide-react";
import { NewTenantForm } from "./new-tenant-form";

export const dynamic = "force-dynamic";

export default async function NewTenantPage() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: plans } = await svc
    .from("subscription_plans")
    .select("slug, name, monthly_price_cents")
    .eq("is_active", true)
    .order("sort_order");

  return (
    <div className="max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
          <Building2 className="w-7 h-7 text-indigo-600" /> Create organization
        </h1>
        <p className="text-slate-500 mt-1">
          Provision a new tenant workspace. The slug becomes the URL prefix
          (e.g. <code className="bg-slate-100 px-1 rounded">/{`{slug}`}/dashboard</code>) and cannot be changed later.
        </p>
      </header>
      <NewTenantForm
        plans={(plans ?? []).map((p) => ({
          slug: (p as { slug: string }).slug,
          name: (p as { name: string }).name,
          monthly_price_cents: (p as { monthly_price_cents: number }).monthly_price_cents,
        }))}
      />
    </div>
  );
}
