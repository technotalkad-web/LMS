/**
 * Unit test for the browser telemetry scrubber (lib/security/telemetry-scrub.ts):
 * the invitation token, the q / email / token query values and the Supabase
 * credentials in a query or fragment, and the aria-label / title / alt values
 * in a UI breadcrumb's element selector never reach Sentry, and everything
 * else in a URL, selector or event is left as it was.
 *
 * Run:  npx tsx tests/unit/telemetry-scrub.test.ts   (or npm run test:unit)
 */
import {
  FILTERED,
  isCredentialUrl,
  scrubBreadcrumb,
  scrubEvent,
  scrubRecordingEvent,
  scrubSelectorText,
  scrubSpan,
  scrubText,
} from "../../lib/security/telemetry-scrub";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const TOKEN = "f3b2c1d0-aaaa-4bbb-8ccc-0123456789ab";
const F = FILTERED;

console.log("\nscrubText: invitation token");
eq("bare path", scrubText(`/invitations/${TOKEN}`), `/invitations/${F}`);
eq("full URL", scrubText(`https://lms.example.test/invitations/${TOKEN}`), `https://lms.example.test/invitations/${F}`);
eq("trailing path kept", scrubText(`/invitations/${TOKEN}/accept`), `/invitations/${F}/accept`);
eq("query after token kept", scrubText(`/invitations/${TOKEN}?ref=mail`), `/invitations/${F}?ref=mail`);
eq("fragment after token kept", scrubText(`/invitations/${TOKEN}#form`), `/invitations/${F}#form`);
eq("case-insensitive", scrubText(`/Invitations/${TOKEN}`), `/Invitations/${F}`);
eq("inside message text", scrubText(`Error loading /invitations/${TOKEN}: 500`), `Error loading /invitations/${F}: 500`);
eq("closing parenthesis kept", scrubText(`(see /invitations/${TOKEN})`), `(see /invitations/${F})`);
eq("percent-encoded token scrubbed whole", scrubText("/invitations/ab%2Bcd_9.x~y"), `/invitations/${F}`);
eq("two URLs in one text", scrubText(`/invitations/a1 then /invitations/b2`), `/invitations/${F} then /invitations/${F}`);
eq("API accept route kept", scrubText("/api/invitations/accept"), "/api/invitations/accept");
eq("API bulk route kept", scrubText("/api/invitations/bulk?x=1"), "/api/invitations/bulk?x=1");
eq("token that only starts with 'accept' is scrubbed", scrubText("/invitations/acceptXYZ"), `/invitations/${F}`);
eq("collection path kept", scrubText("/api/invitations"), "/api/invitations");
eq("idempotent", scrubText(scrubText(`/invitations/${TOKEN}`)), `/invitations/${F}`);

console.log("\nscrubText: q / email / token query values");
for (const name of ["q", "email", "token"]) {
  eq(`${name}= first param`, scrubText(`/api/x?${name}=jane%40example.test&page=2`), `/api/x?${name}=${F}&page=2`);
  eq(`${name}= middle param`, scrubText(`/api/x?a=1&${name}=jane&b=2`), `/api/x?a=1&${name}=${F}&b=2`);
  eq(`${name}= last param`, scrubText(`/api/x?a=1&${name}=jane`), `/api/x?a=1&${name}=${F}`);
  eq(`${name}= before a fragment`, scrubText(`/api/x?${name}=jane#top`), `/api/x?${name}=${F}#top`);
}
eq("user search URL", scrubText("https://lms.example.test/api/users/search?q=Jane+Doe"), `https://lms.example.test/api/users/search?q=${F}`);
eq("upper-case name", scrubText("/api/x?EMAIL=a%40b.c"), `/api/x?EMAIL=${F}`);
eq("q= in the fragment", scrubText("/acme/admin/users#q=jane"), `/acme/admin/users#q=${F}`);
eq("query= is another name: untouched", scrubText("/api/x?query=abc"), "/api/x?query=abc");
eq("emails= is another name: untouched", scrubText("/api/x?emails=abc"), "/api/x?emails=abc");
eq("empty value left as is", scrubText("/api/x?q=&page=2"), "/api/x?q=&page=2");
eq("q= in a path, not a query: untouched", scrubText("/docs/q=1"), "/docs/q=1");
eq("token and query together", scrubText(`/invitations/${TOKEN}?email=a%40b.c`), `/invitations/${F}?email=${F}`);
eq("plain URL unchanged", scrubText("https://lms.example.test/acme/learn?page=2&sort=asc"), "https://lms.example.test/acme/learn?page=2&sort=asc");
eq("empty string", scrubText(""), "");

