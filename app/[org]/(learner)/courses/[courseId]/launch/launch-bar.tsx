"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  CONTINUE_CHECK_DEBOUNCE_MS,
  CONTINUE_MESSAGE_MS,
  CONTINUE_STATUS_POLL_MS,
  CONTINUE_WAITING_MESSAGE,
  continueState,
  parseStoredAnswer,
  shouldPoll,
} from "@/lib/learner/continue-state";

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
 * - Continue shows only on a Learning Path launch (`continueHref`). It waits
 *   until the module's official result is stored (ADR 0019, note of
 *   2026-11-11): muted, `aria-disabled`, a lock icon and no `href`, so a tap
 *   before hydration cannot navigate; a tap shows "Finish this module to
 *   continue" and runs one status check. Once the result is stored it is
 *   today's plain `<a>` to the continue address: a full navigation, so the
 *   continue route (which waits and redirects) is never prefetched, and the
 *   module document unloads as on a tab close. The launch page renders it
 *   ready at once when the result is already stored (`continueReady`).
 * - How the bar learns the result: cmi5 and xAPI launches poll the status
 *   route (`continueStatusHref`) every CONTINUE_STATUS_POLL_MS while the tab
 *   is visible, and check at once when it becomes visible again; the SCORM
 *   runtime does not poll and bumps `continueRecheck` after a commit the
 *   server answered with a terminal status. Only `{ stored: true }` turns it
 *   ready, and once ready it never goes back.
 * - Below `sm` the bar is thinner (`py-0.5`, 36 px controls) so the module
 *   gets the room; from `sm` it is unchanged (`sm:py-1`, 40 px controls).
 * - `children` sits in the centre beside the badge (the SCORM sync status).
 */
export function LaunchBar({
  backHref,
  backLabel,
  title,
  showTitle,
  revision,
  continueHref,
  continueReady,
  continueStatusHref,
  continuePoll,
  continueRecheck = 0,
  children,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  showTitle: boolean;
  revision: boolean;
  continueHref: string | null;
  /** The official result is already stored (or the launch is a preview): Continue starts active. */
  continueReady: boolean;
  /** The status route the bar asks while it waits; null on a launch that is not a path launch. */
  continueStatusHref: string | null;
  /** Whether this runtime polls the status route (cmi5 and xAPI: true; SCORM: false). */
  continuePoll: boolean;
  /** A change of this number runs one status check at once (the SCORM runtime's terminal commit). */
  continueRecheck?: number;
  children?: ReactNode;
}) {
  const { ready, check } = useContinueReady({
    statusHref: continueHref ? continueStatusHref : null,
    initialReady: continueReady,
    poll: continuePoll,
    recheck: continueRecheck,
  });
  const state = continueState(ready);
  const [message, setMessage] = useState("");
  const messageTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    },
    []
  );

  const onTap = async (e: MouseEvent<HTMLAnchorElement> | KeyboardEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const answer = await check();
    if (answer === true) {
      // The learner tapped to continue and the result is stored: go now (a
      // full navigation to the same address the ready button links to).
      if (continueHref) window.location.assign(continueHref);
      return;
    }
    setMessage(CONTINUE_WAITING_MESSAGE);
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => {
      messageTimer.current = null;
      setMessage("");
    }, CONTINUE_MESSAGE_MS);
  };

  return (
    <header
      data-testid="launch-bar"
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 sm:px-4 py-0.5 sm:py-1 bg-ink text-canvas border-b border-canvas/10 relative z-10"
    >
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 min-h-9 sm:min-h-10 px-3 rounded-lg border border-canvas/20 hover:border-canvas/50 hover:bg-canvas/10 text-sm font-medium transition-colors shrink-0"
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
        state === "ready" ? (
          <a
            href={continueHref}
            data-testid="continue-next"
            data-state="ready"
            className="inline-flex items-center gap-1.5 min-h-9 sm:min-h-10 px-3 rounded-lg bg-canvas text-ink text-sm font-semibold hover:bg-canvas/90 transition-colors shrink-0"
          >
            Continue
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" />
            </svg>
          </a>
        ) : (
          <a
            data-testid="continue-next"
            data-state="waiting"
            role="link"
            tabIndex={0}
            aria-disabled="true"
            className="inline-flex items-center gap-1.5 min-h-9 sm:min-h-10 px-3 rounded-lg bg-canvas/30 text-canvas/60 text-sm font-semibold cursor-not-allowed select-none shrink-0"
            onClick={onTap}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") void onTap(e);
            }}
          >
            Continue
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
            </svg>
          </a>
        )
      ) : (
        <span aria-hidden />
      )}
      {continueHref && (
        <p
          role="status"
          aria-live="polite"
          data-testid="continue-waiting-message"
          className={message ? "absolute right-2 top-full mt-1 z-20 rounded-md bg-ink text-canvas text-xs px-2 py-1 shadow-lg whitespace-nowrap" : "sr-only"}
        >
          {message}
        </p>
      )}
    </header>
  );
}

