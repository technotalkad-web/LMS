/**
 * The public privacy notice at /privacy (ADR 0034, step 5).
 *
 *   (a) RESERVED_TOP_PATHS (lib/supabase/middleware.ts) holds "privacy" and
 *       "super-mfa", keeps its earlier entries, and does not hold "terms".
 *   (b) isInfraPath("/privacy") is true and exact, so a white-label host
 *       serves the platform's notice instead of rewriting it.
 *   (c) the real middleware, signed out, on a platform host and on a
 *       container-style host (as behind Cloud Run): /privacy passes with no
 *       redirect and no rewrite; /privacy/dashboard goes to /login;
 *       /privacy-team/dashboard keeps its own org login; /super-mfa/challenge
 *       goes to /login; no fetch is made.
 *   (d) the same on a white-label host (CUSTOM_DOMAINS_ENABLED=1): /privacy
 *       passes unchanged, /dashboard is still bounced to /login, and the
 *       host lookup is the only fetch.
 *   (e) both sign-in pages link "Privacy Policy" to /privacy; "Terms" stays
 *       a plain word and no dead link is left.
 *   (f) the page and its text module read nothing: imports, banned calls,
 *       no browser code, no route segment config.
 *   (g) the text: the version line, the required phrases, no placeholder
 *       brackets or links, the word count, every string rendered by the real
 *       page, and no terms route.
 *   (h) organisation creation refuses a reserved slug before its
 *       uniqueness read.
 *
 * Run:  npx tsx tests/unit/privacy-notice.test.ts   (or npm run test:unit)
 * (No DB, no network: fetch is stubbed.)
 */
import fs from "node:fs";
import path from "node:path";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { RESERVED_TOP_PATHS } from "../../lib/supabase/middleware";
import { isInfraPath, tenantRewritePath } from "../../lib/domains/resolve";
import * as NOTICE from "../../app/privacy/notice";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

// The version the page shows today. A wording change by legal updates the
// version line in app/privacy/notice.ts and this line in the same change.
const VERSION = "Version 1, draft for legal review, 2026-11-26";

console.log("\n(a) RESERVED_TOP_PATHS");
{
  eq("holds privacy", RESERVED_TOP_PATHS.has("privacy"), true);
  eq("holds super-mfa", RESERVED_TOP_PATHS.has("super-mfa"), true);
  eq("does not hold terms (no terms route exists)", RESERVED_TOP_PATHS.has("terms"), false);
  const earlier = ["super", "auth", "api", "invitations", "login", "forgot-password", "select-org", "change-password", "_next"];
  eq("keeps every earlier entry", earlier.filter((p) => !RESERVED_TOP_PATHS.has(p)), []);
  eq("…and nothing else", [...RESERVED_TOP_PATHS].sort(), [...earlier, "privacy", "super-mfa"].sort());
}

console.log("\n(b) isInfraPath and the white-label rewrite");
{
  eq("isInfraPath(/privacy)", isInfraPath("/privacy"), true);
  eq("isInfraPath(/privacy-team) is false: exact match", isInfraPath("/privacy-team"), false);
  eq("isInfraPath(/privacy/x) is false: exact match", isInfraPath("/privacy/x"), false);
  eq("tenantRewritePath(/privacy, acme) is null (served as is)", tenantRewritePath("/privacy", "acme"), null);
  eq("tenantRewritePath(/privacy-team, acme) still rewrites", tenantRewritePath("/privacy-team", "acme"), "/acme/privacy-team");
}

