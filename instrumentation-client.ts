import * as Sentry from "@sentry/nextjs";
import {
  isCredentialUrl,
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
 * replaces the /invitations/<token> segment, q= / email= / token= query
 * values and Supabase credentials in a query or fragment (access_token=,
 * refresh_token=, ...) with "[Filtered]". Error replays are not sampled
 * from a document that has shown a credential page (see below).
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  // Session Replay writes location.href into the Meta event of every full
  // snapshot (one at page load, then one per checkout), and no hook can
  // scrub it. A document that has shown a page whose URL carries a
  // credential (/auth/finish#access_token=..., /invitations/<token>) never
  // samples an error replay: its buffer may still hold that href.
  let credentialPageSeen = isCredentialUrl(window.location.href);

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
    beforeBreadcrumb: (breadcrumb) => {
      const to = breadcrumb.category === "navigation" ? breadcrumb.data?.to : undefined;
      if (typeof to === "string" && isCredentialUrl(to)) credentialPageSeen = true;
      return scrubBreadcrumb(breadcrumb);
    },

    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
        beforeAddRecordingEvent: (event) => scrubRecordingEvent(event),
        beforeErrorSampling: () => !(credentialPageSeen || isCredentialUrl(window.location.href)),
      }),
    ],
  });

  // Replay events (their page urls and request url) skip beforeSend and
  // beforeSendTransaction; event processors run for them too.
  Sentry.addEventProcessor((event) => (event.type === "replay_event" ? scrubEvent(event) : event));
}
