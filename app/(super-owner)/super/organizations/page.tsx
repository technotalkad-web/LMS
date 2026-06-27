import Link from "next/link";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  Activity,
  Building2,
  Users as UsersIcon,
  AlertTriangle,
  Plus,
} from "lucide-react";
import { OrganizationsTable, type TenantRow } from "./organizations-table";

export const dynamic = "force-dynamic";

type SubRow = {
  organization_id: string;
  billing_status: "active" | "past_due" | "suspended" | "cancelled";
  mrr_cents: number;
  plan: { slug: string; name: string } | { slug: string; name: string }[] | null;
};
type OrgRow = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  scheduled_deletion_at: string | null;
  deleted_at: string | null;
};

export default async function OrganizationsPage() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: orgRows } = await svc
    .from("organizations")
    .select("id, name, slug, created_at, scheduled_deletion_at, deleted_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  const orgs = (orgRows ?? []) as OrgRow[];

  const { data: subRows } = await svc
    .from("tenant_subscriptions")
    .select("organization_id, billing_status, mrr_cents, plan:subscription_plans(slug, name)");
  const subs = (subRows ?? []) as SubRow[];
  const subByOrg = new Map<string, SubRow>();
  for (const s of subs) subByOrg.set(s.organization_id, s);

  const { data: memberRows } = await svc
    .from("organization_members")
    .select("organization_id");
  const userCountByOrg = new Map<string, number>();
  for (const m of (memberRows ?? []) as Array<{ organization_id: string }>) {
    userCountByOrg.set(m.organization_id, (userCountByOrg.get(m.organization_id) ?? 0) + 1);
  }

  const storageGbByOrg = new Map<string, number>();

  const { data: planRows } = await svc
    .from("subscription_plans")
    .select("id, slug, name, monthly_price_cents")
    .eq("is_active", true)
    .order("sort_order");
  const plans = ((planRows ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    monthly_price_cents: number;
  }>);
  const planIdBySlug = new Map(plans.map((p) => [p.slug, p.id]));

  const tenants: TenantRow[] = orgs.map((o) => {
    const sub = subByOrg.get(o.id);
    const planObj = Array.isArray(sub?.plan) ? sub?.plan?.[0] : sub?.plan;
    const planName = planObj?.name ?? "Basic";
    const billingStatus = sub?.billing_status ?? "active";
    const status: TenantRow["status"] = o.scheduled_deletion_at
      ? "scheduled_deletion"
      : billingStatus === "past_due"
        ? "past_due"
        : billingStatus === "suspended"
          ? "suspended"
          : billingStatus === "cancelled"
            ? "suspended"
            : "active";
    const planSlug = planObj?.slug ?? "basic";
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      plan_slug: planSlug,
      plan_id: planIdBySlug.get(planSlug) ?? null,
      plan_name: planName,
      users: userCountByOrg.get(o.id) ?? 0,
      storage_gb: storageGbByOrg.get(o.id) ?? 0,
      mrr_cents: sub?.mrr_cents ?? 0,
      status,
      scheduled_deletion_at: o.scheduled_deletion_at,
    };
  });

  const totalMrrCents = tenants.filter((t) => t.status === "active").reduce((s, t) => s + t.mrr_cents, 0);
  const activeCount = tenants.filter((t) => t.status === "active").length;
  const totalUsers = tenants.reduce((s, t) => s + t.users, 0);
  const actionRequired = tenants.filter(
    (t) => t.status === "past_due" || t.status === "suspended" || t.status === "scheduled_deletion"
  ).length;

  return (
    <div>
      <header className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">Organizations</h1>
          <p className="text-muted mt-1">
            Manage tenant workspaces, subscriptions, and platform access.
          </p>
        </div>
        <Link
          href="/super/organizations/new"
          className="bg-ink hover:opacity-90 text-white px-5 py-2.5 rounded-lg font-semibold text-sm transition shadow-sm flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Create new organization
        </Link>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <KpiCard
          title="Total MRR"
          value={fmtMoney(totalMrrCents)}
          trend="active subscriptions only"
          icon={<Activity className="text-emerald-500 w-5 h-5" />}
        />
        <KpiCard
          title="Active tenants"
          value={activeCount.toString()}
          trend={`${tenants.length} total`}
          icon={<Building2 className="text-blue-500 w-5 h-5" />}
        />
        <KpiCard
          title="Total platform users"
          value={totalUsers.toLocaleString()}
          trend="across all tenants"
          icon={<UsersIcon className="text-accent w-5 h-5" />}
        />
        <div className="bg-paper p-6 rounded-xl border border-red-200 shadow-sm flex flex-col">
          <div className="flex justify-between items-start mb-2">
            <span className="text-red-600 font-bold text-sm">Action required</span>
            <AlertTriangle className="text-red-500 w-5 h-5" />
          </div>
          <p className="text-3xl font-black text-ink">{actionRequired} accounts</p>
          <p className="text-sm text-muted mt-1">past due, suspended, or scheduled for deletion</p>
        </div>
      </div>

      <OrganizationsTable tenants={tenants} plans={plans} />
    </div>
  );
}

function KpiCard({
  title,
  value,
  trend,
  icon,
}: {
  title: string;
  value: string;
  trend: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-paper p-6 rounded-xl border border-line shadow-sm flex flex-col">
      <div className="flex justify-between items-start mb-2">
        <span className="text-muted font-medium text-sm">{title}</span>
        <div className="p-2 bg-canvas rounded-lg border border-line">{icon}</div>
      </div>
      <p className="text-3xl font-black text-ink">{value}</p>
      <p className="text-sm text-muted mt-1">{trend}</p>
    </div>
  );
}

function fmtMoney(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString()}`;
}