console.log("\nscrubText: Supabase credentials (query and fragment)");
for (const name of ["token_hash", "access_token", "refresh_token", "provider_token", "provider_refresh_token"]) {
  eq(`${name}= in the query`, scrubText(`/auth/callback?${name}=abc.def&type=magiclink`), `/auth/callback?${name}=${F}&type=magiclink`);
  eq(`${name}= first in the fragment`, scrubText(`/auth/finish#${name}=abc.def&x=1`), `/auth/finish#${name}=${F}&x=1`);
}
eq("implicit-flow landing URL", scrubText(
  "https://lms.example.test/auth/finish?next=%2Facme%2Fdashboard#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-_x&expires_at=1760000000&expires_in=3600&refresh_token=r3fr35h-t0k3n&token_type=bearer&type=magiclink"),
  `https://lms.example.test/auth/finish?next=%2Facme%2Fdashboard#access_token=${F}&expires_at=1760000000&expires_in=3600&refresh_token=${F}&token_type=bearer&type=magiclink`);
eq("error fragment untouched", scrubText("/auth/finish#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid"),
  "/auth/finish#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid");
eq("token_type= is another name: untouched", scrubText("/cb#token_type=bearer"), "/cb#token_type=bearer");
eq("a fragment that is not a parameter: untouched", scrubText("/docs#access"), "/docs#access");

console.log("\nisCredentialUrl");
eq("/auth/finish (path)", isCredentialUrl("/auth/finish"), true);
eq("/auth/finish with next and fragment (full URL)", isCredentialUrl("https://lms.example.test/auth/finish?next=%2Fx#access_token=a&refresh_token=b"), true);
eq("/auth/finishing is another page", isCredentialUrl("/auth/finishing"), false);
eq("/invitations/<token>", isCredentialUrl(`https://lms.example.test/invitations/${TOKEN}`), true);
eq("/Invitations/<token> (case)", isCredentialUrl(`/Invitations/${TOKEN}`), true);
eq("/invitations alone", isCredentialUrl("/invitations"), false);
eq("/api/invitations/<id> is not a page", isCredentialUrl(`/api/invitations/${TOKEN}`), false);
eq("access_token in a fragment on another page", isCredentialUrl("https://lms.example.test/select-org#access_token=a"), true);
eq("token_hash in a query", isCredentialUrl("/auth/callback?token_hash=abc&type=magiclink"), true);
eq("empty token value", isCredentialUrl("/x?token=&a=1"), false);
eq("search page with q= is not a credential page", isCredentialUrl("https://lms.example.test/acme/admin/users?q=jane"), false);
eq("plain page", isCredentialUrl("https://lms.example.test/acme/learn"), false);
eq("empty string", isCredentialUrl(""), false);

console.log("\nscrubSelectorText");
eq("title and aria-label across ancestors", scrubSelectorText('span[title="alice@corp.com"] > button[aria-label="Remove Alice Kumar"]'),
  `span[title="${F}"] > button[aria-label="${F}"]`);
eq("alt on an image", scrubSelectorText('div.card > img[alt="Photo of Alice"]'), `div.card > img[alt="${F}"]`);
eq("type and name kept, text attributes filtered", scrubSelectorText('button#save.btn[aria-label="Change role for a@b.c"][type="button"][name="role"][title="Alice"]'),
  `button#save.btn[aria-label="${F}"][type="button"][name="role"][title="${F}"]`);
eq("value with a quote", scrubSelectorText('button[aria-label="Remove "Bob" now"] > svg'), `button[aria-label="${F}"] > svg`);
eq("value with ] inside", scrubSelectorText('a[title="x] y"][type="z"]'), `a[title="${F}"][type="z"]`);
eq("component name (no attributes) unchanged", scrubSelectorText("GroupsClient > MemberRow"), "GroupsClient > MemberRow");
eq("plain selector unchanged", scrubSelectorText('div.flex > button.btn[type="submit"]'), 'div.flex > button.btn[type="submit"]');
eq("data-* attribute with a similar name untouched", scrubSelectorText('div[data-title="x"]'), 'div[data-title="x"]');

console.log("\nscrubBreadcrumb");
eq("fetch breadcrumb data.url", scrubBreadcrumb({ category: "fetch", data: { method: "GET", url: "/api/users/search?q=jane", status_code: 200 } }),
  { category: "fetch", data: { method: "GET", url: `/api/users/search?q=${F}`, status_code: 200 } });
eq("navigation breadcrumb data.from/to", scrubBreadcrumb({ category: "navigation", data: { from: `/invitations/${TOKEN}`, to: "/select-org?email=a%40b.c" } }),
  { category: "navigation", data: { from: `/invitations/${F}`, to: `/select-org?email=${F}` } });
eq("console breadcrumb message and arguments", scrubBreadcrumb({ category: "console", message: `visit /invitations/${TOKEN}`, data: { arguments: [`/invitations/${TOKEN}`, 3] } }),
  { category: "console", message: `visit /invitations/${F}`, data: { arguments: [`/invitations/${F}`, 3] } });
