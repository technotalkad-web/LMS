"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Send, Inbox, CheckCircle2, Clock, AlertTriangle } from "lucide-react";

export type LearnerTicket = {
  id: string;
  subject: string;
  body: string | null;
  status: "open" | "in_progress" | "closed";
  priority: "low" | "normal" | "high";
  admin_note: string | null;
  created_at: string;
  updated_at: string;
};

const CATEGORIES = [
  "Course won't load or play",
  "Certificate missing",
  "Login or profile issue",
  "Assigned the wrong course",
  "Something else",
];

export function SupportClient({
  orgSlug,
  tickets,
}: {
  orgSlug: string;
  tickets: LearnerTicket[];
}) {
  const router = useRouter();
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [priority, setPriority] = useState<LearnerTicket["priority"]>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) return;
    setBusy(true);
    setError(null);
    setSent(false);
    const subjectFinal = category
      ? `[${category}] ${subject.trim()}`
      : subject.trim();
    const res = await fetch("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        subject: subjectFinal,
        body: bodyText,
        priority,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Couldn't submit your ticket.");
      return;
    }
    setSubject("");
    setBodyText("");
    setCategory("");
    setPriority("normal");
    setSent(true);
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <form
        onSubmit={submit}
        className="bg-paper border border-line rounded-2xl shadow-sm p-6 sm:p-8 space-y-5"
      >
        <Field label="Issue category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="field-input"
          >
            <option value="">Select a category…</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Subject" required>
          <input
            type="text"
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Briefly describe the issue"
            className="field-input"
          />
        </Field>

        <Field label="Description">
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder="Please provide as much detail as possible…"
            rows={5}
            className="field-input resize-none"
          />
        </Field>

        <Field label="Priority">
          <div className="flex gap-2">
            {(["low", "normal", "high"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition ${
                  priority === p
                    ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                    : "border-line text-muted hover:border-ink hover:text-ink"
                }`}
              >
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </Field>

        {error && (
          <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </div>
        )}
        {sent && (
          <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            Ticket submitted. Your admin will reach out shortly.
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !subject.trim()}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition shadow-sm disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
          {busy ? "Submitting…" : "Submit ticket"}
        </button>

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

      {tickets.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <Inbox className="w-5 h-5 text-muted" />
              My tickets
            </h2>
            <span className="text-xs text-muted">
              {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="space-y-2">
            {tickets.map((t) => (
              <li
                key={t.id}
                className="bg-paper border border-line rounded-xl px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <h3 className="font-medium truncate">{t.subject}</h3>
                  <StatusPill status={t.status} />
                </div>
                {t.body && (
                  <p className="text-sm text-muted mt-1 whitespace-pre-wrap">
                    {t.body}
                  </p>
                )}
                {t.admin_note && (
                  <div className="mt-3 border-l-2 border-indigo-300 pl-3 text-sm bg-indigo-50/40 rounded">
                    <div className="text-[10px] uppercase tracking-wide text-indigo-700 font-medium">
                      Admin reply
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap">{t.admin_note}</div>
                  </div>
                )}
                <div className="text-xs text-muted mt-2 flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Opened {new Date(t.created_at).toISOString().slice(0, 10)}
                  </span>
                  <span>· priority {t.priority}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
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
      <span className="block text-sm font-medium mb-1.5">
        {label}
        {required && <span className="text-red-700 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}

function StatusPill({ status }: { status: LearnerTicket["status"] }) {
  const map = {
    open: "bg-blue-100 text-blue-800 border-blue-200",
    in_progress: "bg-amber-100 text-amber-800 border-amber-200",
    closed: "bg-canvas text-muted border-line",
  };
  const label = { open: "Open", in_progress: "In progress", closed: "Closed" };
  return (
    <span
      className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide border ${map[status]}`}
    >
      {label[status]}
    </span>
  );
}
