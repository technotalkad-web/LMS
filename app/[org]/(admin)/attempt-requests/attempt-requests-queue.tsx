"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Inbox,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Users,
  Check,
  X,
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

export type AttemptRequestRow = {
  id: string;
  status: "pending" | "approved" | "rejected";
  source: "request" | "bulk";
  reason: string | null;
  decision_note: string | null;
  decided_at: string | null;
  decided_by_email: string | null;
  expires_at: string | null;
  used_at: string | null;
  created_at: string;
  user_id: string;
  learner_name: string | null;
  learner_email: string;
  course_id: string;
  course_title: string;
  course_code: string | null;
  current_score: number | null;
  current_status: string | null;
};

export type BulkCourse = { id: string; title: string; code: string | null };

type Filter = "pending" | "approved" | "rejected" | "all";

const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "Never expires" },
];

export function AttemptRequestsQueue({
  rows,
  courses,
  orgSlug,
  orgName,
}: {
  rows: AttemptRequestRow[];
  courses: BulkCourse[];
  orgSlug: string;
  orgName?: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stats = useMemo(() => {
    const pending = rows.filter((r) => r.status === "pending").length;
    const grantedUnused = rows.filter((r) => r.status === "approved" && !r.used_at).length;
    const grantedUsed = rows.filter((r) => r.status === "approved" && r.used_at).length;
    const rejected = rows.filter((r) => r.status === "rejected").length;
    return { pending, grantedUnused, grantedUsed, rejected };
  }, [rows]);

  const filtered = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  async function decide(id: string, action: "approve" | "reject", note: string, expiry: string) {
    setBusyId(id);
    setError(null);
    const res = await fetch(`/api/attempt-requests/${id}?orgSlug=${encodeURIComponent(orgSlug)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        note: note || undefined,
        expires_in_days: expiry === "never" ? null : Number(expiry),
      }),
    });
    setBusyId(null);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    router.refresh();
  }

  const tabs: TabDef<Filter>[] = [
    { key: "pending", label: "Pending", count: stats.pending },
    { key: "approved", label: "Granted", count: stats.grantedUnused + stats.grantedUsed },
    { key: "rejected", label: "Declined", count: stats.rejected },
    { key: "all", label: "All", count: rows.length },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Attempt Requests"
        description={`Extra-attempt requests and grants${orgName ? ` across ${orgName}` : ""}.`}
      />

      <KpiStrip>
        <KpiCard label="Pending" value={stats.pending} icon={<Inbox className="w-4 h-4" />} accent="text-amber-600" />
        <KpiCard label="Granted · unused" value={stats.grantedUnused} icon={<CheckCircle2 className="w-4 h-4" />} accent="text-emerald-600" />
        <KpiCard label="Granted · used" value={stats.grantedUsed} icon={<Check className="w-4 h-4" />} accent="text-sky-600" />
        <KpiCard label="Declined" value={stats.rejected} icon={<XCircle className="w-4 h-4" />} accent="text-slate-500" />
      </KpiStrip>

      <BulkGrantPanel courses={courses} orgSlug={orgSlug} onDone={() => router.refresh()} />

      <TabStrip tabs={tabs} active={filter} onChange={setFilter} />

      {error && (
        <div className="mb-3 border border-red-200 bg-red-50 text-red-900 rounded-xl px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={<Inbox className="w-5 h-5" />}
            title="Nothing in this view"
            description="When learners ask for another attempt — or you bulk-grant one — the requests appear here."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {filtered.map((r) => (
            <RequestCard key={r.id} row={r} busy={busyId === r.id} onDecide={decide} />
          ))}
        </div>
      )}
    </div>
  );
}

function BulkGrantPanel({
  courses,
  orgSlug,
  onDone,
}: {
  courses: BulkCourse[];
  orgSlug: string;
  onDone: () => void;
}) {
  const [courseId, setCourseId] = useState("");
  const [expiry, setExpiry] = useState("30");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function grant() {
    if (!courseId) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    const res = await fetch(`/api/attempt-requests/bulk?orgSlug=${encodeURIComponent(orgSlug)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        courseId,
        expires_in_days: expiry === "never" ? null : Number(expiry),
      }),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as {
      error?: string;
      granted?: number;
      skipped?: number;
      failed_total?: number;
    };
    if (!res.ok) {
      setErr(j.error ?? `HTTP ${res.status}`);
      return;
    }
    if ((j.failed_total ?? 0) === 0) {
      setMsg("No learners have failed this module's official attempt — nothing to grant.");
    } else {
      setMsg(
        `Granted ${j.granted ?? 0} extra attempt${j.granted === 1 ? "" : "s"}` +
          ((j.skipped ?? 0) > 0 ? ` · ${j.skipped} already had an open grant` : "") +
          `.`
      );
    }
    onDone();
  }

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
          <Users className="w-4.5 h-4.5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="serif text-lg leading-tight text-ink">Bulk grant</h3>
          <p className="text-xs text-muted mt-0.5">
            Give one extra official attempt to every learner who used up their window on a module and didn&apos;t pass. Learners
            who already have an open grant are skipped.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              disabled={busy}
              className="text-sm px-3 py-2 border border-line rounded-lg bg-canvas outline-none hover:border-ink max-w-[320px]"
            >
              <option value="">Choose a module…</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code ? `${c.code} · ` : ""}
                  {c.title}
                </option>
              ))}
            </select>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              disabled={busy}
              className="text-sm px-3 py-2 border border-line rounded-lg bg-canvas outline-none hover:border-ink"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  Expires: {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={grant}
              disabled={busy || !courseId}
              className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
              Grant all failed
            </button>
          </div>
          {msg && <p className="text-xs text-emerald-700 mt-2">{msg}</p>}
          {err && <p className="text-xs text-red-700 mt-2">{err}</p>}
        </div>
      </div>
    </Card>
  );
}

