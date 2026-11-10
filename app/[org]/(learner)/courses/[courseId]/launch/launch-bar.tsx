"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The bar above a running module (ADR 0019 step 6), one component for both
 * runtimes: Exit on the left, Revision Mode in the centre, Continue on the
 * right. Three columns at every width (`auto minmax(0,1fr) auto`), so the
 * centre takes the remaining space and never overlaps either side.
 *
 * - Exit stays a `next/link` with its target and wording (`backHref`,
 *   "Exit" below `sm`, `backLabel` from `sm`).
 * - The course title shows only when `showTitle` (packages that are not
 *   KIVO builds) and only from `sm`, capped at 28vw: in a grid the `auto`
 *   column grows to its content before the centre gets any space, so an
 *   uncapped long title would squeeze Revision Mode to nothing. The iframe's
 *   `title` keeps it for screen readers at every width.
 * - Continue shows only on a Learning Path launch (`continueHref`). It is a
 *   plain `<a>`: a full navigation, so the continue route (which waits and
 *   redirects) is never prefetched, and the module document unloads as on a
 *   tab close.
 * - `children` sits in the centre beside the badge (the SCORM sync status).
 */
export function LaunchBar({
  backHref,
  backLabel,
  title,
  showTitle,
  revision,
  continueHref,
  children,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  showTitle: boolean;
  revision: boolean;
  continueHref: string | null;
  children?: ReactNode;
}) {
  return (
    <header
      data-testid="launch-bar"
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 sm:px-4 py-1 bg-ink text-canvas border-b border-canvas/10"
    >
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 min-h-10 px-3 rounded-lg border border-canvas/20 hover:border-canvas/50 hover:bg-canvas/10 text-sm font-medium transition-colors shrink-0"
          title={`Exit course — ${backLabel.toLowerCase()}`}
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z" clipRule="evenodd" />
          </svg>
          <span className="hidden sm:inline">{backLabel}</span>
          <span className="sm:hidden">Exit</span>
        </Link>
        {showTitle && <span className="hidden sm:inline serif text-lg truncate min-w-0 max-w-[28vw]">{title}</span>}
      </div>
      <div className="flex items-center justify-center gap-2 min-w-0">
        {revision && (
          <span
            className="truncate min-w-0 px-2 py-0.5 rounded-full border border-amber-300/60 bg-amber-400/15 text-amber-200 text-[11px] font-semibold uppercase tracking-wide"
            title="Revision visit: your official result does not change"
            data-testid="practice-badge"
          >
            Revision Mode
          </span>
        )}
        {children}
      </div>
      {continueHref ? (
        <a
          href={continueHref}
          data-testid="continue-next"
          className="inline-flex items-center gap-1.5 min-h-10 px-3 rounded-lg bg-canvas text-ink text-sm font-semibold hover:bg-canvas/90 transition-colors shrink-0"
        >
          Continue
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" />
          </svg>
        </a>
      ) : (
        <span aria-hidden />
      )}
    </header>
  );
}
