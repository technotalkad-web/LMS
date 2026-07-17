"use client";

import { useState } from "react";
import { Image as ImageIcon, Upload, X } from "lucide-react";

export function ThumbnailPicker({
  orgSlug,
  value,
  onChange,
  kind = "thumbnail",
  className,
}: {
  orgSlug: string;
  value: string | null;
  onChange: (url: string | null) => void;
  kind?: "thumbnail" | "logo";
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Course thumbnails render in a landscape 16:9 banner in the learner view, so
  // show the picker (preview + dropzone) at that same ratio and tell admins the
  // exact target size. Logos keep the original box.
  const isThumb = kind === "thumbnail";
  const frame = isThumb
    ? "w-full max-w-xs aspect-video"
    : "w-full max-w-xs h-32";

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
    // Reset the input so picking the same file again retriggers onChange.
    e.target.value = "";
  }

  return (
    <div className={className}>
      {value ? (
        <div className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt="Thumbnail"
            className={`${frame} object-cover rounded-lg border border-line bg-canvas`}
          />
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

      {isThumb && (
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
