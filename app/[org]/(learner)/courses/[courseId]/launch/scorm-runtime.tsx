"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CmiData } from "@/lib/scorm/types";

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
}: {
  attemptId: string;
  initialCmi: CmiData;
  iframeSrc: string;
  courseTitle: string;
  backHref: string;
}) {
  const cmiRef = useRef<CmiData>({ ...initialCmi });
  const initializedRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "syncing" | "saved" | "error">(
    "idle"
  );
  const [lastError, setLastError] = useState("0");

  async function commit(finished: boolean): Promise<boolean> {
    setStatus("syncing");
    try {
      const res = await fetch(`/api/scorm/${attemptId}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmi: cmiRef.current, finished }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 1500);
      return true;
    } catch (err) {
      console.error("[scorm] commit failed:", err);
      setStatus("error");
      return false;
    }
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
      <header className="flex items-center justify-between px-4 sm:px-5 py-2.5 bg-ink text-canvas border-b border-canvas/10">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-canvas/20 hover:border-canvas/50 hover:bg-canvas/10 text-sm font-medium transition-colors shrink-0"
            title="Exit course and return to dashboard"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z" clipRule="evenodd" />
            </svg>
            <span className="hidden sm:inline">Exit course</span>
            <span className="sm:hidden">Exit</span>
          </Link>
          <span className="serif text-lg sm:text-xl truncate">{courseTitle}</span>
        </div>
        <SyncBadge status={status} />
      </header>
      <iframe
        src={iframeSrc}
        className="flex-1 w-full bg-white"
        title={courseTitle}
        // SCORM courses commonly use document.write, inline scripts, etc.
        // No sandbox attribute so the course has full access to window.parent.API.
      />
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
