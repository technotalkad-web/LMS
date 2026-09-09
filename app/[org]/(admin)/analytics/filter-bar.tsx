"use client";

import { useRouter } from "next/navigation";
import { X } from "lucide-react";

/**
 * URL-driven filter bar for the Learner Analytics dashboard. Every select
 * writes its value into the query string and lets the SERVER page re-derive
 * the whole dashboard — no client state, no fetch waterfalls, links are
 * shareable ("here's the Mumbai Retail view").
 */

export type FilterOption = { value: string; label: string };

export type FilterState = {
  team: string;
  vertical: string;
  branch: string;
  city: string;
  manager: string;
  cohort: string;
  group: string;
  content: string;
};

export function FilterBar({
  orgSlug,
  current,
  teams,
  verticals,
  branches,
  cities,
  managers,
  cohorts,
  groups,
  contents,
}: {
  orgSlug: string;
  current: FilterState;
  teams: FilterOption[];
  verticals: FilterOption[];
  branches: FilterOption[];
  cities: FilterOption[];
  managers: FilterOption[];
  cohorts: FilterOption[];
  groups: FilterOption[];
  contents: Array<{ label: string; options: FilterOption[] }>;
}) {
  const router = useRouter();

  function apply(patch: Partial<FilterState>) {
    const next = { ...current, ...patch };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) qs.set(k, v);
    // Changing any population filter exits a learner drill-down.
    router.push(`/${orgSlug}/analytics${qs.size ? `?${qs}` : ""}`);
  }

  const anyActive = Object.values(current).some(Boolean);

  const sel =
    "px-2.5 py-1.5 border border-line rounded-lg bg-paper text-xs outline-none focus:border-ink max-w-[170px]";

  const Select = ({
    label,
    value,
    options,
    onChange,
  }: {
    label: string;
    value: string;
    options: FilterOption[];
    onChange: (v: string) => void;
  }) =>
    options.length === 0 ? null : (
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)} className={sel}>
          <option value="">All</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div className="flex flex-wrap items-end gap-2.5">
      <Select label="Team" value={current.team} options={teams} onChange={(v) => apply({ team: v })} />
      <Select label="Vertical" value={current.vertical} options={verticals} onChange={(v) => apply({ vertical: v })} />
      <Select label="Branch" value={current.branch} options={branches} onChange={(v) => apply({ branch: v })} />
      <Select label="City" value={current.city} options={cities} onChange={(v) => apply({ city: v })} />
      <Select label="Manager (L1)" value={current.manager} options={managers} onChange={(v) => apply({ manager: v })} />
      <Select label="Joining cohort" value={current.cohort} options={cohorts} onChange={(v) => apply({ cohort: v })} />
      <Select label="Custom group" value={current.group} options={groups} onChange={(v) => apply({ group: v })} />
      {contents.some((g) => g.options.length > 0) && (
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted">Course / Journey / Path</span>
          <select
            value={current.content}
            onChange={(e) => apply({ content: e.target.value })}
            className={sel}
          >
            <option value="">Everything</option>
            {contents.map((g) =>
              g.options.length === 0 ? null : (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )
            )}
          </select>
        </label>
      )}
      {anyActive && (
        <button
          type="button"
          onClick={() =>
            apply({
              team: "",
              vertical: "",
              branch: "",
              city: "",
              manager: "",
              cohort: "",
              group: "",
              content: "",
            })
          }
          className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-line rounded-lg text-xs text-muted hover:border-ink hover:text-ink"
        >
          <X className="w-3 h-3" /> Clear
        </button>
      )}
    </div>
  );
}
