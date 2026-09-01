"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { OPTIONAL_FIELDS, type GovernedField } from "@/lib/org/field-options";

export type ManagerOption = { user_id: string; email: string };
export type LmsRole = "user" | "data_analyst" | "admin" | "super_owner";

export type UserDetail = {
  user_id: string;
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  gender: "" | "male" | "female" | "other" | "prefer_not_to_say";
  date_of_birth: string;
  phone: string;
  employee_id: string;
  status: "active" | "inactive" | "suspended";
  date_of_joining: string;
  grade: string;
  designation: string;
  job_role: string;
  line_manager_id: string;
  indirect_manager_id: string;
  lms_role: LmsRole;
  node_id: string;
  city: string;
  state: string;
  business_vertical: string;
  branch: string;
};

export function EditUserForm({
  orgSlug,
  userId,
  initial,
  managers,
  canAssignSuperOwner,
  fieldOptions = {},
  requireManagers = false,
}: {
  orgSlug: string;
  userId: string;
  initial: UserDetail;
  managers: ManagerOption[];
  canAssignSuperOwner: boolean;
  /** Master-data lists (migration 0055): field → allowed values. A field
   *  with values here is mandatory and renders as a restricted dropdown. */
  fieldOptions?: Record<string, string[]>;
  /** Line Manager (L1) + Indirect Line Manager (L2) mandatory? */
  requireManagers?: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<UserDetail>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof UserDetail>(key: K, value: UserDetail[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  // Governed Organization-details field (migration 0055): a restricted,
  // required dropdown when master values exist; the legacy free-text input
  // otherwise. A legacy value that's no longer in the master list renders
  // the select empty, so the admin must pick a valid value to save.
  const governed = (
    label: string,
    key: Extract<GovernedField, keyof UserDetail>,
    extra?: { mono?: boolean }
  ) => {
    const opts = fieldOptions[key] ?? [];
    const optional = OPTIONAL_FIELDS.has(key);
    const enforced = opts.length > 0 && !optional;
    // Optional fields keep showing a stored value that's no longer in the
    // master list (labeled) instead of a misleading "—"; unchanged values
    // are omitted from the PATCH, so it's preserved unless deliberately
    // changed. Mandatory fields render empty + required, forcing a pick.
    const stale = optional && !!form[key] && !opts.includes(form[key]);
    return (
      <Field label={label} required={enforced || key === "node_id"}>
        {opts.length > 0 ? (
          <select
            required={enforced}
            value={stale || opts.includes(form[key]) ? form[key] : ""}
            onChange={(e) => set(key, e.target.value)}
            className="input"
          >
            <option value="">{optional ? "—" : "Select…"}</option>
            {stale && (
              <option value={form[key]}>
                {form[key]} (no longer in master list)
              </option>
            )}
            {opts.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            required={key === "node_id"}
            value={form[key]}
            onChange={(e) => set(key, e.target.value)}
            className={`input${extra?.mono ? " font-mono" : ""}`}
          />
        )}
      </Field>
    );
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { user_id: _u, email: _e, ...payload } = form;
    void _u;
    void _e;
    // Optional governed fields: only send what the admin actually changed.
    // A stored value that was later removed from the master list would
    // otherwise be re-submitted untouched and rejected ("not specified in
    // the system database") on an unrelated edit — and must never be
    // silently cleared either. Unchanged → omitted → preserved.
    for (const k of OPTIONAL_FIELDS) {
      if (payload[k] === initial[k]) {
        delete (payload as Record<string, unknown>)[k];
      }
    }
    const res = await fetch(
      `/api/users/${userId}?orgSlug=${encodeURIComponent(orgSlug)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
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
    <form onSubmit={submit} className="space-y-8">
      {/* PERSONAL ------------------------------------------------------- */}
      <section className="border border-line rounded-lg bg-paper p-6">
        <h2 className="serif text-2xl mb-4">Personal details</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name" required>
            <input
              type="text"
              required
              value={form.first_name}
              onChange={(e) => set("first_name", e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Last name">
            <input
              type="text"
              value={form.last_name}
              onChange={(e) => set("last_name", e.target.value)}
              className="input"
            />
          </Field>

          <Field label="Email (read-only)">
            <input
              type="email"
              readOnly
              value={form.email}
              className="input bg-canvas/60 text-muted cursor-not-allowed"
            />
          </Field>
          <Field label="Username">
            <input
              type="text"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              className="input"
            />
          </Field>

          <Field label="Phone">
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Gender">
            <select
              value={form.gender}
              onChange={(e) => set("gender", e.target.value as UserDetail["gender"])}
              className="input"
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
              className="input"
            />
          </Field>
        </div>
      </section>

      {/* ORGANIZATION --------------------------------------------------- */}
      <section className="border border-line rounded-lg bg-paper p-6">
        <h2 className="serif text-2xl mb-4">Organization details</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Unique ID (Employee ID)" required>
            <input
              type="text"
              required
              value={form.employee_id}
              onChange={(e) => set("employee_id", e.target.value)}
              className="input font-mono"
            />
          </Field>
          <Field label="Status" required>
            <select
              value={form.status}
              onChange={(e) =>
                set("status", e.target.value as UserDetail["status"])
              }
              className="input"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="suspended">Suspended</option>
            </select>
          </Field>

          <Field label="Date of joining">
            <input
              type="date"
              value={form.date_of_joining}
              onChange={(e) => set("date_of_joining", e.target.value)}
              className="input"
            />
          </Field>
          <Field label="LMS role" required>
            <select
              required
              value={form.lms_role}
              onChange={(e) => set("lms_role", e.target.value as LmsRole)}
              className="input"
            >
              <option value="user">User (Learner)</option>
              <option value="data_analyst">Data Analyst</option>
              <option value="admin">Administrator</option>
              {(canAssignSuperOwner || form.lms_role === "super_owner") && (
                <option value="super_owner">Super Owner</option>
              )}
            </select>
          </Field>

          <Field label="Grade">
            <input
              type="text"
              value={form.grade}
              onChange={(e) => set("grade", e.target.value)}
              className="input"
            />
          </Field>
          {governed("Designation", "designation")}

          {governed("Job role / title", "job_role")}
          {governed("Node ID (hierarchy branch)", "node_id", { mono: true })}

          <Field label="Line manager" required={requireManagers}>
            <select
              required={requireManagers}
              value={form.line_manager_id}
              onChange={(e) => set("line_manager_id", e.target.value)}
              className="input"
            >
              <option value="">—</option>
              {managers.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.email}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Indirect line manager" required={requireManagers}>
            <select
              required={requireManagers}
              value={form.indirect_manager_id}
              onChange={(e) => set("indirect_manager_id", e.target.value)}
              className="input"
            >
              <option value="">—</option>
              {managers.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.email}
                </option>
              ))}
            </select>
          </Field>

          {governed("City", "city")}
          {governed("Branch", "branch")}

          {governed("State / Territory", "state")}
          {governed("Business vertical", "business_vertical")}
        </div>
      </section>

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

      <div className="flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={busy}
          className="px-5 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>

      <style jsx>{`
        :global(.input) {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid var(--color-line);
          border-radius: 0.5rem;
          background: var(--color-canvas);
          outline: none;
          font-size: 0.875rem;
        }
        :global(.input:focus) {
          border-color: var(--color-ink);
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
      <span className="block text-xs uppercase tracking-wide text-muted mb-1">
        {label}
        {required && <span className="text-red-700 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
