"use client";

import { useEffect, useState } from "react";
import { Megaphone, X } from "lucide-react";

export type Announcement = {
  id: string;
  title: string;
  body: string | null;
  tone: "info" | "success" | "warning" | "critical";
};

export function AnnouncementsBanner({
  announcements,
  orgSlug,
}: {
  announcements: Announcement[];
  orgSlug: string;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`ann-dismissed:${orgSlug}`);
      if (raw) setDismissed(new Set(JSON.parse(raw) as string[]));
    } catch {
      // ignore
    }
  }, [orgSlug]);

  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    try {
      localStorage.setItem(
        `ann-dismissed:${orgSlug}`,
        JSON.stringify(Array.from(next))
      );
    } catch {
      // ignore
    }
  }

  const visible = announcements.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  // Show only the most recent active announcement as the slim banner.
  // Older ones still show as full cards below, so admins don't lose them.
  const [top, ...rest] = visible;
  const topTone = toneClasses(top.tone);

  return (
    <div className="space-y-2">
      {/* Slim top strip — full-bleed edge-to-edge across the page, matching
          the reference. Negative margins escape the page padding; we still
          center the inner content. */}
      <div
        className={`-mx-4 sm:-mx-6 lg:-mx-8 -mt-6 sm:-mt-8 mb-6 ${topTone.bar}`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center gap-3">
          <Megaphone className="w-4 h-4 shrink-0" />
          <div className="flex-1 min-w-0 text-sm">
            <span className="font-semibold">{top.title}</span>
            {top.body && (
              <span className="opacity-90 ml-2 truncate">— {top.body}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismiss(top.id)}
            aria-label="Dismiss"
            className="shrink-0 opacity-80 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Any additional unread announcements render as in-flow cards */}
      {rest.map((a) => {
        const tone = toneClasses(a.tone);
        return (
          <div
            key={a.id}
            className={`relative border rounded-xl px-4 py-3 ${tone.card}`}
          >
            <button
              type="button"
              onClick={() => dismiss(a.id)}
              className="absolute top-2 right-2 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="font-medium pr-6 text-sm">{a.title}</div>
            {a.body && <div className="text-xs opacity-90 mt-1">{a.body}</div>}
          </div>
        );
      })}
    </div>
  );
}

function toneClasses(tone: Announcement["tone"]): {
  bar: string;
  card: string;
} {
  switch (tone) {
    case "success":
      return {
        bar: "bg-emerald-600 text-white",
        card: "border-emerald-200 bg-emerald-50 text-emerald-900",
      };
    case "warning":
      return {
        bar: "bg-amber-500 text-white",
        card: "border-amber-200 bg-amber-50 text-amber-900",
      };
    case "critical":
      return {
        bar: "bg-red-600 text-white",
        card: "border-red-200 bg-red-50 text-red-900",
      };
    default:
      return {
        bar: "bg-indigo-600 text-white",
        card: "border-indigo-200 bg-indigo-50 text-indigo-900",
      };
  }
}
