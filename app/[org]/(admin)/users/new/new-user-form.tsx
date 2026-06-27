"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type ManagerOption = { user_id: string; email: string };

type LmsRole = "user" | "data_analyst" | "admin" | "super_owner";

type FormState = {
  // Personal
  first_name: string;
  last_name: string;
  username: string;
  email: string;
  password: string;
  gender: "" | "male" | "female" | "other" | "prefer_not_to_say";
  date_of_birth: string;
  phone: string;
  // Org
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
};

const INITIAL: FormState = {
  first_name: "",
  last_name: "",
  username: "",
  email: "",
  password: "",
  gender: "",
  date_of_birth: "",
  phone: "",
  employee_id: "",
  status: "active",
  date_of_joining: "",
  grade: "",
  designation: "",
  job_role: "",
  line_manager_id: "",
  indirect_manager_id: "",
  lms_role: "user",
  node_id: "",
  city: "",
  state: "",
};

export function NewUserForm({
  orgSlug,
  managers,
  canAssignSuperOwner,
}: {
  orgSlug: string;
  managers: ManagerOption[];
  canAssignSuperOwner: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    email: string;
    invited: boolean;
    updated: boolean;
  } | null>(null);
  const [usernameTouched, setUsernameTouched] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Inline email-format validation (only flags once something is typed).
  const emailInvalid =
    form.email.trim().length > 0 &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  // Username mirrors email until the user types into it directly.
  function onEmail(v: string) {
    setForm((f) => ({
      ...f,
      email: v,
      username: usernameTouched ? f.username : v,
    }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    const payload = { orgSlug, ...form };
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as {
      email?: string;
      invited?: boolean;
      updated_existing?: boolean;
      error?: string;
    };
    if (!res.ok) {
      setError(j.error ?? "Could not create user");
      return;
    }
    setSuccess({
      email: j.email ?? form.email,
      invited: !!j.invited,
      updated: !!j.updated_existing,
    });
    setForm(INITIAL);
    setUsernameTouched(false);
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

          <Field label="Email" required>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => onEmail(e.target.value)}
              className="input"
              placeholder="user@company.com"
              aria-invalid={emailInvalid}
              aria-describedby={emailInvalid ? "email-error" : undefined}
            />
            {emailInvalid && (
              <p id="email-error" className="mt-1 text-xs text-red-600">
                Enter a valid email address.
              </p>
            )}
          </Field>
          <Field label="Username" required>
            <input
              type="text"
              required
              value={form.username}
              onFocus={() => setUsernameTouched(true)}
              onChange={(e) => set("username", e.target.value)}
              className="input"
              placeholder="Defaults to email"
            />
          </Field>

          <Field label="Password (leave blank → invite email)">
            <input
              type="text"
              autoComplete="off"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              className="input font-mono"
              placeholder="Min 8 chars; blank for invite link"
              minLength={form.password.length > 0 ? 8 : undefined}
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
              onChange={(e) => set("gender", e.target.value as FormState["gender"])}
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
        <h2 className="serif text-2xl mb-1">Organization details</h2>
        <p className="text-xs text-muted mb-4">
          These fields are locked for the learner after creation. Only admins can
          change them later.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Unique ID (Employee ID)" required>
            <input
              type="text"
              required
              value={form.employee_id}
              onChange={(e) => set("employee_id", e.target.value)}
              className="input font-mono"
              placeholder="EMP-001"
            />
          </Field>
          <Field label="Status" required>
            <select
              value={form.status}
              onChange={(e) => set("status", e.target.value as FormState["status"])}
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
              {canAssignSuperOwner && (
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
          <Field label="Designation">
            <input
              type="text"
              value={form.designation}
              onChange={(e) => set("designation", e.target.value)}
              className="input"
            />
          </Field>

          <Field label="Job role / title">
            <input
              type="text"
              value={form.job_role}
              onChange={(e) => set("job_role", e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Node ID (hierarchy branch)" required>
            <input
              type="text"
              required
              value={form.node_id}
              onChange={(e) => set("node_id", e.target.value)}
              className="input font-mono"
              placeholder="e.g. SALES-WEST-3"
            />
          </Field>

          <Field label="Line manager">
            <select
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
          <Field label="Indirect line manager">
            <select
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

          <Field label="City">
            <input
              type="text"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
              className="input"
            />
          </Field>
          <Field label="State / Territory">
            <input
              type="text"
              value={form.state}
              onChange={(e) => set("state", e.target.value)}
              className="input"
            />
          </Field>
        </div>
      </section>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-lg p-3 text-sm">
          <span className="font-medium">
            {success.updated ? "Updated " : "Created "}
            {success.email}.
          </span>{" "}
          {success.invited
            ? "An invite link has been emailed for them to set a password."
            : "The account is active with the password you set."}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="reset"
          onClick={() => {
            setForm(INITIAL);
            setUsernameTouched(false);
            setError(null);
            setSuccess(null);
          }}
          className="px-4 py-2 border border-line rounded-lg text-sm hover:border-ink"
        >
          Reset
        </button>
        <button
          type="submit"
          disabled={busy || emailInvalid}
          className="px-5 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create user"}
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
        :global(.input[aria-invalid="true"]) {
          border-color: #f87171;
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
