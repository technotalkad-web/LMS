/**
 * The launch bar's Continue state (ADR 0019, note of 2026-11-11), as constants
 * and pure functions: on a Learning Path launch Continue waits until the
 * module's official result is stored, then turns active. The bar
 * (courses/[courseId]/launch/launch-bar.tsx) holds the state and the timers;
 * every decision lives here, so it is unit-tested
 * (tests/unit/continue.test.ts).
 *
 * Imported by a client component: deliberately free of next/*, Supabase and
 * lib/scoring imports, so the client bundle gains only these lines. Whether
 * the result is stored is the server's answer (officialResultStored in
 * lib/learner/continue.ts, through the status route); nothing here reads a
 * result.
 */

/** One status check per interval while the bar waits and the tab is visible. */
export const CONTINUE_STATUS_POLL_MS = 25_000;

/** How long the waiting message stays after a tap on the inactive button. */
export const CONTINUE_MESSAGE_MS = 3_000;

/** The message a tap on the inactive button shows (an aria-live status). */
export const CONTINUE_WAITING_MESSAGE = "Finish this module to continue";

/** No second immediate check within this long of the last one (a tap, a return to the tab, a commit). */
export const CONTINUE_CHECK_DEBOUNCE_MS = 2_000;

export type ContinueState = "waiting" | "ready";

/** The bar's `data-state`. */
export function continueState(ready: boolean): ContinueState {
  return ready ? "ready" : "waiting";
}

/**
 * Whether the bar polls the status route now: only on a path launch (a status
 * address), only while waiting, only while the tab is visible, and only for a
 * runtime that polls (cmi5 and xAPI; the SCORM runtime checks after its own
 * terminal commit instead).
 */
export function shouldPoll(i: { hasStatusHref: boolean; ready: boolean; visible: boolean; poll: boolean }): boolean {
  return i.hasStatusHref && !i.ready && i.visible && i.poll;
}

/**
 * The status route's answer: true or false only for a 200 whose body is an
 * object with a boolean `stored`; null (unknown, keep waiting) for anything
 * else: a signed-out check, whose middleware redirect the bar does not follow
 * (`redirect: "manual"`, so status 0), 401, 404, 503, or a body that did not
 * parse.
 */
export function parseStoredAnswer(status: number, body: unknown): boolean | null {
  if (status !== 200) return null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const stored = (body as { stored?: unknown }).stored;
  return typeof stored === "boolean" ? stored : null;
}
