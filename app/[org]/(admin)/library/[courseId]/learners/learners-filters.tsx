"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

/**
 * URL-driven filter bar for the enrolled-learners page.
 *
 * All state lives in the URL search params, so the server page can
 * render the right slice on first paint, links are shareable, and
 * the browser back button does the right thing.
 *
 * Keys we own:
 *   q       — free-text search (matches name / email / employee_id)
 *   status  — "all" | "not_started" | "in_progress" | "completed" | "passed" | "failed"
 *   via     — "any" | "user" | "team" | "org"
 *   page    — we reset to 1 whenever any filter changes
 *
 * (sort + page are owned by the page itself; this component only emits
 * the user-facing filter keys.)
 */
export function LearnersFilters({
  counts,
}: {
  counts: {
    all: number;
    not_started: number;
    in_progress: number;
    completed: number;
    passed: number;
    failed: number;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentStatus = searchParams.get("status") ?? "all";
  const currentVia = searchParams.get("via") ?? "any";
  const currentQ = searchParams.get("q") ?? "";

  // Local input state so typing feels instant; we debounce-push to URL.
  const [q, setQ] = useState(currentQ);
  useEffect(() => setQ(currentQ), [currentQ]);

  // Debounce search-query writes to the URL by 250ms so we don't fire
  // a router push on every keystroke.
  useEffect(() => {
    if (q === currentQ) return;
    const t = setTimeout(() => updateParam("q", q || null), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null || value === "" || value === "all" || value === "any") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    // Any filter change resets pagination to page 1.
    next.delete("page");
    const qs = next.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  const statusChips: Array<{ key: string; label: string; count: number; tone: string }> = [
    { key: "all", label: "All", count: counts.all, tone: "border-line text-ink" },
    { key: "not_started", label: "Not started", count: counts.not_started, tone: "border-line text-muted" },
    { key: "in_progress", label: "In progress", count: counts.in_progress, tone: "border-amber-300 text-amber-800" },
    { key: "completed", label: "Completed", count: counts.completed, tone: "border-indigo-300 text-indigo-800" },
    { key: "passed", label: "Passed", count: counts.passed, tone: "border-emerald-300 text-emerald-800" },
    { key: "failed", label: "Failed", count: counts.failed, tone: "border-red-300 text-red-800" },
  ];

  return (
    <div className={`space-y-3 ${isPending ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email, or employee ID…"
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
          />
          {q && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                updateParam("q", null);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink text-sm"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <label className="text-xs uppercase tracking-wide text-muted">Source</label>
        <select
          value={currentVia}
          onChange={(e) => updateParam("via", e.target.value)}
          className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
        >
          <option value="any">Any</option>
          <option value="user">Direct assignment</option>
          <option value="team">Via team</option>
          <option value="org">Org-wide</option>
        </select>
      </div>

      <div className="flex flex-wrap gap-2">
        {statusChips.map((c) => {
          const active = currentStatus === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => updateParam("status", c.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs transition-colors ${
                active
                  ? "bg-ink text-canvas border-ink"
                  : `bg-paper hover:bg-canvas ${c.tone}`
              }`}
            >
              <span>{c.label}</span>
              <span
                className={`tabular-nums text-[10px] px-1.5 py-0.5 rounded-full ${
                  active ? "bg-canvas/20" : "bg-canvas"
                }`}
              >
                {c.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
