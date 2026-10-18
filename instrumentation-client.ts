import * as Sentry from "@sentry/nextjs";
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubRecordingEvent,
  scrubSpan,
} from "./lib/security/telemetry-scrub";

/**
 * Client-side Sentry init.
 *
 * Runs in the browser. Captures uncaught errors, unhandled promise
 * rejections, React error boundaries (when wrapped), and fetch/XHR
 * failures. Server-side (in the Cloudflare Worker) is deliberately
 * NOT instrumented yet — that needs @sentry/cloudflare integration
 * which is a separate follow-up. For now this gives us ~80% of
 * user-visible bugs at zero risk to the OpenNext build.
 *
 * DSN is injected at build time via NEXT_PUBLIC_SENTRY_DSN (see
 * .github/workflows/deploy-*.yml). When the env var is missing
 * (e.g. local `next dev` without secrets), init is a no-op.
 *
 * Privacy: Session Replay keeps the SDK defaults (all text masked, all
 * media blocked, inputs masked), so learner and admin names, emails and
 * scores never reach Sentry. Every event, span, breadcrumb and replay
 * custom event passes through lib/security/telemetry-scrub.ts, which
 * replaces the /invitations/<token> segment and q= / email= / token=
 * query values with "[Filtered]".
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENV ?? "staging",

    // Sample 10% of transactions for performance monitoring.
    // Bump to 1.0 if you want every transaction; drop to 0 to disable
    // perf tracking entirely (errors-only mode).
    tracesSampleRate: 0.1,

    // Session replays — record 0% of normal sessions and 100% of
    // sessions that hit an error. Free tier includes 50 replays/month.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,

    // Filter known-benign noise so it doesn't burn through the quota.
    ignoreErrors: [
      // Browser extensions
      "top.GLOBALS",
      // Network errors from cancelled fetches on navigation
      "AbortError",
      "Failed to fetch",
      // ResizeObserver: see https://stackoverflow.com/a/50387233
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
    ],

    // Credential and search scrubbing (see the header comment).
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeSendSpan: (span) => scrubSpan(span),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),

    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
        beforeAddRecordingEvent: (event) => scrubRecordingEvent(event),
      }),
    ],
  });

  // Replay events (their page urls and request url) skip beforeSend and
  // beforeSendTransaction; event processors run for them too.
  Sentry.addEventProcessor((event) => (event.type === "replay_event" ? scrubEvent(event) : event));
}
