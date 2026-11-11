"use client";

import { useEffect, useRef, useState } from "react";
import type { CmiData } from "@/lib/scorm/types";
import { LaunchBar } from "./launch-bar";
import { ModuleFrameLoader, useModuleFrame, useNextModulePreload } from "./module-frame";

/**
 * Parent page for a SCORM 1.2 course iframe.
 *
 * Exposes a `window.API` object before the iframe loads — the SCORM course's
 * runtime walks up the window hierarchy looking for `window.parent.API` (1.2)
 * or `window.parent.API_1484_11` (2004) and binds to whichever it finds.
 *
 * Our shim:
 *   - Initializes with seeded CMI data from the server
 *   - Buffers SetValue calls in memory
 *   - Flushes the full CMI dict to /api/scorm/{id}/commit on LMSCommit/Finish
 */
export function ScormRuntime({
  attemptId,
  initialCmi,
  iframeSrc,
  courseTitle,
  backHref,
  backLabel = "Exit course",
  preloadUrls = [],
  revision = false,
  showTitle = true,
  continueHref = null,
  continueReady = false,
  continueStatusHref = null,
}: {
  attemptId: string;
  initialCmi: CmiData;
  iframeSrc: string;
  courseTitle: string;
  backHref: string;
  /** Names the launch context the exit returns to ("Back to journey"). */
  backLabel?: string;
  /** Next module's content file(s) to warm in the background once this one is up. */
  preloadUrls?: string[];
  /** A revision visit (ADR 0014): review only; this launch never changes the official result. */
  revision?: boolean;
  /** The course title in the bar (ADR 0019 step 8): false for a KIVO build, which shows its own. */
  showTitle?: boolean;
  /** The continue address on a Learning Path launch (ADR 0019 step 8); null hides Continue. */
  continueHref?: string | null;
  /**
   * Continue starts active (ADR 0019, note of 2026-11-11): the official result
   * is already stored, or the launch is a preview. False, the safe default,
   * keeps it waiting until the status route answers stored.
   */
  continueReady?: boolean;
  /** The status route the bar checks after a terminal commit; null off a path launch. */
  continueStatusHref?: string | null;
}) {
  const cmiRef = useRef<CmiData>({ ...initialCmi });
  const initializedRef = useRef(false);
  const frame = useModuleFrame();
  useNextModulePreload(preloadUrls, frame.loaded);
  const [status, setStatus] = useState<"idle" | "syncing" | "saved" | "error">(
    "idle"
  );
  const [lastError, setLastError] = useState("0");
  // ADR 0019, note of 2026-11-11: the parent owns the API, so the bar does not
  // poll; a commit the server answered with a terminal status bumps this and
  // the bar runs one status check. The bar turns ready only on the route's
  // `{ stored: true }`, never on this commit's answer: the server's own
  // derivation decides, and a `completed` without a verdict on a
  // pass_required course keeps waiting, as on the continue address.
  // Only a terminal status that differs from the last one checked bumps it:
  // a package that keeps committing `completed` on a pass_required course
  // would otherwise add one status request to every commit. A check lost to
  // the network then waits for a status change or a tap on the button.
  const [continueRecheck, setContinueRecheck] = useState(0);
  const lastCheckedStatus = useRef<string | null>(null);
  // Serialize commits: packages often call LMSCommit then LMSFinish back to
  // back (both fire-and-forget). Overlapping requests would each read the
  // attempt as "not yet complete" and could double-fire the completion
  // webhook / email. Chaining makes the second commit start only after the
  // first has fully landed, so the server sees the real transition once.
  const commitChain = useRef<Promise<boolean>>(Promise.resolve(true));

  function commit(finished: boolean): Promise<boolean> {
    const run = commitChain.current.then(async () => {
      setStatus("syncing");
      try {
        const res = await fetch(`/api/scorm/${attemptId}/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmi: cmiRef.current, finished }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        const answered = body ? String(body.status) : "";
        if (["completed", "passed", "failed"].includes(answered) && answered !== lastCheckedStatus.current) {
          lastCheckedStatus.current = answered;
          setContinueRecheck((n) => n + 1);
        }
        setStatus("saved");
        window.setTimeout(() => setStatus("idle"), 1500);
        return true;
      } catch (err) {
        console.error("[scorm] commit failed:", err);
        setStatus("error");
        return false;
      }
    });
    // Keep the chain alive even if one commit rejects.
    commitChain.current = run.catch(() => false);
    return run;
  }

  useEffect(() => {
    // Define the SCORM 1.2 API on window BEFORE the iframe loads its
    // course content. The iframe inherits the parent window via window.parent.
    type ScormApi = {
      LMSInitialize: (p: string) => string;
      LMSFinish: (p: string) => string;
      LMSGetValue: (k: string) => string;
      LMSSetValue: (k: string, v: string) => string;
      LMSCommit: (p: string) => string;
      LMSGetLastError: () => string;
      LMSGetErrorString: (c: string) => string;
      LMSGetDiagnostic: (c: string) => string;
    };

    const api: ScormApi = {
      LMSInitialize: () => {
        initializedRef.current = true;
        setLastError("0");
        return "true";
      },
      LMSFinish: () => {
        setLastError("0");
        // Fire-and-forget commit with finished=true; SCORM expects sync return.
        void commit(true);
        return "true";
      },
      LMSGetValue: (key) => {
        setLastError("0");
        return cmiRef.current[key] ?? "";
      },
      LMSSetValue: (key, value) => {
        setLastError("0");
        cmiRef.current[key] = String(value);
        return "true";
      },
      LMSCommit: () => {
        setLastError("0");
        void commit(false);
        return "true";
      },
      LMSGetLastError: () => lastError,
      LMSGetErrorString: (code) => (code === "0" ? "No error" : "Unknown"),
      LMSGetDiagnostic: () => "",
    };

    // SCORM courses look for window.API (1.2). We expose it on the global.
    (window as unknown as { API: ScormApi }).API = api;

    // Safety: if the user closes the tab mid-course, attempt a final commit.
    const handleUnload = () => {
      navigator.sendBeacon?.(
        `/api/scorm/${attemptId}/commit`,
        new Blob(
          [JSON.stringify({ cmi: cmiRef.current, finished: false })],
          { type: "application/json" }
        )
      );
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      delete (window as unknown as { API?: ScormApi }).API;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <LaunchBar
        backHref={backHref}
        backLabel={backLabel}
        title={courseTitle}
        showTitle={showTitle}
        revision={revision}
        continueHref={continueHref}
        continueReady={continueReady}
        continueStatusHref={continueStatusHref}
        continuePoll={false}
        continueRecheck={continueRecheck}
      >
        <SyncBadge status={status} />
      </LaunchBar>
      <div className="relative flex-1 min-h-0 bg-white">
        <iframe
          ref={frame.ref}
          src={iframeSrc}
          className="absolute inset-0 w-full h-full bg-white"
          title={courseTitle}
          onLoad={frame.onLoad}
          // SCORM courses commonly use document.write, inline scripts, etc.
          // No sandbox attribute so the course has full access to window.parent.API.
        />
        <ModuleFrameLoader loaded={frame.loaded} />
      </div>
    </div>
  );
}

function SyncBadge({ status }: { status: "idle" | "syncing" | "saved" | "error" }) {
  const map = {
    idle: { label: "", className: "" },
    syncing: { label: "Saving...", className: "text-canvas/70" },
    saved: { label: "Saved", className: "text-emerald-300" },
    error: { label: "Sync error", className: "text-red-300" },
  };
  const { label, className } = map[status];
  if (!label) return null;
  return <span className={`text-xs ${className}`}>{label}</span>;
}
