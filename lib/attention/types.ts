/**
 * Admin Attention Center — shared, client-safe types + the provider registry
 * METADATA (no server imports, so the config UI can read it too).
 *
 * The center is a scalable PROVIDER REGISTRY: each notification source is a
 * provider with a `type`, a default priority and whether its priority is
 * admin-configurable. Adding a new kind of notification later = add one entry
 * here + one fetcher in collect.ts; nothing else in the UI changes.
 */

export type AttentionPriority = "critical" | "high" | "normal" | "low";

/** Sort order: lower rank = more urgent (shown first). */
export const PRIORITY_RANK: Record<AttentionPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const PRIORITY_META: Record<
  AttentionPriority,
  { label: string; emoji: string; dot: string; chip: string }
> = {
  critical: { label: "Critical", emoji: "🔴", dot: "bg-red-500", chip: "bg-red-50 text-red-700 border-red-200" },
  high: { label: "High", emoji: "🟠", dot: "bg-orange-500", chip: "bg-orange-50 text-orange-700 border-orange-200" },
  normal: { label: "Normal", emoji: "🟡", dot: "bg-amber-400", chip: "bg-amber-50 text-amber-800 border-amber-200" },
  low: { label: "Low", emoji: "⚪", dot: "bg-slate-300", chip: "bg-slate-50 text-slate-600 border-slate-200" },
};

export const PRIORITY_ORDER: AttentionPriority[] = ["critical", "high", "normal", "low"];

/** One actionable/alert item shown in the center. */
export type AttentionItem = {
  /** Stable identity `${type}:${sourceId}` — used for mark-as-read. */
  key: string;
  type: string;
  priority: AttentionPriority;
  /** What happened. */
  title: string;
  /** Who / which learner (name or email). */
  who: string | null;
  /** Course / task. */
  context: string | null;
  /** When (ISO) — also the "seen up to" mark for recurring-alert dismissals. */
  occurredAt: string;
  /** Required action, in words. */
  actionLabel: string;
  /** Open/View target. */
  href: string | null;
  /** Inline action the client can perform without leaving the center. */
  inline: { kind: "attempt-request" | "ticket"; id: string } | null;
  /** Whether the admin may mark it as read/done. */
  dismissible: boolean;
};

export type AttentionProviderMeta = {
  type: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  defaultPriority: AttentionPriority;
  /** false = priority is derived per item (e.g. a ticket's own priority). */
  configurablePriority: boolean;
};

/** The registry. Add a provider here (+ a fetcher in collect.ts) to add a type. */
export const ATTENTION_PROVIDERS: AttentionProviderMeta[] = [
  {
    type: "attempt-request",
    label: "Attempt requests",
    description: "Learners waiting on an extra-attempt decision.",
    defaultEnabled: true,
    defaultPriority: "high",
    configurablePriority: true,
  },
  {
    type: "ticket",
    label: "Support tickets",
    description: "Open and in-progress learner tickets (auto-prioritised by the ticket's own priority).",
    defaultEnabled: true,
    defaultPriority: "normal",
    configurablePriority: false,
  },
  {
    type: "failed-email",
    label: "Failed emails",
    description: "Notifications that failed to send in the last 14 days.",
    defaultEnabled: true,
    defaultPriority: "high",
    configurablePriority: true,
  },
  {
    type: "overdue",
    label: "Overdue learners",
    description: "Learners past a course due date who haven't completed it.",
    defaultEnabled: true,
    defaultPriority: "normal",
    configurablePriority: true,
  },
];

export type AttentionTypeConfig = { enabled: boolean; priority: AttentionPriority };

/**
 * Merge a per-org settings row over the registry defaults. Fail-soft: an
 * absent/garbage row yields the registry defaults.
 */
export function effectiveConfig(raw: {
  enabled?: boolean | null;
  config?: Record<string, { enabled?: boolean; priority?: string }> | null;
} | null): { masterEnabled: boolean; byType: Record<string, AttentionTypeConfig> } {
  const cfg = (raw?.config ?? {}) as Record<string, { enabled?: boolean; priority?: string }>;
  const byType: Record<string, AttentionTypeConfig> = {};
  for (const p of ATTENTION_PROVIDERS) {
    const o = cfg[p.type] ?? {};
    const priority = PRIORITY_ORDER.includes(o.priority as AttentionPriority)
      ? (o.priority as AttentionPriority)
      : p.defaultPriority;
    byType[p.type] = {
      enabled: typeof o.enabled === "boolean" ? o.enabled : p.defaultEnabled,
      // A non-configurable-priority provider always uses its default/derived value.
      priority: p.configurablePriority ? priority : p.defaultPriority,
    };
  }
  return { masterEnabled: raw?.enabled !== false, byType };
}
