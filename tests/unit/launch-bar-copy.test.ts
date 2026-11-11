/**
 * ADR 0019 steps 6-8 and 10: source checks of the launch bar, the two
 * runtimes that render it, the launch page's two props and the continue
 * page's reads. The files are .tsx pages and client components (next/*
 * imports, a cookie client), so nothing here renders them; the checks read
 * the source with comments blanked, the revision-ui-copy.test.ts shape.
 *
 *   - both runtimes render <LaunchBar> in place of their own header, the
 *     format label is gone, and the iframe keeps the course title;
 *   - the badge keeps data-testid="practice-badge", reads "Revision Mode" and
 *     renders only under `revision`;
 *   - Continue is a plain <a> (a full navigation), rendered only under
 *     `continueHref`; Exit is the bar's one next/link, to `backHref`;
 *   - the title renders only under `showTitle`, capped and truncated;
 *   - the launch page computes continueHref from pathContextId and
 *     !journeyParam, and showTitle from isKivoStamped, for both runtimes;
 *   - the continue page decides staff through launchModeFor, reads
 *     pass_required and the grants strictly (never through the fail-soft
 *     helpers), ends the wait only on a stored result whose verdict is not
 *     pending (verdictPending), uses no service client and writes nothing.
 *
 * Run:  npx tsx tests/unit/launch-bar-copy.test.ts   (or npm run test:unit)
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import fs from "node:fs";
import path from "node:path";
import { isKivoStamped } from "../../lib/courses/engine-version";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const raw = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
/** Source with line and block comments blanked (strings kept), so a comment is never read as code. */
const code = (rel: string) =>
  raw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const count = (src: string, needle: string) => src.split(needle).length - 1;

const LAUNCH = "app/[org]/(learner)/courses/[courseId]/launch";
const BAR = `${LAUNCH}/launch-bar.tsx`;
const CMI5 = `${LAUNCH}/cmi5-runtime.tsx`;
const SCORM = `${LAUNCH}/scorm-runtime.tsx`;
const LAUNCH_PAGE = `${LAUNCH}/page.tsx`;
const CONTINUE_PAGE = "app/[org]/(learner)/continue/page.tsx";
const CONTINUE_LOADING = "app/[org]/(learner)/continue/loading.tsx";

console.log("\nboth runtimes render the one bar (step 7)");
for (const f of [CMI5, SCORM]) {
  const src = code(f);
  eq(`${f}: imports LaunchBar from ./launch-bar`, /import \{ LaunchBar \} from "\.\/launch-bar";/.test(src), true);
  eq(`${f}: renders <LaunchBar once, with no header of its own`, [count(src, "<LaunchBar"), count(src, "<header")], [1, 0]);
  eq(`${f}: passes the bar its props`, /<LaunchBar\s+backHref=\{backHref\}\s+backLabel=\{backLabel\}\s+title=\{courseTitle\}\s+showTitle=\{showTitle\}\s+revision=\{revision\}\s+continueHref=\{continueHref\}/.test(src), true);
  eq(`${f}: no {standard} as rendered text, no format label`, [src.includes("{standard}"), /\bstandard\b/.test(src)], [false, false]);
  eq(`${f}: the iframe keeps title={courseTitle} (screen readers)`, /<iframe[\s\S]*?title=\{courseTitle\}/.test(src), true);
  eq(`${f}: showTitle defaults to true and continueHref to null`, [/showTitle = true,/.test(src), /continueHref = null,/.test(src)], [true, true]);
  eq(`${f}: the frame hooks and the full-screen layout are unchanged`, [
    src.includes("const frame = useModuleFrame();"),
    src.includes("useNextModulePreload(preloadUrls, frame.loaded);"),
    src.includes("<ModuleFrameLoader loaded={frame.loaded} />"),
    src.includes('className="fixed inset-0 z-50 flex flex-col bg-ink"'),
  ], [true, true, true, true]);
}
eq("the SCORM runtime passes its SyncBadge as the bar's children", /<LaunchBar[\s\S]*?>\s*<SyncBadge status=\{status\} \/>\s*<\/LaunchBar>/.test(code(SCORM)), true);
eq("the cmi5 runtime's bar has no children", /<LaunchBar[^>]*\/>/.test(code(CMI5)), true);