/**
 * Continue's state on a path launch: `ready` starts as the page's own answer
 * and turns true only on the status route's `{ stored: true }`; once true it
 * never goes back and every timer and listener is removed. `check()` runs one
 * status request (one in flight at a time, aborted on unmount, never
 * throwing) and returns the parsed answer; an immediate check within
 * CONTINUE_CHECK_DEBOUNCE_MS of the last answers the last answer instead,
 * except a forced one (a terminal SCORM commit changed the row), which waits
 * for any request in flight and asks again.
 */
function useContinueReady({
  statusHref,
  initialReady,
  poll,
  recheck,
}: {
  statusHref: string | null;
  initialReady: boolean;
  poll: boolean;
  recheck: number;
}): { ready: boolean; check: (force?: boolean) => Promise<boolean | null> } {
  const [ready, setReady] = useState(initialReady);
  const readyRef = useRef(initialReady);
  const inflight = useRef<Promise<boolean | null> | null>(null);
  const lastAt = useRef(0);
  const lastAnswer = useRef<boolean | null>(null);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    lifetime.current = ac;
    return () => ac.abort();
  }, []);

  const check = useCallback(
    async (force = false): Promise<boolean | null> => {
      if (force) while (inflight.current) await inflight.current;
      if (readyRef.current) return true;
      if (statusHref === null) return null;
      if (inflight.current) return inflight.current;
      if (!force && Date.now() - lastAt.current < CONTINUE_CHECK_DEBOUNCE_MS) return lastAnswer.current;
      lastAt.current = Date.now();
      const run = (async (): Promise<boolean | null> => {
        try {
          const res = await fetch(statusHref, {
            cache: "no-store",
            credentials: "same-origin",
            signal: lifetime.current?.signal,
          });
          const answer = parseStoredAnswer(res.status, await res.json().catch(() => null));
          lastAnswer.current = answer;
          if (answer === true) {
            readyRef.current = true;
            setReady(true);
          }
          return answer;
        } catch {
          return null;
        }
      })();
      inflight.current = run;
      void run.finally(() => {
        if (inflight.current === run) inflight.current = null;
      });
      return run;
    },
    [statusHref]
  );

  // The poll: only while shouldPoll holds (a path launch, waiting, the tab
  // visible, a runtime that polls). Nothing at all for a launch that never
  // polls or once ready.
  useEffect(() => {
    if (statusHref === null || !poll || ready) return;
    let timer: number | null = null;
    const sync = () => {
      const want = shouldPoll({
        hasStatusHref: true,
        ready: readyRef.current,
        visible: document.visibilityState === "visible",
        poll,
      });
      if (want && timer === null) timer = window.setInterval(() => void check(), CONTINUE_STATUS_POLL_MS);
      if (!want && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void check();
      sync();
    };
    sync();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [statusHref, poll, ready, check]);

  // The SCORM runtime's terminal commit: one check, after the commit's answer.
  useEffect(() => {
    if (!recheck) return;
    void check(true);
  }, [recheck, check]);

  return { ready, check };
}
