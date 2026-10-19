/**
 * Unit test for the bundled react-dom lost-ping fix (ADR 0013):
 * scripts/react-dom-ping-fix.cjs, registered as a webpack loader in
 * next.config.ts.
 *
 *   - the transform, on fixture text in both spellings (production and
 *     development builds): patched once, then passed through unchanged;
 *     refused on zero or two matches; an upstream-fixed source passes
 *     through unchanged;
 *   - the loader throws (fails the build) on a refused source;
 *   - the guard the loader cannot give itself: each of the four installed
 *     react-dom client files is matched by the path rule next.config.ts
 *     uses (else webpack would skip it and the build would pass unpatched),
 *     and its source is patched exactly once (else the next Next upgrade
 *     needs a person: see the ADR).
 *
 * Run:  npx tsx tests/unit/react-dom-ping-fix.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type PatchResult = { status: "patched" | "already-fixed" | "refused"; source: string; reason?: string };
const loader = require("../../scripts/react-dom-ping-fix.cjs") as ((this: { resourcePath: string }, src: string) => string) & {
  patchSource: (src: string) => PatchResult;
  TARGET_FILES: string[];
  REACT_DOM_CLIENT_FILE: RegExp;
};
const { patchSource, TARGET_FILES, REACT_DOM_CLIENT_FILE } = loader;

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// The text of pingSuspendedRoot's tail in the two spellings react-dom ships.
const PROD_BROKEN = `      300 > now() - globalMostRecentFallbackTime)
      ? 0 === (executionContext & 2) && prepareFreshStack(root, 0)
      : (workInProgressRootPingedLanes |= pingedLanes),
    workInProgressSuspendedRetryLanes === workInProgressRootRenderLanes &&`;
const PROD_FIXED = `      300 > now() - globalMostRecentFallbackTime)
      ? 0 === (executionContext & 2)
        ? prepareFreshStack(root, 0)
        : (workInProgressRootPingedLanes |= pingedLanes)
      : (workInProgressRootPingedLanes |= pingedLanes),
    workInProgressSuspendedRetryLanes === workInProgressRootRenderLanes &&`;
const DEV_BROKEN = `          now$1() - globalMostRecentFallbackTime < FALLBACK_THROTTLE_MS)
          ? (executionContext & RenderContext) === NoContext &&
            prepareFreshStack(root, 0)
          : (workInProgressRootPingedLanes |= pingedLanes),
        workInProgressSuspendedRetryLanes === workInProgressRootRenderLanes &&`;
const DEV_FIXED = `          now$1() - globalMostRecentFallbackTime < FALLBACK_THROTTLE_MS)
          ? (executionContext & RenderContext) === NoContext
            ? prepareFreshStack(root, 0)
            : (workInProgressRootPingedLanes |= pingedLanes)
          : (workInProgressRootPingedLanes |= pingedLanes),
        workInProgressSuspendedRetryLanes === workInProgressRootRenderLanes &&`;

console.log("\nthe transform");
{
  const r = patchSource(PROD_BROKEN);
  eq("production spelling → patched", r.status, "patched");
  eq("production: the nested ternary React 19.3 ships (text as in Next 16.4.2)", r.source, PROD_FIXED);
  eq("production: a second pass passes it through", patchSource(r.source).status, "already-fixed");
  eq("production: and leaves it unchanged", patchSource(r.source).source, PROD_FIXED);
}
{
  const r = patchSource(DEV_BROKEN);
  eq("development spelling → patched", r.status, "patched");
  eq("development: nested ternary, indentation kept", r.source, DEV_FIXED);
  eq("development: a second pass passes it through", patchSource(r.source).status, "already-fixed");
}
{
  const oneLine = "a ? 0 === (executionContext & 2) && prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes), b";
  const r = patchSource(oneLine);
  eq("minified-style single line → patched", r.status, "patched");
  eq("single line result",
    r.source,
    "a ? 0 === (executionContext & 2) ? prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes) : (workInProgressRootPingedLanes |= pingedLanes), b");
}
eq("an upstream-fixed source (Next ships the fix) → passes through", patchSource(PROD_FIXED).status, "already-fixed");
eq("no pingSuspendedRoot at all → refused", patchSource("function pingSuspendedRoot() {}").status, "refused");
eq("the broken form twice → refused", patchSource(`${PROD_BROKEN}\n${PROD_BROKEN}`).status, "refused");
eq("broken and fixed forms together → refused", patchSource(`${PROD_BROKEN}\n${PROD_FIXED}`).status, "refused");
eq("an unknown condition spelling → refused",
  patchSource("? 0 === (executionContext & 6) && prepareFreshStack(root, 0)\n : (workInProgressRootPingedLanes |= pingedLanes),").status,
  "refused");

console.log("\nthe loader");
{
  const ctx = { resourcePath: "x/react-dom-client.production.js" };
  eq("returns the patched source", loader.call(ctx, PROD_BROKEN), PROD_FIXED);
  let threw = "";
  try { loader.call(ctx, "no match here"); } catch (e) { threw = (e as Error).message; }
  eq("throws (fails the build) on a refused source, naming the file and the ADR",
    threw.includes("x/react-dom-client.production.js") && threw.includes("ADR 0013"), true);
}

console.log("\nthe path rule");
eq("posix path matches",
  REACT_DOM_CLIENT_FILE.test("/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js"), true);
eq("windows path matches",
  REACT_DOM_CLIENT_FILE.test("D:\\LMS\\app\\node_modules\\next\\dist\\compiled\\react-dom\\cjs\\react-dom-client.development.js"), true);
eq("profiling build matches",
  REACT_DOM_CLIENT_FILE.test("/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom-profiling.profiling.js"), true);
eq("the server renderer is not matched",
  REACT_DOM_CLIENT_FILE.test("/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom-server.browser.production.js"), false);
eq("react-dom itself (no reconciler) is not matched",
  REACT_DOM_CLIENT_FILE.test("/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom.production.js"), false);
eq("the experimental channel is not matched",
  REACT_DOM_CLIENT_FILE.test("/app/node_modules/next/dist/compiled/react-dom-experimental/cjs/react-dom-client.production.js"), false);

console.log("\nthe installed react-dom (guard for the next Next upgrade)");
{
  const nextDir = path.join(process.cwd(), "node_modules", "next");
  const version = (JSON.parse(fs.readFileSync(path.join(nextDir, "package.json"), "utf8")) as { version: string }).version;
  const cjs = path.join(nextDir, "dist", "compiled", "react-dom", "cjs");
  for (const name of TARGET_FILES) {
    const file = path.join(cjs, name);
    eq(`${name}: matched by the next.config.ts rule`, REACT_DOM_CLIENT_FILE.test(file), true);
    const r = patchSource(fs.readFileSync(file, "utf8"));
    eq(`${name} (next ${version}): patched exactly once`, r.status === "refused" ? `refused: ${r.reason}` : r.status, "patched");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
