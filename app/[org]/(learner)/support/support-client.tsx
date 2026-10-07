"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Send, Inbox, CheckCircle2, Clock, AlertTriangle, LifeBuoy, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select } from "@/components/ui/input";
import { CATEGORY_LABEL, OUTCOME_LABEL, type TicketCategory, type TicketOutcome } from "@/lib/tickets/types";

export type LearnerTicket = {
  id: string;
  subject: string;
  body: string | null;
  status: "open" | "in_progress" | "closed";
  priority: "low" | "normal" | "high";
  admin_note: string | null;
  created_at: string;
  updated_at: string;
  /** manager = raised from the Report Card with context (Phase 4a). */
  source: "learner" | "manager";
  category: TicketCategory | null;
  outcome: TicketOutcome | null;
  context: { contentTitle: string | null; contentKind: string | null; people: string[]; exception: string | null; dueAt: string | null } | null;
  messages: Array<{ id: string; role: "requester" | "admin"; body: string; at: string }>;
};

const CATEGORIES = [
  "Course won't load or play",
  "Certificate missing",
  "Login or profile issue",
  "Assigned the wrong course",
  "Something else",
];

export function SupportClient({ orgSlug, tickets }: { orgSlug: string; tickets: LearnerTicket[] }) {
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
    const subjectFinal = category ? `[${category}] ${subject.trim()}` : subject.trim();
    const res = await fetch("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, subject: subjectFinal, body: bodyText, priority }),
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
      <form onSubmit={submit} className="bg-paper border border-line rounded-2xl shadow-sm p-6 sm:p-8 space-y-5">
        <Field label="Issue category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select a category…</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </Field>

        <Field label="Subject" required>
          <Input type="text" required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Briefly describe the issue" />
        </Field>

        <Field label="Description">
          <Textarea value={bodyText} onChange={(e) => setBodyText(e.target.value)} placeholder="Please provide as much detail as possible…" rows={5} className="resize-none" />
        </Field>

        <Field label="Priority">
          <div className="flex gap-2">
            {(["low", "normal", "high"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                aria-pressed={priority === p}
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition ${priority === p ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:border-ink hover:text-ink"}`}
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

        <Button type="submit" disabled={busy || !subject.trim()} className="w-full">
          <Send className="w-4 h-4" />
          {busy ? "Submitting…" : "Submit ticket"}
        </Button>
      </form>

      {tickets.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <Inbox className="w-5 h-5 text-muted" />
              My tickets
            </h2>
            <span className="text-xs text-muted">{tickets.length} ticket{tickets.length === 1 ? "" : "s"}</span>
          </div>
          <ul className="space-y-2">
            {tickets.map((t) => (
              <TicketItem key={t.id} ticket={t} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function TicketItem({ ticket: t }: { ticket: LearnerTicket }) {
  const router = useRouter();
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/tickets/${t.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: reply.trim() }) });
    setBusy(false);
    if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j.error ?? "Couldn't send your reply."); return; }
    setReply("");
    setOpen(false);
    router.refresh();
  };
  const thread = t.messages.length ? t.messages : t.admin_note ? [{ id: "note", role: "admin" as const, body: t.admin_note, at: t.updated_at }] : [];
  return (
    <li className="bg-paper border border-line rounded-xl px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h3 className="font-medium truncate">{t.subject}</h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {t.outcome && <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide border bg-emerald-50 text-emerald-800 border-emerald-200">{OUTCOME_LABEL[t.outcome]}</span>}
          <StatusPill status={t.status} />
        </div>
      </div>
      {t.source === "manager" && (
        <div className="text-xs text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1">
          <span className="inline-flex items-center gap-1 text-indigo-700"><LifeBuoy className="w-3 h-3" /> From Team Performance</span>
          {t.category && <span>· {CATEGORY_LABEL[t.category]}</span>}
          {t.context?.contentTitle && <span>· {t.context.contentTitle}</span>}
          {t.context && t.context.people.length > 0 && <span>· {t.context.people.length === 1 ? t.context.people[0] : `${t.context.people.length} people`}</span>}
          {t.context?.dueAt && <span>· requested due {t.context.dueAt}</span>}
        </div>
      )}
      {t.body && <p className="text-sm text-muted mt-1 whitespace-pre-wrap">{t.body}</p>}
      {thread.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {thread.map((m) => (
            <li key={m.id} className={`border-l-2 pl-3 text-sm rounded ${m.role === "admin" ? "border-indigo-300 bg-indigo-50/40" : "border-line bg-canvas/60"}`}>
              <div className={`text-[10px] uppercase tracking-wide font-medium ${m.role === "admin" ? "text-indigo-700" : "text-muted"}`}>{m.role === "admin" ? "Admin reply" : "You"} · {new Date(m.at).toISOString().slice(0, 10)}</div>
              <div className="mt-0.5 whitespace-pre-wrap">{m.body}</div>
            </li>
          ))}
        </ol>
      )}
      {open ? (
        <div className="mt-3 space-y-2">
          <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} placeholder="Add information for your admin…" className="resize-none" />
          {err && <p className="text-xs text-red-700">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="text-xs px-3 py-1.5 border border-line rounded-lg hover:border-ink" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" disabled={busy || !reply.trim()} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50" onClick={send}>
              <Send className="w-3 h-3" /> Send
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted mt-2 flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />Opened {new Date(t.created_at).toISOString().slice(0, 10)}</span>
          <span>· priority {t.priority}</span>
          <button type="button" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink" onClick={() => setOpen(true)}>
            <MessageSquare className="w-3 h-3" /> Reply
          </button>
        </div>
      )}
    </li>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
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
  return <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide border ${map[status]}`}>{label[status]}</span>;
}
