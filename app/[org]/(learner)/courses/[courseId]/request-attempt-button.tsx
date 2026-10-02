"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Loader2 } from "lucide-react";

/**
 * "Request another attempt" on the learner course page (revision rule, Phase 2).
 * Opens a small modal for the learner's reason and POSTs to /api/attempt-requests.
 * The server enforces one open request per learner+course; a 409 is surfaced as
 * a friendly message. On success the page refreshes to the "under review" state.
 */
export function RequestAttemptButton({
  orgSlug,
  courseId,
}: {
  orgSlug: string;
  courseId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setError("Please add a short reason (a few words is fine).");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/attempt-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, courseId, reason: trimmed }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    setOpen(false);
    setReason("");
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 text-sm px-4 py-2 border border-line rounded-xl bg-paper hover:border-ink text-ink font-medium transition"
      >
        <RotateCcw className="w-4 h-4" />
        Request another attempt
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="bg-paper border border-line rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="serif text-2xl">Request another attempt</h3>
            <p className="text-sm text-muted leading-relaxed">
              Tell your administrator why you&apos;d like another official attempt.
              If approved, relaunching the course will start a fresh attempt that
              becomes your new official result — your first result stays on record.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              autoFocus
              maxLength={2000}
              placeholder="e.g. I misread the final question and would like to retake the assessment."
              className="w-full px-3 py-2 border border-line rounded-xl bg-canvas text-sm outline-none focus:border-ink focus:ring-2 focus:ring-ink/10"
            />
            {error && <p className="text-xs text-red-700">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                disabled={busy}
                className="px-4 py-2 border border-line rounded-lg text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Send request
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
