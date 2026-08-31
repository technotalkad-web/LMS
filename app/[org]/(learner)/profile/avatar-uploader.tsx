"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { Avatar } from "@/components/ui/avatar";

/**
 * Learner photo with a crop editor: pick a file → position it in a circular
 * viewport (drag to reposition, slider/wheel to zoom, Fit/Fill presets, live
 * previews) → the visible square is rendered to a 512×512 JPEG and uploaded
 * via /api/upload/image (kind=avatar). Baking the crop into the stored file
 * means every surface that shows avatar_url (nav, leaderboard, podium)
 * automatically honors it — no per-surface crop metadata needed.
 */

const V = 288; // viewport CSS px (square); export is 512×512
const EXPORT = 512;
const MAX_ZOOM = 4;

type Crop = {
  src: string;
  w: number; // natural image px
  h: number;
  z: number; // zoom, multiplier of the cover scale (1 = fill the circle)
  ox: number; // image top-left relative to viewport, CSS px
  oy: number;
};

export function AvatarUploader({
  orgSlug,
  displayName,
  avatarUrl,
  allowUploads,
}: {
  orgSlug: string;
  displayName: string;
  avatarUrl: string | null;
  allowUploads: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(null);

  const coverScale = crop ? Math.max(V / crop.w, V / crop.h) : 1;
  const containScale = crop ? Math.min(V / crop.w, V / crop.h) : 1;
  const zMin = crop ? Math.min(1, containScale / coverScale) : 1;

  const clampOffsets = useCallback(
    (c: Crop): Crop => {
      const scale = Math.max(V / c.w, V / c.h) * c.z;
      const dw = c.w * scale;
      const dh = c.h * scale;
      const ox = dw >= V ? Math.min(0, Math.max(V - dw, c.ox)) : (V - dw) / 2;
      const oy = dh >= V ? Math.min(0, Math.max(V - dh, c.oy)) : (V - dh) / 2;
      return { ...c, ox, oy };
    },
    []
  );

  /** New crop at target zoom, keeping the viewport center on the same image point. */
  const withZoom = useCallback(
    (c: Crop, targetZ: number): Crop => {
      const fitZ = Math.min(1, Math.min(V / c.w, V / c.h) / Math.max(V / c.w, V / c.h));
      const z = Math.min(MAX_ZOOM, Math.max(fitZ, targetZ));
      const s0 = Math.max(V / c.w, V / c.h);
      const cx = (V / 2 - c.ox) / (c.w * s0 * c.z);
      const cy = (V / 2 - c.oy) / (c.h * s0 * c.z);
      return clampOffsets({
        ...c,
        z,
        ox: V / 2 - cx * c.w * s0 * z,
        oy: V / 2 - cy * c.h * s0 * z,
      });
    },
    [clampOffsets]
  );
  const setZoom = useCallback(
    (z: number) => setCrop((c) => (c ? withZoom(c, z) : c)),
    [withZoom]
  );
  const zoomBy = useCallback(
    (factor: number) => setCrop((c) => (c ? withZoom(c, c.z * factor) : c)),
    [withZoom]
  );

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const src = URL.createObjectURL(f);
    const probe = new Image();
    probe.onload = () => {
      const w = probe.naturalWidth;
      const h = probe.naturalHeight;
      if (!w || !h) {
        URL.revokeObjectURL(src);
        toast.error("Could not read that image");
        return;
      }
      const s0 = Math.max(V / w, V / h);
      setCrop({ src, w, h, z: 1, ox: (V - w * s0) / 2, oy: (V - h * s0) / 2 });
    };
    probe.onerror = () => {
      URL.revokeObjectURL(src);
      toast.error("Could not read that image");
    };
    probe.src = src;
  }

  const closeEditor = useCallback(() => {
    setCrop((c) => {
      if (c) URL.revokeObjectURL(c.src);
      return null;
    });
  }, []);

  // Esc closes; wheel zoom needs a non-passive listener to preventDefault.
  useEffect(() => {
    if (!crop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEditor();
    };
    document.addEventListener("keydown", onKey);
    const vp = viewportRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08);
    };
    vp?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      document.removeEventListener("keydown", onKey);
      vp?.removeEventListener("wheel", onWheel);
    };
  }, [crop ? crop.src : null, closeEditor, zoomBy]); // eslint-disable-line react-hooks/exhaustive-deps

  function onPointerDown(e: React.PointerEvent) {
    if (!crop) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: crop.ox, oy: crop.oy };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setCrop((c) =>
      c
        ? clampOffsets({ ...c, ox: d.ox + (e.clientX - d.x), oy: d.oy + (e.clientY - d.y) })
        : c
    );
  }
  function onPointerUp() {
    dragRef.current = null;
  }

  async function save() {
    const img = imgRef.current;
    if (!crop || !img) return;
    setBusy(true);
    try {
      const scale = coverScale * crop.z;
      const k = EXPORT / V;
      const canvas = document.createElement("canvas");
      canvas.width = EXPORT;
      canvas.height = EXPORT;
      const ctx = canvas.getContext("2d")!;
      // White letterbox for "fit" crops (JPEG has no alpha).
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, EXPORT, EXPORT);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        img,
        crop.ox * k,
        crop.oy * k,
        crop.w * scale * k,
        crop.h * scale * k
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92)
      );
      if (!blob) throw new Error("Could not process the image");
      const form = new FormData();
      form.set("file", new File([blob], "avatar.jpg", { type: "image/jpeg" }));
      form.set("orgSlug", orgSlug);
      form.set("kind", "avatar");
      const res = await fetch("/api/upload/image", { method: "POST", body: form });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(j.error ?? "Upload failed");
        return;
      }
      toast.success("Photo updated");
      closeEditor();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto() {
    setBusy(true);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatar_url: null }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error("Could not remove photo");
      return;
    }
    toast.success("Photo removed");
    router.refresh();
  }

  /** Positioned image markup at a given viewport size (live previews reuse it). */
  const positioned = (size: number, interactive: boolean) => {
    if (!crop) return null;
    const r = size / V;
    const scale = coverScale * crop.z;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={interactive ? imgRef : undefined}
        src={crop.src}
        alt=""
        draggable={false}
        className="absolute select-none"
        style={{
          maxWidth: "none",
          left: crop.ox * r,
          top: crop.oy * r,
          width: crop.w * scale * r,
          height: crop.h * scale * r,
        }}
      />
    );
  };

  return (
    <div>
      <div className="relative inline-block">
        <Avatar name={displayName} avatarUrl={avatarUrl} size="xl" className="ring-4 ring-canvas h-28 w-28" />
        <button
          type="button"
          disabled={!allowUploads || busy}
          onClick={() => inputRef.current?.click()}
          title={
            allowUploads
              ? "Change photo"
              : "Photo uploads are disabled by your administrator"
          }
          className={`absolute bottom-1 right-1 bg-indigo-600 text-white p-2 rounded-full shadow-lg ${
            allowUploads
              ? "hover:bg-indigo-700"
              : "cursor-not-allowed opacity-70"
          } disabled:opacity-70`}
          aria-label="Change photo"
        >
          <Camera className="w-4 h-4" />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onFile}
          className="hidden"
        />
      </div>
      {avatarUrl && allowUploads && (
        <div>
          <button
            type="button"
            onClick={removePhoto}
            disabled={busy}
            className="mt-2 text-xs text-muted hover:text-red-700 underline underline-offset-4"
          >
            Remove photo
          </button>
        </div>
      )}

      {/* ---- Crop editor modal ---- */}
      {crop && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) closeEditor();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Position your photo"
            className="bg-paper border border-line rounded-2xl shadow-xl w-full max-w-md p-5 sm:p-6"
          >
            <h2 className="font-semibold text-lg">Position your photo</h2>
            <p className="text-xs text-muted mt-0.5 mb-4">
              Drag to reposition · zoom until your face fills the circle. Only
              the area inside the circle is kept.
            </p>

            <div className="flex flex-col items-center gap-4">
              {/* Viewport (the large live preview) */}
              <div
                ref={viewportRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="relative overflow-hidden rounded-xl bg-canvas cursor-grab active:cursor-grabbing"
                style={{ width: V, height: V, touchAction: "none" }}
              >
                {positioned(V, true)}
                {/* Darken everything outside the circle, keep it visible. */}
                <div
                  aria-hidden
                  className="absolute rounded-full pointer-events-none ring-2 ring-white/90"
                  style={{
                    inset: 0,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  }}
                />
              </div>

              {/* Zoom + presets */}
              <div className="w-full flex items-center gap-3">
                <ZoomOut className="w-4 h-4 text-muted shrink-0" />
                <input
                  type="range"
                  min={zMin}
                  max={MAX_ZOOM}
                  step={0.01}
                  value={crop.z}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="flex-1 accent-indigo-600"
                  aria-label="Zoom"
                />
                <ZoomIn className="w-4 h-4 text-muted shrink-0" />
                <button
                  type="button"
                  onClick={() => setZoom(zMin)}
                  title="Fit the whole photo inside the circle"
                  className="inline-flex items-center gap-1 text-xs border border-line rounded-lg px-2.5 py-1.5 hover:border-ink"
                >
                  <Maximize2 className="w-3 h-3" /> Fit
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(1)}
                  title="Fill the circle"
                  className="text-xs border border-line rounded-lg px-2.5 py-1.5 hover:border-ink"
                >
                  Fill
                </button>
              </div>

              {/* Small live previews — how it will look in the nav + lists */}
              <div className="flex items-center gap-4 self-start">
                <span className="text-xs text-muted">Preview:</span>
                {[64, 32].map((s) => (
                  <div
                    key={s}
                    className="relative overflow-hidden rounded-full bg-canvas ring-1 ring-line shrink-0"
                    style={{ width: s, height: s }}
                    aria-hidden
                  >
                    {positioned(s, false)}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={closeEditor}
                disabled={busy}
                className="px-4 py-2 border border-line rounded-lg text-sm hover:border-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save photo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
