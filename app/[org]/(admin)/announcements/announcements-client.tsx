"use client";


import { useConfirm } from "@/components/ui/confirm";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Megaphone,
  Eye,
  EyeOff,
  Clock,
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
  Plus,
  Trash2,
  Calendar,
  X,
} from "lucide-react";
import {
  AdminPageHeader,
  KpiCard,
  KpiStrip,
  Card,
  EmptyState,
  StatusPill,
} from "@/components/admin";

export type Announcement = {
  id: string;
  title: string;
  body: string | null;
  tone: "info" | "success" | "warning" | "critical";
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
};

export function AnnouncementsClient({
  orgSlug,
  announcements,
}: {
  orgSlug: string;
  announcements: Announcement[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tone, setTone] = useState<Announcement["tone"]>("info");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        title,
        body,
        tone,
        expires_at: expiresAt || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Failed");
      return;
    }
    setTitle("");
    setBody("");
    setExpiresAt("");
    setTone("info");
    setShowForm(false);
    router.refresh();
  }

  async function toggle(id: string, current: boolean) {
    await fetch(`/api/announcements/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: !current }),
    });
    router.refresh();
  }

  async function remove(id: string) {
    if (!await confirm("Delete this announcement?")) return;
    await fetch(`/api/announcements/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const stats = useMemo(() => {
    const now = Date.now();
    const total = announcements.length;
    const active = announcements.filter(
      (a) =>
        a.is_active &&
        (!a.expires_at || new Date(a.expires_at).getTime() > now)
    ).length;
    const scheduled = announcements.filter(
      (a) =>
        a.is_active &&
        a.expires_at &&
        new Date(a.expires_at).getTime() > now
    ).length;
    const expired = announcements.filter(
      (a) => a.expires_at && new Date(a.expires_at).getTime() <= now
    ).length;
    const hidden = announcements.filter((a) => !a.is_active).length;
    return { total, active, scheduled, expired, hidden };
  }, [announcements]);

  return (
    <div>
      <AdminPageHeader
        title="Announcements"
        description="Messages shown as a banner on every learner's dashboard."
        action={
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
          >
            {showForm ? (
              <>
                <X className="w-4 h-4" /> Cancel
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" /> New announcement
              </>
            )}
          </button>
        }
      />

      <KpiStrip>
        <KpiCard
          label="Total"
          value={stats.total}
          icon={<Megaphone className="w-4 h-4" />}
        />
        <KpiCard
          label="Active"
          value={stats.active}
          icon={<CheckCircle2 className="w-4 h-4" />}
          accent="text-emerald-600"
        />
        <KpiCard
          label="Scheduled"
          value={stats.scheduled}
          icon={<Clock className="w-4 h-4" />}
          accent="text-amber-600"
        />
        <KpiCard
          label="Expired"
          value={stats.expired}
          icon={<XCircle className="w-4 h-4" />}
          accent="text-slate-500"
        />
        <KpiCard
          label="Hidden"
          value={stats.hidden}
          icon={<EyeOff className="w-4 h-4" />}
          accent="text-slate-500"
        />
      </KpiStrip>

      {showForm && (
        <Card className="p-5 mb-6">
          <form onSubmit={create} className="space-y-3">
            <h2 className="serif text-2xl">New announcement</h2>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              className="w-full px-3 py-2 border border-line rounded-xl bg-canvas outline-none focus:border-ink text-sm"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Body (optional)"
              rows={3}
              className="w-full px-3 py-2 border border-line rounded-xl bg-canvas outline-none focus:border-ink text-sm"
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs text-muted">Tone:</label>
              <select
                value={tone}
                onChange={(e) =>
                  setTone(e.target.value as Announcement["tone"])
                }
                className="px-3 py-1.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink text-sm"
              >
                <option value="info">Info</option>
                <option value="success">Success</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
              <label className="text-xs text-muted ml-3">Expires:</label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="px-3 py-1.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="ml-auto inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Posting…" : "Post"}
              </button>
            </div>
            {error && <p className="text-sm text-red-700">{error}</p>}
          </form>
        </Card>
      )}

      {announcements.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={<Megaphone className="w-5 h-5" />}
            title="No announcements yet"
            description="Post one to display a banner on every learner's dashboard."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {announcements.map((a) => (
            <AnnouncementCard
              key={a.id}
              announcement={a}
              onToggle={() => toggle(a.id, a.is_active)}
              onDelete={() => remove(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AnnouncementCard({
  announcement: a,
  onToggle,
  onDelete,
}: {
  announcement: Announcement;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const now = Date.now();
  const isExpired =
    !!a.expires_at && new Date(a.expires_at).getTime() <= now;
  const status: "active" | "hidden" | "expired" = !a.is_active
    ? "hidden"
    : isExpired
      ? "expired"
      : "active";

  return (
    <article className="bg-paper border border-line rounded-xl p-4 transition-all hover:border-ink/30 hover:shadow-sm flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <ToneIcon tone={a.tone} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <ToneBadge tone={a.tone} />
            <StatusBadge status={status} />
          </div>
          <h3 className="serif text-lg mt-2 leading-tight text-ink line-clamp-2">
            {a.title}
          </h3>
          {a.body && (
            <p className="text-sm text-muted mt-1.5 line-clamp-3 whitespace-pre-wrap">
              {a.body}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted flex-wrap">
        <span className="inline-flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          Posted {new Date(a.created_at).toISOString().slice(0, 10)}
        </span>
        {a.expires_at && (
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Expires {new Date(a.expires_at).toISOString().slice(0, 10)}
          </span>
        )}
      </div>

      <div className="flex items-center justify-end gap-1 pt-2 border-t border-line">
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 text-xs px-2 py-1.5 border border-line rounded-md hover:border-ink text-muted hover:text-ink transition-colors"
          title={a.is_active ? "Hide" : "Show"}
        >
          {a.is_active ? (
            <>
              <EyeOff className="w-3.5 h-3.5" /> Hide
            </>
          ) : (
            <>
              <Eye className="w-3.5 h-3.5" /> Show
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1 text-xs px-2 py-1.5 border border-line rounded-md hover:border-red-500 text-muted hover:text-red-600 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </button>
      </div>
    </article>
  );
}

function ToneIcon({ tone }: { tone: Announcement["tone"] }) {
  const map: Record<Announcement["tone"], { Icon: typeof Info; cls: string }> = {
    info: { Icon: Info, cls: "bg-sky-50 text-sky-700 border-sky-200" },
    success: {
      Icon: CheckCircle2,
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    },
    warning: {
      Icon: AlertTriangle,
      cls: "bg-amber-50 text-amber-700 border-amber-200",
    },
    critical: {
      Icon: AlertTriangle,
      cls: "bg-red-50 text-red-700 border-red-200",
    },
  };
  const { Icon, cls } = map[tone];
  return (
    <div
      className={`shrink-0 w-9 h-9 rounded-full border flex items-center justify-center ${cls}`}
      aria-hidden
    >
      <Icon className="w-4 h-4" />
    </div>
  );
}

function ToneBadge({ tone }: { tone: Announcement["tone"] }) {
  const map: Record<Announcement["tone"], string> = {
    info: "bg-sky-50 text-sky-700 border-sky-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    critical: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${map[tone]}`}
    >
      {tone}
    </span>
  );
}

function StatusBadge({
  status,
}: {
  status: "active" | "hidden" | "expired";
}) {
  if (status === "active") {
    return <StatusPill tone="active">Active</StatusPill>;
  }
  if (status === "expired") {
    return <StatusPill tone="neutral">Expired</StatusPill>;
  }
  return <StatusPill tone="neutral">Hidden</StatusPill>;
}
