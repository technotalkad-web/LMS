/**
 * Scrubbing for browser telemetry (Sentry). Pure: no SDK import, no I/O.
 *
 * The browser SDK records page and request URLs in error events, in
 * transactions (pageload and navigation spans are named from
 * location.pathname), in breadcrumbs (fetch/xhr `data.url`, navigation
 * `data.from` / `data.to`, console messages) and in Session Replay's own
 * events. Three kinds of value must never leave the browser:
 *
 *   - the invitation token in /invitations/<token>: the token is the
 *     credential (app/invitations/[token]/page.tsx);
 *   - the values of the q, email and token query parameters (q= is the
 *     user search by name or email, app/api/users/search/route.ts) and of
 *     the Supabase credentials (token_hash, access_token, refresh_token,
 *     provider_token, provider_refresh_token), in the query or in the
 *     fragment: an implicit-flow sign-in link lands on
 *     /auth/finish#access_token=...&refresh_token=...
 *     (app/auth/finish/AuthCallbackFragment.tsx), and the SDK reads
 *     location.href, fragment included;
 *   - the aria-label, title and alt attribute values in a UI breadcrumb
 *     (ui.click, ui.input, ...). The SDK describes the target element as a
 *     selector read from the live DOM, e.g.
 *     span[title="alice@corp.com"] > button[aria-label="Remove Alice"],
 *     and admin pages put learner names and emails in those attributes.
 *     Replay's text and attribute masking never sees that string.
 *
 * Each such value becomes "[Filtered]". The rest of the URL or selector is
 * kept, so an event stays debuggable. Wired up in instrumentation-client.ts.
 */

export const FILTERED = "[Filtered]";

// The path segment after /invitations/ (a bare path or inside a full URL),
// except the static API routes /api/invitations/accept and /bulk. Tokens are
// uuids (0005_invitations_assignments.sql); the segment is matched as URL
// unreserved characters plus percent-escapes, + and =, so text right after
// it (": 500", ")") is kept.
const INVITATION_TOKEN = /(\/invitations\/)(?!(?:accept|bulk)(?![\w.~%+=-]))[\w.~%+=-]+/gi;

