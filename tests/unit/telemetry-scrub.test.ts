/**
 * Unit test for the browser telemetry scrubber (lib/security/telemetry-scrub.ts):
 * the invitation token and the q / email / token query values never reach
 * Sentry, and everything else in a URL or event is left as it was.
 *
 * Run:  npx tsx tests/unit/telemetry-scrub.test.ts   (or npm run test:unit)
 */
import {
  FILTERED,
  scrubBreadcrumb,
  scrubEvent,
  scrubRecordingEvent,
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
eq("access_token= is another name: untouched", scrubText("/cb?access_token=abc&x=1"), "/cb?access_token=abc&x=1");
eq("query= is another name: untouched", scrubText("/api/x?query=abc"), "/api/x?query=abc");
eq("emails= is another name: untouched", scrubText("/api/x?emails=abc"), "/api/x?emails=abc");
eq("empty value left as is", scrubText("/api/x?q=&page=2"), "/api/x?q=&page=2");
eq("q= in a path, not a query: untouched", scrubText("/docs/q=1"), "/docs/q=1");
eq("token and query together", scrubText(`/invitations/${TOKEN}?email=a%40b.c`), `/invitations/${F}?email=${F}`);
eq("plain URL unchanged", scrubText("https://lms.example.test/acme/learn?page=2&sort=asc"), "https://lms.example.test/acme/learn?page=2&sort=asc");
eq("empty string", scrubText(""), "");

console.log("\nscrubBreadcrumb");
eq("fetch breadcrumb data.url", scrubBreadcrumb({ category: "fetch", data: { method: "GET", url: "/api/users/search?q=jane", status_code: 200 } }),
  { category: "fetch", data: { method: "GET", url: `/api/users/search?q=${F}`, status_code: 200 } });
eq("navigation breadcrumb data.from/to", scrubBreadcrumb({ category: "navigation", data: { from: `/invitations/${TOKEN}`, to: "/select-org?email=a%40b.c" } }),
  { category: "navigation", data: { from: `/invitations/${F}`, to: `/select-org?email=${F}` } });
eq("console breadcrumb message and arguments", scrubBreadcrumb({ category: "console", message: `visit /invitations/${TOKEN}`, data: { arguments: [`/invitations/${TOKEN}`, 3] } }),
  { category: "console", message: `visit /invitations/${F}`, data: { arguments: [`/invitations/${F}`, 3] } });
eq("breadcrumb without data or message", scrubBreadcrumb({ category: "ui.click" }), { category: "ui.click" });
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
