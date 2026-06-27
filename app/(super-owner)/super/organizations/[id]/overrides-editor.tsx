"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Save, SlidersHorizontal } from "lucide-react";

/**
 * Platform-owner manual cap overrides + grace period + notes for custom-tenant
 * support and transparent dispute settlement (feature #5). Blank = no override
 * (fall back to the plan / Basic default). Caps are enforced atomically by the
 * 0038 DB trigger; this just sets the per-tenant override values.
 */
type Overrides = {
  custom_user_limit_override: number | null;
  custom_storage_limit_override: number | null;
  manual_grace_period_until: string | null;
  owner_notes: string | null;
};

type Usage = { users: number; courses: number; storageMb: number };
type Caps = { users: number | null; courses: number | null; storageMb: number | null };

export function OverridesEditor({
  tenantId,
  initial,
  usage,
  caps,
}: {
  tenantId: string;
  initial: Overrides;
  usage: Usage;
  caps: Caps;
}) {
  const router = useRouter();
  const [userLimit, setUserLimit] = useState<string>(
    initial.custom_user_limit_override?.toString() ?? ""
  );
  const [storageLimit, setStorageLimit] = useState<string>(
    initial.custom_storage_limit_override?.toString() ?? ""
  );
  const [grace, setGrace] = useState<string>(
    initial.manual_grace_period_until
      ? initial.manual_grace_period_until.slice(0, 10)
      : ""
  );
  const [notes, setNotes] = useState<string>(initial.owner_notes ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const toIntOrNull = (s: string) => {
      const t = s.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    };
    const res = await fetch(`/api/super/tenants/${tenantId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "set_overrides",
        custom_user_limit_override: toIntOrNull(userLimit),
        custom_storage_limit_override: toIntOrNull(storageLimit),
        manual_grace_period_until: grace.trim()
          ? new Date(`${grace}T23:59:59Z`).toISOString()
          : null,
        owner_notes: notes.trim() || null,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved.");
      router.refresh();
    } else {
      const j = await res.json().catch(() => ({}));
      setMsg(j.error ?? "Save failed.");
    }
  }

  const capLabel = (c: number | null) => (c === null ? "unlimited" : c.toString());

  return (
    <section className="bg-paper border border-line rounded-lg p-5 mt-6">
      <h2 className="text-sm font-bold text-ink flex items-center gap-2 mb-1">
        <SlidersHorizontal className="w-4 h-4 text-accent" /> Plan overrides
      </h2>
      <p className="text-xs text-muted mb-4">
        Manual caps for custom-tenant support. Leave blank to use the plan limit.
        A grace period (date) lifts all caps until that day.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          label="User limit override"
          hint={`Now: ${usage.users} used · effective cap ${capLabel(caps.users)}`}
        >
          <input
            type="number"
            min={0}
            value={userLimit}
            onChange={(e) => setUserLimit(e.target.value)}
            placeholder="plan default"
            className="w-full border border-line rounded-md px-3 py-2 text-sm"
            aria-label="User limit override"
          />
        </Field>

        <Field
          label="Storage limit override (MB)"
          hint={`Now: ${usage.storageMb} MB used · effective cap ${capLabel(caps.storageMb)} MB`}
        >
          <input
            type="number"
            min={0}
            value={storageLimit}
            onChange={(e) => setStorageLimit(e.target.value)}
            placeholder="plan default"
            className="w-full border border-line rounded-md px-3 py-2 text-sm"
            aria-label="Storage limit override in MB"
          />
        </Field>

        <Field label="Manual grace period until" hint="Caps lifted through this date">
          <input
            type="date"
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
            className="w-full border border-line rounded-md px-3 py-2 text-sm"
            aria-label="Manual grace period until"
          />
        </Field>

        <Field label="Owner notes" hint="Internal — not shown to the tenant">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. raised to 250 users for Q3 pilot"
            className="w-full border border-line rounded-md px-3 py-2 text-sm"
            aria-label="Owner notes"
          />
        </Field>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={save}
          disabled={busy}
          className="bg-ink text-canvas hover:opacity-90 px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-1 disabled:opacity-60"
        >
          <Save className="w-4 h-4" /> {busy ? "Saving…" : "Save overrides"}
        </button>
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-muted mb-1">{label}</label>
      {children}
      <p className="text-[11px] text-muted mt-1">{hint}</p>
    </div>
  );
}
