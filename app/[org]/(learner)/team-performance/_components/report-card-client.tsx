"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { BookPlus, Loader2, X } from "lucide-react";
import { PERIODS, STATUS_FILTERS, type ExceptionAction } from "@/lib/manager/types";

/**
 * Client pieces of the Report Card: URL-driven filters (the server re-derives
 * everything, so views are shareable), the action buttons behind each
 * exception (send reminder / grant retry), and the assign-a-course dialog.
 * Every action re-checks the hierarchy on the server; the browser only names
 * people it was shown.
 */

export type ContentOption = { value: string; label: string };
export type TeamMember = { userId: string; name: string };

const selectCls = "px-2 py-1.5 border border-line rounded-lg bg-paper text-xs min-w-[150px]";
const btnPrimary = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-ink text-canvas hover:opacity-90 disabled:opacity-50";
const btnSecondary = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-line bg-paper hover:border-ink disabled:opacity-50";

export function ReportFilters({
  orgSlug,
  basePath,
  current,
  contents,
}: {
  orgSlug: string;
  basePath: string;
  current: { period: string; content: string; status: string };
  contents: Array<{ label: string; options: ContentOption[] }>;
}) {
  const router = useRouter();
  const apply = (patch: Partial<typeof current>) => {
    const next = { ...current, ...patch };
    const qs = new URLSearchParams();
    if (next.period && next.period !== "30") qs.set("period", next.period);
    if (next.content) qs.set("content", next.content);
    if (next.status) qs.set("status", next.status);
    const q = qs.toString();
    router.push(`/${orgSlug}/${basePath}${q ? `?${q}` : ""}`);
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs">
        <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Period</span>
        <select value={current.period} onChange={(e) => apply({ period: e.target.value })} className={selectCls}>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </label>
      <label className="text-xs">
        <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Content</span>
        <select value={current.content} onChange={(e) => apply({ content: e.target.value })} className={selectCls}>
          <option value="">All content</option>
          {contents.map((g) =>
            g.options.length ? (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </optgroup>
            ) : null
          )}
        </select>
      </label>
      <label className="text-xs">
        <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Status</span>
        <select value={current.status} onChange={(e) => apply({ status: e.target.value })} className={selectCls}>
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </label>
      {(current.period !== "30" || current.content || current.status) && (
        <button type="button" className="text-xs text-muted underline underline-offset-2 hover:text-ink pb-2" onClick={() => apply({ period: "30", content: "", status: "" })}>
          Reset
        </button>
      )}
    </div>
  );
}

type ActionResult = { results?: Array<{ userId: string; status: string; reason?: string }>; error?: string };

function summarize(r: ActionResult, verb: string): string {
  if (r.error) return r.error;
  const rs = r.results ?? [];
  const did = rs.filter((x) => x.status === "sent" || x.status === "granted" || x.status === "assigned").length;
  const skipped = rs.filter((x) => x.status !== "sent" && x.status !== "granted" && x.status !== "assigned");
  const reasons = [...new Set(skipped.map((x) => x.reason).filter(Boolean))];
  return `${verb} ${did}` + (skipped.length ? ` · ${skipped.length} skipped${reasons.length ? ` (${reasons.join("; ")})` : ""}` : "") + ".";
}

