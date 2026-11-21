"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * One organisation's daily email limit on /super/email (ADR 0029 step 17;
 * rule FP4): POST /api/super/email/limit with the organisation's id and the
 * number, or with `use_default` from its own button to go back to the
 * default. The route checks the caller and writes the audit row; this form
 * only sends the values.
 *
 * The box is text, not a number field: a number field hides what was typed
 * when the browser cannot read it, so an unreadable box could be sent as
 * "empty". Here the form reads the text itself, and an empty or unreadable
 * box is refused with a sentence; it is never sent as the default.
 */

/** The largest limit the route and migration 0114 accept. */
export const DAILY_LIMIT_MAX = 100_000;

const LIMIT_RULE = "Type a whole number from 1 to 100,000, or choose Use the default.";

/**
 * The box's text as the route takes it: a whole number from 1 to 100,000,
 * written plainly or in groups of three after a comma or a space ("1,500",
 * "1 500"). Anything else, an empty box included, is refused with a
 * sentence and nothing is sent.
 */
export function parseDailyLimitText(text: string): { ok: true; value: number } | { ok: false; message: string } {
  const typed = text.trim();
  if (!/^\d+$/.test(typed) && !/^\d{1,3}([, ]\d{3})+$/.test(typed)) return { ok: false, message: LIMIT_RULE };
  const value = Number(typed.replace(/[, ]/g, ""));
  if (!Number.isInteger(value) || value < 1 || value > DAILY_LIMIT_MAX) return { ok: false, message: LIMIT_RULE };
  return { ok: true, value };
}

export function DailyLimitForm({ organizationId, storedLimit, defaultLimit }: { organizationId: string; storedLimit: number | null; defaultLimit: number }) {
  const router = useRouter();
  const [value, setValue] = useState(storedLimit === null ? "" : String(storedLimit));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function post(body: { daily_limit: number } | { use_default: true }, saved: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/super/email/limit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, ...body }),
      });
      const answer = (await res.json().catch(() => ({}))) as { error?: string; audited?: boolean };
      if (!res.ok) {
        setMessage(answer.error ?? `Not saved (HTTP ${res.status}).`);
      } else {
        setMessage(answer.audited === false ? `${saved} The audit row could not be written.` : saved);
        router.refresh();
      }
    } catch {
      setMessage("Not saved: the request failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const parsed = parseDailyLimitText(value);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    void post({ daily_limit: parsed.value }, "Saved.");
  }

  function resetToDefault() {
    setValue("");
    void post({ use_default: true }, `Saved: the default (${defaultLimit}) applies.`);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
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
        <button
          type="button"
          onClick={resetToDefault}
          disabled={busy || storedLimit === null}
          className="px-3 py-1 rounded-md border border-line text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50"
        >
          Use the default
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
