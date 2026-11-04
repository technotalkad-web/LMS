"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Target } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  describePolicy,
  type EffectivePolicy,
  type RuleScope,
  type ScoringRule,
} from "@/lib/scoring/policy";

/**
 * Attempt scoring rules (0073), read-only since ADR 0014 step 9 (Q1,
 * "Retire the multi-attempt setting"): every module resolves to one official
 * attempt, then review-only revision visits, and extra official attempts
 * open only by an admin's grant. The editor is gone and POST
 * /api/scoring-rules refuses any non-default value; a rule row stored before
 * (a legacy row) is read as the default, and the card says so and keeps
 * "Remove rule" (DELETE, unchanged). The same card still drops into the
 * module page, the learning-path editor and the journey settings tab.
 *
 * The copy names no rule precedence, inheritance or override: with every
 * rule read as the default, a legacy
 * row on this target or on a path or journey above it changes nothing, and
 * removing it changes nothing for learners.
 */
export function ScoringRulesCard({
  orgSlug,
  scope,
  targetId,
  initialRule,
  compact = false,
}: {
  orgSlug: string;
  scope: RuleScope;
  targetId: string;
  /** The explicit rule on this target, if any. */
  initialRule: ScoringRule | null;
  /**
   * For scope=course: what resolves after path/journey inheritance. Kept for
   * the callers; the card no longer names it, because every rule reads as
   * the default (ADR 0014 step 9).
   */
  inherited?: EffectivePolicy | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const [hasRule, setHasRule] = useState(!!initialRule);
  const [busy, setBusy] = useState(false);

  const targetNoun: Record<RuleScope, string> = {
    course: "module",
    path: "learning path",
    journey: "journey",
  };

  async function reset() {
    if (
      !(await confirm({
        message: `Remove the rule stored on this ${targetNoun[scope]}? Nothing changes for learners: it is already read as the default.`,
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
      setHasRule(false);
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
            Attempt rules are the same for every module (ADR 0014). Learners can revisit a
            module any time to review; revisiting never changes their official result.
          </p>
        </div>
        <span
          className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
            hasRule
              ? "border-indigo-200 bg-indigo-50 text-indigo-800"
              : "border-line bg-canvas text-muted"
          }`}
        >
          {hasRule ? "Legacy rule · read as default" : "Platform default"}
        </span>
      </div>

      {/* ADR 0014 step 9: the read-only note in place of the editor. */}
      <p
        className="text-xs bg-indigo-50 border border-indigo-100 text-indigo-900 rounded-lg px-3 py-2"
        data-testid="scoring-rules-note"
      >
        One official attempt, then review-only revision visits; extra attempts by grant
      </p>

      {hasRule && initialRule && (
        <p
          className="text-xs text-muted bg-canvas border border-line rounded-lg px-3 py-2"
          data-testid="scoring-rules-legacy"
        >
          A rule is stored on this {targetNoun[scope]} ({describePolicy(initialRule)}); it is
          read as the default.
        </p>
      )}

      {hasRule && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="px-4 py-2 border border-line rounded-lg text-sm hover:border-red-500 hover:text-red-700 disabled:opacity-50"
          >
            Remove rule
          </button>
        </div>
      )}
    </section>
  );
}
