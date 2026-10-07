"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Inbox,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  Clock,
  Send,
  LifeBuoy,
  ExternalLink,
  Check,
  Ban,
} from "lucide-react";
import {
  AdminPageHeader,
  KpiCard,
  KpiStrip,
  TabStrip,
  type Tab as TabDef,
  Card,
  Avatar,
  EmptyState,
  StatusPill,
} from "@/components/admin";
import { CATEGORY_LABEL, OUTCOME_LABEL, type TicketCategory, type TicketOutcome } from "@/lib/tickets/types";
import { GRANT_EXPIRY_CHOICES } from "@/lib/attempts/constants";

export type TicketView = {
  id: string;
  subject: string;
  body: string | null;
  status: "open" | "in_progress" | "closed";
  priority: "low" | "normal" | "high";
  admin_note: string | null;
  created_at: string;
  updated_at: string;
  source: "learner" | "manager";
  category: TicketCategory | null;
  requestedByLevel: number | null;
  outcome: TicketOutcome | null;
  outcomeAt: string | null;
  requester: { id: string; name: string; email: string };
  people: Array<{ userId: string; name: string; href: string }>;
  content: { kind: "course" | "path" | "journey"; id: string; title: string; href: string | null } | null;
  exception: string | null;
  dueAt: string | null;
  messages: Array<{ id: string; role: "requester" | "admin"; author: string; body: string; at: string }>;
};

type Filter = "manager" | "open" | "in_progress" | "closed" | "all";

