/**
 * Per-page instrumentation. Attaches to a Playwright Page and collects the
 * runtime signals that reveal defects the eye would miss: uncaught
 * exceptions, console errors, React hydration warnings, and failed network
 * requests. A spec asks the monitor what it saw after each navigation.
 */

import type { Page, Response } from "@playwright/test";

export interface NetFailure {
  url: string;
  status: number;
  method: string;
  resourceType: string;
}

export interface PageSignals {
  pageErrors: string[]; // uncaught exceptions (most severe)
  consoleErrors: string[]; // console.error output
  hydrationErrors: string[]; // subset of console: React hydration/runtime
  netFailures: NetFailure[]; // same-origin 4xx/5xx responses
}

/**
 * Console noise that is documented as accepted in QA_CHECKLIST.md and is not a
 * bug. Suppressed so the report stays signal-dense. Keep this list tight —
 * over-filtering hides real defects.
 */
const ACCEPTED_CONSOLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /Cannot call impure function during render/i, // Date.now for "x hours ago"
  /react\/no-unescaped-entities/i,
  // Third-party telemetry failures (Sentry ingest) are not app defects — they
  // depend on network/ad-blockers/quotas, not LMS code.
  /sentry\.io/i,
  /ingest\.[a-z0-9-]+\.sentry/i,
];

/** React hydration / runtime markers worth escalating above plain console errors. */
const HYDRATION_MARKERS = [
  /hydrat/i,
  /did not match/i,
  /Text content does not match/i,
  /Minified React error #(418|421|422|423|425)/i,
];

function isAccepted(text: string): boolean {
  return ACCEPTED_CONSOLE.some((re) => re.test(text));
}

/**
 * Attach listeners and return a live signal bag plus a reset() for reuse
 * across multiple navigations on the same page. Same-origin is derived from
 * the page's baseURL host so third-party widgets (analytics, fonts) don't
 * generate false network findings.
 */
export function attachMonitor(page: Page, baseURL: string): {
  signals: PageSignals;
  reset: () => void;
} {
  const host = safeHost(baseURL);
  const signals: PageSignals = {
    pageErrors: [],
    consoleErrors: [],
    hydrationErrors: [],
    netFailures: [],
  };

  page.on("pageerror", (err) => {
    signals.pageErrors.push(err.message || String(err));
  });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isAccepted(text)) return;
    signals.consoleErrors.push(text);
    if (HYDRATION_MARKERS.some((re) => re.test(text))) {
      signals.hydrationErrors.push(text);
    }
  });

  page.on("response", (res: Response) => {
    const status = res.status();
    if (status < 400) return;
    const url = res.url();
    if (host && safeHost(url) !== host) return; // only our own origin
    signals.netFailures.push({
      url,
      status,
      method: res.request().method(),
      resourceType: res.request().resourceType(),
    });
  });

  return {
    signals,
    reset: () => {
      signals.pageErrors.length = 0;
      signals.consoleErrors.length = 0;
      signals.hydrationErrors.length = 0;
      signals.netFailures.length = 0;
    },
  };
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}
