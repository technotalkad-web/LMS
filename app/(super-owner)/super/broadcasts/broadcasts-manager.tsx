"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Megaphone } from "lucide-react";

export type BroadcastRow = {
  id: string;
  title: string;
  body_md: string;
  tone: "info" | "warning" | "critical" | "success";
  audience: "all" | "admins_only" | "super_owners_only";
  dismissable: boolean;
  is_active: boolean;
  posted_at: string;
  expires_at: string | null;
};

const TONE_BADGE: Record<BroadcastRow["tone"], string> = {
  info: "bg-indigo-50 text-indigo-700",
  warning: "bg-amber-50 text-amber-700",
  critical: "bg-red-50 text-red-700",
  success: "bg-emerald-50 text-emerald-700",
};

export function BroadcastsManager({ initial }: { initial: BroadcastRow[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Omit<BroadcastRow, "id" | "posted_at">>({
    title: "",
    body_md: "",
    tone: "info",
    audience: "all",
    dismissable: true,
    is_active: true,
    expires_at: null,
  });

  async function submit() {
    if (!draft.title.trim() || !draft.body_md.trim()) {
      alert("Title and body are required.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/super/broadcasts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Failed");
      return;
    }
    setCreating(false);
    setDraft({
      title: "",
      body_md: "",
      tone: "info",
      audience: "all",
      dismissable: true,
      is_active: true,
      expires_at: null,
    });
    router.refresh();
  }

  async function toggle(b: BroadcastRow) {
    setBusy(true);
    await fetch("/api/super/broadcasts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: b.id, is_active: !b.is_active }),
    });
    setBusy(false);
    router.refresh();
  }

  async function remove(b: BroadcastRow) {
    if (!confirm(`Permanently delete "${b.title}"?`)) return;
    setBusy(true);
    await fetch(`/api/super/broadcasts?id=${b.id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setCreating((v) => !v)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> New broadcast
        </button>
      </div>

      {creating && (
        <div className="bg-white border-2 border-indigo-200 rounded-xl p-5 shadow-sm mb-6">
          <h3 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
            <Megaphone className="w-4 h-4" /> Compose
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <label>
              <span className="text-xs text-slate-500">Title</span>
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
              />
            </label>
            <label>
              <span className="text-xs text-slate-500">Tone</span>
              <select
                value={draft.tone}
                onChange={(e) => setDraft({ ...draft, tone: e.target.value as BroadcastRow["tone"] })}
                className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
              >
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
                <option value="success">Success</option>
              </select>
            </label>
            <label className="md:col-span-2">
              <span className="text-xs text-slate-500">Body (Markdown supported)</span>
              <textarea
                rows={3}
                value={draft.body_md}
                onChange={(e) => setDraft({ ...draft, body_md: e.target.value })}
                className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm font-mono"
              />
            </label>
            <label>
              <span className="text-xs text-slate-500">Audience</span>
              <select
                value={draft.audience}
                onChange={(e) => setDraft({ ...draft, audience: e.target.value as BroadcastRow["audience"] })}
                className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
              >
                <option value="all">All users</option>
                <option value="admins_only">Admins only</option>
                <option value="super_owners_only">Super owners only</option>
              </select>
            </label>
            <label>
              <span className="text-xs text-slate-500">Expires (optional)</span>
              <input
                type="datetime-local"
                value={draft.expires_at ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, expires_at: e.target.value || null })
                }
                className="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={draft.dismissable}
                onChange={(e) => setDraft({ ...draft, dismissable: e.target.checked })}
                className="w-4 h-4"
              />
              Allow users to dismiss
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
                className="w-4 h-4"
              />
              Live immediately
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setCreating(false)}
              disabled={busy}
              className="text-slate-500 px-3 py-1.5 text-sm hover:bg-slate-100 rounded-md"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-md text-sm font-semibold disabled:opacity-60"
            >
              Publish
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
        {initial.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-sm">No broadcasts yet.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 font-semibold uppercase text-xs">Title</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs">Tone</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs">Audience</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs">Status</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs">Posted</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {initial.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-900">{b.title}</p>
                    <p className="text-slate-500 text-xs mt-0.5 line-clamp-1">{b.body_md}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-bold ${TONE_BADGE[b.tone]}`}>
                      {b.tone}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-700 text-xs">
                    {b.audience.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className={b.is_active ? "text-emerald-700 font-semibold" : "text-slate-400"}>
                      {b.is_active ? "Live" : "Paused"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(b.posted_at).toLocaleString()}
                    {b.expires_at && (
                      <p className="text-[10px] mt-0.5">expires {new Date(b.expires_at).toLocaleDateString()}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => toggle(b)}
                        disabled={busy}
                        className="text-xs px-2 py-1 rounded-md hover:bg-slate-100 text-slate-700"
                      >
                        {b.is_active ? "Pause" : "Activate"}
                      </button>
                      <button
                        onClick={() => remove(b)}
                        disabled={busy}
                        className="p-1.5 text-slate-400 hover:text-red-600 transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
