"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * One organisation's daily email limit on /super/email (ADR 0029 step 17;
 * rule FP4): POST /api/super/email/limit with the organisation's id and the
 * number, or an empty field for the default. The route checks the caller
 * and writes the audit row; this form only sends the two values.
 */
export function DailyLimitForm({ organizationId, storedLimit, defaultLimit }: { organizationId: string; storedLimit: number | null; defaultLimit: number }) {
  const router = useRouter();
  const [value, setValue] = useState(storedLimit === null ? "" : String(storedLimit));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    const typed = value.trim();
    const dailyLimit = typed === "" ? null : Number(typed);
    if (dailyLimit !== null && !(Number.isInteger(dailyLimit) && dailyLimit >= 1 && dailyLimit <= 100_000)) {
      setMessage("A whole number from 1 to 100,000, or empty for the default.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/super/email/limit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, daily_limit: dailyLimit }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; audited?: boolean };
      if (!res.ok) {
        setMessage(body.error ?? `Not saved (HTTP ${res.status}).`);
      } else {
        setMessage(body.audited === false ? "Saved. The audit row could not be written." : "Saved.");
        router.refresh();
      }
    } catch {
      setMessage("Not saved: the request failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={100000}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`default ${defaultLimit}`}
          aria-label="Daily email limit"
          className="w-28 border border-line rounded-md px-2 py-1 text-sm bg-paper"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="px-3 py-1 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {message && (
        <p role="status" className="text-xs text-ink">
          {message}
        </p>
      )}
    </div>
  );
}
