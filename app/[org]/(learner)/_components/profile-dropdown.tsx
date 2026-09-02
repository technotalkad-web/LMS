"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  User,
  Settings,
  LogOut,
  Palette,
} from "lucide-react";
import {
  LEARNER_THEMES,
  type LearnerThemeId,
} from "@/lib/theme/learner-themes";

export function ProfileDropdown({
  orgSlug,
  email,
  displayName,
  avatarUrl,
  roleLabel,
  canSwitchToAdmin,
  brandColor = "#4f46e5",
  lmsTheme = null,
}: {
  orgSlug: string;
  email: string;
  /** "First Last" when the profile has a name, else the email. */
  displayName?: string;
  avatarUrl?: string | null;
  roleLabel: string;
  canSwitchToAdmin: boolean;
  brandColor?: string;
  /** Active learner-view theme (null = never chosen → default look). */
  lmsTheme?: LearnerThemeId | null;
}) {
  const [open, setOpen] = useState(false);
  const [activeTheme, setActiveTheme] = useState<LearnerThemeId>(
    lmsTheme ?? "classic"
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function pickTheme(id: LearnerThemeId) {
    // Instant apply on the learner shell, then persist the cookie so the
    // next SSR render paints the theme before hydration.
    document
      .querySelector("[data-lms-root]")
      ?.setAttribute("data-lms-theme", id);
    setActiveTheme(id);
    await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lms: id }),
    });
  }

  const name = displayName || email?.split("@")[0] || "you";
  const initial = name.trim()[0]?.toUpperCase() ?? "?";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 p-1 pr-2 rounded-full hover:bg-canvas border border-transparent hover:border-line transition"
      >
        {avatarUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={avatarUrl}
            alt=""
            className="h-8 w-8 rounded-full object-cover object-center bg-canvas ring-2 ring-paper"
          />
        ) : (
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white text-sm font-medium ring-2 ring-paper"
            style={{ background: brandColor }}
          >
            {initial}
          </span>
        )}
        <div className="hidden md:block text-left leading-tight">
          <div className="text-sm font-medium truncate max-w-[140px]">{name}</div>
          <div className="text-[11px] text-muted">{roleLabel}</div>
        </div>
        <ChevronDown
          className={`hidden md:block w-4 h-4 text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-64 border border-line rounded-xl bg-paper shadow-lg overflow-hidden z-50"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-line">
            <div className="text-sm font-medium truncate">{name}</div>
            {name !== email && (
              <div className="text-xs text-muted truncate">{email}</div>
            )}
            <div className="text-xs text-muted">{roleLabel}</div>
          </div>

          {/* Profile */}
          <Link
            href={`/${orgSlug}/profile`}
            onClick={() => setOpen(false)}
            role="menuitem"
            className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-canvas"
          >
            <User className="w-4 h-4 text-muted" />
            My profile
          </Link>

          {/* Switch to admin */}
          {canSwitchToAdmin && (
            <Link
              href={`/${orgSlug}/users`}
              onClick={() => setOpen(false)}
              role="menuitem"
              className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-canvas border-t border-line"
            >
              <Settings className="w-4 h-4 text-muted" />
              <span>
                <span className="block font-medium">Switch to Admin View</span>
                <span className="block text-xs text-muted">Manage workspace</span>
              </span>
            </Link>
          )}

          {/* Learner-view theme picker */}
          <div className="border-t border-line px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted mb-2">
              <Palette className="w-3.5 h-3.5" />
              Theme
            </div>
            <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Theme">
              {LEARNER_THEMES.map((t) => {
                const active = t.id === activeTheme;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => pickTheme(t.id)}
                    title={t.tagline}
                    aria-pressed={active}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-[11px] leading-none transition ${
                      active
                        ? "border-accent ring-1 ring-accent bg-canvas font-medium"
                        : "border-line hover:bg-canvas"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="h-5 w-5 rounded-full border border-line"
                      style={{
                        background: `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)`,
                      }}
                    />
                    <span>
                      {t.emoji} {t.name}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-muted">
              {LEARNER_THEMES.find((t) => t.id === activeTheme)?.tagline}
            </p>
          </div>

          {/* Sign out */}
          <form
            action="/auth/sign-out"
            method="post"
            className="border-t border-line"
          >
            <input type="hidden" name="org" value={orgSlug} />
            <button
              type="submit"
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
