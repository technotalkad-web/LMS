/**
 * webpack loader: applies the upstream React fix for a lost "ping" to the
 * copy of react-dom that Next.js bundles into the App Router, while the
 * client bundle is built (ADR 0013). next.config.ts registers it for the
 * files matched by REACT_DOM_CLIENT_FILE; node_modules is never modified.
 *
 * The bug (react-dom 19.2.0-canary-0bdb9206-20250818, bundled by Next
 * 15.5.18 … 15.5.28; stable react-dom 19.2.4 has it too): a transition such
 * as router.refresh() suspends on a streamed RSC chunk inside a Suspense
 * boundary that is already showing content. If that chunk finishes
 * streaming during React's one-task pause, React attaches its ping listener
 * to an already-resolved chunk, the listener fires synchronously inside the
 * render, and pingSuspendedRoot drops it (`… && prepareFreshStack(root, 0)`
 * does nothing while rendering). The render ends suspended, nothing pings
 * again, and the update never commits: the page keeps the old server
 * content (Library "Set as default" left the header on the old language;
 * lifecycle spec 54 test 7), and every later refresh or soft navigation on
 * that tab hangs until a full reload.
 *
 * The fix is the one React shipped (react-dom 19.3.0-canary-278794d7-
 * 20261002, bundled by Next 16.4.2): a ping that arrives during the render
 * is recorded in workInProgressRootPingedLanes, so the render is retried.
 *
 *   broken: ? <not rendering> && prepareFreshStack(root, 0)
 *           : (workInProgressRootPingedLanes |= pingedLanes)
 *   fixed:  ? <not rendering>
 *             ? prepareFreshStack(root, 0)
 *             : (workInProgressRootPingedLanes |= pingedLanes)
 *           : (workInProgressRootPingedLanes |= pingedLanes)
 *
 * Files: the four react-dom client builds under
 * next/dist/compiled/react-dom/cjs (production, development and the two
 * profiling builds). The react-dom-experimental copy is used only with
 * experimental flags this app does not set (PPR, cacheComponents) and is
 * not matched.
 *
 * Rules: a source that already has the fixed form (a Next version that
 * ships the fix) passes through unchanged. Otherwise the broken form must
 * occur exactly once; zero or several matches fail the build with the file
 * name, so a Next upgrade is checked by a person instead of shipping
 * unpatched. tests/unit/react-dom-ping-fix.test.ts checks the transform and
 * that the installed files and their paths match. webpack only: under
 * `--turbopack` this loader does not run (ADR 0013).
 *
 * CommonJS because webpack loads loaders with require().
 */
"use strict";

/** The react-dom client builds that carry pingSuspendedRoot. */
const TARGET_FILES = [
  "react-dom-client.production.js",
  "react-dom-client.development.js",
  "react-dom-profiling.profiling.js",
  "react-dom-profiling.development.js",
];

/** The resource paths the loader is registered for (either path separator). */
const REACT_DOM_CLIENT_FILE =
  /[\\/]next[\\/]dist[\\/]compiled[\\/]react-dom[\\/]cjs[\\/]react-dom-(client|profiling)\.(production|development|profiling)\.js$/;

// `<not rendering> && prepareFreshStack(root, 0) : (wip |= pingedLanes)`.
// The condition is spelled `0 === (executionContext & 2)` in the production
// and profiling builds and `(executionContext & RenderContext) === NoContext`
// in the development builds; whitespace differs between builds.
const BROKEN =
  /\?(\s*)(0 === \(executionContext & 2\)|\(executionContext & RenderContext\) === NoContext)\s*&&\s*prepareFreshStack\(root, 0\)(\s*):(\s*)\(workInProgressRootPingedLanes \|= pingedLanes\)/g;

// The nested ternary React ships from 19.3.0-canary-278794d7-20261002 on.
const FIXED =
  /(0 === \(executionContext & 2\)|\(executionContext & RenderContext\) === NoContext)\s*\?\s*prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/g;

/**
 * Pure transform of one file's source.
 * @param {string} src
 * @returns {{ status: "patched" | "already-fixed" | "refused", source: string, reason?: string }}
 */
function patchSource(src) {
  const fixed = (src.match(FIXED) || []).length;
  const broken = (src.match(BROKEN) || []).length;
  if (fixed === 1 && broken === 0) return { status: "already-fixed", source: src };
  if (fixed !== 0) {
    return { status: "refused", source: src, reason: `found the fixed form ${fixed} time(s) and the broken form ${broken} time(s)` };
  }
  if (broken !== 1) {
    return { status: "refused", source: src, reason: `expected the broken pingSuspendedRoot form exactly once, found it ${broken} time(s)` };
  }
  const source = src.replace(BROKEN, (_m, sp, cond, nl, sp2) => {
    // Keep the original line break and indentation; nest one level deeper.
    const inner = nl.includes("\n") ? `${nl}  ` : " ";
    return `?${sp}${cond}${inner}? prepareFreshStack(root, 0)${inner}: (workInProgressRootPingedLanes |= pingedLanes)${nl}:${sp2}(workInProgressRootPingedLanes |= pingedLanes)`;
  });
  return { status: "patched", source };
}

/**
 * The webpack loader.
 * @this {{ resourcePath: string }}
 * @param {string} source
 * @returns {string}
 */
function reactDomPingFixLoader(source) {
  const r = patchSource(source);
  if (r.status === "refused") {
    throw new Error(
      `[react-dom-ping-fix] ${this.resourcePath}: ${r.reason}. The bundled react-dom no longer matches what ADR 0013 patches: ` +
        "if this Next version ships the upstream fix, remove the loader from next.config.ts; otherwise update the pattern " +
        "(docs/adr/0013-patch-bundled-react-dom-lost-ping.md).",
    );
  }
  return r.source;
}

module.exports = reactDomPingFixLoader;
module.exports.patchSource = patchSource;
module.exports.TARGET_FILES = TARGET_FILES;
module.exports.REACT_DOM_CLIENT_FILE = REACT_DOM_CLIENT_FILE;