eq("breadcrumb without data or message", scrubBreadcrumb({ category: "ui.click" }), { category: "ui.click" });
eq("ui.click breadcrumb: selector text attributes filtered", scrubBreadcrumb({ category: "ui.click", message: 'span[title="alice@corp.com"] > button[aria-label="Remove Alice Kumar"]' }),
  { category: "ui.click", message: `span[title="${F}"] > button[aria-label="${F}"]` });
eq("ui.input breadcrumb filtered too", scrubBreadcrumb({ category: "ui.input", message: 'input[aria-label="Search Alice"][type="text"]' }),
  { category: "ui.input", message: `input[aria-label="${F}"][type="text"]` });
eq("console breadcrumb message is not a selector: kept", scrubBreadcrumb({ category: "console", message: 'found [title="x"]' }),
  { category: "console", message: 'found [title="x"]' });
eq("navigation breadcrumb from a fragment with tokens", scrubBreadcrumb({ category: "navigation", data: { from: "/auth/finish?next=%2Fx#access_token=a.b.c&refresh_token=r", to: "/select-org" } }),
  { category: "navigation", data: { from: `/auth/finish?next=%2Fx#access_token=${F}&refresh_token=${F}`, to: "/select-org" } });
{
  // Console breadcrumbs carry the app's own console arguments: the scrubber
  // must not write into them (or into anything they reference).
  const appObject = { href: `/invitations/${TOKEN}`, nested: { q: "?q=jane" } };
  const args: unknown[] = [`/invitations/${TOKEN}`, appObject];
  const data = { arguments: args, logger: "console" };
  const crumb = scrubBreadcrumb({ category: "console", data });
  const outArgs = (crumb.data as { arguments: unknown[] }).arguments;
  eq("console: string argument scrubbed in the copy", outArgs[0], `/invitations/${F}`);
  eq("console: object argument is the same reference", outArgs[1] === appObject, true);
  eq("console: app object left unchanged", appObject, { href: `/invitations/${TOKEN}`, nested: { q: "?q=jane" } });
  eq("console: original arguments array not written", args[0], `/invitations/${TOKEN}`);
  eq("console: original data object not written", data.arguments === args && crumb.data !== data, true);
}
eq("returns the same object", (() => { const b = { message: "x" }; return scrubBreadcrumb(b) === b; })(), true);

console.log("\nscrubSpan");
eq("fetch span description and data", scrubSpan({ op: "http.client", description: "GET /api/users/search?q=jane", data: { url: "/api/users/search?q=jane", "http.url": "https://lms.example.test/api/users/search?q=jane", "http.response.status_code": 200 } }),
  { op: "http.client", description: `GET /api/users/search?q=${F}`, data: { url: `/api/users/search?q=${F}`, "http.url": `https://lms.example.test/api/users/search?q=${F}`, "http.response.status_code": 200 } });
eq("span without data", scrubSpan({ description: `/invitations/${TOKEN}` }), { description: `/invitations/${F}` });

console.log("\nscrubEvent");
const errorEvent = {
  message: `failed on /invitations/${TOKEN}`,
  transaction: `/invitations/${TOKEN}`,
  request: { url: `https://lms.example.test/invitations/${TOKEN}`, headers: { Referer: "https://lms.example.test/acme/admin/users?q=jane", "User-Agent": "UA" } },
  exception: { values: [{ type: "Error", value: "GET /api/users/search?email=a%40b.c failed", stacktrace: { frames: [{ filename: "app:///_next/static/chunks/x.js", lineno: 1 }] } }] },
  breadcrumbs: [{ category: "fetch", data: { url: "/api/users/search?q=jane" } }],
  contexts: { trace: { data: { url: `/invitations/${TOKEN}` } }, browser: { name: "Chrome" } },
  tags: { route: `/invitations/${TOKEN}`, level: 3 },
  extra: { note: "token=abc" },
  level: "error",
};
eq("error event", scrubEvent(errorEvent), {
  message: `failed on /invitations/${F}`,
  transaction: `/invitations/${F}`,
  request: { url: `https://lms.example.test/invitations/${F}`, headers: { Referer: `https://lms.example.test/acme/admin/users?q=${F}`, "User-Agent": "UA" } },
  exception: { values: [{ type: "Error", value: `GET /api/users/search?email=${F} failed`, stacktrace: { frames: [{ filename: "app:///_next/static/chunks/x.js", lineno: 1 }] } }] },
  breadcrumbs: [{ category: "fetch", data: { url: `/api/users/search?q=${F}` } }],
  contexts: { trace: { data: { url: `/invitations/${F}` } }, browser: { name: "Chrome" } },
  tags: { route: `/invitations/${F}`, level: 3 },
  extra: { note: "token=abc" },
  level: "error",
});
eq("query_string without leading ?", scrubEvent({ request: { query_string: "q=jane&page=2" } }), { request: { query_string: `q=${F}&page=2` } });
eq("transaction event with spans", scrubEvent({ type: "transaction", transaction: `/invitations/${TOKEN}`, spans: [{ description: "GET /api/x?token=abc", data: {} }] }),
  { type: "transaction", transaction: `/invitations/${F}`, spans: [{ description: `GET /api/x?token=${F}`, data: {} }] });
