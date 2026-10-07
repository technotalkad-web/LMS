"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertOctagon, AlertTriangle, Check, Search, Wand2 } from "lucide-react";
import {
  LEVEL_FIELDS,
  LEVEL_LABELS,
  type BackfillSuggestion,
  type IntegrityIssue,
} from "@/lib/org/reporting-line";
import type { ReportingLineRow, ReportingLinesData } from "@/lib/org/reporting-lines-data";

const LEVELS = [1, 2, 3] as const;
type ManagerCol = (typeof LEVEL_FIELDS)[1 | 2 | 3];
const ISSUE_TITLES: Record<IntegrityIssue["code"], string> = {
  self_reference: "Points at themselves",
  cycle: "Reporting cycle",
  manager_missing: "Manager is not a member",
  manager_inactive: "Manager is inactive",
  chain_mismatch_l2: "L2 is not the L1's manager",
  chain_mismatch_l3: "L3 is not the L2's manager",
  missing_l1: "No L1 manager",
  missing_l2: "No L2 manager",
  missing_l3: "No L3 manager",
  manager_no_vertical: "Manager has no Business Vertical",
  manager_no_department: "Manager has no Department",
};
/** Suggestions per backfill request; the API caps a request at 5000. */
const BACKFILL_CHUNK = 2000;
const inputCls =
  "w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink";
const btnCls =
  "inline-flex items-center gap-1.5 px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50";

type Feedback = { kind: "ok" | "error"; text: string; where: "editor" | "backfill" };

