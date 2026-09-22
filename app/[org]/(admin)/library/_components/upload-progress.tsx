"use client";

import { formatBytes, type UploadProgress } from "./direct-upload";

const PHASE_LABEL: Record<UploadProgress["phase"], string> = {
  unzipping: "Opening the package…",
  validating: "Checking the package…",
  preparing: "Preparing storage…",
  uploading: "Uploading files…",
  finalizing: "Publishing…",
  done: "Done",
};

/** Progress bar for a direct upload: files and bytes, phase label. */
export function UploadProgressBar({
  progress,
  fileName,
  onCancel,
}: {
  progress: UploadProgress;
  fileName: string;
  /** Shown while files are still going up; aborts and cleans up the version. */
  onCancel?: () => void;
}) {
  const pct =
    progress.phase === "done"
      ? 100
      : progress.bytesTotal > 0
        ? Math.min(99, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
        : 0;
  return (
    <div className="border border-line rounded-lg bg-paper p-6" aria-live="polite" data-testid="upload-progress">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="font-medium truncate">{fileName}</div>
        <div className="text-sm text-muted tabular-nums shrink-0">{pct}%</div>
      </div>
      <div className="h-2 rounded-full bg-canvas overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 text-xs text-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>{PHASE_LABEL[progress.phase]}</span>
        {progress.phase === "uploading" && (
          <span className="tabular-nums">
            {progress.filesDone} of {progress.filesTotal} files · {formatBytes(progress.bytesDone)} of {formatBytes(progress.bytesTotal)}
          </span>
        )}
        {progress.failed > 0 && <span className="text-red-700">{progress.failed} failed, retrying</span>}
        {onCancel && progress.phase === "uploading" && (
          <button type="button" onClick={onCancel} className="ml-auto underline hover:text-ink">
            Cancel upload
          </button>
        )}
      </div>
    </div>
  );
}
