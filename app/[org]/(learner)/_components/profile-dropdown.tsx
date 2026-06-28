"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  User,
  Settings,
  LogOut,
  Moon,
  Sun,
} from "lucide-react";

type Theme = "light" | "dark";

export function ProfileDropdown({
  orgSlug,
  email,
  roleLabel,
  canSwitchToAdmin,
  brandColor = "#4f46e5",
}: {
  orgSlug: string;
  email: string;
  roleLabel: string;
  canSwitchToAdmin: boolean;
  brandColor?: string;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const current =
      (document.documentElement.dataset.theme as Theme | undefined) ?? "light";
    setTheme(current);
  }, []);

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

  async function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: next }),
    });
  }

  const initial = email?.[0]?.toUpperCase() ?? "?";
  const name = email?.split("@")[0] ?? "you";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 p-1 pr-2 rounded-full hover:bg-canvas border border-transparent hover:border-line transition"
      >
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white text-sm font-medium ring-2 ring-paper"
          style={{ background: brandColor }}
        >
          {initial}
        </span>
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
            <div className="text-sm font-medium truncate">{email}</div>
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

          {/* Theme */}
          <button
            type="button"
            onClick={toggleTheme}
            role="menuitem"
            className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-canvas border-t border-line"
          >
            <span className="flex items-center gap-3">
              {theme === "dark" ? (
                <Sun className="w-4 h-4 text-muted" />
              ) : (
                <Moon className="w-4 h-4 text-muted" />
              )}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted">
              {theme}
            </span>
          </button>

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
