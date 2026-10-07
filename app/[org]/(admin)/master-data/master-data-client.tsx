"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, X, ShieldCheck, Network, Tags, Eye, Users } from "lucide-react";

export type OptionRow = { id: string; field: string; value: string; parent_id?: string | null };

const FIELDS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "business_vertical",
    label: "Business Vertical",
    hint: "Drives the Verticals leaderboard (e.g. Retail, Institutional, Fulfillment). Optional on profiles — unassigned users appear in an admin-only bucket.",
  },
  {
    key: "department",
    label: "Department",
    hint: "Departments sit under a Business Vertical (e.g. Retail → Home Loan Sales). Optional on profiles; a person's department must belong to their vertical. Content can be mapped to a vertical + department.",
  },
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
  {
    key: "branch",
    label: "Branch",
    hint: "Branches within a city for the Verticals leaderboard (e.g. Thane, Borivali, Vashi). Optional on profiles.",
  },
  { key: "state", label: "State / Territory", hint: "e.g. Maharashtra" },
];

export function MasterDataClient({
  orgSlug,
  initialOptions,
  initialRequireManagers,
  unmappedContent = null,
  initialEnforce = null,
}: {
  orgSlug: string;
  initialOptions: OptionRow[];
  initialRequireManagers: boolean;
  /** 0096: active content with no vertical / department mapping (null before the migration). */
  unmappedContent?: number | null;
  /** 0097: hide unmapped content from managers (null before the migration). */
  initialEnforce?: boolean | null;
}) {
  const [options, setOptions] = useState<OptionRow[]>(initialOptions);
  const [requireManagers, setRequireManagers] = useState(initialRequireManagers);
  const [enforce, setEnforce] = useState(initialEnforce === true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyField, setBusyField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addValue(field: string, parentId?: string) {
    const draftKey = parentId ? `${field}:${parentId}` : field;
    const value = (drafts[draftKey] ?? "").trim();
    if (!value) return;
    setBusyField(draftKey);
    setError(null);
    const res = await fetch("/api/org-field-options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, field, value, ...(parentId ? { parent_id: parentId } : {}) }),
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
    setDrafts((d) => ({ ...d, [draftKey]: "" }));
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

  async function toggleEnforce(next: boolean) {
    setError(null);
    setEnforce(next);
    const res = await fetch("/api/org-field-options", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, enforce_content_mapping: next }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Could not save setting");
      setEnforce(!next);
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
              Require the full reporting line (L1, L2 &amp; L3 managers)
            </h2>
            <p className="text-xs text-muted mt-1">
              When on, all three manager fields are mandatory for every user
              created manually, via bulk upload or via the CRM sync. Bulk CSVs
              may reference managers by email address.
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

      {/* Reporting lines (migration 0091) */}
      <section className="border border-line rounded-lg bg-paper p-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Network className="w-5 h-5 text-indigo-600 mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold text-sm">Reporting lines</h2>
            <p className="text-xs text-muted mt-1">
              Employee → L1 → L2 → L3. Review who reports to whom, fix broken
              links (self-references, cycles, inactive managers) and fill in
              missing L2/L3 managers from the L1 chain with one confirmation.
              Managers only ever see the people who list them.
            </p>
          </div>
        </div>
        <Link
          href={`/${orgSlug}/master-data/reporting-lines`}
          className="shrink-0 inline-flex items-center px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90"
        >
          Open
        </Link>
      </section>

      {/* Enforce content mapping for managers (0097, decision 15) */}
      <section className="border border-line rounded-lg bg-paper p-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Eye className="w-5 h-5 text-indigo-600 mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold text-sm">Enforce content mapping for managers</h2>
            <p className="text-xs text-muted mt-1">
              Managers see content only when it belongs to their Business Vertical + Department and is assigned to people in their reporting line.
              While this is off, content that has not been mapped yet stays visible to them (transition). Turn it on once the mapping below is complete
              {unmappedContent !== null && unmappedContent > 0 ? ` — ${unmappedContent} active item${unmappedContent === 1 ? " is" : "s are"} still unmapped.` : "."}
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enforce}
          aria-label="Enforce content mapping for managers"
          disabled={initialEnforce === null}
          onClick={() => toggleEnforce(!enforce)}
          className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${enforce ? "bg-indigo-600" : "bg-line"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enforce ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </section>

      {/* Manager coverage (0097, decision 14) */}
      <section className="border border-line rounded-lg bg-paper p-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Users className="w-5 h-5 text-indigo-600 mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold text-sm">Manager coverage</h2>
            <p className="text-xs text-muted mt-1">
              Each manager&apos;s vertical and department come from their own record. Grant extra Vertical + Department pairs to a head whose hierarchy spans verticals, and spot managers with no vertical set.
            </p>
          </div>
        </div>
        <Link
          href={`/${orgSlug}/master-data/manager-coverage`}
          className="shrink-0 inline-flex items-center px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90"
        >
          Open
        </Link>
      </section>

      {/* Content mapping (0096) */}
      <section className="border border-line rounded-lg bg-paper p-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Tags className="w-5 h-5 text-indigo-600 mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold text-sm">Content mapping</h2>
            <p className="text-xs text-muted mt-1">
              Map every course, learning path and journey to the Business Vertical + Department it belongs to.
              {unmappedContent === null ? " Needs migration 0096." : unmappedContent > 0 ? ` ${unmappedContent} active item${unmappedContent === 1 ? "" : "s"} still unmapped.` : " Everything is mapped."}
            </p>
          </div>
        </div>
        <Link
          href={`/${orgSlug}/master-data/content-mapping`}
          className="shrink-0 inline-flex items-center px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90"
        >
          Open
        </Link>
      </section>

      {/* Per-field master lists */}
      {FIELDS.map((f) => {
        const values = options.filter((o) => o.field === f.key);
        if (f.key === "department") {
          const verticals = options.filter((o) => o.field === "business_vertical");
          return (
            <section key={f.key} className="border border-line rounded-lg bg-paper p-5">
              <div className="flex items-baseline justify-between mb-1">
                <h2 className="font-semibold text-sm">{f.label}</h2>
                <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${values.length > 0 ? "bg-indigo-50 text-indigo-700" : "bg-canvas text-muted"}`}>
                  {values.length > 0 ? `Enforced · ${values.length} value${values.length === 1 ? "" : "s"}` : "Free text"}
                </span>
              </div>
              <p className="text-xs text-muted mb-3">{f.hint}</p>
              {verticals.length === 0 ? (
                <p className="text-xs text-muted">Add a Business Vertical first.</p>
              ) : (
                <div className="space-y-3">
                  {verticals.map((v) => {
                    const depts = values.filter((d) => d.parent_id === v.id);
                    const draftKey = `department:${v.id}`;
                    return (
                      <div key={v.id} className="border border-line rounded-lg p-3" data-testid={`department-group-${v.value}`}>
                        <div className="text-xs font-semibold mb-2">{v.value}</div>
                        {depts.length > 0 && (
                          <ul className="flex flex-wrap gap-2 mb-2">
                            {depts.map((d) => (
                              <li key={d.id} className="inline-flex items-center gap-1.5 border border-line bg-canvas rounded-full pl-3 pr-1.5 py-1 text-sm">
                                {d.value}
                                <button type="button" onClick={() => removeValue(d.id)} title={`Remove ${d.value}`} className="p-0.5 rounded-full text-muted hover:text-red-600 hover:bg-red-50">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <form onSubmit={(e) => { e.preventDefault(); addValue("department", v.id); }} className="flex gap-2">
                          <input
                            type="text"
                            value={drafts[draftKey] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [draftKey]: e.target.value }))}
                            placeholder={`Add a department under ${v.value}`}
                            aria-label={`Add a department under ${v.value}`}
                            className="flex-1 px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
                          />
                          <button type="submit" disabled={busyField === draftKey || !(drafts[draftKey] ?? "").trim()} className="inline-flex items-center gap-1.5 px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50">
                            <Plus className="w-4 h-4" /> Add
                          </button>
                        </form>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        }
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
