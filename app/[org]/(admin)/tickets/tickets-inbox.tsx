"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Inbox,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  Clock,
  Pencil,
  Send,
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

export type Ticket = {
  id: string;
  user_id: string;
  email: string;
  subject: string;
  body: string | null;
  status: "open" | "in_progress" | "closed";
  priority: "low" | "normal" | "high";
  admin_note: string | null;
  created_at: string;
  updated_at: string;
};

type Filter = "all" | "open" | "in_progress" | "closed";

export function TicketsInbox({
  tickets,
  orgName,
}: {
  tickets: Ticket[];
  orgName?: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const filtered =
    filter === "all" ? tickets : tickets.filter((t) => t.status === filter);

  async function setStatus(id: string, status: Ticket["status"]) {
    setBusy(true);
    await fetch(`/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    router.refresh();
  }

  async function setPriority(id: string, priority: Ticket["priority"]) {
    setBusy(true);
    await fetch(`/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority }),
    });
    setBusy(false);
    router.refresh();
  }

  async function saveNote(id: string) {
    setBusy(true);
    await fetch(`/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admin_note: note }),
    });
    setBusy(false);
    setOpenId(null);
    setNote("");
    router.refresh();
  }

  const stats = useMemo(() => {
    const open = tickets.filter((t) => t.status === "open").length;
    const inProgress = tickets.filter((t) => t.status === "in_progress").length;
    const closed = tickets.filter((t) => t.status === "closed").length;
    const total = tickets.length;
    const highPriority = tickets.filter(
      (t) => t.priority === "high" && t.status !== "closed"
    ).length;
    return { open, inProgress, closed, total, highPriority };
  }, [tickets]);

  const tabs: TabDef<Filter>[] = [
    { key: "open", label: "Open", count: stats.open },
    { key: "in_progress", label: "In progress", count: stats.inProgress },
    { key: "closed", label: "Closed", count: stats.closed },
    { key: "all", label: "All", count: stats.total },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Tickets"
        description={`Support requests from learners${orgName ? ` across ${orgName}` : ""}.`}
      />

      <KpiStrip>
        <KpiCard
          label="Open"
          value={stats.open}
          icon={<Inbox className="w-4 h-4" />}
          accent="text-amber-600"
        />
        <KpiCard
          label="In progress"
          value={stats.inProgress}
          icon={<Loader2 className="w-4 h-4" />}
          accent="text-sky-600"
        />
        <KpiCard
          label="Resolved"
          value={stats.closed}
          icon={<CheckCircle2 className="w-4 h-4" />}
          accent="text-emerald-600"
        />
        <KpiCard
          label="High priority"
          value={stats.highPriority}
          icon={<AlertTriangle className="w-4 h-4" />}
          accent={stats.highPriority > 0 ? "text-red-600" : "text-slate-500"}
        />
        <KpiCard
          label="Total"
          value={stats.total}
          icon={<MessageSquare className="w-4 h-4" />}
        />
      </KpiStrip>

      <TabStrip tabs={tabs} active={filter} onChange={setFilter} />

      {filtered.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={<Inbox className="w-5 h-5" />}
            title="No tickets in this view"
            description="When learners file support requests, they'll appear here for you to triage."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {filtered.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              busy={busy}
              isEditing={openId === t.id}
              note={note}
              onSetStatus={(s) => setStatus(t.id, s)}
              onSetPriority={(p) => setPriority(t.id, p)}
              onStartReply={() => {
                setOpenId(t.id);
                setNote(t.admin_note ?? "");
              }}
              onCancelReply={() => {
                setOpenId(null);
                setNote("");
              }}
              onChangeNote={setNote}
              onSaveNote={() => saveNote(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TicketCard({
  ticket: t,
  busy,
  isEditing,
  note,
  onSetStatus,
  onSetPriority,
  onStartReply,
  onCancelReply,
  onChangeNote,
  onSaveNote,
}: {
  ticket: Ticket;
  busy: boolean;
  isEditing: boolean;
  note: string;
  onSetStatus: (s: Ticket["status"]) => void;
  onSetPriority: (p: Ticket["priority"]) => void;
  onStartReply: () => void;
  onCancelReply: () => void;
  onChangeNote: (v: string) => void;
  onSaveNote: () => void;
}) {
  return (
    <article className="bg-paper border border-line rounded-xl p-4 transition-all hover:border-ink/30 hover:shadow-sm flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Avatar name={t.email} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
          </div>
          <h3 className="serif text-lg mt-2 leading-tight text-ink line-clamp-2">
            {t.subject}
          </h3>
          <div className="text-xs text-muted mt-1 flex items-center gap-2 flex-wrap">
            <span className="truncate">{t.email}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {relativeTime(t.created_at)}
            </span>
          </div>
        </div>
      </div>

      {t.body && (
        <p className="text-sm text-muted whitespace-pre-wrap line-clamp-4 border-l-2 border-line pl-3">
          {t.body}
        </p>
      )}

      {t.admin_note && !isEditing && (
        <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold mb-1">
            Your reply
          </div>
          <div className="text-sm whitespace-pre-wrap text-ink">
            {t.admin_note}
          </div>
        </div>
      )}

      {isEditing ? (
        <div className="space-y-2">
          <textarea
            value={note}
            onChange={(e) => onChangeNote(e.target.value)}
            rows={3}
            placeholder="Reply visible to the learner…"
            className="w-full px-3 py-2 border border-line rounded-xl bg-canvas text-sm outline-none focus:border-ink focus:ring-2 focus:ring-ink/10"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancelReply}
              className="text-xs px-3 py-1.5 border border-line rounded-lg hover:border-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSaveNote}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Send className="w-3 h-3" />
              Save reply
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-line flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted">
            Priority
          </label>
          <select
            value={t.priority}
            onChange={(e) =>
              onSetPriority(e.target.value as Ticket["priority"])
            }
            disabled={busy}
            className="text-xs px-2 py-1 border border-line rounded-md bg-canvas outline-none hover:border-ink"
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted ml-2">
            Status
          </label>
          <select
            value={t.status}
            onChange={(e) => onSetStatus(e.target.value as Ticket["status"])}
            disabled={busy}
            className="text-xs px-2 py-1 border border-line rounded-md bg-canvas outline-none hover:border-ink"
          >
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        {!isEditing && (
          <button
            type="button"
            onClick={onStartReply}
            className="inline-flex items-center gap-1 text-xs px-2 py-1.5 border border-line rounded-md hover:border-ink text-muted hover:text-ink transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
            {t.admin_note ? "Edit reply" : "Reply"}
          </button>
        )}
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: Ticket["status"] }) {
  if (status === "open") {
    return <StatusPill tone="warning">Open</StatusPill>;
  }
  if (status === "in_progress") {
    return <StatusPill tone="pending">In progress</StatusPill>;
  }
  return <StatusPill tone="success">Resolved</StatusPill>;
}

function PriorityBadge({ priority }: { priority: Ticket["priority"] }) {
  const map: Record<Ticket["priority"], string> = {
    low: "bg-slate-50 text-slate-700 border-slate-200",
    normal: "bg-sky-50 text-sky-700 border-sky-200",
    high: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${map[priority]}`}
    >
      {priority === "high" && <AlertTriangle className="w-3 h-3" />}
      {priority}
    </span>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}