function RequestCard({
  row: r,
  busy,
  onDecide,
}: {
  row: AttemptRequestRow;
  busy: boolean;
  onDecide: (id: string, action: "approve" | "reject", note: string, expiry: string) => void;
}) {
  const [note, setNote] = useState("");
  const [expiry, setExpiry] = useState("30");

  return (
    <article className="bg-paper border border-line rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Avatar name={r.learner_name ?? r.learner_email} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge row={r} />
            {r.source === "bulk" && (
              <span className="text-[10px] uppercase tracking-wider font-semibold text-muted border border-line rounded-full px-2 py-0.5">
                Bulk grant
              </span>
            )}
            <CurrentScore row={r} />
          </div>
          <h3 className="serif text-lg mt-2 leading-tight text-ink line-clamp-2">
            {r.course_code ? <span className="text-muted font-sans text-sm mr-1">{r.course_code}</span> : null}
            {r.course_title}
          </h3>
          <div className="text-xs text-muted mt-1 flex items-center gap-2 flex-wrap">
            <span className="truncate">{r.learner_name ? `${r.learner_name} · ` : ""}{r.learner_email}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {relativeTime(r.created_at)}
            </span>
          </div>
        </div>
      </div>

      {r.reason && (
        <p className="text-sm text-muted whitespace-pre-wrap line-clamp-4 border-l-2 border-line pl-3">
          {r.reason}
        </p>
      )}

      {r.status === "pending" ? (
        <div className="space-y-2 pt-1">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Optional note to the learner…"
            className="w-full px-3 py-2 border border-line rounded-xl bg-canvas text-sm outline-none focus:border-ink focus:ring-2 focus:ring-ink/10"
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              disabled={busy}
              className="text-xs px-2 py-1.5 border border-line rounded-md bg-canvas outline-none hover:border-ink"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  Grant expires: {o.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onDecide(r.id, "reject", note, expiry)}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 border border-line rounded-lg hover:border-red-400 hover:text-red-700 disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" />
                Decline
              </button>
              <button
                type="button"
                onClick={() => onDecide(r.id, "approve", note, expiry)}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Approve
              </button>
            </div>
          </div>
        </div>
      ) : (
        <DecidedFooter row={r} />
      )}
    </article>
  );
}

function DecidedFooter({ row: r }: { row: AttemptRequestRow }) {
  return (
    <div className="pt-2 border-t border-line text-xs text-muted space-y-1">
      {r.decision_note && (
        <div className="border border-line bg-canvas/50 rounded-lg p-2 text-ink whitespace-pre-wrap">
          {r.decision_note}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {r.decided_at && <span>Decided {relativeTime(r.decided_at)}</span>}
        {r.decided_by_email && <span>· by {r.decided_by_email}</span>}
        {r.status === "approved" && (
          <span>
            ·{" "}
            {r.used_at
              ? `used ${relativeTime(r.used_at)}`
              : r.expires_at
                ? new Date(r.expires_at) < new Date()
                  ? "expired, unused"
                  : `expires ${new Date(r.expires_at).toLocaleDateString()}`
                : "never expires, unused"}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ row: r }: { row: AttemptRequestRow }) {
  if (r.status === "pending") return <StatusPill tone="warning">Pending</StatusPill>;
  if (r.status === "rejected") return <StatusPill tone="neutral">Declined</StatusPill>;
  if (r.used_at) return <StatusPill tone="success">Granted · used</StatusPill>;
  if (r.expires_at && new Date(r.expires_at) < new Date()) return <StatusPill tone="neutral">Expired</StatusPill>;
  return <StatusPill tone="success">Granted</StatusPill>;
}

function CurrentScore({ row: r }: { row: AttemptRequestRow }) {
  if (r.current_score === null && !r.current_status) return null;
  const failed = r.current_status === "failed";
  const passed = r.current_status === "passed";
  const tone = passed
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : failed
      ? "bg-red-50 text-red-700 border-red-200"
      : "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${tone}`}>
      {r.current_score !== null ? `${r.current_score}%` : "—"}
      {r.current_status ? ` · ${r.current_status}` : ""}
    </span>
  );
}

function relativeTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} ${d === 1 ? "day" : "days"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} ${mo === 1 ? "month" : "months"} ago`;
  const y = Math.floor(mo / 12);
  return `${y} ${y === 1 ? "year" : "years"} ago`;
}
