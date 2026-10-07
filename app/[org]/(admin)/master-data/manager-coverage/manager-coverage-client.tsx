"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Plus, X } from "lucide-react";
import type { ScopeOptions } from "../../_components/scope-picker";

export type ManagerRow = {
  user_id: string;
  name: string;
  vertical: string | null;
  department: string | null;
  coverage: Array<{ id: string; vertical: string; department: string | null }>;
};

export function ManagerCoverageClient({ orgSlug, managers, options }: { orgSlug: string; managers: ManagerRow[]; options: ScopeOptions }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Record<string, { vertical: string; department: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = managers.filter((m) => !q.trim() || m.name.toLowerCase().includes(q.trim().toLowerCase()));
  const missing = managers.filter((m) => !m.vertical).length;

  const call = async (key: string, method: "POST" | "DELETE", body: unknown) => {
    setBusy(key);
    setError(null);
    const res = await fetch("/api/manager-coverage", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (!res.ok) { setError(j.error ?? "Could not save"); return false; }
    router.refresh();
    return true;
  };

  return (
    <div className="space-y-4">
      {missing > 0 && (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          {missing} manager{missing === 1 ? " has" : "s have"} no Business Vertical on their record and will see no mapped content until it is set (Users → edit) or a coverage pair is granted below.
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search managers…" aria-label="Search managers" className="px-3 py-2 border border-line rounded-lg bg-paper text-sm min-w-[240px]" />
      <div className="bg-paper border border-line rounded-xl divide-y divide-line">
        {visible.map((m) => {
          const d = draft[m.user_id] ?? { vertical: "", department: "" };
          const depts = d.vertical ? options.departmentsByVertical[d.vertical] ?? [] : [];
          return (
            <div key={m.user_id} className="px-4 py-3 flex flex-col gap-2" data-testid={`coverage-${m.user_id}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">{m.name}</span>
                <span className={`text-xs ${m.vertical ? "text-muted" : "text-amber-700 font-medium"}`}>
                  Own record: {m.vertical ? `${m.vertical}${m.department ? ` · ${m.department}` : " (all)"}` : "no vertical set"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {m.coverage.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-1 border border-line bg-canvas rounded-full pl-2.5 pr-1 py-0.5 text-xs">
                    {c.department ? `${c.vertical} · ${c.department}` : `${c.vertical} (all)`}
                    <button type="button" onClick={() => call(c.id, "DELETE", { orgSlug, id: c.id })} disabled={busy === c.id} aria-label={`Remove ${c.vertical}${c.department ? ` ${c.department}` : ""} from ${m.name}`} className="p-0.5 rounded-full text-muted hover:text-red-600 hover:bg-red-50">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <select value={d.vertical} onChange={(e) => setDraft((s) => ({ ...s, [m.user_id]: { vertical: e.target.value, department: "" } }))} aria-label={`Extra vertical for ${m.name}`} className="px-2 py-1 border border-line rounded-lg bg-paper text-xs">
                  <option value="">Add a vertical…</option>
                  {options.verticals.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <select value={d.department} onChange={(e) => setDraft((s) => ({ ...s, [m.user_id]: { ...d, department: e.target.value } }))} disabled={!d.vertical || depts.length === 0} aria-label={`Extra department for ${m.name}`} className="px-2 py-1 border border-line rounded-lg bg-paper text-xs disabled:opacity-50">
                  <option value="">Whole vertical</option>
                  {depts.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                <button
                  type="button"
                  disabled={!d.vertical || busy === m.user_id}
                  onClick={async () => { if (await call(m.user_id, "POST", { orgSlug, user_id: m.user_id, vertical: d.vertical, department: d.department || null })) setDraft((s) => ({ ...s, [m.user_id]: { vertical: "", department: "" } })); }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 border border-line rounded-lg text-xs font-medium hover:border-ink disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Grant
                </button>
              </div>
            </div>
          );
        })}
        {visible.length === 0 && <p className="px-4 py-8 text-sm text-muted text-center">{managers.length === 0 ? "Nobody is mapped as a manager yet." : "No manager matches."}</p>}
      </div>
    </div>
  );
}
