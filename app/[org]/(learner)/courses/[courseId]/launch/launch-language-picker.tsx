"use client";

import { useEffect, useRef, useState } from "react";
import { languageDisplay } from "@/lib/i18n/languages";
import {
  switchConfirmText,
  type InProgressAttemptLang,
  type SwitchContextBody,
} from "@/lib/courses/slot-routing";

export type LaunchPickerPackage = {
  id: string;
  language: string | null;
  display_label: string;
};

/**
 * Full-screen language picker shown to learners when a course has more
 * than one active language package AND the learner has no saved
 * preference yet, and (ADR 0024 P2-9) on a Start with ?switch=: rule (1)'s
 * redirect, which opens the confirm for that language at once, and "Change
 * language" on a path step or a journey day, which shows the picker alone.
 *
 * On pick:
 *   1. PUT /api/courses/{courseId}/language-preference, naming the launch's
 *      own context (ADR 0024 step 27: the switch closes that product's open
 *      attempt only)
 *   2. If 409 with requires_confirm: show the progress-reset warning
 *      with a "Switch and reset progress" button.
 *   3. On success: full-page nav to ?lang={code} so the SCORM/cmi5
 *      runtime re-mounts with the chosen package (?switch= is dropped, or
 *      the page would render this picker again).
 *
 * A Preview by mode (ADR 0024 step 23, P2-5) skips 1 and 2: it saves no
 * language preference and resets nothing (the switch route resets the
 * learner's open rows on the other language, a real attempt included). It
 * goes straight to ?lang={code}, which keeps ?mode=preview.
 *
 * Closes #158 Phase 2 + Phase 3 + Phase 4 (confirmation modal).
 */
export function LaunchLanguagePicker({
  orgSlug,
  courseId,
  courseTitle,
  packages,
  preview = false,
  context = null,
  inProgress = [],
  initialSwitch = null,
}: {
  orgSlug: string;
  courseId: string;
  courseTitle: string;
  packages: LaunchPickerPackage[];
  /** A Preview by mode: pick the language for this launch only. */
  preview?: boolean;
  /** ADR 0024 P2-9: the launch's own context, sent with every switch (null on a preview). */
  context?: SwitchContextBody | null;
  /** That context's open attempts by language (the confirm's words). */
  inProgress?: InProgressAttemptLang[];
  /** ?switch=<language>: open the confirm for it at once (rule (1)'s redirect). */
  initialSwitch?: string | null;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<{
    language: string;
    label: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const product = context?.kind ?? "individual";
  const labelOf = (language: string | null) =>
    packages.find((p) => p.language === language)?.display_label ?? languageDisplay(language, "english") ?? language ?? "";

  // Open the confirm once for rule (1)'s redirect (?switch=<lang>).
  const initialSwitchDone = useRef(false);
  useEffect(() => {
    if (initialSwitchDone.current || !initialSwitch || preview) return;
    initialSwitchDone.current = true;
    const target = packages.find((p) => p.language === initialSwitch);
    if (!target) return;
    setConfirmFor({ language: initialSwitch, label: target.display_label });
  }, [initialSwitch, packages, preview]);

  async function pick(language: string, restart = false) {
    setError(null);
    setPicking(language);
    if (preview) {
      const next = new URL(window.location.href);
      next.searchParams.set("lang", language);
      window.location.href = next.toString();
      return;
    }
    const res = await fetch(
      `/api/courses/${courseId}/language-preference`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          language,
          restart_if_in_progress: restart,
          ...(context ? { context } : {}),
        }),
      }
    );
    if (res.status === 409 && !restart) {
      const j = (await res.json().catch(() => ({}))) as {
        requires_confirm?: boolean;
        requires_finish?: boolean;
        in_progress_attempts?: number;
        message?: string;
        error?: string;
      };
      if (j.requires_confirm) {
        setConfirmFor({
          language,
          label:
            packages.find((p) => p.language === language)?.display_label ??
            language,
        });
        setPicking(null);
        return;
      }
      // ADR 0014 step 18: an attempt that has taken an assessment cannot be
      // reset by a switch. The body was read once above; show its message
      // (never "HTTP 409") and stop.
      if (j.requires_finish) {
        setError(j.message ?? j.error ?? "");
        setPicking(null);
        return;
      }
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${res.status}`);
      setPicking(null);
      return;
    }
    // Full-page nav so the server re-evaluates with the new saved pref.
    // Keep the launch context (?journey=&day=, ?lp=, ?back=) — replacing
    // the whole query string here used to untag journey/path launches and
    // send the exit button to the wrong place. Drop ?switch= (ADR 0024
    // P2-9): the page renders this picker for it, so keeping it would loop.
    const next = new URL(window.location.href);
    next.searchParams.delete("switch");
    next.searchParams.set("lang", language);
    window.location.href = next.toString();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-6 py-10">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <h1 className="serif text-3xl mb-2">Choose your language</h1>
          <p className="text-muted text-sm">
            <span className="font-medium text-ink">{courseTitle}</span> is
            available in multiple languages. Pick one to continue.
          </p>
        </div>

        {error && (
          <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-4 py-3 text-sm mb-4">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {packages.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => p.language && pick(p.language)}
              disabled={picking !== null}
              className="text-left border border-line rounded-2xl bg-paper p-5 hover:border-ink hover:shadow-sm transition-all disabled:opacity-50"
            >
              <div className="text-2xl font-medium mb-1">{p.display_label}</div>
              <div className="text-xs text-muted">
                {languageDisplay(p.language, "english")}
                {p.language ? <> &middot; <code>{p.language}</code></> : null}
              </div>
              {picking === p.language && (
                <div className="text-xs text-muted mt-2">Saving…</div>
              )}
            </button>
          ))}
        </div>

        <p className="text-xs text-muted text-center mt-6">
          {product === "path"
            ? "You can change your language later from this step on the path page."
            : product === "journey"
              ? "You can change your language later from today's mission on your journey page."
              : "You can change your language later from the course detail page."}
        </p>
      </div>

      {confirmFor && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="bg-paper border border-line rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="serif text-2xl">Change Course Language?</h3>
            <p className="text-sm text-ink leading-relaxed" data-testid="language-switch-copy">
              {switchConfirmText({
                product,
                target: confirmFor.language,
                targetLabel: confirmFor.label,
                inProgress,
                labelOf,
              })}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmFor(null)}
                className="px-4 py-2 border border-line rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  pick(confirmFor.language, true);
                  setConfirmFor(null);
                }}
                className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-semibold hover:opacity-90"
              >
                OK, Switch Language
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