export function ReportingLinesClient({
  orgSlug,
  initial,
}: {
  orgSlug: string;
  initial: ReportingLinesData;
}) {
  const [data, setData] = useState<ReportingLinesData>(initial);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The editor never snapshots the person: what it shows is the latest
  // loaded row plus the admin's explicit edits (`overrides`). A refresh after
  // a save/backfill therefore can't leave a stale draft that a later Save
  // would silently write back.
  const [overrides, setOverrides] = useState<Partial<Record<ManagerCol, string>>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const [openWarning, setOpenWarning] = useState<string | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);

  const byId = useMemo(() => new Map(data.members.map((m) => [m.user_id, m])), [data.members]);
  const active = useMemo(() => data.members.filter((m) => m.status === "active"), [data.members]);
  const label = (id: string | null | undefined) => (id ? byId.get(id)?.name ?? id.slice(0, 8) : "—");

  const stats = useMemo(() => {
    const managers = LEVELS.map(
      (l) => new Set(active.map((m) => m[LEVEL_FIELDS[l]]).filter(Boolean)).size
    );
    return {
      active: active.length,
      managers,
      blocking: data.issues.filter((i) => i.severity === "block").length,
      warnings: data.issues.filter((i) => i.severity === "warn").length,
    };
  }, [active, data.issues]);

  const blocking = data.issues.filter((i) => i.severity === "block");
  const warningGroups = useMemo(() => {
    const g = new Map<IntegrityIssue["code"], IntegrityIssue[]>();
    for (const i of data.issues) {
      if (i.severity !== "warn") continue;
      g.set(i.code, [...(g.get(i.code) ?? []), i]);
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data.issues]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return data.members
      .filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          (m.email ?? "").toLowerCase().includes(q) ||
          (m.employee_id ?? "").toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [query, data.members]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const reports = useMemo(() => {
    if (!selectedId) return null;
    return LEVELS.map((l) => active.filter((m) => m[LEVEL_FIELDS[l]] === selectedId));
  }, [selectedId, active]);

  /** What the editor shows for a level: the admin's edit if any, else the loaded value. */
  const shown = (col: ManagerCol): string =>
    overrides[col] !== undefined ? overrides[col]! : selected?.[col] ?? "";

  function select(id: string, scroll = true) {
    setSelectedId(id);
    setOverrides({});
    setFeedback(null);
    if (scroll) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function refresh() {
    const res = await fetch(`/api/reporting-lines?orgSlug=${encodeURIComponent(orgSlug)}`);
    if (res.ok) setData((await res.json()) as ReportingLinesData);
  }

  async function save() {
    if (!selected) return;
    setBusy(true);
    setFeedback(null);
    // Only what the admin actually changed, diffed against the LATEST row.
    const patch: Record<string, string | null> = {};
    for (const col of Object.values(LEVEL_FIELDS)) {
      const v = overrides[col];
      if (v !== undefined && v !== (selected[col] ?? "")) patch[col] = v || null;
    }
    if (Object.keys(patch).length === 0) {
      setBusy(false);
      setFeedback({ kind: "ok", text: "No changes.", where: "editor" });
      return;
    }
    const res = await fetch("/api/reporting-lines", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, user_id: selected.user_id, ...patch }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; warnings?: string[] };
    setBusy(false);
    if (!res.ok) {
      setFeedback({ kind: "error", text: j.error ?? "Could not save", where: "editor" });
      return;
    }
    setOverrides({});
    setFeedback({
      kind: "ok",
      text: j.warnings && j.warnings.length > 0 ? `Saved. ${j.warnings.join(" ")}` : "Saved.",
      where: "editor",
    });
    await refresh();
  }

  async function applyBackfill(rows: BackfillSuggestion[]) {
    setBusy(true);
    setFeedback(null);
    let applied = 0, skipped = 0;
    const failed: string[] = [];
    let error: string | null = null;
    for (let i = 0; i < rows.length && !error; i += BACKFILL_CHUNK) {
      const res = await fetch("/api/reporting-lines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          apply: rows
            .slice(i, i + BACKFILL_CHUNK)
            .map((s) => ({ user_id: s.user_id, level: s.level, manager_id: s.suggested })),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        applied?: number;
        skipped?: number;
        failed?: string[];
      };
      if (!res.ok) {
        error = j.error ?? "Backfill failed";
        break;
      }
      applied += j.applied ?? 0;
      skipped += j.skipped ?? 0;
      failed.push(...(j.failed ?? []));
    }
    setBusy(false);
    setConfirmBackfill(false);
    if (error && applied === 0) {
      setFeedback({ kind: "error", text: error, where: "backfill" });
      return;
    }
    setFeedback({
      kind: failed.length > 0 || error ? "error" : "ok",
      text:
        `Applied ${applied} change${applied === 1 ? "" : "s"}` +
        (skipped ? ` (${skipped} no longer applicable)` : "") +
        (failed.length > 0 ? ` — ${failed.length} batch${failed.length === 1 ? "" : "es"} failed` : "") +
        (error ? ` — then stopped: ${error}` : "") +
        ".",
      where: "backfill",
    });
    await refresh();
  }

  const feedbackBox = (where: Feedback["where"]) =>
    feedback && feedback.where === where ? (
      <p
        role="status"
        className={`text-sm rounded-lg border p-2 ${
          feedback.kind === "error"
            ? "border-red-200 bg-red-50 text-red-900"
            : "border-emerald-200 bg-emerald-50 text-emerald-900"
        }`}
      >
        {feedback.text}
      </p>
    ) : null;

  /** Why a stored manager id is not in the picker (shown as a stale option). */
  const staleReason = (id: string): string => {
    if (selected && id === selected.user_id) return "themselves";
    const m = byId.get(id);
    return m ? (m.status === "active" ? "" : m.status) : "not a member";
  };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Active members" value={stats.active} />
        <Stat label="L1 managers" value={stats.managers[0]} />
        <Stat label="L2 managers" value={stats.managers[1]} />
        <Stat label="L3 managers" value={stats.managers[2]} />
        <Stat
          label="To fix / to review"
          value={`${stats.blocking} / ${stats.warnings}`}
          tone={stats.blocking > 0 ? "bad" : stats.warnings > 0 ? "warn" : "ok"}
        />
      </section>

      {/* Person lookup + editor (kept near the top: the tables below link here) */}
      <section ref={editorRef} className="border border-line rounded-lg bg-paper p-5 scroll-mt-4">
        <h2 className="font-semibold text-sm mb-1">Look up a person</h2>
        <p className="text-xs text-muted mb-3">
          See and change who they report to, and who reports to them at each level. Click a name
          in any table below to open them here.
        </p>
        <div className="relative">
          <Search className="w-4 h-4 text-muted absolute left-3 top-2.5" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, email or employee ID"
            className={`${inputCls} pl-9`}
            aria-label="Search members"
          />
        </div>
        {matches.length > 0 && (
          <ul className="mt-2 border border-line rounded-lg divide-y divide-line bg-canvas max-h-64 overflow-y-auto">
            {matches.map((m) => (
              <li key={m.user_id}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-paper flex justify-between gap-3"
                  onClick={() => {
                    select(m.user_id, false);
                    setQuery("");
                  }}
                >
                  <span>
                    {m.name}
                    {m.status !== "active" && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-muted">{m.status}</span>
                    )}
                  </span>
                  <span className="text-muted truncate">{m.email ?? m.employee_id ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected && reports && (
          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-semibold">
                {selected.name}{" "}
                <span className="text-muted font-normal">
                  {selected.email ?? ""}
                  {selected.employee_id ? ` · ${selected.employee_id}` : ""}
                  {selected.status !== "active" ? ` · ${selected.status}` : ""}
                </span>
              </h3>
              <div className="mt-3 space-y-3">
                {LEVELS.map((l) => {
                  const col = LEVEL_FIELDS[l];
                  const cur = shown(col);
                  // The stored manager may be inactive, gone or the person
                  // themselves (exactly what "Must fix" points at): show them
                  // as a labelled option so the control tells the truth and
                  // "—" stays selectable to clear.
                  const stale =
                    !!cur && !active.some((m) => m.user_id === cur && m.user_id !== selected.user_id);
                  return (
                    <label key={col} className="block">
                      <span className="block text-xs font-medium mb-1">{LEVEL_LABELS[l]}</span>
                      <select
                        value={cur}
                        onChange={(e) => setOverrides((o) => ({ ...o, [col]: e.target.value }))}
                        className={inputCls}
                      >
                        <option value="">—</option>
                        {stale && (
                          <option value={cur}>
                            {label(cur)} ({staleReason(cur)})
                          </option>
                        )}
                        {active
                          .filter((m) => m.user_id !== selected.user_id)
                          .map((m) => (
                            <option key={m.user_id} value={m.user_id}>
                              {m.name}
                              {m.email ? ` (${m.email})` : ""}
                            </option>
                          ))}
                      </select>
                    </label>
                  );
                })}
                <div className="flex items-center gap-3">
                  <button type="button" className={btnCls} disabled={busy} onClick={save}>
                    Save
                  </button>
                  <Link
                    href={`/${orgSlug}/users/${selected.user_id}/edit`}
                    className="text-sm text-muted hover:text-ink"
                  >
                    Open full profile
                  </Link>
                </div>
                {feedbackBox("editor")}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Reports to {selected.name}</h3>
              <div className="mt-3 space-y-3">
                {LEVELS.map((l, i) => (
                  <div key={l}>
                    <p className="text-xs font-medium">
                      As {LEVEL_LABELS[l]} — {reports[i].length}
                    </p>
                    {reports[i].length > 0 && (
                      <ul className="mt-1 text-sm text-muted max-h-40 overflow-y-auto">
                        {reports[i].slice(0, 100).map((m) => (
                          <li key={m.user_id}>
                            <button type="button" className="hover:underline hover:text-ink" onClick={() => select(m.user_id, false)}>
                              {m.name}
                            </button>
                          </li>
                        ))}
                        {reports[i].length > 100 && <li>…and {reports[i].length - 100} more</li>}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Blocking issues */}
      <section className="border border-line rounded-lg bg-paper p-5">
        <div className="flex items-center gap-2 mb-1">
          <AlertOctagon className={`w-4 h-4 ${blocking.length ? "text-red-600" : "text-muted"}`} />
          <h2 className="font-semibold text-sm">Must fix ({blocking.length})</h2>
        </div>
        <p className="text-xs text-muted mb-3">
          Self-references, cycles and managers who are missing or inactive. These people are
          invisible (or wrongly visible) to their managers until fixed.
        </p>
        {blocking.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-600" /> Nothing to fix.
          </p>
        ) : (
          <IssueTable issues={blocking.slice(0, 200)} label={label} onPick={select} />
        )}
        {blocking.length > 200 && (
          <p className="text-xs text-muted mt-2">Showing the first 200 of {blocking.length}.</p>
        )}
      </section>

      {/* Backfill */}
      <section className="border border-line rounded-lg bg-paper p-5">
        <div className="flex items-start justify-between gap-4 mb-1">
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-indigo-600" />
            <h2 className="font-semibold text-sm">
              Fill in missing L2 / L3 from the L1 chain ({data.suggestions.length})
            </h2>
          </div>
          {data.suggestions.length > 0 && !confirmBackfill && (
            <button type="button" className={btnCls} disabled={busy} onClick={() => setConfirmBackfill(true)}>
              Review &amp; apply all
            </button>
          )}
        </div>
        <p className="text-xs text-muted mb-3">
          Suggested only — nothing is written until you confirm. An empty L2 becomes the L1
          manager&rsquo;s own manager; an empty L3 becomes the L2 manager&rsquo;s own manager.
          People whose chain has gaps are left for you to set by hand.
        </p>
        {confirmBackfill && (
          <div className="border border-indigo-200 bg-indigo-50 rounded-lg p-3 mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>
              Apply all <strong>{data.suggestions.length}</strong> suggested manager assignments?
            </span>
            <span className="flex gap-2">
              <button type="button" className="px-3 py-1.5 border border-line rounded-lg bg-paper" onClick={() => setConfirmBackfill(false)}>
                Cancel
              </button>
              <button type="button" className={btnCls} disabled={busy} onClick={() => applyBackfill(data.suggestions)}>
                Yes, apply {data.suggestions.length}
              </button>
            </span>
          </div>
        )}
        <div className="mb-3">{feedbackBox("backfill")}</div>
        {data.suggestions.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-600" /> No suggestions — every L2/L3 that can be
            derived from the chain is already set.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted text-left">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Person</th>
                  <th className="py-1.5 pr-3 font-medium">Set</th>
                  <th className="py-1.5 pr-3 font-medium">To</th>
                  <th className="py-1.5 pr-3 font-medium">Because</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {data.suggestions.slice(0, 200).map((s) => (
                  <tr key={`${s.user_id}:${s.level}`} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      <button type="button" className="hover:underline" onClick={() => select(s.user_id)}>
                        {label(s.user_id)}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3">{LEVEL_LABELS[s.level]}</td>
                    <td className="py-1.5 pr-3">{label(s.suggested)}</td>
                    <td className="py-1.5 pr-3 text-muted">{s.via}</td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        className="text-xs px-2 py-1 border border-line rounded-lg hover:bg-canvas disabled:opacity-50"
                        disabled={busy}
                        onClick={() => applyBackfill([s])}
                      >
                        Apply
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.suggestions.length > 200 && (
              <p className="text-xs text-muted mt-2">
                Showing the first 200 of {data.suggestions.length}; &ldquo;apply all&rdquo; covers every one.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Warnings */}
      <section className="border border-line rounded-lg bg-paper p-5">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className={`w-4 h-4 ${warningGroups.length ? "text-amber-600" : "text-muted"}`} />
          <h2 className="font-semibold text-sm">Worth a look ({stats.warnings})</h2>
        </div>
        <p className="text-xs text-muted mb-3">
          Gaps and chain mismatches. Saved as-is; they only limit what a manager can see.
        </p>
        {warningGroups.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-600" /> Nothing to review.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {warningGroups.map(([code, list]) => (
              <li key={code} className="py-2">
                <button
                  type="button"
                  className="w-full flex justify-between text-sm"
                  onClick={() => setOpenWarning((o) => (o === code ? null : code))}
                  aria-expanded={openWarning === code}
                >
                  <span>{ISSUE_TITLES[code]}</span>
                  <span className="text-muted">{list.length}</span>
                </button>
                {openWarning === code && (
                  <div className="mt-2">
                    <IssueTable issues={list.slice(0, 200)} label={label} onPick={select} />
                    {list.length > 200 && (
                      <p className="text-xs text-muted mt-2">Showing the first 200 of {list.length}.</p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "ok" | "warn" | "bad" }) {
  const color =
    tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : tone === "ok" ? "text-emerald-700" : "";
  return (
    <div className="border border-line rounded-lg bg-paper p-3">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`text-2xl font-semibold mt-0.5 ${color}`}>{value}</p>
    </div>
  );
}

function IssueTable({
  issues,
  label,
  onPick,
}: {
  issues: IntegrityIssue[];
  label: (id: string | null | undefined) => string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted text-left">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Person</th>
            <th className="py-1.5 pr-3 font-medium">Level</th>
            <th className="py-1.5 pr-3 font-medium">Manager</th>
            <th className="py-1.5 font-medium">Problem</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i, n) => (
            <tr key={`${i.user_id}:${i.code}:${i.level}:${n}`} className="border-t border-line">
              <td className="py-1.5 pr-3">
                <button type="button" className="hover:underline" onClick={() => onPick(i.user_id)}>
                  {label(i.user_id)}
                </button>
              </td>
              <td className="py-1.5 pr-3">{i.level ? LEVEL_LABELS[i.level] : "—"}</td>
              <td className="py-1.5 pr-3">{label(i.manager_id)}</td>
              <td className="py-1.5">{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type { ReportingLineRow };
