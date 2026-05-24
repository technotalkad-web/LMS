"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export type ReminderSettings = {
  enabled: boolean;
  cadence_days: number; // 1-30 (DB constraint from migration 0028)
  cap_days: number;     // 1-365
};

// Preset cadences for the dropdown. Any other 1-30 value is supported via
// the "Custom..." option that reveals a number input.
const CADENCE_PRESETS = [
  { value: 1, label: "Daily (every 24h)" },
  { value: 2, label: "Every 2 days" },
  { value: 3, label: "Every 3 days" },
  { value: 7, label: "Weekly" },
  { value: 14, label: "Every 2 weeks" },
  { value: 30, label: "Monthly" },
] as const;

// Preset caps. "Custom..." reveals a number input (1-365 days).
const CAP_PRESETS = [
  { value: 7, label: "1 week" },
  { value: 14, label: "2 weeks" },
  { value: 30, label: "1 month" },
  { value: 60, label: "2 months" },
  { value: 90, label: "3 months" },
  { value: 180, label: "6 months" },
  { value: 365, label: "1 year" },
] as const;

export function ReminderSection({
  courseId,
  initial,
}: {
  courseId: string;
  initial: ReminderSettings;
}) {
  const router = useRouter();
  const [form, setForm] = useState<ReminderSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect "custom" mode purely from the value — if the current cadence
  // isn't one of the presets, fall into Custom automatically.
  const cadenceIsPreset = useMemo(
    () => CADENCE_PRESETS.some((p) => p.value === form.cadence_days),
    [form.cadence_days]
  );
  const capIsPreset = useMemo(
    () => CAP_PRESETS.some((p) => p.value === form.cap_days),
    [form.cap_days]
  );

  function setCadence(n: number) {
    // Clamp to migration 0028's CHECK range (1-30).
    const clamped = Math.max(1, Math.min(30, Math.round(n)));
    setForm({ ...form, cadence_days: clamped });
    setSaved(false);
  }
  function setCap(n: number) {
    // Clamp to migration 0014's CHECK range (1-365).
    const clamped = Math.max(1, Math.min(365, Math.round(n)));
    setForm({ ...form, cap_days: clamped });
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/courses/${courseId}/reminders`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(j.error ?? "Save failed");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <section className="border border-line rounded-lg bg-paper p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="serif text-2xl">Reminders</h2>
        <span className="text-xs text-muted">
          Nudge learners who haven&apos;t completed yet.
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => {
              setForm({ ...form, enabled: e.target.checked });
              setSaved(false);
            }}
          />
          <span>Send automated reminders</span>
        </label>

        {/* Cadence: preset + custom */}
        <div>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">
            Cadence
          </div>
          <div className="flex items-center gap-2">
            <select
              value={cadenceIsPreset ? form.cadence_days : "custom"}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  // Seed a sensible custom default if the user is currently
                  // on a preset — pick the closest non-preset (5 days).
                  if (cadenceIsPreset) setCadence(5);
                } else {
                  setCadence(parseInt(e.target.value, 10));
                }
              }}
              disabled={!form.enabled}
              className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm disabled:opacity-50"
            >
              {CADENCE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
            {!cadenceIsPreset && (
              <>
                <span className="text-sm text-muted">every</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={form.cadence_days}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!Number.isNaN(n)) setCadence(n);
                  }}
                  disabled={!form.enabled}
                  className="w-20 px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm disabled:opacity-50 tabular-nums"
                />
                <span className="text-sm text-muted">days</span>
              </>
            )}
          </div>
        </div>

        {/* Stop after: preset + custom */}
        <div>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">
            Stop after
          </div>
          <div className="flex items-center gap-2">
            <select
              value={capIsPreset ? form.cap_days : "custom"}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  if (capIsPreset) setCap(45);
                } else {
                  setCap(parseInt(e.target.value, 10));
                }
              }}
              disabled={!form.enabled}
              className="px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm disabled:opacity-50"
            >
              {CAP_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
            {!capIsPreset && (
              <>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.cap_days}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!Number.isNaN(n)) setCap(n);
                  }}
                  disabled={!form.enabled}
                  className="w-24 px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm disabled:opacity-50 tabular-nums"
                />
                <span className="text-sm text-muted">days</span>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="ml-auto px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save reminders"}
        </button>
      </div>

      <p className="text-xs text-muted mt-3">
        Reminders stop automatically when a learner completes the course or
        when the cap is reached, whichever is first.
        {form.enabled && (
          <>
            {" "}
            With the current settings, a learner will receive up to{" "}
            <span className="text-ink font-medium">
              {Math.floor(form.cap_days / form.cadence_days)}
            </span>{" "}
            reminder{Math.floor(form.cap_days / form.cadence_days) === 1 ? "" : "s"}.
          </>
        )}
      </p>

      {error && (
        <div className="mt-3 border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-3 border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-lg p-3 text-sm">
          Saved.
        </div>
      )}
    </section>
  );
}
