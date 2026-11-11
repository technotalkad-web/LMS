"use client";

import { LaunchBar } from "./launch-bar";
import { ModuleFrameLoader, useModuleFrame, useNextModulePreload } from "./module-frame";

/**
 * Parent page for a cmi5 or standalone xAPI (TinCan) course iframe.
 *
 * Unlike SCORM 1.2 we don't expose a `window.API` shim — the package talks
 * HTTP to the LRS (our /api/xapi/* endpoints) using the attempt token it
 * either fetches from the cmi5 `fetch` URL or receives verbatim in the
 * TinCan `auth` launch parameter. The parent's only job is to host the
 * iframe and the launch bar (Exit, Revision Mode, Continue).
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
  preloadUrls = [],
  revision = false,
  showTitle = true,
  continueHref = null,
  continueReady = false,
  continueStatusHref = null,
}: {
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
  /** The status route the bar polls while Continue waits; null off a path launch. */
  continueStatusHref?: string | null;
}) {
  const frame = useModuleFrame();
  useNextModulePreload(preloadUrls, frame.loaded);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      {/* cmi5 and xAPI content posts its statements itself, so the parent has
          no completion signal of its own: the bar polls the status route. */}
      <LaunchBar
        backHref={backHref}
        backLabel={backLabel}
        title={courseTitle}
        showTitle={showTitle}
        revision={revision}
        continueHref={continueHref}
        continueReady={continueReady}
        continueStatusHref={continueStatusHref}
        continuePoll={true}
      />
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
