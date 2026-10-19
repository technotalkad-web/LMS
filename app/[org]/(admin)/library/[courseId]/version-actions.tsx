"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm";
import { isAnalyticsTier, tierBadge } from "@/lib/alds/tier";

/**
 * "Make current" for a non-current, fully uploaded version: the rollback /
 * roll-forward control on the course page's version list.
 */
/**
 * Retire a version whose upload never finished: its files are deleted and
 * the row stays as a failed upload, so its number is never reused (ADR 0008
 * D1). Rendered for 'uploading' rows only.
 */
export function DiscardUploadButton({
  orgSlug,
  versionId,
  versionNumber,
}: {
  orgSlug: string;
  versionId: string;
  versionNumber: number;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function discard() {
    const ok = await confirm({
      title: `Discard the unfinished upload v${versionNumber}?`,
      message: `Its files are deleted and v${versionNumber} is kept as a failed upload (hidden from this list; the number is not reused). Nothing learners see changes.`,
      confirmText: "Discard",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/courses/upload/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, versionId }),
    });
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
        onClick={discard}
        disabled={busy}
        className="text-[11px] px-2 py-1 border border-red-200 text-red-700 rounded hover:border-red-400 disabled:opacity-50"
      >
        {busy ? "Discarding…" : "Discard"}
      </button>
    </span>
  );
}

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

type RestartPlan = {
  attempt_ids: string[];
  excluded_grant_retake_ids: string[];
  by_role: { learner: number; staff: number };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Restart learners on this version" (ADR 0008 step 6): for a ready version
 * that is not its package's current one, or the current version of an
 * inactive package. Click → dry run → a dialog with the counts and a required
 * reason → the real call → refresh. Zero attempts: the dialog says so and
 * offers nothing. Ids and counts only, never names.
 */
export function RestartVersionButton({
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
  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<RestartPlan | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const url = `/api/courses/${courseId}/packages/${packageId}/versions/${versionId}/restart`;

  async function post(body: Record<string, unknown>) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, ...body }),
    });
    const j = (await res.json().catch(() => ({}))) as Partial<RestartPlan> & {
      error?: string;
      message?: string;
      restarted?: number;
    };
    return { ok: res.ok, status: res.status, j };
  }

  async function open() {
    setChecking(true);
    setError(null);
    setDone(null);
    const { ok, status, j } = await post({ dry_run: true });
    setChecking(false);
    if (!ok) {
      setError(j.message ?? j.error ?? `HTTP ${status}`);
      return;
    }
    setReason("");
    setPlan({
      attempt_ids: j.attempt_ids ?? [],
      excluded_grant_retake_ids: j.excluded_grant_retake_ids ?? [],
      by_role: j.by_role ?? { learner: 0, staff: 0 },
    });
  }

  function close() {
    if (busy) return;
    setPlan(null);
    setError(null);
  }

  async function restart() {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    const { ok, status, j } = await post({ reason: reason.trim() });
    setBusy(false);
    if (!ok) {
      setError(j.message ?? j.error ?? `HTTP ${status}`);
      return;
    }
    setPlan(null);
    setDone(j.restarted ?? j.attempt_ids?.length ?? 0);
    router.refresh();
  }

  const total = plan?.attempt_ids.length ?? 0;
  const excluded = plan?.excluded_grant_retake_ids.length ?? 0;

  return (
    <span className="inline-flex items-center gap-2">
      {error && !plan && <span className="text-[11px] text-red-700">{error}</span>}
      {done !== null && (
        <span className="text-[11px] text-muted" data-testid="restart-done">
          {plural(done, "attempt", "attempts")} reset
        </span>
      )}
      <button
        type="button"
        onClick={open}
        disabled={checking || busy}
        className="text-[11px] px-2 py-1 border border-red-200 text-red-700 rounded hover:border-red-400 disabled:opacity-50"
        title="Close the in-progress attempts on this version only; those learners start the current version"
      >
        {checking ? "Checking…" : "Restart learners on this version"}
      </button>
      {plan && (
        <RestartDialog
          title={total === 0 ? `No learners to restart on v${versionNumber}` : `Restart learners on v${versionNumber}?`}
          onClose={close}
        >
          {total === 0 ? (
            <>
              <p className="mt-1 text-sm text-muted leading-relaxed" data-testid="restart-counts">
                No in-progress attempts on this version. Nothing to restart.
                {excluded > 0 && ` ${plural(excluded, "grant retake is", "grant retakes are")} excluded and stay in progress.`}
              </p>
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={close}
                  className="px-4 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:border-ink transition-colors"
                >
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-ink leading-relaxed" data-testid="restart-counts">
                {plural(total, "in-progress attempt", "in-progress attempts")}:{" "}
                {plural(plan.by_role.learner, "learner", "learners")}, {plan.by_role.staff} staff;{" "}
                {plural(excluded, "grant retake", "grant retakes")} excluded.
              </p>
              <p className="mt-2 text-xs text-muted leading-relaxed">
                Each of these attempts is closed and shows as “Reset — module updated”; those people start the
                current version from 0% at their next launch. Completed attempts, grant retakes and every other
                version are not touched. This cannot be undone.
              </p>
              <label className="block mt-4 text-xs font-medium text-ink" htmlFor={`restart-reason-${versionId}`}>
                Reason (required, kept in the audit log)
              </label>
              <textarea
                id={`restart-reason-${versionId}`}
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                disabled={busy}
                className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm"
                placeholder="e.g. wrong module uploaded on this version"
              />
              {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:border-ink transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={restart}
                  disabled={busy || !reason.trim()}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {busy ? "Restarting…" : `Restart ${plural(total, "attempt", "attempts")}`}
                </button>
              </div>
            </>
          )}
        </RestartDialog>
      )}
    </span>
  );
}

