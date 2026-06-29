"use client";

import { useState } from "react";
import { languageDisplay } from "@/lib/i18n/languages";

export type LaunchPickerPackage = {
  id: string;
  language: string | null;
  display_label: string;
};

/**
 * Full-screen language picker shown to learners when a course has more
 * than one active language package AND the learner has no saved
 * preference yet.
 *
 * On pick:
 *   1. PUT /api/courses/{courseId}/language-preference
 *   2. If 409 with requires_confirm: show the progress-reset warning
 *      with a "Switch and reset progress" button.
 *   3. On success: full-page nav to ?lang={code} so the SCORM/cmi5
 *      runtime re-mounts with the chosen package.
 *
 * Closes #158 Phase 2 + Phase 3 + Phase 4 (confirmation modal).
 */
export function LaunchLanguagePicker({
  orgSlug,
  courseId,
  courseTitle,
  packages,
}: {
  orgSlug: string;
  courseId: string;
  courseTitle: string;
  packages: LaunchPickerPackage[];
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<{
    language: string;
    label: string;
    in_progress_attempts: number;
    message: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(language: string, restart = false) {
    setError(null);
    setPicking(language);
    const res = await fetch(
      `/api/courses/${courseId}/language-preference`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          language,
          restart_if_in_progress: restart,
        }),
      }
    );
    if (res.status === 409 && !restart) {
      const j = (await res.json().catch(() => ({}))) as {
        requires_confirm?: boolean;
        in_progress_attempts?: number;
        message?: string;
      };
      if (j.requires_confirm) {
        setConfirmFor({
          language,
          label:
            packages.find((p) => p.language === language)?.display_label ??
            language,
          in_progress_attempts: j.in_progress_attempts ?? 0,
          message:
            j.message ??
            "Switching languages will reset your progress. Continue?",
        });
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
    window.location.href = `?lang=${encodeURIComponent(language)}`;
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
          You can change your language later from the course detail page.
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
            <p className="text-sm text-ink leading-relaxed">
              Changing the language will reset your current progress and start the
              course from the beginning in the new language.
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
