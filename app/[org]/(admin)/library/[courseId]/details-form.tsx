"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ThumbnailPicker } from "../../_components/thumbnail-picker";

export type CourseDetails = {
  title: string;
  description: string;
  duration_minutes: number | null;
  is_active: boolean;
  thumbnail_url: string | null;
  visibility: "private" | "org_public";
};

export function DetailsForm({
  orgSlug,
  courseId,
  initial,
}: {
  orgSlug: string;
  courseId: string;
  initial: CourseDetails;
}) {
  const router = useRouter();
  const [form, setForm] = useState<CourseDetails>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof CourseDetails>(key: K, value: CourseDetails[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/courses/${courseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        description: form.description,
        duration_minutes: form.duration_minutes,
        is_active: form.is_active,
        thumbnail_url: form.thumbnail_url,
        visibility: form.visibility,
      }),
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
    <form
      onSubmit={submit}
      className="border border-line rounded-2xl bg-paper p-6 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="serif text-2xl">Course details</h2>
        <ActiveToggle
          active={form.is_active}
          onChange={(v) => set("is_active", v)}
        />
      </div>

      <Field label="Title" required>
        <input
          type="text"
          required
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          className="field-input"
        />
      </Field>

      <Field label="Description">
        <textarea
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What learners will get out of this course."
          rows={3}
          className="field-input resize-none"
        />
      </Field>

      <Field label="Estimated duration (minutes)">
        <input
          type="number"
          min={0}
          value={form.duration_minutes ?? ""}
          onChange={(e) =>
            set(
              "duration_minutes",
              e.target.value === ""
                ? null
                : parseInt(e.target.value, 10) || 0
            )
          }
          placeholder="e.g. 45"
          className="field-input max-w-[160px]"
        />
      </Field>

      <Field label="Thumbnail">
        <ThumbnailPicker
          orgSlug={orgSlug}
          value={form.thumbnail_url}
          onChange={(url) => set("thumbnail_url", url)}
        />
      </Field>

      <VisibilityRadio
        value={form.visibility}
        onChange={(v) => set("visibility", v)}
        assetKind="course"
      />

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}
      {saved && (
        <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-lg p-3 text-sm">
          Saved.
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save details"}
        </button>
      </div>

      <style jsx>{`
        :global(.field-input) {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid var(--color-line);
          border-radius: 0.5rem;
          background: var(--color-canvas);
          outline: none;
          font-size: 0.875rem;
        }
        :global(.field-input:focus) {
          border-color: var(--color-ink);
        }
      `}</style>
    </form>
  );
}

function ActiveToggle({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium cursor-pointer transition-colors ${
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-line bg-canvas text-muted"
      }`}
    >
      <input
        type="checkbox"
        checked={active}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        className={`inline-block w-2 h-2 rounded-full ${
          active ? "bg-emerald-500" : "bg-muted"
        }`}
      />
      {active ? "Active" : "Inactive"}
    </label>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-muted mb-1.5">
        {label}
        {required && <span className="text-red-700 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * Visibility radio used by both the course Details form and the
 * learning-path Details form. Exported so the path form can reuse it.
 *
 * - private    → only specifically-assigned learners see this asset
 * - org_public → every member of the org sees it on their dashboard
 *                and can launch it directly. No assignment row required.
 */
export function VisibilityRadio({
  value,
  onChange,
  assetKind,
}: {
  value: "private" | "org_public";
  onChange: (next: "private" | "org_public") => void;
  assetKind: "course" | "learning path";
}) {
  return (
    <div className="block">
      <span className="block text-xs font-medium text-muted mb-1.5">
        Who can see this {assetKind}?
      </span>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <VisibilityOption
          selected={value === "private"}
          onClick={() => onChange("private")}
          title="Assigned only"
          description={`Only learners with an explicit assignment see this ${assetKind} on their dashboard.`}
        />
        <VisibilityOption
          selected={value === "org_public"}
          onClick={() => onChange("org_public")}
          title="Everyone in this org"
          description={`Every member of the workspace sees this ${assetKind} on their dashboard and can launch it directly.`}
        />
      </div>
    </div>
  );
}

function VisibilityOption({
  selected,
  onClick,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left border rounded-xl p-3 transition-colors ${
        selected
          ? "border-ink bg-canvas"
          : "border-line bg-paper hover:border-ink"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-3 h-3 rounded-full border-2 ${
            selected ? "border-ink bg-ink" : "border-line bg-paper"
          }`}
        />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="text-xs text-muted mt-1.5 leading-relaxed">
        {description}
      </div>
    </button>
  );
}