async function middlewareCases() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.stub.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  delete process.env.PLATFORM_OWNER_IP_ALLOWLIST;
  delete process.env.PRIMARY_APP_HOST;
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  // The only call a signed-out request can make is the white-label host
  // lookup (lib/domains/resolve.ts); a signed-out getUser reads no network.
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
    const run = async (url: string, host?: string) => {
      const req = new NextRequest(url, host ? { headers: { host } } : undefined);
      const res = await updateSession(req);
      const loc = res.headers.get("location");
      return {
        status: res.status,
        location: loc ? new URL(loc).pathname : null,
        next: loc ? new URL(loc).searchParams.get("next") : null,
        rewrite: res.headers.get("x-middleware-rewrite"),
        passes: res.headers.get("x-middleware-next"),
      };
    };

    console.log("\n(c) the real middleware, signed out, on a platform host and a container host");
    process.env.CUSTOM_DOMAINS_ENABLED = "0";
    for (const base of ["http://localhost:3000", "http://0.0.0.0:8080"]) {
      const p = await run(`${base}/privacy`);
      eq(`${base}/privacy: passes, no redirect, no rewrite`, [p.status, p.location, p.rewrite, p.passes], [200, null, null, "1"]);
      const deeper = await run(`${base}/privacy/dashboard`);
      eq(`${base}/privacy/dashboard: 307 to the platform login`, [deeper.status, deeper.location, deeper.next], [307, "/login", "/privacy/dashboard"]);
      const team = await run(`${base}/privacy-team/dashboard`);
      eq(`${base}/privacy-team/dashboard: 307 to that org's own login (the gate stays)`, [team.status, team.location], [307, "/privacy-team/login"]);
      const teamRoot = await run(`${base}/privacy-team`);
      eq(`${base}/privacy-team: still behind the gate`, [teamRoot.status, teamRoot.location], [307, "/privacy-team/login"]);
      const mfa = await run(`${base}/super-mfa/challenge`);
      eq(`${base}/super-mfa/challenge: 307 to the platform login, not /super-mfa/login`, [mfa.status, mfa.location], [307, "/login"]);
    }
    eq("no fetch was made on a platform host", calls, []);

    console.log("\n(d) the real middleware, signed out, on a white-label host");
    process.env.CUSTOM_DOMAINS_ENABLED = "1";
    const wl = await run("http://0.0.0.0:8080/privacy", "learn.example.test");
    eq("/privacy on a white-label host: passes, no redirect, no rewrite", [wl.status, wl.location, wl.rewrite, wl.passes], [200, null, null, "1"]);
    const dash = await run("http://0.0.0.0:8080/dashboard", "learn.example.test");
    eq("/dashboard on a white-label host: still bounced to /login", [dash.status, dash.location, dash.next], [307, "/login", "/dashboard"]);
    eq("the host lookup was the only fetch", calls.length >= 1 && calls.every((u) => u.includes("/rest/v1/organizations")), true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CUSTOM_DOMAINS_ENABLED;
  }
}

