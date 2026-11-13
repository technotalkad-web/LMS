/**
 * scripts/lifecycle-nightly.sh retries the app build ONCE, and only when the
 * build log shows next/font failing to fetch Google Fonts (owner, 2026-11-13:
 * one retry; persistent errors and genuine code or build failures are
 * reported as before and never hidden). Source scan and the script's own
 * matcher run over sample log lines; no build is run.
 *
 * Run:  npx tsx tests/unit/nightly-font-retry.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const src = fs.readFileSync(path.join(root, "scripts/lifecycle-nightly.sh"), "utf8").replace(/\r\n/g, "\n");

console.log("\nthe font matcher (the script's grep -E pattern, read as a JavaScript RegExp)");
const m = src.match(/^FONT_FETCH_FAILURE='(.*)'$/m);
eq("FONT_FETCH_FAILURE is defined once", (src.match(/^FONT_FETCH_FAILURE=/gm) ?? []).length, 1);
// In a POSIX bracket a backslash is literal; a JavaScript class needs it escaped.
const BS = String.fromCharCode(92);
const re = new RegExp((m?.[1] ?? "(?!)").split(`[/${BS}]`).join(`[/${BS}${BS}]`));
const winLine = ["    at D:", "x", "node_modules", "next", "dist", "compiled", "@next", "font", "dist", "google", "loader.js:122:78"].join(BS);
const hits: Array<[string, string, boolean]> = [
  ["the runner's loader.js TypeError line", "    at /home/runner/work/LMS/LMS/node_modules/next/dist/compiled/@next/font/dist/google/loader.js:122:78", true],
  ["the same line on Windows", winLine, true],
  ["Failed to fetch font", "Failed to fetch font `Inter`.", true],
  ["Failed to fetch from Google Fonts", "Failed to fetch `Inter` from Google Fonts.", true],
  ["a type error", "Type error: Property 'x' does not exist on type 'Y'.", false],
  ["a missing next/font module (a code error)", "Module not found: Can't resolve 'next/font/google'", false],
  ["a generic compile failure", "Failed to compile.", false],
];
for (const [n, line, want] of hits) eq(n, re.test(line), want);

console.log("\nthe build step retries once, only on the font failure");
eq("npm run build appears exactly twice (the first build and the one retry)", (src.match(/npm run build/g) ?? []).length, 2);
const first = src.indexOf('if ! npm run build > "$OUT/build.log" 2>&1; then');
const check = src.indexOf('if ! font_fetch_failure "$OUT/build.log"; then', first);
const retry = src.indexOf("npm run build", first + 10);
eq("the font check comes before the retry", first >= 0 && check > first && retry > check, true);
eq("a non-font failure fails at once", /if ! font_fetch_failure "\$OUT\/build\.log"; then\n\s+build_failed\n\s+fi/.test(src), true);
eq("the retry's failure fails too", /building again \(the only retry\)"\n\s+if ! npm run build > "\$OUT\/build\.log" 2>&1; then\n\s+build_failed/.test(src), true);
eq("the retry leaves a warning on the run", src.includes("::warning title=Lifecycle nightly::the app build failed fetching Google Fonts; retrying the build once"), true);
eq("build_failed raises the error annotation and exits 1", /build_failed\(\) \{\n\s+echo "::error title=Lifecycle nightly::the app build failed"[\s\S]{0,300}exit 1\n\}/.test(src), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
