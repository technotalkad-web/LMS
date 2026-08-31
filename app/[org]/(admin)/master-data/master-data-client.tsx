"use client";

import { useState } from "react";
import { Plus, X, ShieldCheck } from "lucide-react";

export type OptionRow = { id: string; field: string; value: string };

const FIELDS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "designation",
    label: "Designation",
    hint: "e.g. Sales Executive, Area Manager",
  },
  {
    key: "node_id",
    label: "Node ID (Hierarchy Branch)",
    hint: "e.g. SALES-WEST-3",
  },
  { key: "job_role", label: "Job Role / Title", hint: "e.g. Backend Lead" },
  { key: "city", label: "City", hint: "e.g. Mumbai" },
  { key: "state", label: "State / Territory", hint: "e.g. Maharashtra" },
];

export function MasterDataClient({
  orgSlug,
  initialOptions,
  initialRequireManagers,
}: {
  orgSlug: string;
  initialOptions: OptionRow[];
  initialRequireManagers: boolean;
}) {
  const [options, setOptions] = useState<OptionRow[]>(initialOptions);
  const [requireManagers, setRequireManagers] = useState(initialRequireManagers);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyField, setBusyField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addValue(field: string) {
    const value = (drafts[field] ?? "").trim();
    if (!value) return;
    setBusyField(field);
    setError(null);
    const res = await fetch("/api/org-field-options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, field, value }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      option?: OptionRow;
      error?: string;
    };
    setBusyField(null);
    if (!res.ok || !j.option) {
      setError(j.error ?? "Could not add value");
      return;
    }
    setOptions((o) =>
      [...o, j.option!].sort((a, b) => a.value.localeCompare(b.value))
    );
    setDrafts((d) => ({ ...d, [field]: "" }));
  }

  async function removeValue(id: string) {
    setError(null);
    const prev = options;
    setOptions((o) => o.filter((r) => r.id !== id));
    const res = await fetch("/api/org-field-options", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, id }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Could not remove value");
      setOptions(prev);
    }
  }

  async function toggleManagers(next: boolean) {
    setError(null);
    setRequireManagers(next);
    const res = await fetch("/api/org-field-options", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, require_manager_fields: next }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Could not save setting");
      setRequireManagers(!next);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="serif text-5xl mb-2">Master data</h1>
        <p className="text-muted text-sm max-w-2xl">
          Define the allowed values for the Organization-details fields. Once a
          field has values here, it becomes <strong>mandatory</strong> on user
          creation and bulk upload, and admins can only pick from this list —
          anything else is rejected with &ldquo;This value is not specified in
          the system database.&rdquo; Fields left empty keep free-text entry.
        </p>
      </header>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      {/* Mandatory managers toggle */}
      <section className="border border-line rounded-lg bg-paper p-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-indigo-600 mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold text-sm">
              Require Line Manager (L1) &amp; Indirect Line Manager (L2)
            </h2>
            <p className="text-xs text-muted mt-1">
              When on, both manager fields are mandatory for every user created
              manually or via bulk upload. Bulk CSVs may reference managers by
              email address.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={requireManagers}
          onClick={() => toggleManagers(!requireManagers)}
          className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            requireManagers ? "bg-indigo-600" : "bg-line"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              requireManagers ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </section>

      {/* Per-field master lists */}
      {FIELDS.map((f) => {
        const values = options.filter((o) => o.field === f.key);
        return (
          <section key={f.key} className="border border-line rounded-lg bg-paper p-5">
            <div className="flex items-baseline justify-between mb-1">
              <h2 className="font-semibold text-sm">{f.label}</h2>
              <span
                className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${
                  values.length > 0
                    ? "bg-indigo-50 text-indigo-700"
                    : "bg-canvas text-muted"
                }`}
              >
                {values.length > 0
                  ? `Enforced · ${values.length} value${values.length === 1 ? "" : "s"}`
                  : "Free text"}
              </span>
            </div>
            <p className="text-xs text-muted mb-3">{f.hint}</p>

            {values.length > 0 && (
              <ul className="flex flex-wrap gap-2 mb-3">
                {values.map((v) => (
                  <li
                    key={v.id}
                    className="inline-flex items-center gap-1.5 border border-line bg-canvas rounded-full pl-3 pr-1.5 py-1 text-sm"
                  >
                    {v.value}
                    <button
                      type="button"
                      onClick={() => removeValue(v.id)}
                      title={`Remove ${v.value}`}
                      className="p-0.5 rounded-full text-muted hover:text-red-600 hover:bg-red-50"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                addValue(f.key);
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={drafts[f.key] ?? ""}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [f.key]: e.target.value }))
                }
                placeholder={`Add a ${f.label.toLowerCase()} value`}
                className="flex-1 px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
              />
              <button
                type="submit"
                disabled={busyField === f.key || !(drafts[f.key] ?? "").trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" /> Add
              </button>
            </form>
          </section>
        );
      })}
    </div>
  );
}
