/**
 * webpack loader: applies upstream React fixes to the copy of react-dom that
 * Next.js bundles into the App Router, while the client bundle is built: a lost
 * "ping" (ADR 0013) and a hydration replay that re-claims an element, in two
 * hunks (ADR 0018). next.config.ts registers it for the files matched by
 * REACT_DOM_CLIENT_FILE; node_modules is never modified.
 *
 * Hunk 1, ADR 0013, patchSource.
 *
 * The bug (react-dom 19.2.0-canary-0bdb9206-20250818, bundled by Next
 * 15.5.18 … 15.5.29; stable react-dom 19.2.4 has it too): a transition such
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
 * Hunk 2, ADR 0018, patchReplay.
 *
 * The bug (the same bundled react-dom): while hydrating, a host element whose
 * child suspends on a lazy (the layout's <main>, whose Flight row refers to
 * the segment's client error boundary, before that chunk has loaded) has
 * already claimed its DOM element and moved the hydration cursor to the
 * element's first child. If the thenable settles within React's one-task
 * pause, React replays the host fiber: the replay's `case 5` only resets
 * hooks and beginWork claims again with the cursor one level too deep, which
 * throws minified error #418 although server and client agree. React then
 * client-renders the whole boundary, which can remount the course iframe.
 *
 * The fix is the one React shipped (facebook/react#35494, in Next from 16.2.0):
 * the replay restores the cursor when the replayed fiber is the current
 * hydration parent. `case 5` is in replaySuspendedUnitOfWork in the
 * production and profiling builds and in replayBeginWork, its helper, in the
 * development builds, so the variable is `next` or `unitOfWork`.
 *
 *   broken: case 5:
 *             resetHooksOnUnwind(<v>);
 *           default:
 *   fixed:  case 5:
 *             resetHooksOnUnwind(<v>);
 *             var fiber = <v>;
 *             fiber === hydrationParentFiber &&
 *               (isHydrating
 *                 ? (popToNextHostParent(fiber),
 *                   5 === fiber.tag &&
 *                     null != fiber.stateNode &&
 *                     (nextHydratableInstance = fiber.stateNode))
 *                 : (popToNextHostParent(fiber), (isHydrating = !0)));
 *           default:
 *
 * Hunk 3, ADR 0018, patchForked.
 *
 * The bug it opens once hunk 2 lets that replay finish: a hydrating fiber takes
 * its useId slot in beginWork from the Forked flag (bit 20) placeChild set on
 * it, and resetWorkInProgress's mask strips that flag. So a replayed host with
 * siblings hydrates its subtree with useId values that differ from the server's,
 * with no error.
 *
 * The fix is React's companion to hunk 2 (facebook/react#35518, also in Next
 * from 16.2.0), which made Forked a static flag. This build's numbering differs
 * from later ones (bit 26 is PlacementDEV here), so 16.4.5's mask is not copied:
 * 15.5's mask gets bit 20 and nothing else. Only resetWorkInProgress changes:
 * beginWork reads Forked only on a fiber with no alternate, and that is the one
 * site of the static mask such a fiber passes through (ADR 0018, Limits).
 *
 *   broken: workInProgress.flags &= 65011714;
 *   fixed:  workInProgress.flags &= 66060290;
 *
 * Files: the four react-dom client builds under
 * next/dist/compiled/react-dom/cjs (production, development and the two
 * profiling builds). The react-dom-experimental copy is used only with
 * experimental flags this app does not set (PPR, cacheComponents) and is
 * not matched.
 *
 * Rules, for each hunk on its own: a source that already has the fixed form
 * (a Next version that ships the fix) passes through unchanged. Otherwise the
 * broken form must occur exactly once; zero or several matches fail the build
 * with the file name, the hunk and the record that owns it, so a Next upgrade
 * is checked by a person instead of shipping unpatched.
 * tests/unit/react-dom-ping-fix.test.ts checks the transforms and that the
 * installed files and their paths match. webpack only: under `--turbopack`
 * this loader does not run (ADR 0013, ADR 0018).
 *
 * CommonJS because webpack loads loaders with require().
 */
"use strict";

/** The react-dom client builds that carry pingSuspendedRoot, the replay's `case 5` and resetWorkInProgress. */
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

// The nested ternary, in React's canaries as Next bundles them from 16.3.0 on.
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

// The replay's `case 5` with nothing between the hook reset and the default.
// The variable is `next` in the production and profiling builds and
// `unitOfWork` in the development builds; whitespace differs between builds.
const REPLAY_BROKEN = /case 5:(\s*)resetHooksOnUnwind\((\w+)\);(\s*)default:/g;

