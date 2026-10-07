"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { LifeBuoy, Loader2, X } from "lucide-react";
import { PERIODS, STATUS_FILTERS, type ExceptionAction, type TicketPerson } from "@/lib/manager/types";
import { TICKET_CATEGORIES, type TicketCategory } from "@/lib/tickets/types";

/**
 * Client pieces of the Report Card: URL-driven filters (the server re-derives
 * everything, so views are shareable), the action buttons behind each
 * exception (send reminder, or raise a support ticket with the context —
 * decision 12: managers view, analyse and support; admins act), and the
 * compare picker. Every action re-checks the hierarchy on the server; the
 * browser only names people it was shown.
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
  const did = rs.filter((x) => x.status === "sent").length;
  const skipped = rs.filter((x) => x.status !== "sent");
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
  if (action.kind === "ticket") {
    return <RaiseTicketButton orgSlug={orgSlug} label={action.label} category={action.category} people={action.people} content={action.content} exception={action.exception} origin="team-performance" primary={primary} />;
  }

  const run = async () => {
    setBusy(true);
    setNote(null);
    setConfirming(false);
    const body = { orgSlug, userIds: action.userIds, target: action.target, contentId: action.contentId };
    try {
      const res = await fetch("/api/manager/remind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as ActionResult;
      setNote(res.ok ? summarize(j, "Sent") : j.error ?? "Something went wrong");
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
          <span className="text-xs">{`Email ${action.userIds.length} now?`}</span>
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

export type TicketContent = { kind: "course" | "journey" | "path"; id: string; title: string } | null;

/**
 * "Raise ticket": opens the support form with the Report Card context already
 * filled in — the people (locked when the exception names them, pickable from
 * the team otherwise), the content and the exception. The server re-checks
 * every id against the manager's hierarchy. After a successful raise the
 * button turns into a confirmation with a link to Help & Support.
 */
