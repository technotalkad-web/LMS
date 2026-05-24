"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type EditablePersonal = {
  first_name: string;
  last_name: string;
  username: string;
  gender: "" | "male" | "female" | "other" | "prefer_not_to_say";
  date_of_birth: string;
  phone: string;
};

export function ProfileForm({
  orgSlug,
  initial,
  email,
}: {
  orgSlug: string;
  initial: EditablePersonal;
  email: string;
}) {
  void orgSlug;
  const router = useRouter();
  const [form, setForm] = useState<EditablePersonal>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof EditablePersonal>(
    key: K,
    value: EditablePersonal[K]
  ) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/profile", {
      method: "PATCH",
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
    <form
      onSubmit={submit}
      className="bg-paper border border-line rounded-2xl overflow-hidden shadow-sm"
    >
      <header className="px-6 py-4 border-b border-line bg-canvas/40">
        <h2 className="font-semibold">Personal details</h2>
        <p className="text-xs text-muted mt-0.5">
          You can edit these fields yourself.
        </p>
      </header>

      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="First name" required>
          <input
            type="text"
            required
            value={form.first_name}
            onChange={(e) => set("first_name", e.target.value)}
            className="field-input"
          />
        </Field>
        <Field label="Last name">
          <input
            type="text"
            value={form.last_name}
            onChange={(e) => set("last_name", e.target.value)}
            className="field-input"
          />
        </Field>

        <Field label="Email (read-only)">
          <input
            type="email"
            readOnly
            value={email}
            className="field-input bg-canvas/60 text-muted cursor-not-allowed"
          />
        </Field>
        <Field label="Username">
          <input
            type="text"
            value={form.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="Defaults to your email"
            className="field-input"
          />
        </Field>

        <Field label="Phone">
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            placeholder="+1 555 123 4567"
            className="field-input"
          />
        </Field>
        <Field label="Gender">
          <select
            value={form.gender}
            onChange={(e) =>
              set("gender", e.target.value as EditablePersonal["gender"])
            }
            className="field-input"
          >
            <option value="">—</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
            <option value="prefer_not_to_say">Prefer not to say</option>
          </select>
        </Field>

        <Field label="Date of birth">
          <input
            type="date"
            value={form.date_of_birth}
            onChange={(e) => set("date_of_birth", e.target.value)}
            className="field-input"
          />
        </Field>
      </div>

      <div className="px-6 py-4 bg-canvas/40 border-t border-line flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="text-sm">
          {error && (
            <span className="text-red-700">
              <strong>Couldn&apos;t save.</strong> {error}
            </span>
          )}
          {saved && (
            <span className="text-emerald-700">
              <strong>Saved.</strong> Your profile is up to date.
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex justify-center px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold transition shadow-sm disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>

      <style jsx>{`
        :global(.field-input) {
          width: 100%;
          padding: 0.625rem 0.75rem;
          border: 1px solid var(--color-line);
          border-radius: 0.5rem;
          background: var(--color-canvas);
          outline: none;
          font-size: 0.875rem;
          transition: border-color 150ms, box-shadow 150ms;
        }
        :global(.field-input:focus) {
          border-color: rgb(79 70 229);
          box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15);
        }
      `}</style>
    </form>
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