const RERUN_ERRORS: Record<string, string> = {
  super_owner_required: "Only a super owner can re-run the check.",
  p4_disabled: "The certification check is switched off on this environment.",
  not_ready: "This version is not fully uploaded.",
  no_manifest: "This package has no alds-manifest.json: there is nothing to certify.",
  schema_missing: "The certification tables are not on this database yet.",
  unavailable: "The check could not run. Nothing changed; try again.",
};

/**
 * "Re-run check" (ADR 0005 note (f) of 2026-10-19): super_owner only, on a
 * version whose analytics tier is pending, uncertified or revoked. A dialog
 * asks for the reason (kept in the audit log), then the certify route runs
 * the Package Guardian again and the page refreshes. The tier is
 * informational: nothing learners see or are scored on changes.
 */
export function RerunCertificationButton({
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
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function rerun() {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/courses/${courseId}/packages/${packageId}/versions/${versionId}/certify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, reason: reason.trim() }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; tier?: string; reason?: string | null };
    setBusy(false);
    if (!res.ok) {
      setError((j.error && RERUN_ERRORS[j.error]) ?? j.error ?? `HTTP ${res.status}`);
      return;
    }
    const label = tierBadge(isAnalyticsTier(j.tier) ? j.tier : null)?.label ?? j.tier ?? "done";
    setOpen(false);
    setResult(j.reason ? `${label}: ${j.reason}` : label);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && !open && <span className="text-[11px] text-red-700">{error}</span>}
      {result && (
        <span className="text-[11px] text-muted max-w-[16rem] truncate" title={result} data-testid="rerun-result">
          {result}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setReason("");
          setError(null);
          setResult(null);
          setOpen(true);
        }}
        disabled={busy}
        className="text-[11px] px-2 py-1 border border-line rounded hover:border-ink disabled:opacity-50"
        title="Run the static certification check on this version's stored files again"
        data-testid="rerun-certification"
      >
        {busy ? "Checking…" : "Re-run check"}
      </button>
      {open && (
        <RestartDialog title={`Re-run the certification check on v${versionNumber}?`} onClose={close}>
          <p className="mt-1 text-xs text-muted leading-relaxed">
            The static check reads this version&apos;s stored files again and sets its analytics tier. Completion,
            scores, the Report Card, CRM and journeys never depend on the tier, and learners are not affected.
          </p>
          <label className="block mt-4 text-xs font-medium text-ink" htmlFor={`rerun-reason-${versionId}`}>
            Reason (required, kept in the audit log)
          </label>
          <textarea
            id={`rerun-reason-${versionId}`}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
            disabled={busy}
            className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm"
            placeholder="e.g. storage timed out during the upload check"
          />
          {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="px-4 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:border-ink transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={rerun}
              disabled={busy || !reason.trim()}
              className="px-4 py-2 rounded-lg bg-ink text-canvas text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {busy ? "Checking…" : "Re-run check"}
            </button>
          </div>
        </RestartDialog>
      )}
    </span>
  );
}

/** Modal shell local to this file (same look as components/ui/confirm),
 *  portalled to <body> so no ancestor's layout or text style reaches it. */
function RestartDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-line bg-paper p-6 shadow-2xl text-left whitespace-normal">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 rounded-full bg-red-100 p-1.5">
            <AlertTriangle className="w-5 h-5 text-red-600" />
          </span>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="serif text-lg text-ink">
              {title}
            </h2>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
