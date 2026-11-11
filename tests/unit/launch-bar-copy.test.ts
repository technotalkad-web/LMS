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
 *     pending (officialResultStored), uses no service client and writes
 *     nothing.
 *
 * ADR 0019, note of 2026-11-11 (Continue waits for the stored result):
 *   - the bar renders Continue in two states, `data-state="waiting"` (no
 *     href, aria-disabled, role="link", a lock icon, a tap that checks,
 *     never navigates and shows the waiting message in an aria-live status)
 *     and
 *     `data-state="ready"` (today's <a href>); the poll follows shouldPoll
 *     and the tab's visibility; the bar is thinner below sm;
 *   - both runtimes pass continueReady, continueStatusHref and continuePoll
 *     (true for cmi5, false for SCORM); the SCORM runtime bumps
 *     continueRecheck only after a commit the server answered ok with a
 *     terminal status that differs from the last one checked;
 *   - the launch page computes continueReady through officialResultStored
 *     (never on the launch that has just opened a granted retake) and
 *     continueStatusHref from attemptId, for both runtimes;
 *   - the status route: a uuid check before any read, the caller's cookie
 *     client, no service role, no write, the continue page's strict reads,
 *     officialResultStored once, Cache-Control: no-store.
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
const STATUS_ROUTE = "app/api/attempts/[attemptId]/result-stored/route.ts";

console.log("\nboth runtimes render the one bar (step 7)");
for (const f of [CMI5, SCORM]) {
  const src = code(f);
  eq(`${f}: imports LaunchBar from ./launch-bar`, /import \{ LaunchBar \} from "\.\/launch-bar";/.test(src), true);
  eq(`${f}: renders <LaunchBar once, with no header of its own`, [count(src, "<LaunchBar"), count(src, "<header")], [1, 0]);
  eq(`${f}: passes the bar its props`, /<LaunchBar\s+backHref=\{backHref\}\s+backLabel=\{backLabel\}\s+title=\{courseTitle\}\s+showTitle=\{showTitle\}\s+revision=\{revision\}\s+continueHref=\{continueHref\}/.test(src), true);
  eq(`${f}: no {standard} as rendered text, no format label`, [src.includes("{standard}"), /\bstandard\b/.test(src)], [false, false]);
  eq(`${f}: the iframe keeps title={courseTitle} (screen readers)`, /<iframe[\s\S]*?title=\{courseTitle\}/.test(src), true);
  eq(`${f}: showTitle defaults to true and continueHref to null`, [/showTitle = true,/.test(src), /continueHref = null,/.test(src)], [true, true]);
  eq(`${f}: continueReady defaults to false (the safe default) and continueStatusHref to null`, [/continueReady = false,/.test(src), /continueStatusHref = null,/.test(src)], [true, true]);
  eq(`${f}: passes the bar continueReady and continueStatusHref, once each`, [
    count(src, "continueReady={continueReady}"),
    count(src, "continueStatusHref={continueStatusHref}"),
  ], [1, 1]);
  eq(`${f}: the frame hooks and the full-screen layout are unchanged`, [
    src.includes("const frame = useModuleFrame();"),
    src.includes("useNextModulePreload(preloadUrls, frame.loaded);"),
    src.includes("<ModuleFrameLoader loaded={frame.loaded} />"),
    src.includes('className="fixed inset-0 z-50 flex flex-col bg-ink"'),
  ], [true, true, true, true]);
}
eq("the SCORM runtime passes its SyncBadge as the bar's children", /<LaunchBar[\s\S]*?>\s*<SyncBadge status=\{status\} \/>\s*<\/LaunchBar>/.test(code(SCORM)), true);
eq("the cmi5 runtime's bar has no children", /<LaunchBar[^>]*\/>/.test(code(CMI5)), true);
eq("the cmi5 runtime polls (continuePoll={true}); the SCORM runtime does not (continuePoll={false})", [
  code(CMI5).includes("continuePoll={true}"),
  code(CMI5).includes("continuePoll={false}"),
  code(SCORM).includes("continuePoll={false}"),
  code(SCORM).includes("continuePoll={true}"),
], [true, false, true, false]);
{
  const src = code(SCORM);
  eq("the SCORM runtime passes continueRecheck from its own state; the cmi5 runtime passes none", [
    /const \[continueRecheck, setContinueRecheck\] = useState\(0\);/.test(src),
    count(src, "continueRecheck={continueRecheck}"),
    code(CMI5).includes("continueRecheck"),
  ], [true, 1, false]);
  eq("…bumped once, only after if (!res.ok) throw, only on a terminal status in the server's answer, and only when it differs from the last one checked", [
    count(src, "setContinueRecheck("),
    /const lastCheckedStatus = useRef<string \| null>\(null\);/.test(src),
    /if \(!res\.ok\) throw new Error\(`HTTP \$\{res\.status\}`\);\s*const body = \(await res\.json\(\)\.catch\(\(\) => null\)\) as \{ status\?: string \} \| null;\s*const answered = body \? String\(body\.status\) : "";\s*if \(\["completed", "passed", "failed"\]\.includes\(answered\) && answered !== lastCheckedStatus\.current\) \{\s*lastCheckedStatus\.current = answered;\s*setContinueRecheck\(\(n\) => n \+ 1\);\s*\}\s*setStatus\("saved"\);/.test(src),
    count(src, "lastCheckedStatus.current = "),
  ], [1, true, true, 1]);
}

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
  eq("continue-next: exactly two, one per state, both <a , only under `continueHref`", [
    count(src, 'data-testid="continue-next"'),
    count(src, 'data-state="waiting"'),
    count(src, 'data-state="ready"'),
    /\{continueHref \? \(\s*state === "ready" \? \(\s*<a\s+href=\{continueHref\}\s+data-testid="continue-next"\s+data-state="ready"/.test(src),
    /\) : \(\s*<a\s+data-testid="continue-next"\s+data-state="waiting"/.test(src),
  ], [2, 1, 1, true, true]);
  eq("…the state from continueState(ready)", /const state = continueState\(ready\);/.test(src), true);
  // The opening tags, up to the `>` that comes before the label (the waiting
  // tag's onKeyDown arrow holds `=>`, so [^>]* would stop early).
  const ready = src.match(/<a\s+href=\{continueHref\}\s+data-testid="continue-next"\s+data-state="ready"([\s\S]*?)>\s*Continue\b([\s\S]*?)<\/a>/);
  const waiting = src.match(/<a\s+data-testid="continue-next"\s+data-state="waiting"([\s\S]*?)>\s*Continue\b([\s\S]*?)<\/a>/);
  eq("ready: today's element: href={continueHref}, the arrow icon, no handler, no aria-disabled", [
    !!ready,
    (ready?.[1] ?? "").includes("onClick"),
    (ready?.[1] ?? "").includes("aria-disabled"),
    (ready?.[2] ?? "").includes('d="M3 10a.75.75'),
    (ready?.[1] ?? "").includes("bg-canvas text-ink"),
  ], [true, false, false, true, true]);
  eq("waiting: no href, aria-disabled, role=link, focusable, the tap handler, the lock icon", [
    !!waiting,
    /\bhref=/.test(waiting?.[1] ?? "href="),
    (waiting?.[1] ?? "").includes('aria-disabled="true"'),
    (waiting?.[1] ?? "").includes('role="link"'),
    (waiting?.[1] ?? "").includes("tabIndex={0}"),
    (waiting?.[1] ?? "").includes("onClick={onTap}"),
    /onKeyDown=\{\(e\) => \{\s*if \(e\.key === "Enter" \|\| e\.key === " "\) void onTap\(e\);\s*\}\}/.test(waiting?.[1] ?? ""),
    (waiting?.[2] ?? "").includes('d="M10 1a4.5'),
    ["bg-canvas/30", "text-canvas/60", "cursor-not-allowed", "select-none"].every((c) => (waiting?.[1] ?? "").includes(c)),
  ], [true, false, true, true, true, true, true, true, true]);
  eq("…and an empty cell keeps the third column when there is none", /\) : \(\s*<span aria-hidden \/>\s*\)\}/.test(src), true);
  eq("the bar's decisions come from lib/learner/continue-state", [
    /import \{[^}]*\} from "@\/lib\/learner\/continue-state";/.test(src),
    ...["CONTINUE_STATUS_POLL_MS", "CONTINUE_WAITING_MESSAGE", "CONTINUE_MESSAGE_MS", "CONTINUE_CHECK_DEBOUNCE_MS", "shouldPoll(", "parseStoredAnswer(", "continueState("].map((n) => count(src, n) >= 2 || (n.endsWith("(") && src.includes(n))),
  ], [true, true, true, true, true, true, true, true]);
  eq("…and the bar imports nothing that reads a result (no Supabase, no lib/scoring, no lib/learner/continue)", [
    /from "@supabase\//.test(src),
    /from "@\/lib\/scoring\//.test(src),
    /from "@\/lib\/learner\/continue";/.test(src),
  ], [false, false, false]);
  eq("the check: one fetch of the status address, no-store, same-origin, the middleware's redirect not followed, aborted on unmount, parsed by parseStoredAnswer", [
    count(src, "fetch("),
    /fetch\(statusHref, \{\s*cache: "no-store",\s*credentials: "same-origin",\s*redirect: "manual",\s*signal: lifetime\.current\?\.signal,\s*\}\)/.test(src),
    /parseStoredAnswer\(res\.status, await res\.json\(\)\.catch\(\(\) => null\)\)/.test(src),
    /return \(\) => ac\.abort\(\);/.test(src),
  ], [1, true, true, true]);
  eq("…only { stored: true } turns it ready, and nothing turns it back", [
    /if \(answer === true\) \{\s*readyRef\.current = true;\s*setReady\(true\);\s*\}/.test(src),
    count(src, "setReady("),
    src.includes("setReady(false)"),
  ], [true, 1, false]);
  eq("…an immediate check within the debounce answers the last answer; a forced one waits for the one in flight", [
    /if \(!force && Date\.now\(\) - lastAt\.current < CONTINUE_CHECK_DEBOUNCE_MS\) return lastAnswer\.current;/.test(src),
    /if \(force\) while \(inflight\.current\) await inflight\.current;/.test(src),
    /if \(inflight\.current\) return inflight\.current;/.test(src),
  ], [true, true, true]);
  eq("the poll: shouldPoll over the tab's visibility, the interval CONTINUE_STATUS_POLL_MS, a check on return to the tab", [
    /if \(statusHref === null \|\| !poll \|\| ready\) return;/.test(src),
    /shouldPoll\(\{\s*hasStatusHref: true,\s*ready: readyRef\.current,\s*visible: document\.visibilityState === "visible",\s*poll,\s*\}\)/.test(src),
    /window\.setInterval\(\(\) => void check\(\), CONTINUE_STATUS_POLL_MS\)/.test(src),
    /document\.addEventListener\("visibilitychange", onVisibility\);/.test(src),
    /document\.removeEventListener\("visibilitychange", onVisibility\);/.test(src),
    /if \(document\.visibilityState === "visible"\) void check\(\);/.test(src),
  ], [true, true, true, true, true, true]);
  eq("the recheck: a change of continueRecheck runs one forced check, none on mount", /useEffect\(\(\) => \{\s*if \(!recheck\) return;\s*void check\(true\);\s*\}, \[recheck, check\]\);/.test(src), true);
  eq("the hook runs whatever continueHref is; its status address is null off a path launch", /const \{ ready, check \} = useContinueReady\(\{\s*statusHref: continueHref \? continueStatusHref : null,\s*initialReady: continueReady,\s*poll: continuePoll,\s*recheck: continueRecheck,\s*\}\);/.test(src), true);
  eq("the tap: preventDefault, one check; stored → nothing more (the hook turned it ready; a tap never navigates); otherwise the message for CONTINUE_MESSAGE_MS", [
    /const onTap = async \([^)]*\) => \{\s*e\.preventDefault\(\);\s*const answer = await check\(\);\s*if \(answer === true\) return;\s*setMessage\(CONTINUE_WAITING_MESSAGE\);/.test(src),
    count(src, "location.assign(") + count(src, "location.href") + count(src, "location.replace(") + count(src, "router.push("),
    /window\.setTimeout\(\(\) => \{\s*messageTimer\.current = null;\s*setMessage\(""\);\s*\}, CONTINUE_MESSAGE_MS\)/.test(src),
  ], [true, 0, true]);
  const status = src.match(/\{continueHref && \(\s*<p\s+role="status"\s+aria-live="polite"\s+data-testid="continue-waiting-message"\s+className=\{message \? "([^"]*)" : "sr-only"\}\s*>\s*\{message\}\s*<\/p>\s*\)\}\s*<\/header>/);
  eq("the status region: role=status, aria-live=polite, its test id, under continueHref, the header's last child", !!status, true);
  eq("…out of the grid's flow in both states (absolute when shown; sr-only is absolute), so the bar's height never changes", (status?.[1] ?? "").split(/\s+/).includes("absolute"), true);
  const header = src.match(/<header\s+data-testid="launch-bar"\s+className="([^"]*)"/);
  eq("the header: thinner below sm (py-0.5 sm:py-1), and its class list ends with relative z-10", [
    (header?.[1] ?? "").includes("py-0.5 sm:py-1"),
    (header?.[1] ?? "").split(/\s+/).includes("py-1"),
    (header?.[1] ?? "").endsWith("relative z-10"),
  ], [true, false, true]);
  eq("py-0.5 sm:py-1 once in the bar", count(src, "py-0.5 sm:py-1"), 1);
  eq("<Link occurs once, in Exit: href={backHref}, its title and wording unchanged", [
    count(src, "<Link"),
    /<Link\s+href=\{backHref\}[^>]*title=\{`Exit course — \$\{backLabel\.toLowerCase\(\)\}`\}\s*>/.test(src),
    /<span className="hidden sm:inline">\{backLabel\}<\/span>\s*<span className="sm:hidden">Exit<\/span>/.test(src),
  ], [1, true, true]);
  eq("touch targets 36 px below sm and 40 px from sm: Exit and both Continue states carry min-h-9 sm:min-h-10, and no bare min-h-10 is left", [
    count(src, "min-h-9 sm:min-h-10"),
    count(src, "min-h-10"),
    count(src, "min-h-9"),
  ], [3, 3, 3]);
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

  // ADR 0019, note of 2026-11-11: the bar's state.
  eq("the course read selects pass_required; passRequired is the continue address's reading", [
    /\.from\("courses"\)\s*\.select\("id, organization_id, current_version_id, title, is_active, pass_required"\)/.test(src),
    /const passRequired = c\.pass_required === true;/.test(src),
  ], [true, true]);
  eq("continueReady: a path launch, and a preview or (no grant opened on this launch and) the page's own scoring reads the result stored through officialResultStored",
    /const continueReady =\s*continueHref !== null &&\s*\(launch\.isPreview \|\|\s*\(openedGrantId === null && ev\.scoring !== null && officialResultStored\(ev\.scoring, ev\.my, passRequired\)\)\);/.test(src), true);
  eq("…officialResultStored imported from lib/learner/continue, called once", [
    /import \{ officialResultStored \} from "@\/lib\/learner\/continue";/.test(src),
    count(src, "officialResultStored("),
  ], [true, 1]);
  eq("continueStatusHref: the attempt's status route on a path launch, else null",
    /const continueStatusHref =\s*continueHref !== null \? `\/api\/attempts\/\$\{encodeURIComponent\(attemptId\)\}\/result-stored` : null;/.test(src), true);
  eq("both runtimes get continueReady and continueStatusHref", [count(src, "continueReady={continueReady}"), count(src, "continueStatusHref={continueStatusHref}")], [2, 2]);
  eq("both are computed after `launch` and before the SCORM return", [
    src.indexOf("const launch = launchModeFor(") < src.indexOf("const continueReady ="),
    src.indexOf("const continueReady =") < src.search(/return \(\s*<ScormRuntime/),
    src.indexOf("const continueStatusHref =") < src.search(/return \(\s*<ScormRuntime/),
  ], [true, true, true]);
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
  eq("the wait ends only on a stored result whose verdict is not pending (officialResultStored), then done through officialDone with the course's pass_required",
    /if \(officialResultStored\(scoring, attempts, passRequired\)\) \{\s*stored = true;\s*done = officialDone\(scoring, passRequired\);\s*break;\s*\}/.test(src), true);
  eq("…officialResultStored imported from lib/learner/continue, the only conclude test in the loop; resultStored and verdictPending no longer called here", [
    /import \{[^}]*\bofficialResultStored\b[^}]*\} from "@\/lib\/learner\/continue";/.test(src),
    count(src, "officialResultStored("),
    count(src, "resultStored("),
    count(src, "verdictPending("),
  ], [true, 1, 0, 0]);
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

console.log("\nthe status route (ADR 0019, note of 2026-11-11)");
{
  const src = code(STATUS_ROUTE);
  eq("GET only, in the repository's handler form (params is a Promise)", [
    /export async function GET\(\s*_request: NextRequest,\s*\{ params \}: \{ params: Promise<\{ attemptId: string \}> \}\s*\)/.test(src),
    /export async function (POST|PUT|PATCH|DELETE)\b/.test(src),
  ], [true, false]);
  eq("the uuid check comes before any read", [
    /if \(!isUuid\(attemptId\)\) return answer\(\{\}, 404\);/.test(src),
    src.indexOf("isUuid(attemptId)") > -1 && src.indexOf("isUuid(attemptId)") < src.indexOf("createClient()") && src.indexOf("isUuid(attemptId)") < src.indexOf(".from("),
  ], [true, true]);
  eq("the caller's cookie client from lib/supabase/server; 401 without a user", [
    /import \{ createClient \} from "@\/lib\/supabase\/server";/.test(src),
    /if \(!user\) return answer\(\{ error: "unauthorized" \}, 401\);/.test(src),
  ], [true, true]);
  eq("no service role, no write, no RPC of its own", [
    src.includes("SUPABASE_SERVICE_ROLE_KEY"),
    src.includes("@supabase/supabase-js"),
    /\.(insert|update|upsert|delete)\(/.test(src),
    /\.rpc\(/.test(src),
  ], [false, false, false, false]);
  eq("the learner's own attempt: id and user_id, maybeSingle; an error is 503, no row is 404", [
    /\.from\("course_attempts"\)\s*\.select\("id, course_version_id, course_versions\(course_id\)"\)\s*\.eq\("id", attemptId\)\s*\.eq\("user_id", user\.id\)\s*\.maybeSingle\(\);\s*if \(ownErr\) return unreadable\(\);\s*if \(!own\) return answer\(\{\}, 404\);/.test(src),
    /if \(typeof courseId !== "string"\) return unreadable\(\);/.test(src),
  ], [true, true]);
  eq("the continue page's strict reads: pass_required, the versions, the grants, the attempts", [
    /\.from\("courses"\)\s*\.select\("pass_required"\)\s*\.eq\("id", courseId\)\s*\.maybeSingle\(\);\s*if \(courseErr \|\| !courseRow\) return unreadable\(\);/.test(src),
    /if \(verErr \|\| versionIds\.length === 0\) return unreadable\(\);/.test(src),
    /\.from\("attempt_requests"\)\s*\.select\("used_attempt_id"\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("course_id", courseId\)\s*\.eq\("status", "approved"\)\s*\.not\("used_attempt_id", "is", null\);\s*if \(grantErr\) return unreadable\(\);/.test(src),
    /const policy = await resolvePolicy\(supabase, courseId\);/.test(src),
    /readWithOptionalColumn<unknown\[\]>\(\s*"is_revision",[\s\S]*?\.eq\("user_id", user\.id\)\s*\.in\("course_version_id", versionIds\),\s*ATTEMPT_COLUMNS\s*\);\s*if \(rowsErr\) return unreadable\(\);/.test(src),
  ], [true, true, true, true, true]);
  eq("…never through the fail-soft helpers", [src.includes("fetchPassRequired("), src.includes("fetchGrantRetakeIds(")], [false, false]);
  eq("the answer: officialResultStored, once, over computeScoring of those rows", [
    count(src, "officialResultStored("),
    /const scoring = computeScoring\(attempts, policy, retakeIds\);\s*return answer\(\{ stored: officialResultStored\(scoring, attempts, passRequired\) \}, 200\);/.test(src),
  ], [1, true]);
  eq("every answer carries Cache-Control: no-store, through one helper", [
    /const NO_STORE = \{ "Cache-Control": "no-store" \};/.test(src),
    /NextResponse\.json\(body, \{ status, headers: NO_STORE \}\)/.test(src),
    count(src, "NextResponse.json("),
  ], [true, true, 1]);
  eq("a read error is 503 unreadable, logged with the attempt id only", [
    /return answer\(\{ error: "unreadable" \}, 503\);/.test(src),
    /console\.warn\(JSON\.stringify\(\{ event: "result_stored_unreadable", attempt_id: attemptId \}\)\);/.test(src),
    count(src, "console."),
  ], [true, true, 1]);
}

console.log("\nisKivoStamped, called directly");
eq("a string → true; null and an absent key → false", [isKivoStamped({ engineVersion: "2026.10.28" }), isKivoStamped({ engineVersion: null }), isKivoStamped({})], [true, false, false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