export function RaiseTicketButton({
  orgSlug,
  label,
  category,
  people,
  team = [],
  content,
  exception,
  origin,
  primary = false,
}: {
  orgSlug: string;
  label: string;
  category: TicketCategory;
  /** Pre-filled people (locked). */
  people: TicketPerson[];
  /** When `people` is empty, the manager may pick from this list. */
  team?: TeamMember[];
  content: TicketContent;
  exception: string | null;
  origin: string;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<TicketCategory>(category);
  const [priority, setPriority] = useState<"low" | "normal" | "high">("normal");
  const [note, setNote] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(people.map((p) => p.userId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Portalled to <body>: the learner shell animates page children with a
  // transform, which would clip a fixed overlay rendered in place.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useDialogKeys(open, () => setOpen(false));
  const locked = people.length > 0;
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const names = locked ? people : team.filter((t) => picked.has(t.userId)).map((t) => ({ userId: t.userId, name: t.name }));
  const needsPeople = cat === "grant_retry" || cat === "assign_content" || cat === "extend_due";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          body: note,
          priority,
          category: cat,
          context: {
            userIds: names.map((p) => p.userId),
            contentKind: content?.kind ?? null,
            contentId: content?.id ?? null,
            exception,
            origin,
            dueAt: cat === "extend_due" && dueAt ? dueAt : null,
          },
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string; subject?: string; error?: string };
      if (!res.ok) { setError(j.error ?? "Something went wrong"); return; }
      setDone(j.subject ?? "Ticket raised");
      setOpen(false);
    } catch {
      setError("Network error — please try again");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <span role="status" className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
        Ticket raised: {done} · <a href={`/${orgSlug}/support`} className="underline">Track it in Help &amp; Support</a>
        · <button type="button" className="underline" onClick={() => { setDone(null); setNote(""); }}>Raise another</button>
      </span>
    );
  }
  // Requests that need named people are offered only when people can be named.
  const canNamePeople = locked || team.length > 0;
  const categories = TICKET_CATEGORIES.filter((c) => canNamePeople || (c.value !== "grant_retry" && c.value !== "assign_content" && c.value !== "extend_due"));
  return (
    <>
      <button type="button" className={primary ? btnPrimary : btnSecondary} onClick={() => setOpen(true)}>
        <LifeBuoy className="w-3.5 h-3.5" /> {label}
        {locked && people.length > 1 ? ` (${people.length})` : ""}
      </button>
      {open && mounted && createPortal(
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Raise a support ticket">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Raise a support ticket</h2>
                <p className="text-xs text-muted mt-0.5">Your admin reviews it and takes the action. You will be emailed with the outcome.</p>
              </div>
              <button type="button" aria-label="Dismiss" autoFocus className="p-1 rounded-lg hover:bg-canvas" onClick={() => setOpen(false)}><X className="w-4 h-4" /></button>
            </div>

            <div className="rounded-xl bg-canvas/70 border border-line p-3 text-xs space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted">Context (from your Report Card)</div>
              {content && <div><span className="text-muted">{content.kind === "journey" ? "Journey" : content.kind === "path" ? "Learning path" : "Course"}:</span> {content.title}</div>}
              {exception && <div><span className="text-muted">Flagged as:</span> {exception.replace(/_/g, " ")}</div>}
              {locked && (
                <div>
                  <span className="text-muted">{people.length === 1 ? "Employee" : "Employees"}:</span>{" "}
                  {people.some((p) => p.name)
                    ? `${people.slice(0, 8).map((p) => p.name || "—").join(", ")}${people.length > 8 ? ` +${people.length - 8}` : ""}`
                    : `${people.length} ${people.length === 1 ? "person" : "people"} from this team (named on the ticket)`}
                </div>
              )}
              {!content && !exception && !locked && <div className="text-muted">No specific employee or content — describe the issue below.</div>}
            </div>

            {!locked && team.length > 0 && (
              <fieldset className="text-xs">
                <legend className="text-[10px] uppercase tracking-wide text-muted mb-1">Employees ({picked.size} of {team.length})</legend>
                <div className="flex gap-2 mb-1">
                  <button type="button" className="underline text-muted" onClick={() => setPicked(new Set(team.map((t) => t.userId)))}>All</button>
                  <button type="button" className="underline text-muted" onClick={() => setPicked(new Set())}>None</button>
                </div>
                <ul className="max-h-40 overflow-y-auto divide-y divide-line border border-line rounded-lg">
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
            )}

            <label className="block text-xs">
              <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Request</span>
              <select value={cat} onChange={(e) => setCat(e.target.value as TicketCategory)} className={`${selectCls} w-full`}>
                {categories.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </label>
            {cat === "extend_due" && (
              <label className="block text-xs">
                <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">New due date</span>
                <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={`${selectCls} w-full`} />
              </label>
            )}
            <label className="block text-xs">
              <span className="block text-[10px] uppercase tracking-wide text-muted mb-0.5">Note for your admin</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What you observed and what you are asking for…" className="w-full px-3 py-2 border border-line rounded-lg bg-paper text-sm" />
            </label>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[10px] uppercase tracking-wide text-muted">Priority</span>
              {(["low", "normal", "high"] as const).map((p) => (
                <button key={p} type="button" aria-pressed={priority === p} onClick={() => setPriority(p)} className={`px-2.5 py-1 rounded-lg border ${priority === p ? "border-ink bg-ink text-canvas" : "border-line"}`}>{p}</button>
              ))}
            </div>
            {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btnSecondary} onClick={() => setOpen(false)}>Close</button>
              <button type="button" className={btnPrimary} disabled={busy || (needsPeople && names.length === 0) || (cat === "extend_due" && !dueAt) || (!content && !locked && names.length === 0 && !note.trim())} onClick={submit}>
                {busy && <Loader2 className="w-3 h-3 animate-spin" />} Raise ticket
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
  // The callback is read through a ref so an inline arrow does not re-run the
  // effect on every render (which would move focus back to the trigger on
  // each keystroke inside the dialog).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);
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
