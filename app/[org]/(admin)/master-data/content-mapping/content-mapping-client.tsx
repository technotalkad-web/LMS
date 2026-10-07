"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ScopePicker, type ScopeOptions } from "../../_components/scope-picker";
import { describeScopes, type ContentScopes, type ContentType } from "@/lib/content/scopes";

export type MappingRow = { type: ContentType; id: string; title: string; active: boolean; scopes: ContentScopes };

type Filter = "unmapped" | "mapped" | "all";
type TypeFilter = "all" | ContentType;

const TYPE_LABEL: Record<ContentType, string> = { course: "Course", path: "Learning path", journey: "Journey" };

export function ContentMappingClient({ orgSlug, rows, options }: { orgSlug: string; rows: MappingRow[]; options: ScopeOptions }) {
  const [filter, setFilter] = useState<Filter>(rows.some((r) => r.active && !r.scopes.common && r.scopes.pairs.length === 0) ? "unmapped" : "all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const isMapped = (r: MappingRow) => r.scopes.common || r.scopes.pairs.length > 0;
  const counts = useMemo(() => {
    const active = rows.filter((r) => r.active);
    return { total: active.length, unmapped: active.filter((r) => !isMapped(r)).length };
  }, [rows]);
  const visible = rows.filter((r) =>
    (showInactive || r.active) &&
    (typeFilter === "all" || r.type === typeFilter) &&
    (filter === "all" || (filter === "unmapped" ? !isMapped(r) : isMapped(r))) &&
    (!q.trim() || r.title.toLowerCase().includes(q.trim().toLowerCase()))
  );
  const key = (r: MappingRow) => `${r.type}:${r.id}`;
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const selectedItems = rows.filter((r) => selected.has(key(r))).map((r) => ({ type: r.type, id: r.id }));
  const hrefOf = (r: MappingRow) =>
    r.type === "course" ? `/${orgSlug}/library/${r.id}` : r.type === "path" ? `/${orgSlug}/learning-paths` : `/${orgSlug}/journey-admin?program=${r.id}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-paper border border-line rounded-xl p-4"><div className="text-[10px] uppercase tracking-wide text-muted">Active content</div><div className="serif text-3xl mt-1">{counts.total}</div></div>
        <div className={`border rounded-xl p-4 ${counts.unmapped ? "bg-amber-50 border-amber-200" : "bg-paper border-line"}`}><div className="text-[10px] uppercase tracking-wide text-muted">Unmapped</div><div className="serif text-3xl mt-1">{counts.unmapped}</div></div>
        <div className="bg-paper border border-line rounded-xl p-4"><div className="text-[10px] uppercase tracking-wide text-muted">Verticals</div><div className="serif text-3xl mt-1">{options.verticals.length}</div></div>
        <div className="bg-paper border border-line rounded-xl p-4"><div className="text-[10px] uppercase tracking-wide text-muted">Departments</div><div className="serif text-3xl mt-1">{Object.values(options.departmentsByVertical).reduce((n, d) => n + d.length, 0)}</div></div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["unmapped", "mapped", "all"] as Filter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={`px-3 py-1.5 rounded-full text-xs font-medium border ${filter === f ? "bg-ink text-canvas border-ink" : "border-line hover:border-ink"}`}>
            {f === "unmapped" ? `Unmapped (${counts.unmapped})` : f === "mapped" ? "Mapped" : "All"}
          </button>
        ))}
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} aria-label="Content type" className="px-2 py-1.5 border border-line rounded-lg bg-paper text-xs">
          <option value="all">All types</option>
          <option value="course">Courses</option>
          <option value="path">Learning paths</option>
          <option value="journey">Journeys</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title…" aria-label="Search" className="px-2 py-1.5 border border-line rounded-lg bg-paper text-xs min-w-[180px]" />
        <label className="text-xs inline-flex items-center gap-1.5 ml-auto"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
      </div>

      {selected.size > 0 && (
        <div className="border border-indigo-200 bg-indigo-50/40 rounded-xl p-4 space-y-2">
          <div className="text-sm font-medium">Map {selected.size} selected item{selected.size === 1 ? "" : "s"} to…</div>
          <ScopePicker key={[...selected].sort().join(",")} orgSlug={orgSlug} items={selectedItems} initial={{ common: false, pairs: [] }} options={options} compact onSaved={() => setSelected(new Set())} />
          <p className="text-[11px] text-muted">Replaces each selected item&apos;s current mapping.</p>
        </div>
      )}

      <div className="bg-paper border border-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
              <th className="px-3 py-2 w-8"><input type="checkbox" aria-label="Select all visible" checked={visible.length > 0 && visible.every((r) => selected.has(key(r)))} onChange={(e) => setSelected(e.target.checked ? new Set(visible.map(key)) : new Set())} /></th>
              <th className="text-left font-semibold px-3 py-2">Content</th>
              <th className="text-left font-semibold px-3 py-2">Type</th>
              <th className="text-left font-semibold px-3 py-2">Belongs to</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((r) => {
              const k = key(r);
              return (
                <tr key={k} className={!r.active ? "opacity-60" : ""}>
                  <td colSpan={5} className="p-0">
                    <div className="flex items-start gap-3 px-3 py-2.5">
                      <input type="checkbox" className="mt-1" checked={selected.has(k)} onChange={() => toggle(k)} aria-label={`Select ${r.title}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <Link href={hrefOf(r)} className="font-medium hover:underline">{r.title}</Link>
                          <span className="text-xs text-muted">{TYPE_LABEL[r.type]}{r.active ? "" : " · inactive"}</span>
                          <span className={`text-xs ${isMapped(r) ? "text-muted" : "text-amber-700 font-medium"}`}>{describeScopes(r.scopes)}</span>
                          <button type="button" className="text-xs underline text-muted hover:text-ink ml-auto" onClick={() => setOpenId(openId === k ? null : k)}>{openId === k ? "Close" : "Edit mapping"}</button>
                        </div>
                        {openId === k && (
                          <div className="mt-2">
                            <ScopePicker orgSlug={orgSlug} items={[{ type: r.type, id: r.id }]} initial={r.scopes} options={options} compact onSaved={() => setOpenId(null)} />
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted">{filter === "unmapped" ? "Everything is mapped." : "Nothing matches."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