export function TicketsInbox({ tickets, orgSlug, orgName }: { tickets: TicketView[]; orgSlug: string; orgName?: string }) {
  const router = useRouter();
  const managerOpen = tickets.filter((t) => t.source === "manager" && t.status !== "closed").length;
  const [filter, setFilter] = useState<Filter>(managerOpen > 0 ? "manager" : "open");
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const filtered =
    filter === "all" ? tickets
      : filter === "manager" ? tickets.filter((t) => t.source === "manager" && t.status !== "closed")
      : tickets.filter((t) => t.status === filter);

  const call = async (key: string, path: string, method: string, body: unknown): Promise<string | null> => {
    setBusy(key);
    try {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { error?: string; summary?: string };
      if (!res.ok) return j.error ?? "Something went wrong";
      router.refresh();
      return null;
    } catch {
      return "Network error — please try again";
    } finally {
      setBusy(null);
    }
  };
  const setErr = (id: string, msg: string | null) => setNotes((n) => ({ ...n, [`err:${id}`]: msg ?? "" }));

  const stats = useMemo(() => ({
    manager: managerOpen,
    open: tickets.filter((t) => t.status === "open").length,
    inProgress: tickets.filter((t) => t.status === "in_progress").length,
    closed: tickets.filter((t) => t.status === "closed").length,
    total: tickets.length,
    highPriority: tickets.filter((t) => t.priority === "high" && t.status !== "closed").length,
  }), [tickets, managerOpen]);

  const tabs: TabDef<Filter>[] = [
    { key: "manager", label: "Manager requests", count: stats.manager },
    { key: "open", label: "Open", count: stats.open },
    { key: "in_progress", label: "In progress", count: stats.inProgress },
    { key: "closed", label: "Closed", count: stats.closed },
    { key: "all", label: "All", count: stats.total },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Tickets"
        description={`Support requests from learners and managers${orgName ? ` across ${orgName}` : ""}. Managers raise; you act.`}
      />

      <KpiStrip>
        <KpiCard label="Manager requests" value={stats.manager} icon={<LifeBuoy className="w-4 h-4" />} accent={stats.manager > 0 ? "text-indigo-600" : "text-slate-500"} />
        <KpiCard label="Open" value={stats.open} icon={<Inbox className="w-4 h-4" />} accent="text-amber-600" />
        <KpiCard label="In progress" value={stats.inProgress} icon={<Loader2 className="w-4 h-4" />} accent="text-sky-600" />
        <KpiCard label="Resolved" value={stats.closed} icon={<CheckCircle2 className="w-4 h-4" />} accent="text-emerald-600" />
        <KpiCard label="High priority" value={stats.highPriority} icon={<AlertTriangle className="w-4 h-4" />} accent={stats.highPriority > 0 ? "text-red-600" : "text-slate-500"} />
        <KpiCard label="Total" value={stats.total} icon={<MessageSquare className="w-4 h-4" />} />
      </KpiStrip>

      <TabStrip tabs={tabs} active={filter} onChange={setFilter} />

      {filtered.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={<Inbox className="w-5 h-5" />}
            title="No tickets in this view"
            description={filter === "manager" ? "When a manager raises a request from their Report Card, it appears here with the employee and content attached." : "When learners file support requests, they'll appear here for you to triage."}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {filtered.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              orgSlug={orgSlug}
              busy={busy}
              error={notes[`err:${t.id}`] || null}
              onSetStatus={async (s) => setErr(t.id, await call(`status:${t.id}`, `/api/tickets/${t.id}`, "PATCH", { status: s }))}
              onSetPriority={async (p) => setErr(t.id, await call(`priority:${t.id}`, `/api/tickets/${t.id}`, "PATCH", { priority: p }))}
              onReply={async (text) => setErr(t.id, await call(`reply:${t.id}`, `/api/tickets/${t.id}/messages`, "POST", { body: text }))}
              onAct={async (action, extra) => setErr(t.id, await call(`act:${t.id}`, `/api/tickets/${t.id}/act`, "POST", { action, ...extra }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const btn = "inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium disabled:opacity-50";

function TicketCard({
  ticket: t,
  orgSlug,
  busy,
  error,
  onSetStatus,
  onSetPriority,
  onReply,
  onAct,
}: {
  ticket: TicketView;
  orgSlug: string;
  busy: string | null;
  error: string | null;
  onSetStatus: (s: TicketView["status"]) => void;
  onSetPriority: (p: TicketView["priority"]) => void;
  onReply: (text: string) => Promise<void>;
  onAct: (action: "grant_retry" | "assign" | "extend_due" | "decline" | "resolve", extra: Record<string, unknown>) => Promise<void>;
}) {
  const act = async (action: "grant_retry" | "assign" | "extend_due" | "decline" | "resolve", extra: Record<string, unknown>) => {
    await onAct(action, extra);
    setMode("none");
  };
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [dueAt, setDueAt] = useState(t.dueAt ?? "");
  const [expiry, setExpiry] = useState<string>("30");
  const [mode, setMode] = useState<"none" | "reply" | "act" | "decline">("none");
  const anyBusy = busy !== null;
  const mine = (k: string) => busy === `${k}:${t.id}`;
  const isManager = t.source === "manager";
  const actionable = isManager && t.status !== "closed";
  const primary = t.category === "grant_retry" ? "grant_retry" : t.category === "assign_content" ? "assign" : t.category === "extend_due" ? "extend_due" : null;
  const canPrimary = !!primary && !!t.content && t.content.kind === "course" && t.people.length > 0;

  return (
    <article className={`bg-paper border rounded-xl p-4 transition-all hover:shadow-sm flex flex-col gap-3 ${isManager && t.status !== "closed" ? "border-indigo-200" : "border-line hover:border-ink/30"}`}>
      <div className="flex items-start gap-3">
        <Avatar name={t.requester.name} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            {isManager && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-indigo-50 text-indigo-700 border-indigo-200">
                <LifeBuoy className="w-3 h-3" /> Manager request{t.requestedByLevel ? ` · L${t.requestedByLevel}` : ""}
              </span>
            )}
            {t.category && <span className="text-[11px] font-semibold text-muted border border-line rounded-full px-2 py-0.5">{CATEGORY_LABEL[t.category]}</span>}
            {t.outcome && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200"><Check className="w-3 h-3" /> {OUTCOME_LABEL[t.outcome]}</span>}
          </div>
          <h3 className="serif text-lg mt-2 leading-tight text-ink line-clamp-2">{t.subject}</h3>
          <div className="text-xs text-muted mt-1 flex items-center gap-2 flex-wrap">
            <span className="truncate">{t.requester.name}{t.requester.email ? ` · ${t.requester.email}` : ""}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{relativeTime(t.created_at)}</span>
          </div>
        </div>
      </div>

      {isManager && (t.content || t.people.length > 0 || t.exception) && (
        <div className="rounded-lg bg-canvas/70 border border-line p-3 text-xs space-y-1" data-testid="ticket-context">
          <div className="text-[10px] uppercase tracking-wide text-muted">Context from the Report Card</div>
          {t.content && (
            <div>
              <span className="text-muted">{t.content.kind === "journey" ? "Journey" : t.content.kind === "path" ? "Learning path" : "Course"}:</span>{" "}
              {t.content.href ? <Link href={t.content.href} className="underline">{t.content.title}</Link> : t.content.title}
            </div>
          )}
          {t.people.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-muted">{t.people.length === 1 ? "Employee:" : `Employees (${t.people.length}):`}</span>
              {t.people.slice(0, 12).map((p) => (
                <Link key={p.userId} href={p.href} className="inline-flex items-center gap-0.5 border border-line rounded-full px-2 py-0.5 hover:border-ink">{p.name} <ExternalLink className="w-2.5 h-2.5 text-muted" /></Link>
              ))}
              {t.people.length > 12 && <span className="text-muted">+{t.people.length - 12}</span>}
            </div>
          )}
          {t.exception && <div><span className="text-muted">Flagged as:</span> {t.exception.replace(/_/g, " ")}</div>}
          {t.dueAt && <div><span className="text-muted">Requested due date:</span> {t.dueAt}</div>}
        </div>
      )}

      {t.body && <p className="text-sm text-muted whitespace-pre-wrap line-clamp-6 border-l-2 border-line pl-3">{t.body}</p>}

      {t.messages.length > 0 && (
        <ol className="space-y-1.5" aria-label="Thread">
          {t.messages.map((m) => (
            <li key={m.id} className={`rounded-lg p-2.5 text-sm border ${m.role === "admin" ? "border-emerald-200 bg-emerald-50/40" : "border-line bg-canvas/60"}`}>
              <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5 text-muted">{m.role === "admin" ? "Admin" : "Requester"} · {m.author} · {relativeTime(m.at)}</div>
              <div className="whitespace-pre-wrap">{m.body}</div>
            </li>
          ))}
        </ol>
      )}
      {t.messages.length === 0 && t.admin_note && (
        <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold mb-1">Your reply</div>
          <div className="text-sm whitespace-pre-wrap text-ink">{t.admin_note}</div>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}

      {mode === "reply" && (
        <div className="space-y-2">
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} placeholder={isManager ? "Reply to the manager…" : "Reply visible to the learner…"} className="w-full px-3 py-2 border border-line rounded-xl bg-canvas text-sm outline-none focus:border-ink focus:ring-2 focus:ring-ink/10" />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setMode("none")} className={`${btn} border border-line hover:border-ink`}>Cancel</button>
            <button type="button" disabled={anyBusy || !reply.trim()} onClick={async () => { await onReply(reply.trim()); setReply(""); setMode("none"); }} className={`${btn} bg-ink text-canvas hover:opacity-90`}>
              {mine("reply") ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Send reply
            </button>
          </div>
        </div>
      )}

      {mode === "act" && primary && actionable && (
        <div className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/30 p-3 text-xs">
          <div className="font-semibold text-sm">{primary === "grant_retry" ? "Grant one extra attempt" : primary === "assign" ? "Assign the course" : "Set a new due date"} for {t.people.length} {t.people.length === 1 ? "person" : "people"} on {t.content?.title}</div>
          {primary === "grant_retry" && (
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Grant expires in</span>
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="text-xs px-2 py-1 border border-line rounded-md bg-canvas">
                {GRANT_EXPIRY_CHOICES.map((d) => <option key={String(d)} value={d === null ? "never" : String(d)}>{d === null ? "Never" : `${d} days`}</option>)}
              </select>
            </label>
          )}
          {(primary === "assign" || primary === "extend_due") && (
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">{primary === "assign" ? "Due date (optional)" : "New due date"}</span>
              <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="text-xs px-2 py-1 border border-line rounded-md bg-canvas" />
            </label>
          )}
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Note to the manager (optional)</span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className="w-full text-xs px-2 py-1 border border-line rounded-md bg-canvas" />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setMode("none")} className={`${btn} border border-line hover:border-ink`}>Cancel</button>
            <button
              type="button"
              disabled={anyBusy || (primary === "extend_due" && !dueAt)}
              onClick={() => act(primary, { note, dueAt: dueAt || null, expires_in_days: expiry === "never" ? null : Number(expiry) })}
              className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}
            >
              {mine("act") ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Confirm and close ticket
            </button>
          </div>
        </div>
      )}

      {mode === "decline" && actionable && (
        <div className="space-y-2 rounded-lg border border-line bg-canvas/60 p-3 text-xs">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Reason for the manager</span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className="w-full text-xs px-2 py-1 border border-line rounded-md bg-canvas" />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setMode("none")} className={`${btn} border border-line hover:border-ink`}>Cancel</button>
            <button type="button" disabled={anyBusy} onClick={() => act("decline", { note })} className={`${btn} bg-ink text-canvas hover:opacity-90`}>
              {mine("act") ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Decline and close
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-line flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted">Priority</label>
          <select value={t.priority} onChange={(e) => onSetPriority(e.target.value as TicketView["priority"])} disabled={anyBusy} className="text-xs px-2 py-1 border border-line rounded-md bg-canvas outline-none hover:border-ink">
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
          </select>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted ml-2">Status</label>
          <select value={t.status} onChange={(e) => onSetStatus(e.target.value as TicketView["status"])} disabled={anyBusy} className="text-xs px-2 py-1 border border-line rounded-md bg-canvas outline-none hover:border-ink">
            <option value="open">Open</option><option value="in_progress">In progress</option><option value="closed">Closed</option>
          </select>
        </div>
        {mode === "none" && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {actionable && canPrimary && primary && (
              <button type="button" onClick={() => setMode("act")} disabled={anyBusy} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>
                <Check className="w-3.5 h-3.5" /> {primary === "grant_retry" ? "Grant retry" : primary === "assign" ? "Assign" : "Extend due date"}
              </button>
            )}
            {actionable && (
              <>
                <button type="button" onClick={() => setMode("decline")} disabled={anyBusy} className={`${btn} border border-line hover:border-ink text-muted hover:text-ink`}><Ban className="w-3.5 h-3.5" /> Decline</button>
                <button type="button" onClick={() => act("resolve", { note: "" })} disabled={anyBusy} className={`${btn} border border-line hover:border-ink text-muted hover:text-ink`}>{mine("act") ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Mark resolved</button>
              </>
            )}
            <button type="button" onClick={() => setMode("reply")} disabled={anyBusy} className={`${btn} border border-line hover:border-ink text-muted hover:text-ink`}>
              <MessageSquare className="w-3.5 h-3.5" /> Reply
            </button>
          </div>
        )}
      </div>
      {isManager && t.content && t.content.kind !== "course" && actionable && (
        <p className="text-[11px] text-muted">Act on a {t.content.kind === "path" ? "learning path" : "journey"} from its admin page, then mark the ticket resolved.</p>
      )}
      <span className="sr-only">{orgSlug}</span>
    </article>
  );
}

function StatusBadge({ status }: { status: TicketView["status"] }) {
  if (status === "open") return <StatusPill tone="warning">Open</StatusPill>;
  if (status === "in_progress") return <StatusPill tone="pending">In progress</StatusPill>;
  return <StatusPill tone="success">Resolved</StatusPill>;
}

function PriorityBadge({ priority }: { priority: TicketView["priority"] }) {
  const map: Record<TicketView["priority"], string> = {
    low: "bg-slate-50 text-slate-700 border-slate-200",
    normal: "bg-sky-50 text-sky-700 border-sky-200",
    high: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${map[priority]}`}>
      {priority === "high" && <AlertTriangle className="w-3 h-3" />}
      {priority}
    </span>
  );
}

function relativeTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  return `${Math.floor(months / 12)} years ago`;
}
