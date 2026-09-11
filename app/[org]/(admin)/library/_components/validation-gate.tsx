"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, XCircle } from "lucide-react";

/**
 * Pre-Upload Package Validation — the client half of the quality gate.
 *
 * Usage: instead of POSTing the zip straight to an upload endpoint, call
 * `runValidation(file, orgSlug)` first; render the returned report with
 * <ValidationReportPanel>. "Accept & Upload" hands the caller
 * { validation_id, acknowledge } to append to the REAL upload form;
 * "Reject & upload new package" marks the row rejected for the audit trail
 * and resets the picker.
 */

export type ValidationCheck = {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail" | "info";
  detail: string;
};

export type ValidationReport = {
  version: 1;
  package: {
    type: string;
    title: string | null;
    launchUrl: string | null;
    sizeBytes: number;
    fileCount: number;
    tool: string | null;
  };
  verdict: "pass" | "warning" | "fail" | "unplayable";
  checks: ValidationCheck[];
};

export type ValidationResult = { validation_id: string; report: ValidationReport };

export async function runValidation(
  file: File,
  orgSlug: string
): Promise<{ ok: true; result: ValidationResult } | { ok: false; error: string }> {
  const fd = new FormData();
  fd.set("file", file);
  fd.set("orgSlug", orgSlug);
  const res = await fetch("/api/courses/validate-package", { method: "POST", body: fd });
  const j = (await res.json().catch(() => ({}))) as ValidationResult & { error?: string };
  if (!res.ok || !j.validation_id) {
    return { ok: false, error: j.error ?? "Validation failed" };
  }
  return { ok: true, result: j };
}

export async function rejectValidation(validationId: string, orgSlug: string): Promise<void> {
  await fetch("/api/courses/validate-package", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reject", orgSlug, validation_id: validationId }),
  }).catch(() => {});
}

const VERDICT_META: Record<
  ValidationReport["verdict"],
  { label: string; className: string; blurb: string }
> = {
  pass: {
    label: "PASS",
    className: "bg-emerald-100 text-emerald-800",
    blurb: "All tracking checks look good. Safe to upload.",
  },
  warning: {
    label: "WARNINGS",
    className: "bg-amber-100 text-amber-900",
    blurb: "The package will play, but some tracking may be missing. Review before accepting.",
  },
  fail: {
    label: "FAIL",
    className: "bg-red-100 text-red-800",
    blurb: "Critical tracking or compatibility problems detected. Accepting anyway is recorded.",
  },
  unplayable: {
    label: "UNPLAYABLE",
    className: "bg-red-600 text-white",
    blurb: "This package cannot open at all and cannot be uploaded. Fix it and validate again.",
  },
};

function CheckIcon({ status }: { status: ValidationCheck["status"] }) {
  if (status === "pass") return <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />;
  if (status === "warning") return <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />;
  if (status === "fail") return <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />;
  return <Info className="w-4 h-4 text-muted shrink-0 mt-0.5" />;
}

export function ValidationReportPanel({
  fileName,
  result,
  busy,
  onAccept,
  onReject,
}: {
  fileName: string;
  result: ValidationResult;
  busy: boolean;
  /** Called with the form fields to append to the real upload. */
  onAccept: (fields: { validation_id: string; acknowledge: boolean }) => void;
  onReject: () => void;
}) {
  const { report } = result;
  const meta = VERDICT_META[report.verdict];
  const needsAck = report.verdict === "warning" || report.verdict === "fail";
  const blocked = report.verdict === "unplayable";
  const [acked, setAcked] = useState(false);

  const order = { fail: 0, warning: 1, pass: 2, info: 3 } as const;
  const sorted = [...report.checks].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <div className="border border-line rounded-lg bg-paper p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-lg truncate">Validation report — {fileName}</h2>
          <p className="text-xs text-muted mt-0.5">
            {report.package.title ?? "Untitled"} · {report.package.type} ·{" "}
            {report.package.fileCount} files ·{" "}
            {(report.package.sizeBytes / (1024 * 1024)).toFixed(1)} MB
            {report.package.tool ? ` · ${report.package.tool}` : ""}
          </p>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-extrabold tracking-wide ${meta.className}`}>
          {meta.label}
        </span>
      </div>

      <p className="text-sm text-muted">{meta.blurb}</p>

      <ul className="space-y-2.5">
        {sorted.map((c) => (
          <li key={c.id} className="flex items-start gap-2.5 text-sm">
            <CheckIcon status={c.status} />
            <span>
              <span className="font-medium">{c.label}:</span>{" "}
              <span className="text-muted">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-muted border-t border-line pt-3">
        Static analysis proves what the package <em>declares</em> — it detects missing
        tracking with certainty, but only a live launch proves runtime behavior. When in
        doubt, assign the course to yourself first and test-drive it.
      </p>

      {needsAck && !blocked && (
        <label className="flex items-start gap-2.5 text-sm px-3 py-2.5 border border-amber-300 bg-amber-50 rounded-lg">
          <input
            type="checkbox"
            checked={acked}
            onChange={(e) => setAcked(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I reviewed the issues above and want to upload anyway.{" "}
            <span className="text-muted">(Your acceptance is recorded.)</span>
          </span>
        </label>
      )}

      <div className="flex flex-wrap gap-3">
        {blocked ? (
          <div className="inline-flex items-center gap-2 text-sm text-red-700 font-medium">
            <ShieldAlert className="w-4 h-4" /> Upload blocked — fix the package and validate again.
          </div>
        ) : (
          <button
            type="button"
            disabled={busy || (needsAck && !acked)}
            onClick={() =>
              onAccept({ validation_id: result.validation_id, acknowledge: needsAck && acked })
            }
            className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Accept & Upload"}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          className="px-4 py-2 border border-line rounded-lg text-sm font-medium hover:border-red-500 hover:text-red-700 disabled:opacity-50"
        >
          Reject & upload a new package
        </button>
      </div>
    </div>
  );
}
