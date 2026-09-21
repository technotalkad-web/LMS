"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Image as ImageIcon, Plus, Upload } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  BACKGROUND_DEFAULT_OPACITY,
  BACKGROUND_FITS,
  backgroundStatus,
  pickActiveBackground,
  type BackgroundFit,
  type DashboardBackground,
} from "@/lib/theme/dashboard-background";

/**
 * Settings → Workspace → "Dashboard background themes" (0074).
 * Saved themes with schedule + on/off, upload/replace/delete, live preview
 * of which one learners see right now.
 */
export function DashboardBackgroundsSection({
  orgSlug,
  initial,
}: {
  orgSlug: string;
  initial: DashboardBackground[];
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<DashboardBackground[]>(initial);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DashboardBackground | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = Date.now();
  const live = pickActiveBackground(rows, now);

  async function call(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) {
    const res = await fetch("/api/org/dashboard-backgrounds", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, ...body }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      error?: string;
      background?: DashboardBackground;
    };
    if (!res.ok) throw new Error(j.error ?? "Request failed");
    return j;
  }

  async function toggle(b: DashboardBackground) {
    setBusyId(b.id);
    try {
      const j = await call("PATCH", { id: b.id, is_enabled: !b.is_enabled });
      setRows((rs) => rs.map((r) => (r.id === b.id && j.background ? j.background : r)));
      toast.success(b.is_enabled ? "Theme disabled" : "Theme enabled");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(b: DashboardBackground) {
    if (
      !(await confirm({
        message: `Delete "${b.name}"? Learners stop seeing it immediately and the uploaded file is removed.`,
        confirmText: "Delete theme",
        destructive: true,
      }))
    )
      return;
    setBusyId(b.id);
    try {
      await call("DELETE", { id: b.id });
      setRows((rs) => rs.filter((r) => r.id !== b.id));
      toast.success("Theme deleted");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="border border-line rounded-lg bg-paper p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="serif text-2xl flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-indigo-600" />
            Dashboard background themes
          </h2>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Decorative artwork behind the learner dashboard for festivals,
            campaigns or special sessions. Schedule a start and end date and it
            appears and disappears on its own; switch any theme on or off at any
            time. It never covers cards, buttons or menus.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setAdding(true);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> Add theme
        </button>
      </div>

      <p className="text-xs rounded-lg px-3 py-2 border border-line bg-canvas">
        <strong>Showing now:</strong>{" "}
        {live ? (
          <>
            {live.name}
            {rows.filter((r) => backgroundStatus(r, now) === "live").length > 1 &&
              " — several themes are live; the most recently updated one wins."}
          </>
        ) : (
          "none — the dashboard uses the plain workspace theme."
        )}
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">No saved themes yet.</p>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
          {rows.map((b) => {
            const status = backgroundStatus(b, now);
            return (
              <li key={b.id} className="flex flex-wrap items-center gap-4 px-4 py-3 bg-paper">
                <Preview b={b} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{b.name}</span>
                    <StatusPill status={status} isLive={live?.id === b.id} />
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {kindLabel(b.asset_kind)} · {BACKGROUND_FITS.find((f) => f.value === b.fit)?.label ?? b.fit} ·{" "}
                    {Math.round(b.opacity * 100)}% opacity
                    {b.starts_at || b.ends_at ? (
                      <>
                        {" "}· {b.starts_at ? `from ${fmt(b.starts_at)}` : "from now"}{" "}
                        {b.ends_at ? `until ${fmt(b.ends_at)}` : "with no end"}
                      </>
                    ) : (
                      " · no schedule"
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => toggle(b)}
                    disabled={busyId === b.id}
                    className={`px-2.5 py-1 rounded-full border ${
                      b.is_enabled
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-line bg-canvas text-muted"
                    } disabled:opacity-50`}
                  >
                    {b.is_enabled ? "Enabled" : "Disabled"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      setEditing(b);
                    }}
                    className="px-2.5 py-1 border border-line rounded-full hover:border-ink"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(b)}
                    disabled={busyId === b.id}
                    className="px-2.5 py-1 border border-line rounded-full hover:border-red-500 hover:text-red-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {(adding || editing) && (
        <ThemeEditor
          orgSlug={orgSlug}
          initial={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={(b) => {
            setRows((rs) => (rs.some((r) => r.id === b.id) ? rs.map((r) => (r.id === b.id ? b : r)) : [b, ...rs]));
            setAdding(false);
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function ThemeEditor({
  orgSlug,
  initial,
  onClose,
  onSaved,
}: {
  orgSlug: string;
  initial: DashboardBackground | null;
  onClose: () => void;
  onSaved: (b: DashboardBackground) => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [assetUrl, setAssetUrl] = useState<string>(initial?.asset_url ?? "");
  const [fit, setFit] = useState<BackgroundFit>(initial?.fit ?? "cover");
  const [opacity, setOpacity] = useState<number>(initial?.opacity ?? BACKGROUND_DEFAULT_OPACITY);
  const [enabled, setEnabled] = useState<boolean>(initial?.is_enabled ?? true);
  const [startsAt, setStartsAt] = useState(toLocalInput(initial?.starts_at ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(initial?.ends_at ?? null));
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", f);
      fd.set("orgSlug", orgSlug);
      fd.set("kind", "background");
      const res = await fetch("/api/upload/image", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) {
        toast.error(j.error ?? "Upload failed");
        return;
      }
      setAssetUrl(j.url);
      if (!name.trim()) setName(f.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80));
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!name.trim()) return toast.error("Give the theme a name");
    if (!assetUrl) return toast.error("Upload the artwork first");
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      return toast.error("End must be after start");
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        orgSlug,
        name: name.trim(),
        asset_url: assetUrl,
        fit,
        opacity,
        is_enabled: enabled,
        starts_at: startsAt ? new Date(startsAt).toISOString() : null,
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      };
      if (initial) body.id = initial.id;
      const res = await fetch("/api/org/dashboard-backgrounds", {
        method: initial ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; background?: DashboardBackground };
      if (!res.ok || !j.background) {
        toast.error(j.error ?? "Save failed");
        return;
      }
      toast.success(initial ? "Theme updated" : "Theme saved");
      onSaved(j.background);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-indigo-200 bg-indigo-50/40 rounded-xl p-4 space-y-4">
      <h3 className="font-semibold">{initial ? `Edit "${initial.name}"` : "New theme"}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">Name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Diwali 2026"
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
        </label>
        <div className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">Artwork</span>
          <div className="flex items-center gap-3">
            {assetUrl ? (
              <Preview b={{ asset_url: assetUrl, asset_kind: kindOf(assetUrl), name }} />
            ) : (
              <div className="w-20 h-12 rounded border border-dashed border-line bg-canvas" />
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 px-3 py-2 border border-line rounded-lg text-sm hover:border-ink disabled:opacity-50"
            >
              <Upload className="w-4 h-4" /> {uploading ? "Uploading…" : assetUrl ? "Replace file" : "Upload file"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.svg,.gif,.json,.lottie,image/png,image/jpeg,image/webp,image/svg+xml,image/gif,application/json"
              onChange={onFile}
              className="hidden"
            />
          </div>
          <p className="text-[11px] text-muted mt-1.5">
            PNG, JPG or WebP up to 4 MB; SVG, GIF or Lottie JSON up to 2 MB. Wide
            artwork (16:9 or wider) works best; keep it light and low-contrast.
          </p>
        </div>
        <div className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">How it fills the dashboard</span>
          <select
            value={fit}
            onChange={(e) => setFit(e.target.value as BackgroundFit)}
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          >
            {BACKGROUND_FITS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} — {f.hint}
              </option>
            ))}
          </select>
        </div>
        <label className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">
            Opacity — {Math.round(opacity * 100)}%
          </span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(opacity * 100)}
            onChange={(e) => setOpacity(Number(e.target.value) / 100)}
            className="w-full"
          />
          <span className="block text-[11px] text-muted mt-1">
            Lower keeps text on the dashboard easy to read; 25–45% suits most artwork.
          </span>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">Start (optional)</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-muted mb-1.5">End (optional)</span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-sm outline-none focus:border-ink"
          />
        </label>
      </div>
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled (shows within the schedule; untick to keep it saved but hidden)
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-4 py-2 border border-line rounded-lg text-sm">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy || uploading}
          className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Save theme"}
        </button>
      </div>
    </div>
  );
}

function Preview({ b }: { b: Pick<DashboardBackground, "asset_url" | "asset_kind" | "name"> }) {
  if (b.asset_kind === "lottie") {
    return (
      <div className="w-20 h-12 shrink-0 rounded border border-line bg-canvas flex items-center justify-center text-[10px] font-medium text-muted">
        Lottie
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={b.asset_url}
      alt=""
      className="w-20 h-12 shrink-0 rounded border border-line object-cover bg-canvas"
    />
  );
}

function StatusPill({ status, isLive }: { status: ReturnType<typeof backgroundStatus>; isLive: boolean }) {
  const map = {
    live: isLive
      ? ["Showing now", "border-emerald-200 bg-emerald-50 text-emerald-800"]
      : ["Live (superseded)", "border-line bg-canvas text-muted"],
    scheduled: ["Scheduled", "border-indigo-200 bg-indigo-50 text-indigo-800"],
    expired: ["Ended", "border-line bg-canvas text-muted"],
    disabled: ["Disabled", "border-line bg-canvas text-muted"],
  } as const;
  const [label, cls] = map[status];
  return <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide border ${cls}`}>{label}</span>;
}

function kindLabel(k: DashboardBackground["asset_kind"]): string {
  return k === "lottie" ? "Lottie animation" : k === "svg" ? "SVG" : k === "gif" ? "GIF" : "Image";
}
function kindOf(url: string): DashboardBackground["asset_kind"] {
  const u = url.toLowerCase().split("?")[0];
  return u.endsWith(".json") || u.endsWith(".lottie") ? "lottie" : u.endsWith(".svg") ? "svg" : u.endsWith(".gif") ? "gif" : "image";
}
function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
