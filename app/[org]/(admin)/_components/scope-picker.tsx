"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Plus, Tags, X } from "lucide-react";
import type { ContentScopes, ContentType, ScopePair } from "@/lib/content/scopes";

export type ScopeOptions = {
  verticals: string[];
  /** vertical → departments defined under it */
  departmentsByVertical: Record<string, string[]>;
};

const canon = (s: ContentScopes) => `${s.common}|${s.pairs.map((p) => `${p.vertical}|${p.department ?? ""}`).sort().join(",")}`;
const sameScopes = (a: ContentScopes, b: ContentScopes) => canon(a) === canon(b);

/**
 * "Belongs to": the Vertical + Department pairs a course / path / journey is
 * mapped to (0096, addendum §5). Saves on its own via PUT /api/content-scopes
 * for the given items (one from a content form, many from the review page).
 * Mapping is not visibility — the copy says so.
 */
export function ScopePicker({
  orgSlug,
  items,
  initial,
  options,
  compact = false,
  onSaved,
}: {
  orgSlug: string;
  items: Array<{ type: ContentType; id: string }>;
  initial: ContentScopes;
  options: ScopeOptions;
  compact?: boolean;
  onSaved?: (scopes: ContentScopes) => void;
}) {
  const router = useRouter();
  const [scopes, setScopes] = useState<ContentScopes>(initial);
  const [baseline, setBaseline] = useState<ContentScopes>(initial);
  const [vertical, setVertical] = useState("");
  const [department, setDepartment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = !sameScopes(scopes, baseline);
  const departments = vertical ? options.departmentsByVertical[vertical] ?? [] : [];

  const add = () => {
    if (!vertical) return;
    const pair: ScopePair = { vertical, department: department || null };
    if (scopes.pairs.some((p) => p.vertical === pair.vertical && (p.department ?? "") === (pair.department ?? ""))) return;
    setScopes((s) => ({ ...s, pairs: [...s.pairs, pair] }));
    setDepartment("");
    setSaved(false);
  };
  const remove = (i: number) => { setScopes((s) => ({ ...s, pairs: s.pairs.filter((_, j) => j !== i) })); setSaved(false); };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/content-scopes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, items, scopes }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; scopes?: ContentScopes };
    setBusy(false);
    if (!res.ok) { setError(j.error ?? "Could not save the mapping"); return; }
    if (j.scopes) { setScopes(j.scopes); setBaseline(j.scopes); } else setBaseline(scopes);
    setSaved(true);
    onSaved?.(j.scopes ?? scopes);
    router.refresh();
  };

  return (
    <div className={compact ? "space-y-2" : "space-y-3"} data-testid="scope-picker">
      <div className="flex flex-wrap items-center gap-1.5 min-h-[28px]">
        {scopes.common && (
          <span className="inline-flex items-center gap-1 border border-indigo-200 bg-indigo-50 text-indigo-800 rounded-full px-2.5 py-0.5 text-xs">
            <Tags className="w-3 h-3" /> Common to all verticals
          </span>
        )}
        {scopes.pairs.map((p, i) => (
          <span key={`${p.vertical}|${p.department ?? ""}`} className="inline-flex items-center gap-1 border border-line bg-canvas rounded-full pl-2.5 pr-1 py-0.5 text-xs">
            {p.department ? `${p.vertical} · ${p.department}` : `${p.vertical} (all)`}
            <button type="button" onClick={() => remove(i)} aria-label={`Remove ${p.vertical}${p.department ? ` ${p.department}` : ""}`} className="p-0.5 rounded-full text-muted hover:text-red-600 hover:bg-red-50">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {!scopes.common && scopes.pairs.length === 0 && <span className="text-xs text-muted">Unmapped — pick where this belongs.</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={vertical} onChange={(e) => { setVertical(e.target.value); setDepartment(""); }} aria-label="Business vertical" className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-xs min-w-[150px]">
          <option value="">Business vertical…</option>
          {options.verticals.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={department} onChange={(e) => setDepartment(e.target.value)} disabled={!vertical || departments.length === 0} aria-label="Department" className="px-2 py-1.5 border border-line rounded-lg bg-canvas text-xs min-w-[150px] disabled:opacity-50">
          <option value="">{departments.length ? "Whole vertical" : "Whole vertical (no departments defined)"}</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button type="button" onClick={add} disabled={!vertical} className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-line rounded-lg text-xs font-medium hover:border-ink disabled:opacity-50">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
        <label className="inline-flex items-center gap-1.5 text-xs ml-1">
          <input type="checkbox" checked={scopes.common} onChange={(e) => { setScopes((s) => ({ ...s, common: e.target.checked })); setSaved(false); }} />
          Common to all verticals
        </label>
        <button type="button" onClick={save} disabled={busy || !dirty} className="inline-flex items-center gap-1 px-3 py-1.5 bg-ink text-canvas rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Save mapping{items.length > 1 ? ` (${items.length})` : ""}
        </button>
        {saved && !dirty && <span role="status" className="text-xs text-emerald-700">Saved</span>}
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {!compact && <p className="text-[11px] text-muted">Mapping says where this content belongs. It does not assign or unlock anything; managers see it only when it is also assigned to people in their reporting line.</p>}
    </div>
  );
}