/** One exception action: a link, or a POST to the matching manager endpoint. */
export function ActionButton({ orgSlug, action, primary }: { orgSlug: string; action: ExceptionAction; primary?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cls = primary ? btnPrimary : btnSecondary;

  if (action.kind === "link") return <a href={action.href} className={cls}>{action.label}</a>;
  if (action.kind === "report") return <a href={`/${orgSlug}/team-performance/${action.userId}`} className={cls}>{action.label}</a>;

  const run = async () => {
    setBusy(true);
    setNote(null);
    setConfirming(false);
    const path = action.kind === "grant" ? "/api/manager/grant" : "/api/manager/remind";
    const body =
      action.kind === "grant"
        ? { orgSlug, userIds: action.userIds, courseId: action.courseId }
        : { orgSlug, userIds: action.userIds, target: action.target, contentId: action.contentId };
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as ActionResult;
      setNote(res.ok ? summarize(j, action.kind === "grant" ? "Granted" : "Sent") : j.error ?? "Something went wrong");
      if (res.ok) router.refresh();
    } catch {
      setNote("Network error — please try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {confirming ? (
        <>
          <span className="text-xs">
            {action.kind === "grant" ? `Grant 1 extra attempt to ${action.userIds.length}?` : `Email ${action.userIds.length} now?`}
          </span>
          <button type="button" className={btnPrimary} onClick={run}>Yes</button>
          <button type="button" className={btnSecondary} aria-label="Cancel" onClick={() => setConfirming(false)}><X className="w-3 h-3" /></button>
        </>
      ) : (
        <button type="button" className={cls} disabled={busy} onClick={() => setConfirming(true)}>
          {busy && <Loader2 className="w-3 h-3 animate-spin" />} {action.label}
          {action.userIds.length > 1 ? ` (${action.userIds.length})` : ""}
        </button>
      )}
      {note && <span role="status" className="text-xs text-muted">{note}</span>}
    </span>
  );
}

export function AssignCourseDialog({
  orgSlug,
  courses,
  team,
  preselected = [],
  label = "Assign a course",
}: {
  orgSlug: string;
  courses: ContentOption[];
  team: TeamMember[];
  preselected?: string[];
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(preselected.length ? preselected : team.map((t) => t.userId)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The overlay is portalled to <body>: the learner shell animates page
  // children with a transform, which would turn a fixed overlay rendered in
  // place into a box clipped to its (animated) ancestor.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/manager/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, userIds: [...picked], courseId, dueAt: dueAt || null }),
      });
      const j = (await res.json().catch(() => ({}))) as ActionResult;
      setNote(res.ok ? summarize(j, "Assigned") : j.error ?? "Something went wrong");
      if (res.ok) router.refresh();
    } catch {
      setNote("Network error — please try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={btnSecondary} onClick={() => setOpen(true)}>
        <BookPlus className="w-3.5 h-3.5" /> {label}
      </button>
      {open && mounted && createPortal(
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Assign a course">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold">Assign a course</h2>
              <button type="button" aria-label="Dismiss" className="p-1 rounded-lg hover:bg-canvas" onClick={() => setOpen(false)}><X className="w-4 h-4" /></button>
            </div>
            <label className="block text-xs">
              <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Course</span>
              <select value={courseId} onChange={(e) => setCourseId(e.target.value)} className={`${selectCls} w-full`}>
                <option value="">Select a course…</option>
                {courses.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Due date (optional)</span>
              <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={`${selectCls} w-full`} />
            </label>
            <fieldset className="text-xs">
              <legend className="text-[10px] uppercase tracking-wide text-muted mb-1">Who ({picked.size} of {team.length})</legend>
              <div className="flex gap-2 mb-1">
                <button type="button" className="underline text-muted" onClick={() => setPicked(new Set(team.map((t) => t.userId)))}>All</button>
                <button type="button" className="underline text-muted" onClick={() => setPicked(new Set())}>None</button>
              </div>
              <ul className="max-h-48 overflow-y-auto divide-y divide-line border border-line rounded-lg">
                {team.map((t) => (
                  <li key={t.userId}>
                    <label className="flex items-center gap-2 px-3 py-1.5 cursor-pointer">
                      <input type="checkbox" checked={picked.has(t.userId)} onChange={() => toggle(t.userId)} />
                      {t.name}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            {note && <p role="status" className="text-xs text-muted">{note}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btnSecondary} onClick={() => setOpen(false)}>Close</button>
              <button type="button" className={btnPrimary} disabled={busy || !courseId || picked.size === 0} onClick={submit}>
                {busy && <Loader2 className="w-3 h-3 animate-spin" />} Assign to {picked.size}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
