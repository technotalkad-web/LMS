"use client";

import Link from "next/link";

/**
 * Parent page for a cmi5 course iframe.
 *
 * Unlike SCORM 1.2 we don't expose a `window.API` shim — cmi5 AUs talk
 * HTTP to the LRS (our /api/xapi/* endpoints) using the Bearer token they
 * fetch from the `fetch` URL on launch. The parent's only job is to host
 * the iframe and provide a back button.
 *
 * The launch URL embedded in `iframeSrc` already contains the cmi5 query
 * parameters: endpoint, fetch, actor, registration, activityId.
 */
export function Cmi5Runtime({
  iframeSrc,
  courseTitle,
  backHref,
}: {
  iframeSrc: string;
  courseTitle: string;
  backHref: string;
}) {
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
        <span className="text-xs text-canvas/50">cmi5</span>
      </header>
      <iframe
        src={iframeSrc}
        className="flex-1 w-full bg-white"
        title={courseTitle}
      />
    </div>
  );
}
