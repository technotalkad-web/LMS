/**
 * Unit test for the bundled react-dom fixes, the lost ping (ADR 0013) and the
 * hydration replay in its two hunks, the cursor restore and the useId slot
 * (ADR 0018): scripts/react-dom-ping-fix.cjs, registered as a webpack loader in
 * next.config.ts.
 *
 *   - each transform, on fixture text in both spellings (production and
 *     development builds): patched once, then passed through unchanged;
 *     refused on zero or two matches or on mixed forms; an upstream-fixed
 *     source passes through unchanged;
 *   - the loader applies all three, and throws (fails the build) on a source
 *     any hunk refuses, naming the file and the record that owns that hunk;
 *   - next.config.ts registers the loader on the path rule;
 *   - the guard the loader cannot give itself: each of the four installed
 *     react-dom client files is matched by the path rule next.config.ts
 *     uses (else webpack would skip it and the build would pass unpatched),
 *     and its source is patched exactly once by each hunk (else the next Next
 *     upgrade needs a person: see the ADRs).
 *
 * Run:  npx tsx tests/unit/react-dom-ping-fix.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type PatchResult = { status: "patched" | "already-fixed" | "refused"; source: string; reason?: string };
const loader = require("../../scripts/react-dom-ping-fix.cjs") as ((this: { resourcePath: string }, src: string) => string) & {
  patchSource: (src: string) => PatchResult;
  patchReplay: (src: string) => PatchResult;
  patchForked: (src: string) => PatchResult;
  TARGET_FILES: string[];
  REACT_DOM_CLIENT_FILE: RegExp;
};
const { patchSource, patchReplay, patchForked, TARGET_FILES, REACT_DOM_CLIENT_FILE } = loader;

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

// The replay's `case 5` in the two spellings react-dom ships: replaySuspendedUnitOfWork in the
// production and profiling builds, its helper replayBeginWork in the development builds. The
// fixed text is upstream's, as in the four react-dom client builds of Next 16.4.5.
const REPLAY_PROD_BROKEN = `      break;
    case 5:
      resetHooksOnUnwind(next);
    default:
      unwindInterruptedWork(current, next),`;
const REPLAY_PROD_FIXED = `      break;
    case 5:
      resetHooksOnUnwind(next);
      var fiber = next;
      fiber === hydrationParentFiber &&
        (isHydrating
          ? (popToNextHostParent(fiber),
            5 === fiber.tag &&
              null != fiber.stateNode &&
              (nextHydratableInstance = fiber.stateNode))
          : (popToNextHostParent(fiber), (isHydrating = !0)));
    default:
      unwindInterruptedWork(current, next),`;
const REPLAY_DEV_BROKEN = `          break;
        case 5:
          resetHooksOnUnwind(unitOfWork);
        default:
          unwindInterruptedWork(current, unitOfWork),`;
const REPLAY_DEV_FIXED = `          break;
        case 5:
          resetHooksOnUnwind(unitOfWork);
          var fiber = unitOfWork;
          fiber === hydrationParentFiber &&
            (isHydrating
              ? (popToNextHostParent(fiber),
                5 === fiber.tag &&
                  null != fiber.stateNode &&
                  (nextHydratableInstance = fiber.stateNode))
              : (popToNextHostParent(fiber), (isHydrating = !0)));
        default:
          unwindInterruptedWork(current, unitOfWork),`;

// resetWorkInProgress's first statement in the two indentations react-dom ships. 66060290 is the mask
// Next 15.5.29 ships with only Forked (bit 20) added. 1206910978 is Next 16.4.5's own mask, which holds
// Forked and static flags 15.5 does not have.
const MASK_PROD_BROKEN = `function resetWorkInProgress(workInProgress, renderLanes) {
  workInProgress.flags &= 65011714;
  var current = workInProgress.alternate;`;
const MASK_PROD_FIXED = `function resetWorkInProgress(workInProgress, renderLanes) {
  workInProgress.flags &= 66060290;
  var current = workInProgress.alternate;`;
const MASK_UPSTREAM = `function resetWorkInProgress(workInProgress, renderLanes) {
  workInProgress.flags &= 1206910978;
  var current = workInProgress.alternate;`;
const MASK_DEV_BROKEN = `    function resetWorkInProgress(workInProgress, renderLanes) {
      workInProgress.flags &= 65011714;
      var current = workInProgress.alternate;`;
const MASK_DEV_FIXED = `    function resetWorkInProgress(workInProgress, renderLanes) {
      workInProgress.flags &= 66060290;
      var current = workInProgress.alternate;`;
const MASK_OTHER = `function resetWorkInProgress(workInProgress, renderLanes) {
  workInProgress.flags &= 65011713;
  var current = workInProgress.alternate;`;

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

console.log("\nthe replay transform");
{
  const r = patchReplay(REPLAY_PROD_BROKEN);
  eq("production spelling → patched", r.status, "patched");
  eq("production: upstream's text exactly", r.source, REPLAY_PROD_FIXED);
  eq("production: a second pass passes it through", patchReplay(r.source).status, "already-fixed");
  eq("production: and leaves it unchanged", patchReplay(r.source).source, REPLAY_PROD_FIXED);
}
{
  const r = patchReplay(REPLAY_DEV_BROKEN);
  eq("development spelling → patched", r.status, "patched");
  eq("development: upstream's text exactly, variable and indentation kept", r.source, REPLAY_DEV_FIXED);
  eq("development: a second pass passes it through", patchReplay(r.source).status, "already-fixed");
  eq("development: and leaves it unchanged", patchReplay(r.source).source, REPLAY_DEV_FIXED);
}
{
  const r = patchReplay("switch (n) { case 5:resetHooksOnUnwind(n);default:go(n) }");
  eq("minified-style single line → patched", r.status, "patched");
  eq("single line: a second pass passes it through", patchReplay(r.source).status, "already-fixed");
  let parsed = true;
  try { new vm.Script(`(function (n) { ${r.source} })`); } catch { parsed = false; }
  eq("single line: the result parses", parsed, true);
}
eq("an upstream-fixed source, production → passes through", patchReplay(REPLAY_PROD_FIXED).status, "already-fixed");
eq("an upstream-fixed source, development → passes through", patchReplay(REPLAY_DEV_FIXED).status, "already-fixed");
eq("no replay at all → refused", patchReplay("function replaySuspendedUnitOfWork() {}").status, "refused");
eq("the broken form twice → refused", patchReplay(`${REPLAY_PROD_BROKEN}\n${REPLAY_PROD_BROKEN}`).status, "refused");
eq("the broken form in both spellings → refused", patchReplay(`${REPLAY_PROD_BROKEN}\n${REPLAY_DEV_BROKEN}`).status, "refused");
eq("broken and fixed forms together → refused", patchReplay(`${REPLAY_PROD_BROKEN}\n${REPLAY_DEV_FIXED}`).status, "refused");
eq("the fixed form twice → refused", patchReplay(`${REPLAY_PROD_FIXED}\n${REPLAY_DEV_FIXED}`).status, "refused");
eq("something else between the hook reset and the default → refused",
  patchReplay("case 5:\n  resetHooksOnUnwind(next);\n  other(next);\ndefault:").status,
  "refused");
eq("another case tag → refused", patchReplay("case 26:\n  resetHooksOnUnwind(next);\ndefault:").status, "refused");
eq("another call → refused", patchReplay("case 5:\n  other(next);\ndefault:").status, "refused");
{
  const src = `${REPLAY_PROD_BROKEN}\n${REPLAY_PROD_BROKEN}`;
  const r = patchReplay(src);
  eq("a refused source comes back untouched", r.source, src);
  eq("a refusal says what it counted", r.reason, "found the fixed replay form 0 time(s) and the broken replay form 2 time(s)");
}
eq("the hunks do not touch each other's text: replay on the ping fixture → refused", patchReplay(PROD_BROKEN).status, "refused");
eq("the hunks do not touch each other's text: ping on the replay fixture → refused", patchSource(REPLAY_PROD_BROKEN).status, "refused");

console.log("\nthe useId slot transform");
{
  const r = patchForked(MASK_PROD_BROKEN);
  eq("production indentation → patched", r.status, "patched");
  eq("production: the mask with Forked added", r.source, MASK_PROD_FIXED);
  eq("production: a second pass passes it through", patchForked(r.source).status, "already-fixed");
  eq("production: and leaves it unchanged", patchForked(r.source).source, MASK_PROD_FIXED);
}
{
  const r = patchForked(MASK_DEV_BROKEN);
  eq("development indentation → patched", r.status, "patched");
  eq("development: the mask with Forked added, indentation kept", r.source, MASK_DEV_FIXED);
  eq("development: a second pass passes it through", patchForked(r.source).status, "already-fixed");
}
{
  const r = patchForked("function resetWorkInProgress(workInProgress, renderLanes) { workInProgress.flags &= 65011714; }");
  eq("single line → patched", r.source, "function resetWorkInProgress(workInProgress, renderLanes) { workInProgress.flags &= 66060290; }");
}
eq("upstream's mask, bit 20 set → passes through", patchForked(MASK_UPSTREAM).status, "already-fixed");
eq("upstream's mask: and leaves it unchanged", patchForked(MASK_UPSTREAM).source, MASK_UPSTREAM);
eq("no resetWorkInProgress at all → refused", patchForked("function other() {}").status, "refused");
eq("the same mask in another function → refused",
  patchForked("function createWorkInProgress(workInProgress, renderLanes) {\n  workInProgress.flags &= 65011714;\n}").status,
  "refused");
eq("a statement before the mask → refused",
  patchForked("function resetWorkInProgress(workInProgress, renderLanes) {\n  other();\n  workInProgress.flags &= 65011714;\n}").status,
  "refused");
eq("another mask without bit 20 → refused", patchForked(MASK_OTHER).status, "refused");
eq("two sites → refused", patchForked(`${MASK_PROD_BROKEN}\n${MASK_PROD_BROKEN}`).status, "refused");
eq("a broken site and a fixed site → refused", patchForked(`${MASK_PROD_BROKEN}\n${MASK_PROD_FIXED}`).status, "refused");
eq("two fixed sites → refused", patchForked(`${MASK_PROD_FIXED}\n${MASK_UPSTREAM}`).status, "refused");
{
  const src = `${MASK_PROD_BROKEN}\n${MASK_PROD_BROKEN}`;
  const r = patchForked(src);
  eq("a refused source comes back untouched", r.source, src);
  eq("a refusal says what it counted", r.reason, "found resetWorkInProgress's mask 2 time(s)");
  eq("no site: a refusal says what it counted", patchForked("function other() {}").reason, "found resetWorkInProgress's mask 0 time(s)");
  eq("another mask comes back untouched", patchForked(MASK_OTHER).source, MASK_OTHER);
  eq("another mask: the refusal names it", patchForked(MASK_OTHER).reason, "resetWorkInProgress's mask is 65011713, expected 65011714");
}
eq("the hunks do not touch each other's text: mask on the ping fixture → refused", patchForked(PROD_BROKEN).status, "refused");
eq("the hunks do not touch each other's text: mask on the replay fixture → refused", patchForked(REPLAY_PROD_BROKEN).status, "refused");
eq("the hunks do not touch each other's text: ping on the mask fixture → refused", patchSource(MASK_PROD_BROKEN).status, "refused");
eq("the hunks do not touch each other's text: replay on the mask fixture → refused", patchReplay(MASK_PROD_BROKEN).status, "refused");

console.log("\nthe loader");
{
  const file = "x/react-dom-client.production.js";
  const ctx = { resourcePath: file };
  const thrown = (src: string) => {
    try { loader.call(ctx, src); return ""; } catch (e) { return (e as Error).message; }
  };
  eq("applies all three hunks to one source", loader.call(ctx, `${PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\n${MASK_PROD_BROKEN}`), `${PROD_FIXED}\n${REPLAY_PROD_FIXED}\n${MASK_PROD_FIXED}`);
  eq("development spellings too", loader.call(ctx, `${DEV_BROKEN}\n${REPLAY_DEV_BROKEN}\n${MASK_DEV_BROKEN}`), `${DEV_FIXED}\n${REPLAY_DEV_FIXED}\n${MASK_DEV_FIXED}`);
  eq("each hunk answers on its own: ping fixed, the others broken", loader.call(ctx, `${PROD_FIXED}\n${REPLAY_PROD_BROKEN}\n${MASK_PROD_BROKEN}`), `${PROD_FIXED}\n${REPLAY_PROD_FIXED}\n${MASK_PROD_FIXED}`);
  eq("each hunk answers on its own: replay fixed, the others broken", loader.call(ctx, `${PROD_BROKEN}\n${REPLAY_PROD_FIXED}\n${MASK_PROD_BROKEN}`), `${PROD_FIXED}\n${REPLAY_PROD_FIXED}\n${MASK_PROD_FIXED}`);
  eq("each hunk answers on its own: mask fixed, the others broken", loader.call(ctx, `${PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\n${MASK_UPSTREAM}`), `${PROD_FIXED}\n${REPLAY_PROD_FIXED}\n${MASK_UPSTREAM}`);
  eq("all three already fixed: unchanged, no throw", loader.call(ctx, `${PROD_FIXED}\n${REPLAY_PROD_FIXED}\n${MASK_UPSTREAM}`), `${PROD_FIXED}\n${REPLAY_PROD_FIXED}\n${MASK_UPSTREAM}`);

  const ping = thrown(`no match here\n${REPLAY_PROD_BROKEN}\n${MASK_PROD_BROKEN}`);
  eq("a refused ping fails the build, naming the file", ping.includes(file), true);
  eq("a refused ping names ADR 0013", ping.includes("ADR 0013") && ping.includes("docs/adr/0013-"), true);
  eq("a refused ping does not name ADR 0018", ping.includes("0018"), false);
  eq("a refused ping names the hunk", ping.includes("the lost ping"), true);

  const replay = thrown(`${PROD_BROKEN}\nno match here\n${MASK_PROD_BROKEN}`);
  eq("a refused replay fails the build, naming the file", replay.includes(file), true);
  eq("a refused replay names ADR 0018", replay.includes("ADR 0018") && replay.includes("docs/adr/0018-"), true);
  eq("a refused replay does not name ADR 0013", replay.includes("0013"), false);
  eq("a refused replay names the hunk", replay.includes("the hydration replay"), true);
  eq("a refused replay says what it counted", replay.includes("found the fixed replay form 0 time(s)"), true);
  eq("two replay forms also fail the build", thrown(`${PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\n${MASK_PROD_BROKEN}`).includes("ADR 0018"), true);
  eq("mixed replay forms also fail the build", thrown(`${PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\n${REPLAY_DEV_FIXED}\n${MASK_PROD_BROKEN}`).includes("ADR 0018"), true);

  const forked = thrown(`${PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\nno match here`);
  eq("a refused mask fails the build, naming the file", forked.includes(file), true);
  eq("a refused mask names ADR 0018", forked.includes("ADR 0018") && forked.includes("docs/adr/0018-"), true);
  eq("a refused mask does not name ADR 0013", forked.includes("0013"), false);
  eq("a refused mask names the hunk", forked.includes("the replay's useId slot"), true);
  eq("a refused mask says what it counted", forked.includes("found resetWorkInProgress's mask 0 time(s)"), true);
  eq("another mask also fails the build, naming it", thrown(`${PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\n${MASK_OTHER}`).includes("resetWorkInProgress's mask is 65011713"), true);
  eq("two mask sites also fail the build", thrown(`${PROD_BROKEN}\n${REPLAY_PROD_BROKEN}\n${MASK_PROD_BROKEN}\n${MASK_PROD_BROKEN}`).includes("the replay's useId slot"), true);
  // The record the ADR's file name points at must exist, or the message sends a person nowhere.
  for (const doc of [...ping.matchAll(/docs\/adr\/[\w.-]+\.md/g), ...replay.matchAll(/docs\/adr\/[\w.-]+\.md/g), ...forked.matchAll(/docs\/adr\/[\w.-]+\.md/g)].map((m) => m[0])) {
    eq(`the message's record exists: ${doc}`, fs.existsSync(path.join(process.cwd(), doc)), true);
  }
}

console.log("\nthe path rule");
{
  // Runs next.config.ts's own webpack hook once, so a rule that is commented out, guarded off in this call or never pushed fails here.
  type Rule = { test?: unknown; exclude?: unknown; use?: { loader: string }[] };
  const cfg = (require("../../next.config.ts") as { default: { webpack?: (c: { module: { rules: Rule[] } }, o: object) => { module: { rules: Rule[] } } } }).default;
  const rules = cfg.webpack ? cfg.webpack({ module: { rules: [] } }, {}).module.rules : [];
  const rule = rules.find((r) => r.test === REACT_DOM_CLIENT_FILE);
  eq("next.config.ts registers the loader on the path rule",
    rule ? [rule.exclude ?? null, rule.use?.map((u) => u.loader)] : null,
    [null, [path.join(process.cwd(), "scripts", "react-dom-ping-fix.cjs")]]);
}
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
eq("the four client builds are the ones checked below", TARGET_FILES, [
  "react-dom-client.production.js",
  "react-dom-client.development.js",
  "react-dom-profiling.profiling.js",
  "react-dom-profiling.development.js",
]);
{
  const nextDir = path.join(process.cwd(), "node_modules", "next");
  const version = (JSON.parse(fs.readFileSync(path.join(nextDir, "package.json"), "utf8")) as { version: string }).version;
  const cjs = path.join(nextDir, "dist", "compiled", "react-dom", "cjs");
  for (const name of TARGET_FILES) {
    const file = path.join(cjs, name);
    eq(`${name}: matched by the next.config.ts rule`, REACT_DOM_CLIENT_FILE.test(file), true);
    const src = fs.readFileSync(file, "utf8");
    const r = patchSource(src);
    eq(`${name} (next ${version}): patched exactly once`, r.status === "refused" ? `refused: ${r.reason}` : r.status, "patched");
    const rr = patchReplay(src);
    eq(`${name} (next ${version}): replay patched exactly once`, rr.status === "refused" ? `refused: ${rr.reason}` : rr.status, "patched");
    const rf = patchForked(src);
    eq(`${name} (next ${version}): resetWorkInProgress's mask patched exactly once`, rf.status === "refused" ? `refused: ${rf.reason}` : rf.status, "patched");
    // The hunk assumes bit 20 is Forked, written by placeChild and read by beginWork.
    eq(`${name}: bit 20 is the flag placeChild writes and beginWork reads`,
      src.includes("newFiber.flags |= 1048576") && src.includes("workInProgress.flags & 1048576"),
      true);
    // The restore uses these by name, and a rename beside an unchanged broken form would throw only at a replay.
    eq(`${name}: the names the restore uses are declared in the file`,
      /hydrationParentFiber = null,\s*nextHydratableInstance = null,\s*isHydrating = !1,/.test(src) && src.includes("function popToNextHostParent(fiber)"),
      true);
    const out = loader.call({ resourcePath: file }, src);
    eq(`${name}: the loader leaves all three hunks fixed`, [patchSource(out).status, patchReplay(out).status, patchForked(out).status], ["already-fixed", "already-fixed", "already-fixed"]);
    eq(`${name}: resetWorkInProgress's mask becomes 66060290, once`, [out.split("workInProgress.flags &= 66060290;").length - 1, out.split("workInProgress.flags &= 65011714;").length - 1], [1, 0]);
    eq(`${name}: the file's other static-mask sites are left alone`, out.split("65011712").length, src.split("65011712").length);
    eq(`${name}: the replay keeps this build's variable`, out.includes(`var fiber = ${name.endsWith(".development.js") ? "unitOfWork" : "next"};`), true);
    let parsed = true;
    try { new vm.Script(`(function (exports, require, module, __filename, __dirname) {${out}\n})`, { filename: name }); } catch { parsed = false; }
    eq(`${name}: the loader's output parses`, parsed, true);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
