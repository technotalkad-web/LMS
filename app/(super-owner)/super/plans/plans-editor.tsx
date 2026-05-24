"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Save, X } from "lucide-react";

export type PlanRow = {
  id: string;
  slug: string;
  name: string;
  monthly_price_cents: number;
  max_users: number | null;
  max_storage_gb: number | null;
  max_courses: number | null;
  features: Record<string, boolean>;
  is_active: boolean;
  sort_order: number;
};

type Counts = Record<string, { total: number; active: number }>;

const KNOWN_FEATURES = [
  "white_label",
  "custom_domain",
  "priority_support",
  "sso_saml",
  "api_access",
  "scorm_xapi",
];

export function PlansEditor({
  initialPlans,
  counts,
}: {
  initialPlans: PlanRow[];
  counts: Counts;
}) {
  const router = useRouter();
  const [plans, setPlans] = useState<PlanRow[]>(initialPlans);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(plan: PlanRow) {
    setBusy(true);
    const res = await fetch("/api/super/plans", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setEditing(null);
    router.refresh();
  }

  async function remove(plan: PlanRow) {
    if (!confirm(`Delete plan "${plan.name}"? This cannot be undone.`)) return;
    setBusy(true);
    const res = await fetch(`/api/super/plans?id=${plan.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setPlans(plans.filter((p) => p.id !== plan.id));
    router.refresh();
  }

  async function create(plan: Omit<PlanRow, "id">) {
    setBusy(true);
    const res = await fetch("/api/super/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setCreating(false);
    router.refresh();
  }

  function updateLocal(id: string, patch: Partial<PlanRow>) {
    setPlans(plans.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <p className="text-slate-500 text-sm">
          {plans.length} plans · {Object.values(counts).reduce((s, c) => s + c.total, 0)} tenant subscriptions
        </p>
        <button
          onClick={() => setCreating(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2 transition disabled:opacity-60"
          disabled={busy}
        >
          <Plus className="w-4 h-4" /> Add plan
        </button>
      </div>

      {creating && (
        <div className="mb-6">
          <PlanCard
            plan={{
              id: "new",
              slug: "",
              name: "",
              monthly_price_cents: 0,
              max_users: null,
              max_storage_gb: null,
              max_courses: null,
              features: {},
              is_active: true,
              sort_order: plans.length + 1,
            }}
            counts={{ total: 0, active: 0 }}
            editing
            onChange={() => {}}
            onSave={(p) => {
              const { ...rest } = p;
              const { id: _, ...withoutId } = rest;
              void _;
              create(withoutId);
            }}
            onCancel={() => setCreating(false)}
            onDelete={() => {}}
            onEdit={() => {}}
            disabled={busy}
          />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            counts={counts[plan.id] ?? { total: 0, active: 0 }}
            editing={editing === plan.id}
            onChange={(patch) => updateLocal(plan.id, patch)}
            onSave={(p) => save(p)}
            onCancel={() => {
              setEditing(null);
              // discard local edits by re-syncing from server-derived initial
              setPlans(plans.map((p) => (p.id === plan.id ? initialPlans.find((ip) => ip.id === plan.id) ?? p : p)));
            }}
            onEdit={() => setEditing(plan.id)}
            onDelete={() => remove(plan)}
            disabled={busy}
          />
        ))}
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  counts,
  editing,
  onChange,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  disabled,
}: {
  plan: PlanRow;
  counts: { total: number; active: number };
  editing: boolean;
  onChange: (patch: Partial<PlanRow>) => void;
  onSave: (p: PlanRow) => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  // Local form state when editing — sit on top of `plan` so cancel reverts.
  const [draft, setDraft] = useState<PlanRow>(plan);
  function field(patch: Partial<PlanRow>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(patch);
  }
  function toggleFeature(key: string) {
    const features = { ...draft.features, [key]: !draft.features?.[key] };
    field({ features });
  }

  if (!editing) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 flex flex-col">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-xl font-bold">{plan.name}</h2>
          <span className="text-xs font-mono text-slate-400">{plan.slug}</span>
        </div>
        <p className="text-3xl font-black mt-2">
          ${Math.round(plan.monthly_price_cents / 100).toLocaleString()}
          <span className="text-sm font-medium text-slate-400">/mo</span>
        </p>
        <dl className="text-sm text-slate-600 mt-4 space-y-1.5">
          <Row label="Max users" value={fmt(plan.max_users)} />
          <Row label="Max storage" value={plan.max_storage_gb === null ? "Unlimited" : `${plan.max_storage_gb} GB`} />
          <Row label="Max courses" value={fmt(plan.max_courses)} />
        </dl>
        <ul className="mt-4 space-y-1 text-xs">
          {Object.entries(plan.features ?? {}).map(([k, v]) => (
            <li key={k} className={`flex items-center gap-2 ${v ? "text-emerald-700" : "text-slate-400 line-through"}`}>
              <span>{v ? "✓" : "·"}</span>
              {k.replace(/_/g, " ")}
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-5 border-t border-slate-100 flex justify-between items-center text-xs text-slate-500">
          <span>
            <span className="font-semibold text-slate-900">{counts.active}</span> active / {counts.total} total
          </span>
          <div className="flex gap-2">
            <button onClick={onEdit} disabled={disabled} className="text-indigo-600 font-semibold hover:underline">
              Edit
            </button>
            <button onClick={onDelete} disabled={disabled || counts.total > 0} className="text-red-600 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border-2 border-indigo-300 rounded-xl shadow-md p-5 flex flex-col">
      <div className="grid grid-cols-2 gap-2 mb-3">
        <label className="text-xs">
          <span className="text-slate-500">Name</span>
          <input
            value={draft.name}
            onChange={(e) => field({ name: e.target.value })}
            className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Slug</span>
          <input
            value={draft.slug}
            onChange={(e) => field({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })}
            className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Price ($/mo)</span>
          <input
            type="number"
            value={Math.round(draft.monthly_price_cents / 100)}
            onChange={(e) => field({ monthly_price_cents: Math.max(0, parseInt(e.target.value || "0", 10)) * 100 })}
            className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Sort order</span>
          <input
            type="number"
            value={draft.sort_order}
            onChange={(e) => field({ sort_order: parseInt(e.target.value || "0", 10) })}
            className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
          />
        </label>
        <LimitField label="Max users" value={draft.max_users} onChange={(v) => field({ max_users: v })} />
        <LimitField label="Max storage (GB)" value={draft.max_storage_gb} onChange={(v) => field({ max_storage_gb: v })} />
        <LimitField label="Max courses" value={draft.max_courses} onChange={(v) => field({ max_courses: v })} />
        <label className="text-xs flex items-end gap-2">
          <input type="checkbox" checked={draft.is_active} onChange={(e) => field({ is_active: e.target.checked })} className="w-4 h-4" />
          <span className="text-slate-700 font-semibold">Active</span>
        </label>
      </div>
      <div className="border-t border-slate-100 pt-3">
        <p className="text-xs font-semibold text-slate-500 mb-2">Features</p>
        <div className="grid grid-cols-2 gap-1.5">
          {KNOWN_FEATURES.map((k) => (
            <label key={k} className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={Boolean(draft.features?.[k])}
                onChange={() => toggleFeature(k)}
                className="w-3.5 h-3.5"
              />
              {k.replace(/_/g, " ")}
            </label>
          ))}
        </div>
      </div>
      <div className="mt-auto pt-4 flex justify-end gap-2">
        <button onClick={onCancel} disabled={disabled} className="text-slate-500 px-3 py-1.5 rounded-md text-sm hover:bg-slate-100 flex items-center gap-1">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        <button onClick={() => onSave(draft)} disabled={disabled || !draft.name || !draft.slug} className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-md text-sm font-semibold flex items-center gap-1 disabled:opacity-60">
          <Save className="w-3.5 h-3.5" /> Save
        </button>
      </div>
    </div>
  );
}

function LimitField({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <label className="text-xs">
      <span className="text-slate-500">{label}</span>
      <div className="flex gap-1 mt-0.5">
        <input
          type="number"
          value={value ?? ""}
          placeholder="∞"
          onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, parseInt(e.target.value, 10)))}
          className="flex-1 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          className="px-2 text-xs text-slate-500 hover:text-slate-900 border border-slate-200 rounded-md"
          title="Set unlimited"
        >
          ∞
        </button>
      </div>
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function fmt(n: number | null): string {
  return n === null ? "Unlimited" : n.toLocaleString();
}