/** Every string a value holds, depth first. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

async function main() {
  await middlewareCases();

  console.log("\n(e) the two sign-in pages link to /privacy");
  {
    const login = read("app/login/page.tsx");
    eq("app/login/page.tsx imports Link from next/link", /import Link from "next\/link";/.test(login), true);
    eq("app/login/page.tsx: \"Privacy Policy\" is a Link to /privacy",
      /<Link href="\/privacy"[^>]*>\s*Privacy Policy\s*<\/Link>/.test(login), true);
    eq("app/login/page.tsx: no href=\"#\" is left", login.includes('href="#"'), false);
    eq("app/login/page.tsx: the sentence reads as before, \"Terms\" a plain word",
      /By signing in you agree to our\s+Terms\s+and\{" "\}\s*<Link href="\/privacy"/.test(login), true);

    const branded = read("app/[org]/login/branded-login.tsx");
    eq("branded-login.tsx imports Link from next/link", /import Link from "next\/link";/.test(branded), true);
    eq("branded-login.tsx: \"Privacy Policy\" is a Link to /privacy",
      /<Link href="\/privacy"[^>]*>\s*Privacy Policy\s*<\/Link>/.test(branded), true);
    eq("branded-login.tsx: the sentence still holds its words",
      /By signing in you agree to\s+\{orgName\}&apos;s\s+Terms\s+and\{" "\}\s*<Link href="\/privacy"[^>]*>\s*Privacy\s+Policy\s*<\/Link>\s*\./.test(branded), true);
    eq("branded-login.tsx: no href=\"#\"", branded.includes('href="#"'), false);
  }

  console.log("\n(f) the page and its text read nothing");
  {
    const page = read("app/privacy/page.tsx");
    const notice = read("app/privacy/notice.ts");
    const sources = [...page.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)].map((m) => [m[1] ? "type" : "value", m[2]]);
    eq("page.tsx imports only the Metadata type from next and ./notice",
      sources, [["type", "next"], ["value", "./notice"]]);
    eq("page.tsx has no other import or require", (page.match(/\bimport\b|\brequire\(/g) ?? []).length, 2);
    eq("notice.ts has no import line", /^\s*import\b/m.test(notice), false);
    const BANNED = ["@/lib/supabase", "@supabase/", "next/headers", "cookies(", "fetch(", "\"use client\"", "'use client'"];
    for (const [f, src] of [["app/privacy/page.tsx", page], ["app/privacy/notice.ts", notice]] as const) {
      eq(`${f}: none of ${BANNED.join(", ")}`, BANNED.filter((b) => src.includes(b)), []);
    }
    (globalThis as { React?: unknown }).React = React;
    const mod = (await import("../../app/privacy/page")) as Record<string, unknown>;
    eq("page.tsx exports only the page and its metadata (no route segment config)", Object.keys(mod).filter((k) => k !== "__esModule").sort(), ["default", "metadata"]);
    eq("the tab title is the notice's title", (mod.metadata as { title?: unknown }).title, "Privacy Notice");
  }

  console.log("\n(g) the text");
  {
    const all = strings(NOTICE);
    const text = all.join("\n");
    eq("the title", NOTICE.PRIVACY_NOTICE_TITLE, "Privacy Notice");
    eq("the version line", NOTICE.PRIVACY_NOTICE_VERSION, VERSION);
    for (const phrase of [
      "Data Protection Board of India",
      "under 18",
      "HR or Learning & Development team",
      "the organisation that gave you access to this platform (usually your employer)",
      "draft for legal review",
    ]) {
      eq(`contains "${phrase}"`, text.includes(phrase), true);
    }
    eq("no placeholder brackets, braces, @ or links", ["[", "]", "{", "}", "@", "http"].filter((c) => text.includes(c)), []);
    eq("none of the words compliant, certified, section", ["compliant", "certified", "section"].filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text)), []);
    const words = text.split(/\s+/).filter(Boolean).length;
    console.log(`    (${words} words in ${all.length} strings)`);
    eq("the word count is between 700 and 1,100", words >= 700 && words <= 1100, true);
    eq("every section has a heading and some text", NOTICE.PRIVACY_NOTICE_SECTIONS.every((s) => s.heading && ((s.paragraphs?.length ?? 0) + (s.items?.length ?? 0) + (s.after?.length ?? 0)) > 0), true);
    eq("no app/terms folder exists", fs.existsSync(path.join(root, "app", "terms")), false);

    // The real page, rendered: every string of the notice is on it, in the
    // headings and lists the record names.
    const Page = (await import("../../app/privacy/page")).default as () => ReactElement;
    const html = renderToStaticMarkup(Page());
    const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const shown = decode(html);
    eq("every string of the notice is on the page", all.filter((s) => !shown.includes(s)), []);
    eq("one h1, the title", [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g)].map((m) => m[1]), ["Privacy Notice"]);
    eq("one h2 per section, in order", [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => decode(m[1])), NOTICE.PRIVACY_NOTICE_SECTIONS.map((s) => s.heading));
    eq("one list per section that has items", (html.match(/<ul\b/g) ?? []).length, NOTICE.PRIVACY_NOTICE_SECTIONS.filter((s) => (s.items?.length ?? 0) > 0).length);
    eq("one list item per item", (html.match(/<li\b/g) ?? []).length, NOTICE.PRIVACY_NOTICE_SECTIONS.reduce((n, s) => n + (s.items?.length ?? 0), 0));
    eq("the version line sits under the title", html.indexOf(VERSION) > html.indexOf("</h1>") && html.indexOf(VERSION) < html.indexOf("<h2"), true);
    eq("the page holds no link and no form", /<a\b|<form\b/.test(html), false);
  }

  console.log("\n(h) organisation creation refuses a reserved slug");
  {
    const route = read("app/api/super/tenants/route.ts");
    eq("the tenants route imports RESERVED_TOP_PATHS from the middleware",
      /import \{ RESERVED_TOP_PATHS \} from "@\/lib\/supabase\/middleware";/.test(route), true);
    const shape = route.indexOf("SLUG_RE.test(slug)");
    const refusal = route.indexOf("RESERVED_TOP_PATHS.has(slug)");
    const uniqueness = route.indexOf('.from("organizations")');
    eq("the refusal sits after the shape check and before the uniqueness read",
      shape > 0 && refusal > shape && uniqueness > refusal, true);
    eq("…answering 400 with the record's message",
      /if \(RESERVED_TOP_PATHS\.has\(slug\)\) \{\s*return NextResponse\.json\(\{ error: "This address is reserved by the platform" \}, \{ status: 400 \}\);\s*\}/.test(route), true);
    eq("…and every reserved name is a slug the shape check would otherwise accept, bar _next",
      [...RESERVED_TOP_PATHS].filter((p) => !/^[a-z0-9](?:[a-z0-9-]{1,40})?[a-z0-9]$/.test(p)), ["_next"]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
