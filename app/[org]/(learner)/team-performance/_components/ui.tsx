import type { ReactNode } from "react";
import type { LearnerStatus, Severity, Tone } from "@/lib/manager/types";
import { STATUS_LABEL } from "@/lib/manager/types";

/** Colour means status, never decoration (§2): one palette for every pill and dot. */
export const TONE_PILL: Record<Tone, string> = {
  ok: "bg-emerald-100 text-emerald-800",
  warn: "bg-amber-100 text-amber-900",
  bad: "bg-red-100 text-red-800",
  none: "bg-canvas text-muted border border-line",
};
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  none: "bg-slate-300",
};
export const STATUS_TONE: Record<LearnerStatus, Tone> = { on_track: "ok", watch: "warn", needs_support: "bad" };
export const SEVERITY_TONE: Record<Severity, Tone> = { critical: "bad", high: "warn", normal: "warn" };

export function Pill({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${TONE_PILL[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: LearnerStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

export function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={`inline-block w-2.5 h-2.5 rounded-full mr-2 align-[-1px] ${TONE_DOT[tone]}`} />;
}

export function Card({ children, className = "", title, eyebrow }: { children: ReactNode; className?: string; title?: string; eyebrow?: string }) {
  return (
    <section className={`bg-paper border border-line rounded-2xl p-5 ${className}`}>
      {eyebrow && <p className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">{eyebrow}</p>}
      {title && <h2 className="font-semibold text-sm mb-3">{title}</h2>}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone?: Tone }) {
  const color = tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : tone === "ok" ? "text-emerald-700" : "";
  return (
    <div className="bg-paper border border-line rounded-2xl px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted font-bold">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

export const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

export function relativeDays(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const d = Math.floor((nowMs - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}