// The cursor restore, in React since #35494, in Next from 16.2.0.
const REPLAY_FIXED = /\w+ === hydrationParentFiber &&\s*\(isHydrating\s*\? \(popToNextHostParent\(/g;

/**
 * Pure transform of one file's source: the replay hunk (ADR 0018).
 * @param {string} src
 * @returns {{ status: "patched" | "already-fixed" | "refused", source: string, reason?: string }}
 */
function patchReplay(src) {
  const fixed = (src.match(REPLAY_FIXED) || []).length;
  const broken = (src.match(REPLAY_BROKEN) || []).length;
  if (fixed === 1 && broken === 0) return { status: "already-fixed", source: src };
  if (fixed !== 0 || broken !== 1) {
    return { status: "refused", source: src, reason: `found the fixed replay form ${fixed} time(s) and the broken replay form ${broken} time(s)` };
  }
  // Upstream's text between the hook reset and the default, the file's indentation kept.
  const source = src.replace(
    REPLAY_BROKEN,
    (_m, sp, v, sp2) =>
      `case 5:${sp}resetHooksOnUnwind(${v});${sp}var fiber = ${v};${sp}fiber === hydrationParentFiber &&` +
      `${sp}  (isHydrating${sp}    ? (popToNextHostParent(fiber),${sp}      5 === fiber.tag &&` +
      `${sp}        null != fiber.stateNode &&${sp}        (nextHydratableInstance = fiber.stateNode))` +
      `${sp}    : (popToNextHostParent(fiber), (isHydrating = !0)));${sp2}default:`,
  );
  return { status: "patched", source };
}

// resetWorkInProgress's mask. React made Forked (bit 20) static in #35518: without it a replay strips the flag and a
// replayed host with siblings loses its useId slot once the restore above lets it hydrate.
const FORKED_BIT = 1 << 20;
const RESET_MASK = /(function resetWorkInProgress\(workInProgress, renderLanes\) \{\s*workInProgress\.flags &= )(\d+);/g;

/**
 * Pure transform of one file's source: resetWorkInProgress keeps Forked (ADR 0018).
 * @param {string} src
 * @returns {{ status: "patched" | "already-fixed" | "refused", source: string, reason?: string }}
 */
function patchForked(src) {
  const sites = [...src.matchAll(RESET_MASK)];
  if (sites.length !== 1) return { status: "refused", source: src, reason: `found resetWorkInProgress's mask ${sites.length} time(s)` };
  const mask = Number(sites[0][2]);
  if (mask & FORKED_BIT) return { status: "already-fixed", source: src };
  if (mask !== 65011714) return { status: "refused", source: src, reason: `resetWorkInProgress's mask is ${mask}, expected 65011714` };
  return { status: "patched", source: src.replace(RESET_MASK, (_m, head) => `${head}${mask | FORKED_BIT};`) };
}

/** The hunks in the order the loader applies them, each with the record that owns it. */
const HUNKS = [
  { name: "the lost ping", patch: patchSource, record: "ADR 0013", doc: "docs/adr/0013-patch-bundled-react-dom-lost-ping.md" },
  { name: "the hydration replay", patch: patchReplay, record: "ADR 0018", doc: "docs/adr/0018-patch-bundled-react-dom-hydration-replay.md" },
  { name: "the replay's useId slot", patch: patchForked, record: "ADR 0018", doc: "docs/adr/0018-patch-bundled-react-dom-hydration-replay.md" },
];

/**
 * The webpack loader.
 * @this {{ resourcePath: string }}
 * @param {string} source
 * @returns {string}
 */
function reactDomPingFixLoader(source) {
  let out = source;
  for (const hunk of HUNKS) {
    const r = hunk.patch(out);
    if (r.status === "refused") {
      throw new Error(
        `[react-dom-ping-fix] ${this.resourcePath}: ${hunk.name}: ${r.reason}. The bundled react-dom no longer matches what ${hunk.record} patches: ` +
          "if this Next version ships the upstream fix, remove this hunk (and the loader from next.config.ts once no hunk is left); otherwise update the pattern " +
          `(${hunk.doc}).`,
      );
    }
    out = r.source;
  }
  return out;
}

module.exports = reactDomPingFixLoader;
module.exports.patchSource = patchSource;
module.exports.patchReplay = patchReplay;
module.exports.patchForked = patchForked;
module.exports.TARGET_FILES = TARGET_FILES;
module.exports.REACT_DOM_CLIENT_FILE = REACT_DOM_CLIENT_FILE;
