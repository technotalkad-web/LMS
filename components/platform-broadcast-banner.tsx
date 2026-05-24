"use client";

import { useEffect, useState } from "react";
import { Megaphone, X, AlertTriangle, CheckCircle2, Info } from "lucide-react";

type Broadcast = {
  id: string;
  title: string;
  body_md: string;
  tone: "info" | "warning" | "critical" | "success";
  dismissable: boolean;
  posted_at: string;
  expires_at: string | null;
};

const TONE_STYLES: Record<Broadcast["tone"], { wrap: string; Icon: typeof Info }> = {
  info: { wrap: "bg-indigo-50 text-indigo-900 border-indigo-200", Icon: Info },
  warning: { wrap: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertTriangle },
  critical: { wrap: "bg-red-50 text-red-900 border-red-200", Icon: AlertTriangle },
  success: { wrap: "bg-emerald-50 text-emerald-900 border-emerald-200", Icon: CheckCircle2 },
};

/**
 * Reads /api/broadcasts on mount and renders any visible broadcasts as
 * a stack of dismissable bars. Once dismissed, server persists it via
 * /api/broadcasts/dismiss so it doesn't reappear on next page load.
 */
export function PlatformBroadcastBanner() {
  const [bs, setBs] = useState<Broadcast[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/broadcasts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { broadcasts: Broadcast[] }) => {
        if (alive) {
          setBs(j.broadcasts ?? []);
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  async function dismiss(id: string) {
    setBs((prev) => prev.filter((b) => b.id !== id));
    try {
      await fetch("/api/broadcasts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ broadcast_id: id }),
      });
    } catch {
      /* if the server fails the banner will reappear on next load; fine */
    }
  }

  if (!loaded || bs.length === 0) return null;

  return (
    <div className="flex flex-col">
      {bs.map((b) => {
        const { wrap, Icon } = TONE_STYLES[b.tone];
        return (
          <div
            key={b.id}
            className={`${wrap} border-b px-4 py-2.5 flex items-start gap-3 text-sm`}
          >
            <Icon className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold inline mr-2">{b.title}</p>
              <span className="opacity-80">{b.body_md}</span>
            </div>
            {b.dismissable && (
              <button
                onClick={() => dismiss(b.id)}
                aria-label="Dismiss"
                className="shrink-0 p-1 hover:bg-black/5 rounded transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Re-export the icon for any consumer that wants to match the "broadcast"
// vocabulary in their own UI.
export { Megaphone };
