"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Upload, X } from "lucide-react";
import type { ThumbFit } from "@/lib/ui/thumbnail";

export type ThumbDisplayValue = { fit: ThumbFit; posX: number; posY: number };

export function ThumbnailPicker({
  orgSlug,
  value,
  onChange,
  kind = "thumbnail",
  className,
  display,
  onDisplayChange,
}: {
  orgSlug: string;
  value: string | null;
  onChange: (url: string | null) => void;
  kind?: "thumbnail" | "logo";
  className?: string;
  /**
   * Display options (fit + crop focal point). When provided together with
   * onDisplayChange, the preview becomes an editor: a Crop/Fit toggle plus
   * drag-to-reposition in crop mode. Omit both to keep the plain picker
   * (logos, learning paths).
   */
  display?: ThumbDisplayValue;
  onDisplayChange?: (d: ThumbDisplayValue) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // Course thumbnails render in a landscape 16:9 banner in the learner view, so
  // show the picker (preview + dropzone) at that same ratio and tell admins the
  // exact target size. Logos keep the original box.
  const isThumb = kind === "thumbnail";
  const frame = isThumb
    ? "w-full max-w-xs aspect-video"
    : "w-full max-w-xs h-32";

  const editable = isThumb && display !== undefined && onDisplayChange !== undefined;
  const fit = display?.fit ?? "cover";
  const posX = display?.posX ?? 50;
  const posY = display?.posY ?? 50;
  const canDrag = editable && fit === "cover";

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("file", f);
    form.set("orgSlug", orgSlug);
    form.set("kind", kind);
    const res = await fetch("/api/upload/image", { method: "POST", body: form });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as {
      url?: string;
      error?: string;
    };
    if (!res.ok || !j.url) {
      setError(j.error ?? "Upload failed");
      return;
    }
    onChange(j.url);
    // A fresh image starts from the neutral centre crop.
    onDisplayChange?.({ fit: "cover", posX: 50, posY: 50 });
    // Reset the input so picking the same file again retriggers onChange.
    e.target.value = "";
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!canDrag) return;
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!canDrag || !drag.current || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    // Dragging the image right reveals more of its left side, i.e. the
    // object-position percentage decreases (and vice versa).
    const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
    onDisplayChange?.({
      fit,
      posX: clamp(posX - (dx / rect.width) * 100),
      posY: clamp(posY - (dy / rect.height) * 100),
    });
  }

  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className={className}>
      {value ? (
        <div className="relative inline-block">
          <div
            ref={frameRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`${frame} rounded-lg border border-line bg-canvas overflow-hidden ${
              canDrag ? "cursor-grab active:cursor-grabbing touch-none select-none" : ""
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value}
              alt="Thumbnail"
              draggable={false}
              className="w-full h-full pointer-events-none"
              style={
                editable
                  ? { objectFit: fit, objectPosition: `${posX}% ${posY}%` }
                  : { objectFit: "cover" }
              }
            />
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="absolute top-1 right-1 bg-paper/95 border border-line rounded-full p-1 hover:bg-red-50 hover:text-red-700"
            title="Remove image"
            aria-label="Remove image"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <label className="block">
          <div className={`${frame} border-2 border-dashed border-line rounded-lg bg-canvas hover:border-ink transition-colors flex flex-col items-center justify-center gap-1 cursor-pointer text-muted text-xs text-center px-3`}>
            <ImageIcon className="w-6 h-6" />
            <span className="font-medium">Click to upload</span>
            {isThumb && (
              <span className="font-medium text-ink">Landscape 16:9 · 1280 × 720 px</span>
            )}
            <span>JPEG, PNG, or WebP · max 4 MB</span>
          </div>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onFile}
            className="hidden"
          />
        </label>
      )}

      {value && editable && (
        <div className="mt-2 max-w-xs space-y-1.5">
          <div className="inline-flex rounded-lg border border-line overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => onDisplayChange?.({ fit: "cover", posX, posY })}
              className={`px-3 py-1.5 font-medium ${
                fit === "cover" ? "bg-ink text-paper" : "bg-paper text-muted hover:text-ink"
              }`}
            >
              Crop &amp; fill
            </button>
            <button
              type="button"
              onClick={() => onDisplayChange?.({ fit: "contain", posX, posY })}
              className={`px-3 py-1.5 font-medium border-l border-line ${
                fit === "contain" ? "bg-ink text-paper" : "bg-paper text-muted hover:text-ink"
              }`}
            >
              Fit entire image
            </button>
          </div>
          {fit === "cover" ? (
            <p className="text-xs text-muted">
              Drag the preview to choose which part of the image stays visible.
              {(posX !== 50 || posY !== 50) && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => onDisplayChange?.({ fit, posX: 50, posY: 50 })}
                    className="underline hover:text-ink"
                  >
                    Reset to centre
                  </button>
                </>
              )}
            </p>
          ) : (
            <p className="text-xs text-muted">
              The whole image is shown; the sides of the banner stay blank when
              the ratio differs.
            </p>
          )}
        </div>
      )}

      {value && (
        <label className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-ink cursor-pointer">
          <Upload className="w-3 h-3" />
          Replace
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onFile}
            className="hidden"
          />
        </label>
      )}

      {isThumb && !editable && (
        <p className="mt-2 text-xs text-muted max-w-xs">
          Use a <strong className="text-ink">landscape banner, 16:9 ratio</strong> — recommended{" "}
          <strong className="text-ink">1280 × 720 px</strong> (e.g. 1600 × 900). Learners see it across
          the top of the card; other ratios are centre-cropped to fit.
        </p>
      )}

      {busy && (
        <p className="mt-2 text-xs text-muted">Uploading…</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-700">{error}</p>
      )}
    </div>
  );
}
