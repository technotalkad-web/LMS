import { tierBadge, type AnalyticsTier, type TierBadgeSpec } from "@/lib/alds/tier";

/**
 * The analytics-tier pill of a course version (ADR 0005 step 11, note (g) of
 * 2026-10-19). Props only, no server-only imports: it renders inside the
 * Library's client browser too. The caller decides whether to show it (the
 * ALDS_P4 flag and a successful read of the column); `tier` undefined or
 * unknown renders nothing. Informational: completion, scores, official
 * status, the Report Card, CRM and journeys never depend on the tier (D1).
 */
const TONE: Record<TierBadgeSpec["tone"], string> = {
  neutral: "bg-canvas text-muted border border-line",
  pending: "bg-amber-100 text-amber-800 border border-amber-200",
  bad: "bg-red-100 text-red-800 border border-red-200",
  good: "bg-emerald-100 text-emerald-800 border border-emerald-200",
  revoked: "bg-slate-200 text-slate-800 border border-slate-300",
};

export function TierBadge({
  tier,
  reason,
  certificationId,
  className = "",
}: {
  tier: AnalyticsTier | null | undefined;
  reason?: string | null;
  certificationId?: string | null;
  className?: string;
}) {
  const spec = tierBadge(tier, reason);
  if (!spec) return null;
  return (
    <span
      className={`px-2 py-0.5 rounded-full uppercase tracking-wide text-[10px] ${TONE[spec.tone]} ${className}`.trim()}
      title={spec.title}
      data-testid="analytics-tier"
      data-tier={tier ?? undefined}
      data-certification-id={certificationId ?? undefined}
    >
      {spec.label}
    </span>
  );
}
