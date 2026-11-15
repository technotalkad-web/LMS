/**
 * The sign-in bounce keeps the whole address (ADR 0024 P2-5, review lens
 * "gate" F1). A signed-out caller sent to a login page comes back to the
 * address they asked for, its query included: a launch's Preview mode,
 * ?lp=, ?journey= and day, and ?lang= decide what the launch does, and a
 * Preview link that came back without its mode would open a Start (a real,
 * official attempt for an enrolled report viewer).
 *
 *   (a) safeNextPath, the one open-redirect guard every hop uses: an
 *       address on this site passes unchanged, query included; "//host",
 *       "/\host", a scheme, a bare host, a control character and an empty
 *       value are refused.
 *   (b) signInNext: the path and its query, Next's `_rsc` left out, no
 *       trailing "?" without a query.
 *   (c) the real middleware (lib/supabase/middleware.ts updateSession), run
 *       signed out with a container-style request host (as behind Cloud
 *       Run): the login address's only parameter is `next`, and `next`
 *       carries the path and the query (the Preview mode, ?lp=, ?journey=
 *       and day, ?lang=), on the org login, the platform login and a
 *       white-label domain (slug-less `next`). The value read back by the
 *       login page's guard is the address asked for; carried through the
 *       callback link (encoded, as the login page, the magic-link e-mail
 *       and SSO build it) it is still the same address.
 *   (d) every consumer of `next` reads it through safeNextPath, and no copy
 *       of the old one-line guard is left; the CRM entry route's `to`
 *       (app/api/integrations/enter) goes through the same guard.
 *
 * Run:  npx tsx tests/unit/sign-in-next.test.ts   (or npm run test:unit)
 * (No DB, no network: fetch is stubbed.)
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { safeNextPath, signInNext } from "../../lib/auth/safe-next";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

const PREVIEW = "/acme/courses/C1/launch?mode=preview";

console.log("\n(a) safeNextPath: an address on this site passes unchanged; anything that could leave it is refused");
{
  const kept = [
    PREVIEW,
    "/acme/courses/C1/launch?lp=P1",
    "/acme/courses/C1/launch?journey=E1&day=3",
    "/acme/courses/C1/launch?lang=hi",
    "/acme/courses/C1/launch?mode=preview&lang=hi",
    "/acme/dashboard",
    "/select-org",
    "/api/integrations/enter?to=%2Facme%2Fdashboard&return_url=https%3A%2F%2Fcrm.example.test%2F",
    "/courses/C1/launch?mode=preview",
    "/acme/dashboard?x=%5C",
  ];
  for (const k of kept) eq(`kept: ${k}`, safeNextPath(k), k);
  const refused: Array<[string, string | null | undefined]> = [
    ["//evil.example", "//evil.example"],
    ["/\\evil.example (browsers read it as //evil.example)", "/\\evil.example"],
    ["/\\/evil.example", "/\\/evil.example"],
    ["https://evil.example", "https://evil.example"],
    ["https:/evil.example", "https:/evil.example"],
    ["http://evil.example/acme/dashboard", "http://evil.example/acme/dashboard"],
    ["javascript:alert(1)", "javascript:alert(1)"],
    ["a bare host", "evil.example"],
    ["\\\\evil.example", "\\\\evil.example"],
    ["/<tab>/evil.example (browsers drop the tab)", "/\t/evil.example"],
    ["/<newline>/evil.example", "/\n/evil.example"],
    ["a backslash later in the path", "/acme/\\evil"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [name, v] of refused) eq(`refused: ${name}`, safeNextPath(v), null);
}

console.log("\n(b) signInNext: the path and its query");
{
  eq("the Preview mode is kept", signInNext("/acme/courses/C1/launch", new URLSearchParams("mode=preview")), PREVIEW);
  eq("?journey= and &day= are kept, in order", signInNext("/acme/courses/C1/launch", new URLSearchParams("journey=E1&day=3")), "/acme/courses/C1/launch?journey=E1&day=3");
  eq("no query: the path alone, no trailing ?", signInNext("/acme/dashboard", new URLSearchParams()), "/acme/dashboard");
  eq("Next's internal _rsc is left out", signInNext("/acme/courses/C1/launch", new URLSearchParams("mode=preview&_rsc=abc")), PREVIEW);
  eq("…and only _rsc: no trailing ?", signInNext("/acme/dashboard", new URLSearchParams("_rsc=abc")), "/acme/dashboard");
  eq("a value that needs encoding stays one value", new URLSearchParams(signInNext("/acme/x", new URLSearchParams({ q: "a&b=c" })).split("?")[1]).get("q"), "a&b=c");
}

console.log("\n(c) the real middleware, signed out, behind a container-style host");
async function middlewareCases() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.stub.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  delete process.env.PLATFORM_OWNER_IP_ALLOWLIST;
  delete process.env.PRIMARY_APP_HOST;
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  // The only call the signed-out path makes is the white-label host lookup
  // (lib/domains/resolve.ts); a signed-out getUser reads no network.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(u);
    if (u.includes("/rest/v1/organizations")) {
      return new Response(JSON.stringify([{ slug: "acme" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const { updateSession } = await import("../../lib/supabase/middleware");
    const bounce = async (url: string, host?: string) => {
      const req = new NextRequest(url, host ? { headers: { host } } : undefined);
      const res = await updateSession(req);
      const loc = res.headers.get("location");
      if (!loc) return { status: res.status, path: null as string | null, params: [] as string[], next: null as string | null };
      const u = new URL(loc);
      return { status: res.status, path: u.pathname, params: [...u.searchParams.keys()], next: u.searchParams.get("next") };
    };
    // The address Cloud Run hands the container: never part of `next`.
    const C = "http://0.0.0.0:8080";

    process.env.CUSTOM_DOMAINS_ENABLED = "0";
    const p = await bounce(`${C}${PREVIEW}`);
    eq("a Preview launch: to the org login, whose only parameter is next", [p.status, p.path, p.params], [307, "/acme/login", ["next"]]);
    eq("…and next keeps ?mode=preview", p.next, PREVIEW);
    eq("…which the login page's guard reads back unchanged (no host in it)", safeNextPath(p.next), PREVIEW);
    for (const q of ["lp=P1", "journey=E1&day=3", "lang=hi", "mode=preview&lang=hi", "lp=P1&lang=hi&back=path"]) {
      const r = await bounce(`${C}/acme/courses/C1/launch?${q}`);
      eq(`?${q} survives the bounce`, r.next, `/acme/courses/C1/launch?${q}`);
    }
    const plain = await bounce(`${C}/acme/courses/C1/launch`);
    eq("no query: next is the path alone", plain.next, "/acme/courses/C1/launch");
    const rsc = await bounce(`${C}/acme/courses/C1/launch?mode=preview&_rsc=x1`);
    eq("an _rsc parameter is not carried", rsc.next, PREVIEW);
    const planted = await bounce(`${C}/acme/dashboard?next=%2F%2Fevil.example`);
    eq("a caller's own ?next= stays inside the page's address, not on the login address",
      [planted.params, planted.next, safeNextPath(planted.next)],
      [["next"], "/acme/dashboard?next=%2F%2Fevil.example", "/acme/dashboard?next=%2F%2Fevil.example"]);
    const reserved = await bounce(`${C}/select-org?x=1`);
    eq("a reserved path goes to the platform login with its query", [reserved.path, reserved.next], ["/login", "/select-org?x=1"]);
    const home = await bounce(`${C}/`);
    eq("/ is public: no bounce", home.path, null);
    const orgLogin = await bounce(`${C}/acme/login?next=%2Facme%2Fdashboard`);
    eq("the org login is public: no bounce", orgLogin.path, null);

    // The hops after the login page: the OAuth/SSO redirectTo and the
    // magic-link e-mail encode next into the callback link
    // (`/auth/callback?next=${encodeURIComponent(next)}`), and the callback
    // reads it back through the same guard.
    const callback = new URL(`https://lms.example.test/auth/callback?code=x&next=${encodeURIComponent(safeNextPath(p.next) ?? "")}`);
    eq("through the callback link: still the Preview address", safeNextPath(callback.searchParams.get("next")), PREVIEW);
    const journey = await bounce(`${C}/acme/courses/C1/launch?journey=E1&day=3`);
    const jCallback = new URL(`https://lms.example.test/auth/callback?token_hash=t&type=magiclink&next=${encodeURIComponent(journey.next ?? "")}`);
    eq("…and the journey day's address", safeNextPath(jCallback.searchParams.get("next")), "/acme/courses/C1/launch?journey=E1&day=3");

    // A white-label host: the login is /login on that host and next is slug-less.
    process.env.CUSTOM_DOMAINS_ENABLED = "1";
    const wl = await bounce("http://0.0.0.0:8080/courses/C1/launch?mode=preview&lang=hi", "learn.example.test");
    eq("a white-label host: /login, a slug-less next with the query", [wl.path, wl.params, wl.next], ["/login", ["next"], "/courses/C1/launch?mode=preview&lang=hi"]);
    eq("…the host lookup was the only fetch", calls.every((u) => u.includes("/rest/v1/organizations")) && calls.length >= 1, true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CUSTOM_DOMAINS_ENABLED;
  }
}

async function main() {
  await middlewareCases();

  console.log("\n(d) every consumer of next reads it through safeNextPath; no copy of the old guard is left");
  {
    const CONSUMERS = [
      "app/[org]/login/branded-login.tsx",
      "app/auth/callback/route.ts",
      "app/api/auth/magic-link/route.ts",
      // Not a `next`, but the same kind of redirect target from a public route.
      "app/api/integrations/enter/route.ts",
    ];
    for (const f of CONSUMERS) {
      const src = read(f);
      eq(`${f}: imports safeNextPath from lib/auth/safe-next`, /import \{[^}]*\bsafeNextPath\b[^}]*\} from "@\/lib\/auth\/safe-next";/.test(src), true);
      eq(`${f}: no startsWith("//") guard of its own`, /startsWith\(\s*["']\/\/["']\s*\)/.test(src), false);
    }
    eq("the callback falls back to /select-org when next is refused",
      /const next = safeNextPath\(searchParams\.get\("next"\)\) \?\? "\/select-org";/.test(read("app/auth/callback/route.ts")), true);
    eq("the CRM entry route falls back to / when `to` is refused (so /\\host never leaves the site)",
      /const safeTo = safeNextPath\(to\) \?\? "\/";/.test(read("app/api/integrations/enter/route.ts")), true);
    eq("the org login falls back to the org dashboard",
      /safeNextPath\(new URLSearchParams\(window\.location\.search\)\.get\("next"\)\) \?\? `\/\$\{orgSlug\}\/dashboard`/.test(read("app/[org]/login/branded-login.tsx")), true);
    const mw = read("lib/supabase/middleware.ts");
    eq("the middleware sets next only through signInNext(…, request.nextUrl.searchParams), in both branches",
      (mw.match(/searchParams\.set\("next", signInNext\([^,]+, request\.nextUrl\.searchParams\)\)/g) ?? []).length, 2);
    eq("…and sets next no other way", (mw.match(/searchParams\.(set|append)\("next"/g) ?? []).length, 2);
    eq("…and clears the caller's query from the login address", /const url = request\.nextUrl\.clone\(\);[\s\S]{0,200}?url\.search = "";/.test(mw), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