eq("replay event urls", scrubEvent({ type: "replay_event", urls: [`https://lms.example.test/invitations/${TOKEN}`, "https://lms.example.test/acme/learn"] }),
  { type: "replay_event", urls: [`https://lms.example.test/invitations/${F}`, "https://lms.example.test/acme/learn"] });
eq("event with nothing to scrub is unchanged", scrubEvent({ message: "boom", request: { url: "https://lms.example.test/acme/learn" } }),
  { message: "boom", request: { url: "https://lms.example.test/acme/learn" } });
eq("error event on the implicit-flow landing page", scrubEvent({ request: { url: "https://lms.example.test/auth/finish?next=%2Fx#access_token=eyJ.a.b&refresh_token=r3f&token_type=bearer" } }),
  { request: { url: `https://lms.example.test/auth/finish?next=%2Fx#access_token=${F}&refresh_token=${F}&token_type=bearer` } });
eq("error event: ui.click breadcrumb selector filtered", scrubEvent({ breadcrumbs: [{ category: "ui.click", message: 'td[title="alice@corp.com"]' }] }),
  { breadcrumbs: [{ category: "ui.click", message: `td[title="${F}"]` }] });
eq("empty event", scrubEvent({}), {});
eq("non-string fields untouched", scrubEvent({ message: undefined, request: null, breadcrumbs: "x", spans: 3 } as object),
  { request: null, breadcrumbs: "x", spans: 3 });

console.log("\nscrubRecordingEvent");
eq("performance span (navigation)", scrubRecordingEvent({ type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { op: "navigation.push", description: `https://lms.example.test/invitations/${TOKEN}`, startTimestamp: 1, endTimestamp: 2, data: { previous: "/acme/admin/users?q=jane" } } } }),
  { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { op: "navigation.push", description: `https://lms.example.test/invitations/${F}`, startTimestamp: 1, endTimestamp: 2, data: { previous: `/acme/admin/users?q=${F}` } } } });
eq("network span", scrubRecordingEvent({ type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { op: "resource.fetch", description: "/api/users/search?q=jane", data: { method: "GET", statusCode: 200, request: { size: 0 } } } } }),
  { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { op: "resource.fetch", description: `/api/users/search?q=${F}`, data: { method: "GET", statusCode: 200, request: { size: 0 } } } } });
eq("breadcrumb frame", scrubRecordingEvent({ type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "navigation", data: { to: `/invitations/${TOKEN}` } } } }),
  { type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "navigation", data: { to: `/invitations/${F}` } } } });

eq("replay click breadcrumb: message and node text attributes", scrubRecordingEvent({ type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: {
  timestamp: 1, type: "default", category: "ui.click", message: 'div[title="alice@corp.com"] > button[aria-label="Remove Alice Kumar"]',
  data: { nodeId: 7, node: { id: 7, tagName: "button", textContent: "******", attributes: { id: "rm", class: "btn", "aria-label": "Remove Alice Kumar", alt: "Alice", title: "***", role: "button", name: "rm", testId: "remove" } } } } } }),
  { type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: {
  timestamp: 1, type: "default", category: "ui.click", message: `div[title="${F}"] > button[aria-label="${F}"]`,
  data: { nodeId: 7, node: { id: 7, tagName: "button", textContent: "******", attributes: { id: "rm", class: "btn", "aria-label": F, alt: F, title: F, role: "button", name: "rm", testId: "remove" } } } } } });
eq("replay slow-click breadcrumb filtered", scrubRecordingEvent({ type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "ui.slowClickDetected", message: 'a[aria-label="Open Alice"]', data: { node: { attributes: { "aria-label": "Open Alice" } } } } } }),
  { type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "ui.slowClickDetected", message: `a[aria-label="${F}"]`, data: { node: { attributes: { "aria-label": F } } } } } });
eq("replay non-UI breadcrumb: no selector scrub", scrubRecordingEvent({ type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "console", message: 'x[title="y"]' } } }),
  { type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "console", message: 'x[title="y"]' } } });
eq("recording event without data", scrubRecordingEvent({ type: 5, timestamp: 1 }), { type: 5, timestamp: 1 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
