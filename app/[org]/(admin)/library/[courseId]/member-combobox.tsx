"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AssignableMember } from "./assign-section";

/**
 * Searchable member picker for the course-assignment flow.
 *
 * Why this replaced a native <select>:
 *   The native dropdown lists 1000+ members with no search, no filtering,
 *   and no way to match by employee_id. A senior admin assigning one
 *   specific person had to scroll through hundreds of emails. This
 *   combobox filters across name / email / employee_id with keyboard
 *   navigation and shows the role + employee_id badge inline.
 *
 * Scaling notes:
 *   Filters client-side over the full member list passed as prop. Fine
 *   for ~5000 members (sub-millisecond per keystroke, ~1MB payload).
 *   Past that, switch to a debounced /api/users/search endpoint — see
 *   ticket #149.
 *
 * Ranking:
 *   1. exact match in any searchable field      (rank 0)
 *   2. any field starts with the query          (rank 1)
 *   3. any field contains the query             (rank 2)
 *   Top 50 results shown so the popover stays usable.
 *
 * Keyboard:
 *   ArrowDown / ArrowUp  → move highlight (and open the popover)
 *   Enter                → select highlighted match
 *   Escape               → close popover (keep input focused)
 *   Click outside        → close popover
 */
export function MemberCombobox({
  members,
  value,
  onChange,
  disabled,
  placeholder = "Search by name, email, or employee ID…",
}: {
  members: AssignableMember[];
  value: string; // user_id, or "" when nothing selected
  onChange: (userId: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => members.find((m) => m.user_id === value) ?? null,
    [members, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members.slice(0, 50);
    const rank = (m: AssignableMember): number => {
      const fields: string[] = [
        m.email ?? "",
        m.employee_id ?? "",
        m.first_name ?? "",
        m.last_name ?? "",
        `${m.first_name ?? ""} ${m.last_name ?? ""}`.trim(),
      ]
        .map((s) => s.toLowerCase())
        .filter(Boolean);
      if (fields.some((s) => s === q)) return 0;
      if (fields.some((s) => s.startsWith(q))) return 1;
      if (fields.some((s) => s.includes(q))) return 2;
      return Infinity;
    };
    return members
      .map((m) => ({ m, r: rank(m) }))
      .filter((x) => x.r !== Infinity)
      .sort((a, b) => a.r - b.r)
      .slice(0, 50)
      .map((x) => x.m);
  }, [members, query]);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (
        !inputRef.current?.contains(t) &&
        !popoverRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Reset highlight when result list changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  function pick(m: AssignableMember) {
    onChange(m.user_id);
    setQuery("");
    setOpen(false);
  }

  function clear() {
    onChange("");
    setQuery("");
    setOpen(true);
    // Focus shortly after state flush so the input is mounted.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && filtered[activeIdx]) {
        e.preventDefault();
        pick(filtered[activeIdx]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  // Render: chip when something is selected, otherwise the input + popover.
  if (selected) {
    const fullName = [selected.first_name, selected.last_name]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        type="button"
        onClick={clear}
        disabled={disabled}
        title="Click to clear and pick a different member"
        className="flex flex-1 min-w-[260px] items-center gap-2 px-3 py-2 border border-ink rounded-lg bg-canvas text-sm hover:bg-canvas/70 transition-colors disabled:opacity-50"
      >
        <span className="font-medium truncate">
          {fullName || selected.email}
        </span>
        {selected.employee_id && (
          <span className="bg-paper border border-line rounded px-1.5 py-0.5 text-[10px] font-mono text-muted shrink-0">
            {selected.employee_id}
          </span>
        )}
        {fullName && (
          <span className="text-xs text-muted truncate">{selected.email}</span>
        )}
        <span className="ml-auto text-muted text-base leading-none" aria-hidden>
          ×
        </span>
        <span className="sr-only">Clear selection</span>
      </button>
    );
  }

  return (
    <div className="relative flex-1 min-w-[260px]">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls="member-combobox-listbox"
        aria-autocomplete="list"
        className="w-full px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm disabled:opacity-50"
      />
      {open && !disabled && (
        <div
          ref={popoverRef}
          className="absolute z-20 left-0 right-0 mt-1 max-h-80 overflow-y-auto border border-line rounded-lg bg-paper shadow-lg"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted text-center">
              No member matches{" "}
              <span className="font-medium text-ink">
                &ldquo;{query}&rdquo;
              </span>
              . Try email or employee ID.
            </div>
          ) : (
            <>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted border-b border-line bg-canvas/50 flex items-center justify-between">
                <span>
                  {query
                    ? `Showing ${filtered.length} ${
                        filtered.length === 1 ? "match" : "matches"
                      }`
                    : `Showing ${filtered.length} of ${members.length}`}
                </span>
                <span className="opacity-60">↑↓ to navigate · Enter to pick</span>
              </div>
              <ul role="listbox" id="member-combobox-listbox">
                {filtered.map((m, i) => {
                  const name = [m.first_name, m.last_name]
                    .filter(Boolean)
                    .join(" ");
                  const initials = (
                    (name && name[0]) || m.email?.[0] || "?"
                  ).toUpperCase();
                  const active = i === activeIdx;
                  return (
                    <li
                      key={m.user_id}
                      role="option"
                      aria-selected={active}
                      onMouseDown={(e) => {
                        // prevent input blur before click fires
                        e.preventDefault();
                        pick(m);
                      }}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${
                        active ? "bg-canvas" : ""
                      }`}
                    >
                      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white flex items-center justify-center text-xs font-semibold shrink-0">
                        {initials}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {name || m.email}
                        </div>
                        <div className="text-xs text-muted truncate flex items-center gap-2 mt-0.5">
                          {m.employee_id && (
                            <span className="bg-canvas border border-line rounded px-1.5 py-0.5 text-[10px] font-mono shrink-0">
                              {m.employee_id}
                            </span>
                          )}
                          {name && <span className="truncate">{m.email}</span>}
                          <span className="capitalize text-muted/80 shrink-0">
                            {m.role.replace(/_/g, " ")}
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
