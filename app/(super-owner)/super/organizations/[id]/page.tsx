import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { ArrowLeft, Building2 } from "lucide-react";
import { TenantDetailEditor } from "./tenant-detail-editor";

export const dynamic = "force-dynamic";

const ADMIN_ROLES = new Set(["super_owner", "admin", "data_analyst"]);

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: org } = await svc
    .from("organizations")
    .select(
      "id, name, slug, allowed_email_domains, custom_domain, created_at, scheduled_deletion_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (!org) notFound();
  const o = org as {
    id: string;
    name: string;
    slug: string;
    allowed_email_domains: string[] | null;
    custom_domain: string | null;
    created_at: string;
    scheduled_deletion_at: string | null;
  };

  // Subscription + plan
  const { data: subRaw } = await svc
    .from("tenant_subscriptions")
    .select("billing_status, mrr_cents, plan:subscription_plans(slug, name)")
    .eq("organization_id", id)
    .maybeSingle();
  const sub = subRaw as
    | {
        billing_status: string;
        mrr_cents: number;
        plan: { slug: string; name: string } | { slug: string; name: string }[] | null;
      }
    | null;
  const planObj = Array.isArray(sub?.plan) ? sub?.plan?.[0] : sub?.plan;

  // Admins
  const { data: members } = await svc
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", id);
  const adminRows = ((members ?? []) as Array<{ user_id: string; role: string }>).filter(
    (m) => ADMIN_ROLES.has(m.role)
  );
  const { data: listed } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map<string, string>();
  for (const u of listed?.users ?? []) {
    if (u.email) emailById.set(u.id, u.email);
  }
  const admins = adminRows.map((r) => ({
    user_id: r.user_id,
    role: r.role,
    email: emailById.get(r.user_id) ?? "(unknown)",
  }));

  // Total org member count
  const totalMembers = (members ?? []).length;

  return (
    <div className="max-w-4xl">
      <Link
        href="/super/organizations"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 mb-3"
      >
        <ArrowLeft className="w-4 h-4" />
        All organizations
      </Link>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
          <Building2 className="w-7 h-7 text-indigo-600" /> {o.name}
        </h1>
        <p className="text-slate-500 mt-1 text-sm font-mono">/{o.slug}</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Stat
          label="Plan"
          value={planObj?.name ?? "—"}
          accent={planObj ? "text-indigo-700" : "text-slate-400"}
        />
        <Stat
          label="Billing"
          value={(sub?.billing_status ?? "active").replace("_", " ")}
          accent={
            sub?.billing_status === "active"
              ? "text-emerald-700"
              : sub?.billing_status === "past_due"
                ? "text-amber-700"
                : "text-red-700"
          }
        />
        <Stat label="Members" value={totalMembers.toString()} accent="text-slate-900" />
      </div>

      <TenantDetailEditor
        tenantId={o.id}
        initial={{
          name: o.name,
          allowed_email_domains: o.allowed_email_domains ?? [],
          custom_domain: o.custom_domain,
        }}
        initialAdmins={admins}
      />

      <div className="mt-6 text-xs text-slate-400">
        Created {new Date(o.created_at).toLocaleString()}
        {o.scheduled_deletion_at && (
          <span className="ml-3 text-red-500">
            · scheduled for deletion on {new Date(o.scheduled_deletion_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold capitalize ${accent}`}>{value}</p>
    </div>
  );
}
