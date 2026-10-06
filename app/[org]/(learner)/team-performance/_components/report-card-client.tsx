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
/** An additional URL-driven select (L3: group by, city, vertical, branch). */
export type ExtraFilter = { key: string; label: string; value: string; options: ContentOption[] };

const selectCls = "px-2 py-1.5 border border-line rounded-lg bg-paper text-xs min-w-[150px]";
const btnPrimary = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-ink text-canvas hover:opacity-90 disabled:opacity-50";
const btnSecondary = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-line bg-paper hover:border-ink disabled:opacity-50";

export function ReportFilters({
  orgSlug,
  basePath,
  current,
  contents,
  hideStatus = false,
  extras = [],
  keep = {},
}: {
  orgSlug: string;
  basePath: string;
  current: { period: string; content: string; status: string };
  contents: Array<{ label: string; options: ContentOption[] }>;
  /** The L2/L3 screens have no per-person status filter (§9). */
  hideStatus?: boolean;
  /** Extra selects written to the URL under their own keys (L3: by, city, vertical, branch). */
  extras?: ExtraFilter[];
  /** URL params preserved verbatim on every change and on Reset (a city / L2 group drill-down). */
  keep?: Record<string, string>;
}) {
  const router = useRouter();
  const keepQs = () => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v) qs.set(k, v);
    return qs;
  };
  const apply = (patch: Partial<typeof current>, extra: Record<string, string> = {}) => {
    const next = { ...current, ...patch };
    const qs = keepQs();
    if (next.period && next.period !== "30") qs.set("period", next.period);
    if (next.content) qs.set("content", next.content);
    if (next.status) qs.set("status", next.status);
    for (const e of extras) {
      const v = e.key in extra ? extra[e.key] : e.value;
      if (v && !(e.key === "by" && v === "city")) qs.set(e.key, v);
    }
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
      {!hideStatus && (
        <label className="text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Status</span>
          <select value={current.status} onChange={(e) => apply({ status: e.target.value })} className={selectCls}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      )}
      {extras.map((e) => (
        <label key={e.key} className="text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">{e.label}</span>
          <select value={e.value} onChange={(ev) => apply({}, { [e.key]: ev.target.value })} className={selectCls}>
            {e.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      ))}
      {(current.period !== "30" || current.content || current.status || extras.some((e) => e.value && !(e.key === "by" && e.value === "city"))) && (
        <button type="button" className="text-xs text-muted underline underline-offset-2 hover:text-ink pb-2" onClick={() => { const q = keepQs().toString(); router.push(`/${orgSlug}/${basePath}${q ? `?${q}` : ""}`); }}>
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
  useDialogKeys(open, () => setOpen(false));

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
              <button type="button" aria-label="Dismiss" autoFocus className="p-1 rounded-lg hover:bg-canvas" onClick={() => setOpen(false)}><X className="w-4 h-4" /></button>
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

/** §8 Compare: pick two or three teams, open the side-by-side page. */
/** Escape closes an open dialog; focus moves into it on open and back to the trigger on close. */
function useDialogKeys(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
}

export function ComparePicker({
  orgSlug,
  teams,
  query = "",
  label = "Compare teams",
  param = "teams",
}: {
  orgSlug: string;
  teams: Array<{ managerId: string; name: string }>;
  query?: string;
  label?: string;
  /** URL key on the compare page: teams | cities | l2s. */
  param?: "teams" | "cities" | "l2s";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // Portalled like the assign dialog: page children are animated with a
  // transform (own stacking context), so an in-place popover paints behind
  // the next card.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useDialogKeys(open, () => setOpen(false));
  if (teams.length < 2) return null;
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 3 ? p : [...p, id]));
  return (
    <>
      <button type="button" className={btnSecondary} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && mounted && createPortal(
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={label}>
          <div className="bg-paper border border-line rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold">{label}</h2>
              <button type="button" aria-label="Dismiss" autoFocus className="p-1 rounded-lg hover:bg-canvas" onClick={() => setOpen(false)}><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[10px] uppercase tracking-wide text-muted">Pick 2–3</p>
            <ul className="max-h-64 overflow-y-auto divide-y divide-line border border-line rounded-lg">
              {teams.map((t) => (
                <li key={t.managerId}>
                  <label className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer">
                    <input type="checkbox" checked={picked.includes(t.managerId)} onChange={() => toggle(t.managerId)} disabled={!picked.includes(t.managerId) && picked.length >= 3} />
                    {t.name}
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" className={btnSecondary} onClick={() => setOpen(false)}>Close</button>
              <button type="button" className={btnPrimary} disabled={picked.length < 2} onClick={() => router.push(`/${orgSlug}/team-performance/compare?${picked.map((v) => `${param}=${encodeURIComponent(v)}`).join("&")}${query ? `&${query.slice(1)}` : ""}`)}>
                Compare {picked.length ? `(${picked.length})` : ""}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
