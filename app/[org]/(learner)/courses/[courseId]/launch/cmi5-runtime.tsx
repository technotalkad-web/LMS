"use client";

import Link from "next/link";
import { ModuleFrameLoader, useModuleFrame, useNextModulePreload } from "./module-frame";

/**
 * Parent page for a cmi5 or standalone xAPI (TinCan) course iframe.
 *
 * Unlike SCORM 1.2 we don't expose a `window.API` shim — the package talks
 * HTTP to the LRS (our /api/xapi/* endpoints) using the attempt token it
 * either fetches from the cmi5 `fetch` URL or receives verbatim in the
 * TinCan `auth` launch parameter. The parent's only job is to host the
 * iframe and provide a back button.
 *
 * The launch URL embedded in `iframeSrc` already contains the launch
 * parameters (cmi5: endpoint, fetch, actor, registration, activityId;
 * xAPI: endpoint, auth, actor, activity_id, registration).
 */
export function Cmi5Runtime({
  iframeSrc,
  courseTitle,
  backHref,
  backLabel = "Exit course",
  standard = "cmi5",
  preloadUrls = [],
}: {
  iframeSrc: string;
  courseTitle: string;
  backHref: string;
  /** Names the launch context the exit returns to ("Back to journey"). */
  backLabel?: string;
  /** Badge in the header corner. */
  standard?: "cmi5" | "xAPI";
  /** Next module's content file(s) to warm in the background once this one is up. */
  preloadUrls?: string[];
}) {
  const frame = useModuleFrame();
  useNextModulePreload(preloadUrls, frame.loaded);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <header className="flex items-center justify-between px-4 sm:px-5 py-2.5 bg-ink text-canvas border-b border-canvas/10">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-canvas/20 hover:border-canvas/50 hover:bg-canvas/10 text-sm font-medium transition-colors shrink-0"
            title={`Exit course — ${backLabel.toLowerCase()}`}
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z" clipRule="evenodd" />
            </svg>
            <span className="hidden sm:inline">{backLabel}</span>
            <span className="sm:hidden">Exit</span>
          </Link>
          <span className="serif text-lg sm:text-xl truncate">{courseTitle}</span>
        </div>
        <span className="text-xs text-canvas/50">{standard}</span>
      </header>
      <div className="relative flex-1 min-h-0 bg-white">
        <iframe
          ref={frame.ref}
          src={iframeSrc}
          className="absolute inset-0 w-full h-full bg-white"
          title={courseTitle}
          onLoad={frame.onLoad}
        />
        <ModuleFrameLoader loaded={frame.loaded} />
      </div>
    </div>
  );
}
