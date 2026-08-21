"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";

/** "Show me on leaderboards" — routed through the set_gamification_opt_out RPC. */
export function LeaderboardPrivacyToggle({
  orgSlug,
  optedOut,
  allowOptOut,
}: {
  orgSlug: string;
  optedOut: boolean;
  allowOptOut: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [visible, setVisible] = useState(!optedOut);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !visible;
    setVisible(next); // optimistic
    setBusy(true);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, leaderboard_opt_out: !next }),
    });
    setBusy(false);
    if (!res.ok) {
      setVisible(!next); // revert
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(j.error ?? "Could not update visibility");
      return;
    }
    toast.success(next ? "You're visible on leaderboards" : "You're hidden from leaderboards");
    router.refresh();
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-medium">Show me on leaderboards</div>
        <p className="text-xs text-muted mt-0.5 leading-relaxed">
          When off, your name and photo are hidden from all leaderboards and
          celebrations. You can still see your own rank.
        </p>
        {!allowOptOut && (
          <p className="text-[11px] text-muted mt-1">
            Visibility is managed by your administrator.
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={visible}
        disabled={busy || !allowOptOut}
        onClick={toggle}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
          visible ? "bg-indigo-600" : "bg-line"
        } ${!allowOptOut ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            visible ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
