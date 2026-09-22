"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/components/ui/confirm";

/**
 * "Make current" for a non-current, fully uploaded version: the rollback /
 * roll-forward control on the course page's version list.
 */
export function ActivateVersionButton({
  orgSlug,
  courseId,
  packageId,
  versionId,
  versionNumber,
}: {
  orgSlug: string;
  courseId: string;
  packageId: string;
  versionId: string;
  versionNumber: number;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    const ok = await confirm({
      title: `Make v${versionNumber} the current version?`,
      message:
        "Learners get this version on their next launch. Attempts already in progress keep the version they started on. You can switch back the same way.",
      confirmText: "Make current",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const res = await fetch(
      `/api/courses/${courseId}/packages/${packageId}/versions/${versionId}/activate`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgSlug }) }
    );
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[11px] text-red-700">{error}</span>}
      <button
        type="button"
        onClick={activate}
        disabled={busy}
        className="text-[11px] px-2 py-1 border border-line rounded hover:border-ink disabled:opacity-50"
        title="Roll back or forward to this version"
      >
        {busy ? "Switching…" : "Make current"}
      </button>
    </span>
  );
}
