"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, X } from "lucide-react";

/**
 * Renders the orange "You are impersonating {tenant}" bar at the top
 * of every learner/admin page. Server components decide whether to
 * mount this (via getImpersonation()); the client component only owns
 * the "End impersonation" button.
 */
export function ImpersonationBanner({
  orgName,
  expiresAt,
}: {
  orgName: string;
  expiresAt: string;
}) {
  const router = useRouter();
  const [ending, setEnding] = useState(false);
  const exp = new Date(expiresAt);
  const minsLeft = Math.max(0, Math.round((exp.getTime() - Date.now()) / 60000));

  async function endNow() {
    setEnding(true);
    try {
      await fetch("/api/super/impersonate", { method: "DELETE" });
    } catch {
      // swallow — we still redirect either way so the cookie is at
      // worst a stale (server-revoked) reference.
    }
    router.push("/super/organizations");
    router.refresh();
  }

  return (
    <div className="w-full bg-amber-500 text-amber-950 px-4 py-2 flex items-center gap-3 text-sm font-semibold shadow-sm z-50">
      <ShieldAlert className="w-4 h-4 shrink-0" />
      <span className="flex-1 truncate">
        Impersonating <span className="font-bold">{orgName}</span>
        <span className="font-normal text-amber-900/80 ml-2">
          · Session ends in {minsLeft} min
        </span>
      </span>
      <button
        onClick={endNow}
        disabled={ending}
        className="bg-amber-900 hover:bg-amber-950 text-amber-50 px-3 py-1 rounded-md text-xs flex items-center gap-1 transition disabled:opacity-60"
      >
        <X className="w-3 h-3" />
        {ending ? "Ending…" : "Exit impersonation"}
      </button>
    </div>
  );
}