// The value of a sensitive parameter in the query or the fragment: after ?,
// & or #, up to the next parameter or the fragment. The name must match
// whole, so names that merely contain one of these (token_type=, query=,
// emails=) are left alone.
const SENSITIVE_QUERY =
  /([?&#](?:q|email|token|token_hash|access_token|refresh_token|provider_token|provider_refresh_token)=)[^&#\s"'<>]+/gi;

// Pages whose own URL carries a credential: the implicit-flow sign-in
// landing page and an invitation (a top-level page, not /api/invitations).
const CREDENTIAL_PATH = /^\/(?:auth\/finish(?:[/?#]|$)|invitations\/[^/?#])/i;
const CREDENTIAL_PARAM = /[?&#](?:token|token_hash|access_token|refresh_token|provider_token|provider_refresh_token)=[^&#]/i;

// One [attr="value"] part of an element selector, for the attributes that
// carry visible text. The SDK does not escape quotes in the value, so the
// value ends at the first "] that closes the part: one followed by the next
// [attr], the " > " ancestor separator, or the end of the string.
const SELECTOR_TEXT_ATTRIBUTE = /\[(aria-label|title|alt)="[\s\S]*?"\](?=\[| > |$)/g;

// The element attributes Session Replay copies into a click breadcrumb's
// data.node.attributes that can carry visible text.
const TEXT_ATTRIBUTES = ["aria-label", "title", "alt"];

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return typeof value === "object" && value !== null;
}

/** Returns `value` with every invitation token and sensitive parameter value replaced. */
export function scrubText(value: string): string {
  return value.replace(INVITATION_TOKEN, `$1${FILTERED}`).replace(SENSITIVE_QUERY, `$1${FILTERED}`);
}

/**
 * Returns an element selector (a UI breadcrumb message) with every
 * aria-label, title and alt value replaced. Tag, id, classes, type and name
 * are kept.
 */
export function scrubSelectorText(value: string): string {
  return value.replace(SELECTOR_TEXT_ATTRIBUTE, `[$1="${FILTERED}"]`);
}

function isUiCategory(category: unknown): boolean {
  return typeof category === "string" && category.startsWith("ui.");
}

/**
 * True when a page URL (absolute, or a path with its query and fragment)
 * itself carries a credential: /auth/finish, /invitations/<token>, or a
 * token / Supabase credential parameter in its query or fragment.
 *
 * Session Replay records location.href in the Meta event of every full
 * snapshot, and no hook can scrub it (beforeAddRecordingEvent only receives
 * custom events), so instrumentation-client.ts does not sample an error
 * replay from a document that has shown such a page.
 */
export function isCredentialUrl(url: string): boolean {
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  return CREDENTIAL_PATH.test(rest) || CREDENTIAL_PARAM.test(rest);
}

/**
 * Scrubs every string inside `value` in place (object properties and array
 * items, down to `depth` levels) and returns it. Non-strings are untouched.
 */
function scrubDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubText(value);
  if (depth <= 0 || !isObject(value)) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], depth - 1);
    return value;
  }
  for (const key of Object.keys(value)) value[key] = scrubDeep(value[key], depth - 1);
  return value;
}

function scrubStringField(target: Loose, key: string): void {
  const v = target[key];
  if (typeof v === "string") target[key] = scrubText(v);
}

/**
 * A breadcrumb: its message and the strings in its data (url, from, to, and
 * the string items of console arguments). beforeBreadcrumb runs before the
 * SDK copies anything, and a console breadcrumb's data.arguments is the
 * app's own console arguments, so data is copied, never written in place,
 * and object values (the app's live objects) are passed through untouched.
 */
export function scrubBreadcrumb<T extends object>(breadcrumb: T): T {
  const b = breadcrumb as Loose;
  scrubStringField(b, "message");
  if (isUiCategory(b.category) && typeof b.message === "string") b.message = scrubSelectorText(b.message);
  if (isObject(b.data) && !Array.isArray(b.data)) {
    const data: Loose = { ...b.data };
    for (const key of Object.keys(data)) {
      const v = data[key];
      if (typeof v === "string") data[key] = scrubText(v);
      else if (Array.isArray(v)) data[key] = v.map((item) => (typeof item === "string" ? scrubText(item) : item));
    }
    b.data = data;
  }
  return breadcrumb;
}

/** A span (a transaction's child span or a standalone span): description and data. */
export function scrubSpan<T extends object>(span: T): T {
  const s = span as Loose;
  scrubStringField(s, "description");
  if (isObject(s.data)) scrubDeep(s.data, 3);
  return span;
}

/**
 * An error, transaction or replay event, in place: request (url, headers
 * such as Referer, query_string), message, transaction name, exception
 * values, breadcrumbs, spans, contexts, tags, extra and replay urls.
 */
export function scrubEvent<T extends object>(event: T): T {
  const e = event as Loose;
  scrubStringField(e, "message");
  scrubStringField(e, "transaction");
  if (isObject(e.request)) {
    const r = e.request;
    // A query string is stored without its leading "?".
    if (typeof r.query_string === "string") r.query_string = scrubText(`?${r.query_string}`).slice(1);
    scrubDeep(r, 3);
  }
  if (isObject(e.exception) && Array.isArray(e.exception.values)) {
    for (const ex of e.exception.values) if (isObject(ex)) scrubStringField(ex, "value");
  }
  if (Array.isArray(e.breadcrumbs)) {
    for (const b of e.breadcrumbs) if (isObject(b)) scrubBreadcrumb(b);
  }
  if (Array.isArray(e.spans)) {
    for (const s of e.spans) if (isObject(s)) scrubSpan(s);
  }
  if (isObject(e.contexts)) scrubDeep(e.contexts, 4);
  if (isObject(e.tags)) scrubDeep(e.tags, 1);
  if (isObject(e.extra)) scrubDeep(e.extra, 4);
  if (Array.isArray(e.urls)) scrubDeep(e.urls, 1);
  return event;
}

/**
 * A Session Replay custom recording event (performance spans with page and
 * request URLs, breadcrumbs, options): every string in its data. Replay
 * hands only its own custom events to this hook, never the DOM recording.
 * A UI breadcrumb (Replay's own click breadcrumb, a slow or rage click)
 * also gets its selector message scrubbed and the text attributes of its
 * data.node replaced.
 */
export function scrubRecordingEvent<T extends object>(event: T): T {
  const e = event as Loose;
  if (!isObject(e.data)) return event;
  scrubDeep(e.data, 6);
  const payload = e.data.payload;
  if (e.data.tag === "breadcrumb" && isObject(payload) && isUiCategory(payload.category)) {
    if (typeof payload.message === "string") payload.message = scrubSelectorText(payload.message);
    const node = isObject(payload.data) ? payload.data.node : undefined;
    const attributes = isObject(node) ? node.attributes : undefined;
    if (isObject(attributes)) {
      for (const key of TEXT_ATTRIBUTES) {
        if (typeof attributes[key] === "string") attributes[key] = FILTERED;
      }
    }
  }
  return event;
}