console.log("\nthe bar (step 6)");
{
  const src = code(BAR);
  eq("a client component", raw(BAR).startsWith('"use client";'), true);
  eq("three columns at every width: auto minmax(0,1fr) auto, with the launch-bar test id",
    /<header\s+data-testid="launch-bar"\s+className="grid grid-cols-\[auto_minmax\(0,1fr\)_auto\] items-center/.test(src), true);
  eq("practice-badge: exactly one, reading Revision Mode, only under `revision`", [
    count(src, 'data-testid="practice-badge"'),
    /\{revision && \(\s*<span[^>]*title="Revision visit: your official result does not change"[^>]*data-testid="practice-badge"\s*>\s*Revision Mode\s*<\/span>\s*\)\}/.test(src),
  ], [1, true]);
  eq("continue-next: exactly one, opening with <a , only under `continueHref`", [
    count(src, 'data-testid="continue-next"'),
    /\{continueHref \? \(\s*<a\s+href=\{continueHref\}\s+data-testid="continue-next"/.test(src),
    /data-testid="continue-next"[^>]*>\s*Continue\b/.test(src),
  ], [1, true, true]);
  eq("…and an empty cell keeps the third column when there is none", /\) : \(\s*<span aria-hidden \/>\s*\)\}/.test(src), true);
  eq("<Link occurs once, in Exit: href={backHref}, its title and wording unchanged", [
    count(src, "<Link"),
    /<Link\s+href=\{backHref\}[^>]*title=\{`Exit course — \$\{backLabel\.toLowerCase\(\)\}`\}\s*>/.test(src),
    /<span className="hidden sm:inline">\{backLabel\}<\/span>\s*<span className="sm:hidden">Exit<\/span>/.test(src),
  ], [1, true, true]);
  eq("touch targets about 40 px: Exit and Continue carry min-h-10", count(src, "min-h-10"), 2);
  const title = src.match(/\{showTitle && <span className="([^"]*)">\{title\}<\/span>\}/);
  eq("the title renders only under showTitle", !!title, true);
  eq("…hidden below sm, truncated and capped at 28vw", ["hidden", "sm:inline", "truncate", "min-w-0", "max-w-[28vw]"].map((c) => (title?.[1] ?? "").split(/\s+/).includes(c)), [true, true, true, true, true]);
  eq("…inside a left cell that clips (min-w-0 overflow-hidden)", /<div className="flex items-center gap-2 min-w-0 overflow-hidden">\s*<Link/.test(src), true);
  eq("the centre cell holds the badge and the children", /<div className="flex items-center justify-center gap-2 min-w-0">\s*\{revision && \([\s\S]*?\)\}\s*\{children\}\s*<\/div>/.test(src), true);
}

console.log("\nthe launch page's two props (step 8)");
{
  const src = code(LAUNCH_PAGE);
  eq("continueHref from pathContextId and !journeyParam, to the continue address",
    /const continueHref =\s*pathContextId && !journeyParam\s*\?\s*`\/\$\{orgSlug\}\/continue\?lp=\$\{encodeURIComponent\(pathContextId\)\}&from=\$\{encodeURIComponent\(courseId\)\}`\s*:\s*null;/.test(src), true);
  eq("showTitle from the cached stamp only", /const showTitle = !isKivoStamped\(v\.manifest_data\);/.test(src), true);
  eq("…imported from lib/courses/engine-version, and the page never calls ensureEngineVersion", [
    /import \{ isKivoStamped \} from "@\/lib\/courses\/engine-version";/.test(src),
    src.includes("ensureEngineVersion("),
  ], [true, false]);
  eq("both runtimes get showTitle and continueHref", [count(src, "showTitle={showTitle}"), count(src, "continueHref={continueHref}")], [2, 2]);
  eq("both are computed before the SCORM return", src.indexOf("const continueHref =") < src.search(/return \(\s*<ScormRuntime/) && src.indexOf("const showTitle =") < src.search(/return \(\s*<ScormRuntime/), true);
  eq("the format label is no longer passed", src.includes("standard="), false);
}

console.log("\nthe continue page (steps 1 and 2)");
{
  const src = code(CONTINUE_PAGE);
  eq("isStaff from launchModeFor, the launch page's own preview test", /const isStaff = launchModeFor\(\{ role, revision: false \}\)\.isPreview;/.test(src), true);
  eq("reads pass_required strictly from courses", /\.from\("courses"\)\s*\.select\("pass_required"\)\s*\.eq\("id", fromCourseId\)\s*\.maybeSingle\(\);\s*if \(courseErr \|\| !courseRow\) readError\(\);/.test(src), true);
  eq("…and the grants from attempt_requests, strictly", /\.from\("attempt_requests"\)\s*\.select\("used_attempt_id"\)[\s\S]*?if \(grantErr\) readError\(\);/.test(src), true);
  eq("…never through the fail-soft helpers", [src.includes("fetchPassRequired("), src.includes("fetchGrantRetakeIds(")], [false, false]);
  eq("the versions read: an error or no rows ends as the timeout target", /if \(verErr \|\| versionIds\.length === 0\) readError\(\);/.test(src), true);
  eq("the attempts read names is_revision with the narrower-select fallback, an error ends the wait", [
    /readWithOptionalColumn<unknown\[\]>\(\s*"is_revision",/.test(src),
    /if \(rowsErr\) readError\(\);/.test(src),
  ], [true, true]);
  eq("the wait ends only on a stored result whose verdict is not pending, then done through officialDone with the course's pass_required",
    /if \(resultStored\(scoring, attempts\) && !verdictPending\(scoring, passRequired\)\) \{\s*stored = true;\s*done = officialDone\(scoring, passRequired\);\s*break;\s*\}/.test(src), true);
  eq("…verdictPending imported from lib/learner/continue, the only conclude test in the loop", [
    /import \{[^}]*\bverdictPending\b[^}]*\} from "@\/lib\/learner\/continue";/.test(src),
    count(src, "resultStored("),
    count(src, "verdictPending("),
  ], [true, 1, 1]);
  eq("no service client, no write", [
    src.includes("SUPABASE_SERVICE_ROLE_KEY"),
    /\.(insert|update|upsert|delete)\(/.test(src),
    /\.rpc\(/.test(src),
  ], [false, false, false]);
  eq("the four log events, ids only", ["continue_not_a_step", "continue_read_error", "continue_timeout", "continue_not_done"].map((e) => src.includes(`"${e}"`)), [true, true, true, true]);
  eq("…in the house shape", /console\.warn\(JSON\.stringify\(\{ event, path_id: pathId, course_id: fromCourseId, user_id: user\.id \}\)\)/.test(src), true);
  eq("no redirect inside a try", /\btry\s*\{/.test(src), false);
  const loading = code(CONTINUE_LOADING);
  eq("loading.tsx: the Saving your result screen with its test id", [
    loading.includes('data-testid="continue-saving"'),
    loading.includes('<LoadingRow label="Saving your result…" />'),
    loading.includes("Your result is being saved. The next step opens in a moment."),
  ], [true, true, true]);
}

console.log("\nisKivoStamped, called directly");
eq("a string → true; null and an absent key → false", [isKivoStamped({ engineVersion: "2026.10.28" }), isKivoStamped({ engineVersion: null }), isKivoStamped({})], [true, false, false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
