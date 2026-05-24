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
            className="w-full max-w-xs h-32 object-cover rounded-lg border border-line bg-canvas"
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
          <div className="w-full max-w-xs h-32 border-2 border-dashed border-line rounded-lg bg-canvas hover:border-ink transition-colors flex flex-col items-center justify-center gap-1 cursor-pointer text-muted text-xs">
            <ImageIcon className="w-6 h-6" />
            <span className="font-medium">Click to upload</span>
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

      {busy && (
        <p className="mt-2 text-xs text-muted">Uploading…</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-700">{error}</p>
      )}
    </div>
  );
}
