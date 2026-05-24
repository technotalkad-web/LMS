"use client";

import type { ReactNode } from "react";

export type Tab<K extends string> = {
  key: K;
  label: string;
  icon?: ReactNode;
  count?: number;
};

/**
 * Pill-style tab strip. Renders horizontally; scrolls on mobile. Active
 * tab gets a dark fill; inactive tabs use a subtle outline. Click pushes
 * the value through `onChange`.
 */
export function TabStrip<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Tab<K>[];
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 py-1 mb-5 scrollbar-hide">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={`shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm font-medium transition-colors whitespace-nowrap ${
              isActive
                ? "bg-ink text-paper"
                : "bg-paper text-muted border border-line hover:text-ink hover:border-ink/40"
            }`}
          >
            {t.icon && <span className="shrink-0">{t.icon}</span>}
            {t.label}
            {typeof t.count === "number" && (
              <span
                className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  isActive ? "bg-paper/20 text-paper" : "bg-canvas text-muted"
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
