/**
 * The sign-in `next` guard (lib/auth/safe-next.ts safeNextPath): a sign-in
 * callback, a magic link and the CRM entry route send a user only to an
 * address on this site.
 *
 *   (a) safeNextPath: an address on this site passes unchanged, query
 *       included; "//host", "/\host", a scheme, a bare host, a control
 *       character and an empty value are refused. Every address it keeps,
 *       appended to a real origin, stays on that origin.
 *   (b) the server routes that redirect to a caller-supplied address read
 *       it through safeNextPath, and no copy of the old one-line guard is
 *       left in them: the auth callback (`next`), the magic-link route
 *       (`next`, carried into the e-mailed link) and the CRM entry route
 *       (`to`).
 *
 * Run:  npx tsx tests/unit/sign-in-next.test.ts   (or npm run test:unit)
 * (No DB, no network.)
 */
import fs from "node:fs";
import path from "node:path";
import { safeNextPath } from "../../lib/auth/safe-next";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

console.log("\n(a) safeNextPath: an address on this site passes unchanged; anything that could leave it is refused");
const kept = [
  "/acme/courses/C1/launch?lp=P1",
  "/acme/courses/C1/launch?journey=E1&day=3",
  "/acme/courses/C1/launch?lang=hi",
  "/acme/dashboard",
  "/select-org",
  "/api/integrations/enter?to=%2Facme%2Fdashboard&return_url=https%3A%2F%2Fcrm.example.test%2F",
  "/courses/C1/launch",
  "/acme/dashboard?x=%5C",
  // "@" after a single "/" is a path segment on this site, not a host.
  "/@evil.example",
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
  ["@evil.example", "@evil.example"],
  ["//user@evil.example", "//user@evil.example"],
  ["/\\@evil.example", "/\\@evil.example"],
  ["/<tab>/evil.example (browsers drop the tab)", "/\t/evil.example"],
  ["/<newline>/evil.example", "/\n/evil.example"],
  ["/<carriage return>/evil.example", "/\r/evil.example"],
  ["a NUL in the path", "/acme/\u0000dashboard"],
  ["a DEL in the path", "/acme/\u007fdashboard"],
  ["a backslash later in the path", "/acme/\\evil"],
  ["empty", ""],
  ["null", null],
  ["undefined", undefined],
];
for (const [name, v] of refused) eq(`refused: ${name}`, safeNextPath(v), null);

// What the routes do with a kept value: append it to the public origin
// (the callback) or resolve it against the origin (the CRM entry route).
// Either way the result stays on that origin.
const ORIGIN = "https://lms.example.test";
eq("every kept value appended to the origin stays on it",
  kept.every((k) => new URL(`${ORIGIN}${safeNextPath(k)}`).origin === ORIGIN), true);
eq("every kept value resolved against the origin stays on it",
  kept.every((k) => new URL(safeNextPath(k) ?? "/", ORIGIN).origin === ORIGIN), true);

console.log("\n(b) every server redirect to a caller-supplied address reads it through safeNextPath");
const CONSUMERS = [
  "app/auth/callback/route.ts",
  "app/api/auth/magic-link/route.ts",
  "app/api/integrations/enter/route.ts",
];
for (const f of CONSUMERS) {
  const src = read(f);
  eq(`${f}: imports safeNextPath from lib/auth/safe-next`, /import \{[^}]*\bsafeNextPath\b[^}]*\} from "@\/lib\/auth\/safe-next";/.test(src), true);
  eq(`${f}: no startsWith("//") guard of its own`, /startsWith\(\s*["']\/\/["']\s*\)/.test(src), false);
}
eq("the callback falls back to /select-org when next is refused",
  /const next = safeNextPath\(searchParams\.get\("next"\)\) \?\? "\/select-org";/.test(read("app/auth/callback/route.ts")), true);
eq("the callback reads next no other way",
  (read("app/auth/callback/route.ts").match(/searchParams\.get\("next"\)/g) ?? []).length, 1);
eq("the magic-link route reads next through the guard",
  /const safeNext = safeNextPath\(body\.next\);/.test(read("app/api/auth/magic-link/route.ts")), true);
eq("the CRM entry route falls back to / when `to` is refused",
  /const safeTo = safeNextPath\(to\) \?\? "\/";/.test(read("app/api/integrations/enter/route.ts")), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
