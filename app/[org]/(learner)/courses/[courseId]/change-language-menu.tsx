"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, ChevronDown, Check } from "lucide-react";
import { languageDisplay } from "@/lib/i18n/languages";

export type ChangeLanguageOption = {
  id: string;
  language: string | null;
  display_label: string;
};

/**
 * Compact "Change language" dropdown on the learner course detail
 * page (#158 Phase 3). Reuses the PUT /api/courses/:courseId/language-preference
 * endpoint and the same 409 + requires_confirm dance as the
 * full-screen LaunchLanguagePicker.
 *
 * Renders nothing unless there are 2+ options.
 */
export function ChangeLanguageMenu({
  orgSlug,
  courseId,
  options,
  currentLanguage,
}: {
  orgSlug: string;
  courseId: string;
  options: ChangeLanguageOption[];
  currentLanguage: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The learner has an existing language; switching always prompts a
  // confirmation first (per spec) — picking a new language opens this.
  const [confirmFor, setConfirmFor] = useState<{
    language: string;
    label: string;
  } | null>(null);

  if (options.length < 2) return null;

  const currentOption =
    options.find((o) => o.language === currentLanguage) ?? null;

  // Switching away from the current language always resets progress, so it
  // requires explicit confirmation before any change is made.
  function requestSwitch(language: string) {
    setError(null);
    setOpen(false);
    setConfirmFor({
      language,
      label: options.find((o) => o.language === language)?.display_label ?? language,
    });
  }

  async function confirmSwitch(language: string) {
    setConfirmFor(null);
    setError(null);
    setPicking(language);
    const res = await fetch(`/api/courses/${courseId}/language-preference`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        language,
        // Confirmed by the learner — reset any in-progress attempt and start
        // fresh in the new language.
        restart_if_in_progress: true,
      }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${res.status}`);
      setPicking(null);
      return;
    }
    setPicking(null);
    router.refresh();
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink px-3 py-1.5 border border-line rounded-lg bg-paper"
      >
        <Globe className="w-3.5 h-3.5" />
        {currentOption?.display_label ?? "Choose language"}
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 min-w-[220px] bg-paper border border-line rounded-xl shadow-lg z-30 py-1">
          {options.map((o) => {
            const isCurrent = o.language === currentLanguage;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => o.language && requestSwitch(o.language)}
                disabled={picking !== null || isCurrent}
                className="w-full text-left flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-canvas/60 disabled:opacity-50"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{o.display_label}</div>
                  <div className="text-[11px] text-muted">
                    {languageDisplay(o.language, "english")}
                    {o.language ? ` · ${o.language}` : ""}
                  </div>
                </div>
                {isCurrent && (
                  <Check className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="absolute right-0 top-full mt-1 border border-red-200 bg-red-50 text-red-900 rounded-xl px-3 py-1.5 text-xs z-30">
          {error}
        </div>
      )}

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
                onClick={() => confirmSwitch(confirmFor.language)}
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
