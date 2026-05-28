"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Search,
  CheckCircle2,
  AlertTriangle,
  Power,
  Trash2,
  Edit3,
  ExternalLink,
  RotateCcw,
} from "lucide-react";

export type TenantRow = {
  id: string;
  slug: string;
  name: string;
  plan_slug: string;
  plan_id: string | null;
  plan_name: string;
  users: number;
  storage_gb: number;
  mrr_cents: number;
  status: "active" | "past_due" | "suspended" | "scheduled_deletion";
  scheduled_deletion_at: string | null;
};

export type PlanOption = {
  id: string;
  slug: string;
  name: string;
  monthly_price_cents: number;
};

type StatusFilter = "all" | "active" | "past_due" | "suspended" | "scheduled_deletion";
type PlanFilter = "all" | "basic" | "pro" | "enterprise";

export function OrganizationsTable({
  tenants,
  plans,
}: {
  tenants: TenantRow[];
  plans: PlanOption[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [planFilter, setPlanFilter] = useState<PlanFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tenants.filter((t) => {
      if (q && !t.name.toLowerCase().includes(q) && !t.slug.includes(q)) return false;
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (planFilter !== "all" && t.plan_slug !== planFilter) return false;
      return true;
    });
  }, [tenants, query, statusFilter, planFilter]);

  async function setPlan(t: TenantRow, plan_id: string) {
    if (plan_id === t.plan_id) return;
    const next = plans.find((p) => p.id === plan_id);
    if (!next) return;
    if (!confirm(`Change ${t.name} from "${t.plan_name}" to "${next.name}" ($${Math.round(next.monthly_price_cents / 100)}/mo)?`)) return;
    setBusy(t.id);
    const res = await fetch(`/api/super/tenants/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_plan", plan_id }),
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    router.refresh();
  }

  async function suspend(t: TenantRow) {
    if (!confirm(`Suspend ${t.name}? Learner access will be cut off immediately.`)) return;
    setBusy(t.id);
    const res = await fetch(`/api/super/tenants/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "suspend" }),
    });
    setBusy(null);
    if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error ?? "Failed"); return; }
    router.refresh();
  }

  async function activate(t: TenantRow) {
    setBusy(t.id);
    const res = await fetch(`/api/super/tenants/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    });
    setBusy(null);
    if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error ?? "Failed"); return; }
    router.refresh();
  }

  async function softDelete(t: TenantRow) {
    if (!confirm(`Schedule ${t.name} for deletion in 30 days?`)) return;
    setBusy(t.id);
    const res = await fetch(`/api/super/tenants/${t.id}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error ?? "Failed"); return; }
    router.refresh();
  }

  async function restore(t: TenantRow) {
    setBusy(t.id);
    const res = await fetch(`/api/super/tenants/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    });
    setBusy(null);
    if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error ?? "Failed"); return; }
    router.refresh();
  }

  async function impersonate(t: TenantRow) {
    const reason = prompt(`Start a 60-minute impersonation of ${t.name}?\n\nOptional: why? (logged for audit)`);
    if (reason === null) return;
    setBusy(t.id);
    const res = await fetch(`/api/super/impersonate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: t.id, reason: reason || undefined }),
    });
    setBusy(null);
    const j = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
    if (!res.ok) { alert(j.error ?? "Failed to start impersonation"); return; }
    router.push(j.redirect ?? `/${t.slug}/dashboard`);
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-slate-200 flex flex-wrap justify-between gap-3 items-center bg-slate-50">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search organizations..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent outline-none"
          />
        </div>
        <div className="flex gap-2">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="past_due">Past Due</option>
            <option value="suspended">Suspended</option>
            <option value="scheduled_deletion">Scheduled deletion</option>
          </select>
          <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value as PlanFilter)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none">
            <option value="all">All plans</option>
            <option value="basic">Basic</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-12 text-center text-slate-500 text-sm">No tenants match the current filters.</div>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
            <tr>
              <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">Organization</th>
              <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">Plan &amp; MRR</th>
              <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">Usage</th>
              <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs">Status</th>
              <th className="px-6 py-3 font-semibold uppercase tracking-wider text-xs text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50 transition">
                <td className="px-6 py-4">
                  <a
                    href={`/super/organizations/${t.id}`}
                    className="font-bold text-slate-900 hover:text-indigo-600 transition"
                  >
                    {t.name}
                  </a>
                  <p className="text-slate-500 text-xs font-mono mt-0.5">{t.slug}</p>
                </td>
                <td className="px-6 py-4">
                  <select
                    value={t.plan_id ?? ""}
                    onChange={(e) => setPlan(t, e.target.value)}
                    disabled={busy === t.id || t.status === "scheduled_deletion"}
                    className="border border-slate-300 rounded-md px-2 py-1 text-xs font-bold bg-slate-50 hover:border-slate-400 outline-none disabled:opacity-60"
                    title="Change plan"
                  >
                    {!t.plan_id && <option value="">No plan</option>}
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-slate-500 text-xs mt-1">${Math.round(t.mrr_cents / 100).toLocaleString()} / mo</p>
                </td>
                <td className="px-6 py-4">
                  <p className="text-slate-900 font-medium">{t.users.toLocaleString()} users</p>
                  <p className="text-slate-500 text-xs mt-0.5">{t.storage_gb > 0 ? `${t.storage_gb} GB` : "—"}</p>
                </td>
                <td className="px-6 py-4">
                  <StatusBadge status={t.status} scheduledAt={t.scheduled_deletion_at} />
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-1">
                    <button type="button" onClick={() => impersonate(t)} disabled={busy === t.id || t.status !== "active"} className="p-1.5 text-slate-400 hover:text-indigo-600 transition disabled:opacity-40" title="Log in as org admin">
                      <ExternalLink className="w-4 h-4" />
                    </button>
                    <Link href="/super/plans" className="p-1.5 text-slate-400 hover:text-slate-900 transition" title="Edit plan definitions (prices, quotas, features)">
                      <Edit3 className="w-4 h-4" />
                    </Link>
                    {t.status === "scheduled_deletion" ? (
                      <button type="button" onClick={() => restore(t)} disabled={busy === t.id} className="p-1.5 text-emerald-500 hover:text-emerald-700 transition disabled:opacity-40" title="Cancel scheduled deletion">
                        <RotateCcw className="w-4 h-4" />
                      </button>
                    ) : t.status === "active" ? (
                      <button type="button" onClick={() => suspend(t)} disabled={busy === t.id} className="p-1.5 text-slate-400 hover:text-amber-600 transition disabled:opacity-40" title="Suspend service">
                        <Power className="w-4 h-4" />
                      </button>
                    ) : (
                      <button type="button" onClick={() => activate(t)} disabled={busy === t.id} className="p-1.5 text-emerald-500 hover:text-emerald-600 transition disabled:opacity-40" title="Restore service">
                        <Power className="w-4 h-4" />
                      </button>
                    )}
                    <button type="button" onClick={() => softDelete(t)} disabled={busy === t.id || t.status === "scheduled_deletion"} className="p-1.5 text-slate-400 hover:text-red-600 transition disabled:opacity-40" title="Schedule deletion (30-day grace)">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status, scheduledAt }: { status: TenantRow["status"]; scheduledAt: string | null }) {
  if (status === "scheduled_deletion") {
    const days = scheduledAt ? Math.max(0, Math.ceil((new Date(scheduledAt).getTime() - Date.now()) / 86400_000)) : 0;
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border bg-red-50 text-red-700 border-red-200">
        <Trash2 className="w-3.5 h-3.5" />
        Deletion in {days}d
      </span>
    );
  }
  const map = {
    active: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2, label: "Active" },
    past_due: { cls: "bg-amber-50 text-amber-700 border-amber-200", Icon: AlertTriangle, label: "Past Due" },
    suspended: { cls: "bg-red-50 text-red-700 border-red-200", Icon: Power, label: "Suspended" },
  } as const;
  const { cls, Icon, label } = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border ${cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
  );
}
