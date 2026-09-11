"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useToast } from "@/components/ui/toast";

/**
 * Runs the package validator against an ALREADY-UPLOADED course's stored
 * files (action validate_existing) — the audit path for content that
 * pre-dates the pre-upload gate, or a fresh re-check any time.
 */
export function ValidateExistingButton({
  orgSlug,
  courseId,
  hasReport,
}: {
  orgSlug: string;
  courseId: string;
  hasReport: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/courses/validate-package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "validate_existing",
          orgSlug,
          course_id: courseId,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        report?: { verdict?: string };
      };
      if (!res.ok) {
        toast.error(j.error ?? "Validation failed");
        return;
      }
      toast.success(
        `Validation complete — verdict: ${j.report?.verdict?.toUpperCase() ?? "?"}`
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-line rounded-lg text-xs font-medium hover:border-ink disabled:opacity-50"
    >
      <ShieldCheck className="w-3.5 h-3.5" />
      {busy
        ? "Scanning stored files…"
        : hasReport
          ? "Re-validate"
          : "Validate now"}
    </button>
  );
}
