import type { ReactNode } from "react";

/**
 * One KPI tile. Use inside <KpiStrip>. Renders an icon, label, big value,
 * and optional trend hint. Width: responsive grid handled by the parent.
 */
export function KpiCard({
  label,
  value,
  icon,
  trend,
  accent,
}: {
  label: string;
  value: string | number;
  icon?: ReactNode;
  trend?: string;
  /** Tailwind text-color class applied to the icon, e.g. "text-emerald-600". */
  accent?: string;
}) {
  return (
    <div className="bg-paper border border-line rounded-xl px-4 py-3.5 sm:px-5 sm:py-4 flex items-start gap-3">
      {icon && (
        <div className={`shrink-0 mt-0.5 ${accent ?? "text-ink"}`}>
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase">
          {label}
        </p>
        <p className="serif text-2xl sm:text-3xl mt-0.5 leading-tight">{value}</p>
        {trend && <p className="text-xs text-muted mt-0.5">{trend}</p>}
      </div>
    </div>
  );
}

export function KpiStrip({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
      {children}
    </div>
  );
}
