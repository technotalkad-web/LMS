"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Target } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  DEFAULT_POLICY,
  OFFICIAL_BASIS_OPTIONS,
  describePolicy,
  policySourceLabel,
  type AfterLimit,
  type AttemptPolicy,
  type EffectivePolicy,
  type OfficialBasis,
  type RuleScope,
  type ScoringRule,
} from "@/lib/scoring/policy";

/**
 * Admin editor for attempt scoring rules (0073). Self-contained: saves via
 * /api/scoring-rules independently of whatever form it sits inside, so the
 * same card drops into the module page, the learning-path editor and the
 * journey settings tab.
 */
export function ScoringRulesCard({
  orgSlug,
  scope,
  targetId,
  initialRule,
  inherited,
  compact = false,
}: {
  orgSlug: string;
  scope: RuleScope;
  targetId: string;
  /** The explicit rule on this target, if any. */
  initialRule: ScoringRule | null;
  /** For scope=course: what applies today after path/journey inheritance. */
  inherited?: EffectivePolicy | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const base: AttemptPolicy = initialRule ?? inherited ?? DEFAULT_POLICY;
  const [hasRule, setHasRule] = useState(!!initialRule);
  const [max, setMax] = useState<number>(base.max_scored_attempts);
  const [basis, setBasis] = useState<OfficialBasis>(base.official_basis);
  const [nth, setNth] = useState<number>(base.official_attempt_number ?? 1);
  const [retainFirst, setRetainFirst] = useState<boolean>(base.retain_first_attempt);
  const [after, setAfter] = useState<AfterLimit>(base.after_limit);
  const [busy, setBusy] = useState(false);

  const draft: AttemptPolicy = {
    max_scored_attempts: max,
    official_basis: basis,
    official_attempt_number: basis === "nth" ? nth : null,
    retain_first_attempt: retainFirst,
    after_limit: after,
  };

  const scopeCopy: Record<RuleScope, string> = {
    course:
      "Rules set here apply to this module and override any learning-path or journey rule.",
    path:
      "Applies to every module in this path that has no rule of its own. If a module sits in several paths, the most restrictive rule wins.",
    journey:
      "Applies to every mission module in this journey that has no module or learning-path rule of its own.",
  };

  async function save() {
    if (basis === "nth" && (nth < 1 || nth > max)) {
      toast.error(`The official attempt must be between 1 and ${max}`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/scoring-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, scope, target_id: targetId, ...draft }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(j.error ?? "Save failed");
        return;
      }
      setHasRule(true);
      toast.success("Attempt rules saved");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (
      !(await confirm({
        message:
          scope === "course"
            ? "Remove this module's own rule? It will follow its learning path / journey rule, or the platform default (3 scored attempts, first attempt official)."
            : "Remove this rule? Modules will fall back to their own rule or the platform default.",
        confirmText: "Remove rule",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/scoring-rules", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, scope, target_id: targetId }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(j.error ?? "Could not remove rule");
        return;
      }
      const fallback = inherited ?? DEFAULT_POLICY;
      setHasRule(false);
      setMax(fallback.max_scored_attempts);
      setBasis(fallback.official_basis);
      setNth(fallback.official_attempt_number ?? 1);
      setRetainFirst(fallback.retain_first_attempt);
      setAfter(fallback.after_limit);
      toast.success("Rule removed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`border border-line rounded-2xl bg-paper ${compact ? "p-4" : "p-6"} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={`${compact ? "font-semibold" : "serif text-2xl"} flex items-center gap-2`}>
            <Target className="w-4 h-4 text-indigo-600" />
            Assessment &amp; attempt rules
          </h2>
          <p className="text-xs text-muted mt-1 leading-relaxed max-w-2xl">
            {scopeCopy[scope]} Learners can always revisit content for revision —
            these rules only decide which attempts count towards scores, reports
            and the leaderboard.
          </p>
        </div>
        <span
          className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
            hasRule
              ? "border-indigo-200 bg-indigo-50 text-indigo-800"
              : "border-line bg-canvas text-muted"
          }`}
        >
          {hasRule
            ? "Custom rule"
            : inherited
              ? `Inheriting: ${policySourceLabel(inherited)}`
              : "Platform default"}
        </span>
      </div>

      {!hasRule && inherited && (
        <p className="text-xs text-muted bg-canvas border border-line rounded-lg px-3 py-2">
          Currently applied: <span className="text-ink">{describePolicy(inherited)}</span>
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">
            Maximum scored attempts
          </span>
          <input
            type="number"
            min={1}
            max={99}
            value={max}
            onChange={(e) => {
              const n = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
              setMax(n);
              if (nth > n) setNth(n);
            }}
            className="w-28 px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
          <span className="block text-[11px] text-muted mt-1.5 leading-relaxed">
            Only <strong>completed</strong> attempts use a slot — an attempt that is
            abandoned or interrupted never counts against the learner.
          </span>
        </label>

        <div className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">
            After the scored attempts are used up
          </span>
          <div className="space-y-1.5">
            <RadioRow
              checked={after === "practice"}
              onSelect={() => setAfter("practice")}
              title="Practice mode"
              hint="Learners may keep relaunching for revision; those attempts are clearly labelled Practice and never change scores, reports or points."
            />
            <RadioRow
              checked={after === "block"}
              onSelect={() => setAfter("block")}
              title="Block further attempts"
              hint="The Launch button is disabled once the window is used. Admins can still preview."
            />
          </div>
        </div>
      </div>

      <div className="block">
        <span className="block text-xs font-medium text-muted mb-1.5">
          Official score (used on the profile, leaderboard and reports)
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {OFFICIAL_BASIS_OPTIONS.map((o) => (
            <RadioRow
              key={o.value}
              checked={basis === o.value}
              onSelect={() => setBasis(o.value)}
              title={o.label}
              hint={o.hint}
              extra={
                o.value === "nth" && basis === "nth" ? (
                  <span className="inline-flex items-center gap-2 text-xs">
                    Attempt #
                    <input
                      type="number"
                      min={1}
                      max={max}
                      value={nth}
                      onChange={(e) =>
                        setNth(Math.max(1, Math.min(max, parseInt(e.target.value, 10) || 1)))
                      }
                      className="w-16 px-2 py-1 border border-line rounded bg-canvas text-sm outline-none focus:border-ink"
                    />
                    of {max}
                  </span>
                ) : null
              }
            />
          ))}
        </div>
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={retainFirst}
          onChange={(e) => setRetainFirst(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm font-medium">
            Keep the first-attempt score for L&amp;D analysis
          </span>
          <span className="block text-xs text-muted mt-0.5 leading-relaxed">
            Shows first attempt vs official score in analytics so learning gain
            (before → after revision) can be measured. The first attempt is always
            stored; this controls whether reports surface it.
          </span>
        </span>
      </label>

      <p className="text-xs bg-indigo-50 border border-indigo-100 text-indigo-900 rounded-lg px-3 py-2">
        <strong>In effect:</strong> {describePolicy(draft)}
        {retainFirst ? " · first attempt retained for analysis" : ""}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasRule && (
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="px-4 py-2 border border-line rounded-lg text-sm hover:border-red-500 hover:text-red-700 disabled:opacity-50"
          >
            {scope === "course" ? "Remove rule (inherit)" : "Remove rule"}
          </button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : hasRule ? "Save rules" : "Set rules"}
        </button>
      </div>
    </section>
  );
}

function RadioRow({
  checked,
  onSelect,
  title,
  hint,
  extra,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
  extra?: React.ReactNode;
}) {
  // `extra` (the attempt-number input) renders as a sibling of the button:
  // interactive content inside <button> is invalid HTML.
  return (
    <div
      className={`border rounded-xl transition-colors ${
        checked ? "border-ink bg-canvas" : "border-line bg-paper hover:border-ink"
      }`}
    >
      <button type="button" onClick={onSelect} className="w-full text-left p-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-3 h-3 rounded-full border-2 shrink-0 ${
              checked ? "border-ink bg-ink" : "border-line bg-paper"
            }`}
          />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div className="text-xs text-muted mt-1.5 leading-relaxed">{hint}</div>
      </button>
      {extra ? <div className="px-3 pb-3 -mt-1">{extra}</div> : null}
    </div>
  );
}
