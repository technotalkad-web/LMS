"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { Avatar } from "@/components/ui/avatar";

/**
 * Learner photo: replaces the old disabled "coming soon" camera button.
 * Uploads via /api/upload/image (kind=avatar), which stores the file
 * user-namespaced and writes profiles.avatar_url server-side.
 */
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
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    const form = new FormData();
    form.set("file", f);
    form.set("orgSlug", orgSlug);
    form.set("kind", "avatar");
    const res = await fetch("/api/upload/image", { method: "POST", body: form });
    setBusy(false);
    e.target.value = "";
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(j.error ?? "Upload failed");
      return;
    }
    toast.success("Photo updated");
    router.refresh();
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
    </div>
  );
}
