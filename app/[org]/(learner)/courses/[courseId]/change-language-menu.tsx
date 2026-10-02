"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Globe, ChevronDown, Check } from "lucide-react";
import { languageDisplay } from "@/lib/i18n/languages";

/** Fixed-position coordinates for the portaled options menu. */
type MenuCoords = {
  left: number;
  width: number;
  maxHeight: number;
  /** Set when opening downward (menu top anchored below the trigger). */
  top?: number;
  /** Set when opening upward (menu bottom anchored above the trigger). */
  bottom?: number;
};

// Layout constants for the viewport-aware placement.
const GAP = 4; // breathing room between trigger and menu (was `mt-1`)
const EDGE = 8; // keep the menu this far from the viewport edges
const HEADER_SAFE = 64; // clear the sticky learner header when opening upward
const NAV_SAFE = 76; // clear the fixed mobile bottom nav when opening downward
const MOBILE_BP = 768; // Tailwind `md` — below this the bottom nav is shown

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
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The learner has an existing language; switching always prompts a
  // confirmation first (per spec) — picking a new language opens this.
  const [confirmFor, setConfirmFor] = useState<{
    language: string;
    label: string;
  } | null>(null);

  // Measure the trigger and decide whether the menu opens up or down, how tall
  // it may be, and where its right edge aligns — all in viewport (fixed)
  // coordinates so the portaled menu is never clipped by the course card's
  // overflow/stacking context or hidden behind the fixed mobile bottom nav.
  const computeCoords = useCallback((): MenuCoords | null => {
    const el = triggerRef.current;
    if (!el || typeof window === "undefined") return null;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < MOBILE_BP;
    const bottomInset = isMobile ? NAV_SAFE : EDGE;
    const spaceBelow = vh - r.bottom - GAP - bottomInset;
    const spaceAbove = r.top - GAP - HEADER_SAFE;
    const placeDown = spaceBelow >= spaceAbove;
    const maxHeight = Math.min(360, Math.max(96, placeDown ? spaceBelow : spaceAbove));
    const width = Math.min(260, vw - EDGE * 2);
    // Align the menu's right edge to the trigger's, then clamp inside the viewport.
    const left = Math.min(Math.max(r.right - width, EDGE), vw - width - EDGE);
    return placeDown
      ? { left, width, maxHeight, top: r.bottom + GAP }
      : { left, width, maxHeight, bottom: vh - (r.top - GAP) };
  }, []);

  function toggleOpen() {
    setError(null);
    if (open) {
      setOpen(false);
      return;
    }
    setCoords(computeCoords());
    setOpen(true);
  }

  // Keep the menu glued to the trigger while open: reposition on scroll/resize,
  // and close on Escape. Closes if the trigger scrolls out of the measurement.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const c = computeCoords();
      if (c) setCoords(c);
      else setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, computeCoords]);

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
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink px-3 py-1.5 border border-line rounded-lg bg-paper"
      >
        <Globe className="w-3.5 h-3.5" />
        {currentOption?.display_label ?? "Choose language"}
        <ChevronDown className="w-3 h-3" />
      </button>

      {/* The menu is portaled to <body> and positioned in fixed/viewport
          coordinates so it escapes the course card's overflow + stacking
          context and clears the fixed mobile bottom nav (z-40). It flips above
          the trigger when there's more room there, and scrolls internally if
          the options can't all fit, so none are ever hidden. */}
      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Click-away catcher (above the nav, below the menu). */}
            <div
              className="fixed inset-0 z-[55]"
              aria-hidden="true"
              onClick={() => setOpen(false)}
            />
            <div
              role="menu"
              className="fixed z-[60] bg-paper border border-line rounded-xl shadow-lg py-1 overflow-y-auto overscroll-contain"
              style={{
                left: coords.left,
                width: coords.width,
                maxHeight: coords.maxHeight,
                ...(coords.top !== undefined
                  ? { top: coords.top }
                  : { bottom: coords.bottom }),
              }}
            >
              {options.map((o) => {
                const isCurrent = o.language === currentLanguage;
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="menuitem"
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
          </>,
          document.body
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
