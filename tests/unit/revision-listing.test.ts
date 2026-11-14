/**
 * Listing tests for ADR 0014 step 17 (PR 1a's scope, widened to every
 * file by PR 1b): reads the sources under app/, lib/ and
 * components/, no database.
 *
 *   (i)   every computeScoring, attemptCounts, hasLiveGrantedRetake,
 *         latestResetRetake, officialHistory and officialRetakeState call
 *         site feeds the helper rows that carry `status` and `is_revision`
 *         (the narrower-select fallback for is_revision) or rows read with
 *         select("*"), and a mapper between the select and the helper names
 *         `is_revision`; every caller is listed in SCOPED (PENDING_1B, PR 1a's
 *         dated allow-list, is empty since PR 1b), so a new caller cannot slip
 *         in unlisted; a paged read goes through readPagedWithOptionalColumn
 *         (the first page decides), and its every
 *         caller, grantSnapshotForUsers's paged grant read included, is
 *         listed;
 *   (ii)  both gamification_record_activity call sites carry the revision
 *         gate (`officialRun` starts with the row's flag);
 *   (iii) no `.delete()` touches course_attempts, xapi_statements, xp_events
 *         or revision_visits under app/, lib/ and components/;
 *   (iv)  every officialStatuses / loadEnrolledCourseStatus caller is listed,
 *         and a file that calls officialStatuses( reads its attempts with
 *         is_revision (the fallback) or select("*"); a file that only calls
 *         loadEnrolledCourseStatus( passes on the call, its select being
 *         checked once in lib/scoring/status.ts;
 *   (v)   the lib/lrs/context.ts reads behind the tenant-LRS markers select
 *         is_revision with the fallback (the two tiers);
 *   (vi)  every courseProgress( call under app/ and lib/ is listed, its file
 *         reads attempts with is_revision (the fallback) or select("*"), and
 *         only the per-course display calls pass a third argument (the
 *         retakeIds whitelist: the path and journey roll-ups stay
 *         retake-unaware, ADR 0014:195);
 *   (vii) ADR 0024 step 41, the allow-list guard: computeScoring is called by
 *         contextResult (lib/scoring/context.ts) only. Today's direct callers
 *         are named on the dated list PENDING_0024 (the form of ADR 0023
 *         step 3 and of PENDING_1B above); the scan's callers outside
 *         lib/scoring/context.ts must equal the list exactly, so a new direct
 *         caller fails here and a file that stops calling must leave the list.
 *         Each later pull request that moves its files onto contextResult
 *         removes them; the last one asserts the list empty. The list never
 *         holds more than its 20 files of 2026-11-14. Hardening H3 of the
 *         ADR's note of 2026-11-14: a call under another name is refused
 *         outside the allow-list (the rule's owner, the definition and
 *         PENDING_0024): an aliased import or re-export (`computeScoring
 *         as`), `computeScoring.bind`, `.call` or `.apply`, and a namespace,
 *         dynamic, star or require import of lib/scoring/policy or
 *         lib/scoring/status (status.ts re-exports it), whose member call
 *         the scan by name cannot see.
 *
 * Run:  npx tsx tests/unit/revision-listing.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["app", "lib", "components"];
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
}
const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(root, d), files);
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
/** Sources with line and block comments blanked (strings kept), so a comment naming a helper is not a call. */
const sources = new Map<string, string>(
  files.map((f) => {
    const raw = fs.readFileSync(f, "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    return [rel(f), code];
  })
);

const HELPERS = ["computeScoring", "attemptCounts", "hasLiveGrantedRetake", "latestResetRetake", "officialHistory", "officialRetakeState"];
/** A call and its first argument: an identifier, or "…" for an expression such as `(rows ?? []) as …`. */
const callRe = new RegExp(`(?<!function\\s)\\b(${HELPERS.join("|")})\\(\\s*([A-Za-z_$][\\w$.]*|\\()`, "g");
const callsIn = (src: string) => [...src.matchAll(callRe)].map((m) => `${m[1]}(${m[2] === "(" ? "…" : m[2]})`);

/** The definitions (and the re-export module) are not call sites. */
const DEFINITIONS = ["lib/scoring/policy.ts", "lib/scoring/official-history.ts", "lib/attempts/request-decision.ts"];

/**
 * The attempts read names `is_revision` through the narrower-select fallback
 * (readWithOptionalColumn("is_revision", …), or its paged form
 * readPagedWithOptionalColumn("is_revision", …) where the first page decides,
 * around a course_attempts select whose column list is the
 * argument), or the rows are read with select("*"). Used by blocks (iv) and
 * (vi), and by tests/unit/engagement-readers.test.ts's stronger predicate in
 * the same words.
 */
const FALLBACK_RE = /read(?:Paged)?WithOptionalColumn<[^>]*>\(\s*"is_revision",/;
const DYNAMIC_SELECT_RE = /\.from\(\s*"course_attempts"\s*\)\s*\.select\(\s*(?:columns|cols)\s*\)|fetchByIds<AttemptRow>\(\s*svc,\s*"course_attempts",\s*columns,/;
const STAR_SELECT_RE = /\.from\(\s*"course_attempts"\s*\)\s*\.select\(\s*"\*"\s*\)/;
const selectsFlag = (src: string) => (FALLBACK_RE.test(src) && DYNAMIC_SELECT_RE.test(src)) || STAR_SELECT_RE.test(src);

/** The two feeds every explicit-select file below carries: the constant names status; the fallback wraps it. */
const columnsFeeds = (name = "ATTEMPT_COLUMNS"): Array<[string, RegExp]> => [
  [`${name} names status`, new RegExp(`const ${name} =\\s*"[^"]*\\bstatus\\b[^"]*";`)],
  [`the read adds is_revision with the fallback over ${name}`, new RegExp(`read(?:Paged)?WithOptionalColumn<[^>]*>\\(\\s*"is_revision",[\\s\\S]*?\\b${name}\\s*[,)]`)],
  ["the course_attempts select takes the fallback's column list", DYNAMIC_SELECT_RE],
];
const STAR_FEED: [string, RegExp] = ["attempts are read with select(\"*\")", STAR_SELECT_RE];
const mapperFeed = (where: string, re: RegExp): [string, RegExp] => [`the mapper (${where}) carries is_revision`, re];
/** A paged read: readPagedWithOptionalColumn decides the column list on its first page, with the site's own options. */
const pagedFeed = (re: RegExp): [string, RegExp] => ["the first page decides the column list (readPagedWithOptionalColumn)", re];

/**
 * Every file that calls a helper, each call site and the read that feeds it.
 * The predicate is on the source: the columns constant names `status`, the
 * select adds `is_revision`, and a missing is_revision column retries without
 * it (readWithOptionalColumn / isMissingColumn), or the rows are read with
 * select("*"). The first seven entries are PR 1a's; the rest are
 * PR 1b's (the former PENDING_1B files, the PATCH route, and the
 * three learning-path surfaces with calls: []).
 */
const SCOPED: Record<string, { calls: string[]; feeds: Array<[string, RegExp]> }> = {
  "app/[org]/(learner)/courses/[courseId]/launch/page.tsx": {
    calls: ["computeScoring(my)"],
    feeds: [
      ["MY_COLUMNS names status", /const MY_COLUMNS = "[^"]*\bstatus\b[^"]*";/],
      ["the read adds is_revision with the fallback", /readMy\(`\$\{MY_COLUMNS\}, is_revision`\);\s*if \(myErr && isMissingColumn\(myErr, "is_revision"\)\) \(\{ data: myRows, error: myErr \} = await readMy\(MY_COLUMNS\)\);/],
      ["computeScoring gets those rows", /my = \(myRows \?\? \[\]\) as unknown as MyAttempt\[\];[\s\S]*?computeScoring\(my, policy, grantsNow\.retakeIds\)/],
    ],
  },
  "lib/scoring/attempt-kind.ts": {
    calls: ["computeScoring(attempts)", "computeScoring(attempts)"],
    feeds: [
      // officialFailedAttemptId, the attempt page's read of ADR 0017 step 15.
      ["the attempt page's read adds is_revision with the fallback", /readWithOptionalColumn<ScorableAttempt\[\]>\(\s*"is_revision",[\s\S]*?KIND_LIST_COLUMNS\s*\);\s*if \(attemptsErr/],
      ["…and computeScoring gets those rows", /if \(attemptsErr \|\| !attempts\?\.length\) return null;[\s\S]*?computeScoring\(attempts, DEFAULT_POLICY, retakeIds\)/],
      ["KIND_LIST_COLUMNS names status", /const KIND_LIST_COLUMNS = "[^"]*\bstatus\b[^"]*";/],
      ["the read adds is_revision with the fallback", /listFor\(`\$\{KIND_LIST_COLUMNS\}, is_revision`\);\s*if \(rowsErr && isMissingColumn\(rowsErr, "is_revision"\)\)/],
      ["computeScoring gets those rows", /const attempts = \(rows \?\? \[\]\) as ScorableAttempt\[\];[\s\S]*?computeScoring\(attempts, policy, retakeIds\)/],
      // The paged grant reader: grantSnapshotForUsers reads
      // reissued_from through the paged fallback, in id order, one decision for
      // every chunk, an empty answer an error; no unpaged chunk read is left.
      ["the paged grant reader: grantSnapshotForUsers pages every chunk in id order through readPagedWithOptionalColumn",
        /const decided: OptionalColumnState = \{ columns: null \};[\s\S]{0,300}?readPagedWithOptionalColumn<GrantPairRow>\(\s*"reissued_from",\s*\(columns, from, to\) => \{\s*const q = svc\.from\("attempt_requests"\)\.select\(columns\)[^;]*;\s*return \(inQuery \? q\.in\("course_id", inQuery\) : q\)\.order\("id"\)\.range\(from, to\);\s*\},\s*`\$\{GRANT_COLUMNS\}, user_id, course_id`,\s*\{ state: decided, nullIsError: true \}\s*\);/],
    ],
  },
  "lib/attempts/force-restart.ts": {
    calls: ["computeScoring(attempts)"],
    feeds: [
      ["ATTEMPT_RESULT_COLUMNS names status", /const ATTEMPT_RESULT_COLUMNS = "[^"]*\bstatus\b[^"]*";/],
      ["the read adds is_revision with the fallback", /read\(`\$\{ATTEMPT_RESULT_COLUMNS\}, is_revision`\);\s*if \(rowsErr && isMissingColumn\(rowsErr, "is_revision"\)\)/],
      ["computeScoring gets those rows", /attempts = rows as unknown as ScorableAttempt\[\];[\s\S]*?computeScoring\(attempts, DEFAULT_POLICY, snapshot\.retakeIds\)/],
    ],
  },
  "app/[org]/(learner)/courses/[courseId]/page.tsx": {
    calls: ["computeScoring(attempts)", "hasLiveGrantedRetake(attempts)", "latestResetRetake(attempts)", "officialHistory(attempts)", "officialRetakeState(history)"],
    feeds: [
      ["attempts are read with select(\"*\")", /\.from\("course_attempts"\)\s*\.select\("\*"\)\s*\.eq\("user_id", user\.id\)/],
      ["…into `attempts`", /const attempts = \(attemptsResp\.data \?\? \[\]\) as Attempt\[\];/],
    ],
  },
  // Touched by PR 1a, no scoring call: listed so a new one must be checked here.
  "app/api/xapi/statements/route.ts": { calls: [], feeds: [] },
  "app/api/scorm/[attemptId]/commit/route.ts": { calls: [], feeds: [] },
  "app/api/courses/[courseId]/language-preference/route.ts": { calls: [], feeds: [] },

  // ---- PR 1b ----
  "app/[org]/(admin)/analytics/page.tsx": {
    calls: ["attemptCounts(my)", "computeScoring(list.map)", "computeScoring(list.map)", "hasLiveGrantedRetake(lensRows)", "hasLiveGrantedRetake(list)"],
    feeds: [
      ...columnsFeeds(),
      mapperFeed("toScorable", /const toScorable = \(a: AttemptRow\) => \(\{[^}]*\bis_revision: a\.is_revision \?\? null,/),
      ["computeScoring gets the mapped rows", /computeScoring\(\s*list\.map\(toScorable\)/],
    ],
  },
  "app/[org]/(admin)/attempt-requests/page.tsx": {
    calls: ["computeScoring(list)", "officialHistory(list)"],
    // An answer with neither rows nor an error is an error here too.
    feeds: [...columnsFeeds(), pagedFeed(/readPagedWithOptionalColumn<Row>\(\s*"is_revision",[\s\S]{0,600}?\.order\("id"\)\s*\.range\(from, to\)[\s\S]{0,200}?ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\)/)],
  },
  "app/[org]/(admin)/library/[courseId]/learners/page.tsx": {
    calls: ["attemptCounts(myAttempts)", "computeScoring(myAttempts)", "officialHistory(myAttempts)", "officialRetakeState(history)"],
    // ADR 0020: the enrolled set in chunks of 150, one decision for every chunk.
    feeds: [...columnsFeeds(), pagedFeed(/const decided: OptionalColumnState = \{ columns: null \};[\s\S]{0,300}?readPagedWithOptionalColumn<unknown>\(\s*"is_revision",[\s\S]{0,600}?ATTEMPT_COLUMNS,\s*\{ state: decided \}\s*\)/)],
  },
  "app/[org]/(admin)/reports/page.tsx": {
    calls: ["attemptCounts(attempts)", "attemptCounts(myAttempts)", "attemptCounts(teamAttempts)"],
    // The pages are taken in id order, so they are disjoint.
    feeds: [...columnsFeeds(), pagedFeed(/readPagedWithOptionalColumn<unknown>\(\s*"is_revision",[\s\S]{0,600}?\.order\("id"\)\s*\.range\(f, t\)[\s\S]{0,200}?ATTEMPT_COLUMNS,\s*\{ maxPages: 500 \}\s*\)/)],
  },
  "app/[org]/(learner)/courses/page.tsx": {
    calls: ["computeScoring(my)", "hasLiveGrantedRetake(my)"],
    feeds: [STAR_FEED],
  },
  "app/[org]/(learner)/dashboard/page.tsx": {
    calls: ["computeScoring(list)", "computeScoring(my)", "hasLiveGrantedRetake(my)"],
    feeds: [STAR_FEED],
  },
  "app/[org]/(learner)/paths/[pathId]/page.tsx": {
    calls: ["computeScoring(list)", "computeScoring(list)"],
    feeds: [
      ["the explicit select names status and adds is_revision with the fallback", /readWithOptionalColumn<unknown\[\]>\(\s*"is_revision",[\s\S]*?\.from\("course_attempts"\)\s*\.select\(columns\)[\s\S]*?"id, course_version_id, status, [^"]*"\s*\)/],
    ],
  },
  "app/api/attempt-requests/[id]/route.ts": {
    calls: ["computeScoring(attempts)"],
    feeds: columnsFeeds(),
  },
  "app/api/attempt-requests/bulk/route.ts": {
    calls: ["computeScoring(list)"],
    feeds: [...columnsFeeds(), pagedFeed(/readPagedWithOptionalColumn<Att>\(\s*"is_revision",[\s\S]{0,600}?ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\)/)],
  },
  "app/api/attempt-requests/route.ts": {
    calls: ["computeScoring(attempts)"],
    feeds: columnsFeeds(),
  },
  "app/api/courses/[courseId]/learners/export/route.ts": {
    calls: ["officialHistory(attempts.filter)", "officialRetakeState(history)"],
    // ADR 0020: the enrolled set in chunks of 150, one decision for every chunk.
    feeds: [...columnsFeeds(), pagedFeed(/const decided: OptionalColumnState = \{ columns: null \};[\s\S]{0,300}?readPagedWithOptionalColumn<unknown>\(\s*"is_revision",[\s\S]{0,600}?ATTEMPT_COLUMNS,\s*\{ state: decided \}\s*\)/)],
  },
  "app/api/integrations/learner-summary/route.ts": {
    calls: ["computeScoring(st.list)", "hasLiveGrantedRetake(st.list)", "officialHistory(st.list)", "officialRetakeState(history)"],
    feeds: [
      STAR_FEED,
      mapperFeed("the row push", /row\.list\.push\(\{[^}]*\bstatus: a\.status \?\? null,\s*is_revision: a\.is_revision \?\? null,/),
    ],
  },
  "lib/attempts/grant.ts": {
    calls: ["computeScoring(mine)", "hasLiveGrantedRetake(mine)"],
    feeds: [...columnsFeeds(), pagedFeed(/readPagedWithOptionalColumn<Att>\(\s*"is_revision",[\s\S]{0,600}?ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\)/)],
  },
  "lib/integrations/progress.ts": {
    calls: ["computeScoring(st.list)", "hasLiveGrantedRetake(st.list)", "officialHistory(st.list)", "officialRetakeState(history)"],
    feeds: [
      ["attempts are read with select(\"*\")", /\.from\("course_attempts"\)\s*\.select\("\*"\)/],
      mapperFeed("the row push", /row\.list\.push\(\{[^}]*\bstatus: a\.status \?\? null, is_revision: a\.is_revision \?\? null \}\)/),
    ],
  },
  "lib/manager/insights.ts": {
    calls: ["attemptCounts(list)", "computeScoring(scorable)", "officialHistory(scorable)", "officialRetakeState(history)"],
    feeds: [
      ...columnsFeeds(),
      pagedFeed(/const decided: OptionalColumnState = \{ columns: null \};[\s\S]{0,300}?readPagedWithOptionalColumn<unknown>\(\s*"is_revision",[\s\S]{0,600}?ATTEMPT_COLUMNS,\s*\{ state: decided \}\s*\)/),
      mapperFeed("toScorable", /const toScorable = \(a: AttemptRow\) => \(\{[^}]*\bis_revision: a\.is_revision \?\? null,/),
      ["computeScoring gets the mapped rows", /const scorable = list\.map\(toScorable\);\s*const scoring = computeScoring\(scorable,/],
    ],
  },
  "lib/scoring/status.ts": {
    // officialStatuses takes rows from its callers (block (iv) checks them);
    // loadEnrolledCourseStatus's own select is the one checked here.
    calls: ["computeScoring(list)"],
    feeds: [...columnsFeeds(), pagedFeed(/const decided: OptionalColumnState = \{ columns: null \};[\s\S]{0,600}?readPagedWithOptionalColumn<unknown>\(\s*"is_revision",[\s\S]{0,600}?ATTEMPT_COLUMNS,\s*\{ pageSize: PAGE, state: decided \}\s*\)/)],
  },
  // ADR 0024 step 41: the official rule per context. A pure function: its
  // rows come typed, and the type makes status and is_revision required, so
  // no caller can hand it rows without them; abandoned and revision rows are
  // dropped before computeScoring sees them. Its strict reader is
  // lib/scoring/context-read.ts (below). Step 41's allow-list turn-around
  // (contextResult as the only caller) is block (vii).
  "lib/scoring/context.ts": {
    calls: ["computeScoring(officialRows)", "hasLiveGrantedRetake(officialRows)"],
    feeds: [
      ["ContextAttempt requires status", /export type ContextAttempt = \{[^}]*\n\s*status: "in_progress" \| "completed" \| "failed" \| "passed" \| "abandoned";/],
      ["ContextAttempt requires is_revision", /export type ContextAttempt = \{[^}]*\n\s*is_revision: boolean;/],
      ["officialRows drop abandoned and revision rows", /const officialRows = rows\.filter\(\s*\(a\) => !isAbandonedAttempt\(a\) && !isRevisionAttempt\(a\)/],
      ["computeScoring gets officialRows", /computeScoring\(officialRows, i\.policy, retakeIds\)/],
    ],
  },
  // ADR 0024 step 41: the strict reader of contextResult; no helper call of
  // its own, and its select carries the two columns the rule reads.
  "lib/scoring/context-read.ts": {
    calls: [],
    feeds: [
      ["CONTEXT_ATTEMPT_COLUMNS names status", /export const CONTEXT_ATTEMPT_COLUMNS =\s*"[^"]*\bstatus\b[^"]*";/],
      ["the read adds is_revision, and leaves it out only on a 42703 naming it",
        /read\(`\$\{CONTEXT_ATTEMPT_COLUMNS\}, is_revision, \$\{CONTEXT_SELECT\}`, true\)[\s\S]*?if \(res\.error && isMissingColumn\(res\.error, "is_revision"\)\) res = await read\(CONTEXT_ATTEMPT_COLUMNS, false\);/],
      ["the course_attempts select takes the column list", /\.from\("course_attempts"\)\.select\(columns\)/],
    ],
  },
  // ADR 0019: the continue address scores the learner's own attempts on the course it waits on.
  "app/[org]/(learner)/continue/page.tsx": {
    calls: ["computeScoring(attempts)"],
    feeds: columnsFeeds(),
  },
  // ADR 0019, note of 2026-11-11: the bar's status route scores the same reads as the continue address.
  "app/api/attempts/[attemptId]/result-stored/route.ts": {
    calls: ["computeScoring(attempts)"],
    feeds: columnsFeeds(),
  },
  // The learning-path surfaces: no helper call; their selects carry the flag.
  "app/[org]/(admin)/learning-paths/[pathId]/learners/page.tsx": { calls: [], feeds: columnsFeeds() },
  "app/[org]/(admin)/learning-paths/[pathId]/reports/page.tsx": {
    calls: [],
    feeds: [...columnsFeeds("PATH_ATTEMPT_COLUMNS"), ...columnsFeeds("ALL_ATTEMPT_COLUMNS").slice(0, 2)],
  },
  "app/api/learning-paths/[id]/learners/export/route.ts": { calls: [], feeds: columnsFeeds() },
};

/**
 * PENDING_1B (2026-10-29): the files PR 1a did not touch that called the
 * helpers. PR 1b brought each to the rule above and listed it in SCOPED,
 * so the list is empty and stays empty.
 */
const PENDING_1B: string[] = [];

console.log("\n(i) every scoring helper's call site reads status and is_revision");
{
  for (const [file, spec] of Object.entries(SCOPED)) {
    const src = sources.get(file) ?? "";
    eq(`${file}: exists`, src.length > 0, true);
    eq(`${file}: its helper calls are exactly the listed ones`, callsIn(src).sort(), [...spec.calls].sort());
    for (const [what, re] of spec.feeds) eq(`${file}: ${what}`, re.test(src), true);
  }
  const callers = [...sources.entries()].filter(([f, s]) => !DEFINITIONS.includes(f) && callsIn(s).length > 0).map(([f]) => f).sort();
  const outside = callers.filter((f) => !(f in SCOPED));
  eq("every caller is in SCOPED: PENDING_1B is empty (PR 1b)", outside, PENDING_1B);
  eq("PENDING_1B is the empty list", PENDING_1B, []);
  eq("non-vacuous: the scan finds the listed callers", callers.filter((f) => f in SCOPED).length >= 20, true);
  // The paged fallback's callers are listed too (the eight paged
  // attempts reads and attempt-kind.ts's paged grant reader), each in SCOPED
  // with its pagedFeed, so a new paged read cannot slip in unlisted.
  const PAGED_CALLERS = [
    "app/[org]/(admin)/attempt-requests/page.tsx",
    "app/[org]/(admin)/library/[courseId]/learners/page.tsx",
    "app/[org]/(admin)/reports/page.tsx",
    "app/api/attempt-requests/bulk/route.ts",
    "app/api/courses/[courseId]/learners/export/route.ts",
    "lib/attempts/grant.ts",
    "lib/manager/insights.ts",
    "lib/scoring/attempt-kind.ts",
    "lib/scoring/status.ts",
  ];
  const paged = [...sources.entries()].filter(([, s]) => /(?<!function\s)\breadPagedWithOptionalColumn</.test(s)).map(([f]) => f).sort();
  eq("every readPagedWithOptionalColumn caller is listed: the eight paged attempts reads and the paged grant reader", paged, [...PAGED_CALLERS].sort());
  eq("…each is in SCOPED", PAGED_CALLERS.every((f) => f in SCOPED), true);
}

console.log("\n(ii) both gamification_record_activity call sites carry the revision gate");
{
  const sites = [...sources.entries()].filter(([, s]) => /\.rpc\(\s*"gamification_record_activity"/.test(s)).map(([f]) => f).sort();
  eq("exactly two call sites: the SCORM commit and the xAPI statements route", sites, ["app/api/scorm/[attemptId]/commit/route.ts", "app/api/xapi/statements/route.ts"].sort());
  const GATES: Record<string, RegExp> = {
    "app/api/xapi/statements/route.ts": /const officialRun = !isRevision && \(!nowComplete \|\| !kind \|\| kind\.official\);/,
    "app/api/scorm/[attemptId]/commit/route.ts": /const officialRun = a\.is_revision !== true && \(!nowComplete \|\| !kind \|\| kind\.official\);/,
  };
  for (const f of sites) {
    const src = sources.get(f) ?? "";
    eq(`${f}: officialRun starts with the row's revision flag`, GATES[f]?.test(src) ?? false, true);
    const at = src.search(/\.rpc\(\s*"gamification_record_activity"/);
    const gate = src.lastIndexOf("if (officialRun) {", at);
    eq(`${f}: the RPC sits under if (officialRun)`, gate > 0 && gate > src.indexOf("const officialRun ="), true);
  }
  eq("the statements route reads isRevision from the bound row, never from the token",
    /const isRevision = row\.is_revision === true;/.test(sources.get("app/api/xapi/statements/route.ts") ?? ""), true);
}

console.log("\n(iii) no .delete() on attempt rows, statements, XP events or revision visits");
{
  const tables = ["course_attempts", "xapi_statements", "xp_events", "revision_visits"];
  const hits: string[] = [];
  for (const [file, src] of sources) {
    for (const t of tables) {
      const re = new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]\\s*\\)`, "g");
      for (const m of src.matchAll(re)) {
        // the chain up to the statement's end
        let depth = 0;
        let i = (m.index ?? 0) + m[0].length;
        for (; i < src.length; i++) {
          const ch = src[i];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") {
            if (depth === 0) break;
            depth--;
          } else if (ch === ";" && depth === 0) break;
        }
        if (/\.delete\(/.test(src.slice((m.index ?? 0) + m[0].length, i))) hits.push(`${file}: ${t}`);
      }
    }
  }
  eq("no delete under app/, lib/, components/", hits, []);
  eq("non-vacuous: those tables are read and written here", [...sources.values()].filter((s) => /\.from\("course_attempts"\)/.test(s)).length > 10, true);
}

console.log("\n(iv) the officialStatuses / loadEnrolledCourseStatus callers read is_revision");
{
  /** "rows": the file passes its own attempts to officialStatuses; "call": it only calls loadEnrolledCourseStatus. */
  const OFFICIAL_STATUS_CALLERS: Record<string, "rows" | "call"> = {
    "app/api/courses/[courseId]/learners/export/route.ts": "rows",
    "app/[org]/(admin)/reports/page.tsx": "rows",
    "app/[org]/(admin)/library/[courseId]/page.tsx": "call",
    "app/[org]/(admin)/library/[courseId]/reports/page.tsx": "call",
    "app/[org]/(admin)/learning-paths/[pathId]/learners/page.tsx": "rows",
    "app/[org]/(admin)/learning-paths/[pathId]/reports/page.tsx": "rows",
    "app/api/learning-paths/[id]/learners/export/route.ts": "rows",
    "lib/scoring/status.ts": "rows",
  };
  const callerRe = /(?<!function\s)\b(officialStatuses|loadEnrolledCourseStatus)\(/g;
  const callersOf = [...sources.entries()].filter(([, s]) => [...s.matchAll(callerRe)].length > 0).map(([f]) => f).sort();
  eq("every caller is in the hand list, and the list names only callers", callersOf, Object.keys(OFFICIAL_STATUS_CALLERS).sort());
  for (const [file, kind] of Object.entries(OFFICIAL_STATUS_CALLERS)) {
    const src = sources.get(file) ?? "";
    const callsOS = /(?<!function\s)\bofficialStatuses\(/.test(src);
    const callsLE = /(?<!function\s)\bloadEnrolledCourseStatus\(/.test(src);
    if (kind === "rows") {
      eq(`${file}: calls officialStatuses(`, callsOS, true);
      eq(`${file}: its attempts select names is_revision with the fallback, or is select("*")`, selectsFlag(src), true);
    } else {
      eq(`${file}: only calls loadEnrolledCourseStatus( (its select is status.ts's)`, [callsOS, callsLE], [false, true]);
    }
  }
  eq("the course CSV is the one strict officialStatuses caller: it injects { grants: }",
    /officialStatuses\(\s*svc,\s*org\.id,[\s\S]*?\{\s*grants:\s*retakeIdsByPair\s*\}\s*\)/.test(sources.get("app/api/courses/[courseId]/learners/export/route.ts") ?? ""), true);
  const injectors = [...sources.entries()].filter(([f, s]) => f !== "lib/scoring/status.ts" && /officialStatuses\([^;]*\{\s*grants:/.test(s)).map(([f]) => f);
  eq("…and no other caller injects grants", injectors, ["app/api/courses/[courseId]/learners/export/route.ts"]);
}

console.log("\n(v) the lib/lrs/context.ts reads behind the markers select is_revision with the fallback");
{
  const src = sources.get("lib/lrs/context.ts") ?? "";
  eq("the first tier names is_revision through readOrMissing",
    /const flagged = await readOrMissing<Row\[\]>\(\s*svc\s*\.from\("course_attempts"\)\s*\.select\(\s*"[^"]*\bstatus, is_revision, "/.test(src), true);
  eq("…and a failed first tier throws ContextReadError (only a missing column falls back)",
    /if \("failed" in flagged\) throw new ContextReadError\("attempts"\);/.test(src), true);
  eq("the siblings tier names is_revision and filters is_revision = false through readOrMissing",
    /readOrMissing<Row\[\]>\(\s*svc\s*\.from\("course_attempts"\)\s*\.select\("[^"]*\bis_revision\b[^"]*"\)[\s\S]*?\.eq\("is_revision", false\),\s*"is_revision"\s*\)/.test(src), true);
  eq("…and a failed siblings tier throws ContextReadError",
    /if \("failed" in flagged\) throw new ContextReadError\("siblings"\);/.test(src), true);
  eq("readOrMissing answers missing only on isMissingColumn",
    /async function readOrMissing<T>\([\s\S]*?isMissingColumn\([^)]*column\)[\s\S]*?\{ missing: true \}/.test(src), true);
}

console.log("\n(vi) the courseProgress feeds and the retakeIds whitelist");
{
  /** The top-level arguments of the call that opens at `open` (the index of its "("). */
  function argsAt(src: string, open: number): string[] {
    const out: string[] = [];
    let depth = 0, start = open + 1, quote: string | null = null;
    for (let i = open + 1; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) { out.push(src.slice(start, i).trim()); break; }
        depth--;
      } else if (ch === "," && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1; }
    }
    return out.filter((a) => a.length > 0);
  }
  const norm = (s: string) => s.replace(/\s+/g, " ");
  /**
   * Every courseProgress( call: the file, its first argument and its arity.
   * Arity 3 is the per-course display whitelist ({ retakeIds }); arity 2 the
   * roll-up feeds, which a running retake never takes a step from.
   */
  const EXPECTED = [
    "app/[org]/(learner)/courses/[courseId]/page.tsx :: attempts :: 3",
    "app/[org]/(admin)/library/[courseId]/learners/page.tsx :: myAttempts :: 3",
    "app/api/courses/[courseId]/learners/export/route.ts :: myAttempts :: 3",
    "lib/manager/insights.ts :: list :: 3",
    "app/[org]/(admin)/analytics/page.tsx :: list :: 3",
    "app/[org]/(admin)/analytics/page.tsx :: lensRows :: 3",
    "app/[org]/(admin)/analytics/page.tsx :: attemptsOfCourse.get(cid) ?? [] :: 2",
    "app/api/learning-paths/[id]/learners/export/route.ts :: myAttempts.filter((a) => courseByVersion.get(a.course_version_id) === s.course_id) :: 2",
    "app/[org]/(admin)/journey-admin/page.tsx :: byUserCourse.get(`${e.user_id}|${m.courseId}`) ?? [] :: 2",
    "app/[org]/(admin)/learning-paths/page.tsx :: attemptsByUserCourse.get(`${uid}|${s.course_id}`) ?? [] :: 2",
  ].sort();
  const got: string[] = [];
  const thirdArgs: string[] = [];
  for (const [file, src] of sources) {
    if (!file.startsWith("app/") && !file.startsWith("lib/")) continue;
    for (const m of src.matchAll(/(?<!function\s)\bcourseProgress\(/g)) {
      const args = argsAt(src, (m.index ?? 0) + m[0].length - 1);
      got.push(`${file} :: ${norm(args[0] ?? "")} :: ${args.length}`);
      if (args.length >= 3) thirdArgs.push(`${file} :: ${norm(args[2])}`);
    }
  }
  eq("every courseProgress( call under app/ and lib/ is the hand list (file, first argument, arity)", got.sort(), EXPECTED);
  eq("every third argument is a retakeIds option", thirdArgs.length === 6 && thirdArgs.every((a) => /^.* :: \{ retakeIds(: [^{}]+)? \}$/.test(a)), true);
  const listedFiles = [...new Set(EXPECTED.map((e) => e.split(" :: ")[0]))];
  for (const f of listedFiles) eq(`${f}: its attempts select names is_revision with the fallback, or is select("*")`, selectsFlag(sources.get(f) ?? ""), true);
  const analytics = sources.get("app/[org]/(admin)/analytics/page.tsx") ?? "";
  eq("analytics: progressOf passes no retakeIds (the path and journey roll-ups)",
    /const progressOf = \(cid: string\): CourseProgressView =>\s*courseProgress\(attemptsOfCourse\.get\(cid\) \?\? \[\], unitCountByVersion\);/.test(analytics), true);
  eq("the path learners export's per-step progress passes no retakeIds",
    /courseProgress\(\s*myAttempts\.filter\(\(a\) => courseByVersion\.get\(a\.course_version_id\) === s\.course_id\),\s*unitCountByVersion\s*\)/.test(sources.get("app/api/learning-paths/[id]/learners/export/route.ts") ?? ""), true);
}

/**
 * PENDING_0024 (2026-11-14, ADR 0024 phase 1): every file that calls
 * computeScoring directly today, besides its definition
 * (lib/scoring/policy.ts) and contextResult (lib/scoring/context.ts), the one
 * caller step 41 keeps. The phases that move these surfaces onto
 * contextResult (and its strict reader, readContextResult) remove their files
 * from this list in the same pull request; the last of them asserts it empty.
 * A file is never added.
 */
const PENDING_0024: string[] = [
  "app/[org]/(admin)/analytics/page.tsx",
  "app/[org]/(admin)/attempt-requests/page.tsx",
  "app/[org]/(admin)/library/[courseId]/learners/page.tsx",
  "app/[org]/(learner)/continue/page.tsx",
  "app/[org]/(learner)/courses/[courseId]/launch/page.tsx",
  "app/[org]/(learner)/courses/[courseId]/page.tsx",
  "app/[org]/(learner)/courses/page.tsx",
  "app/[org]/(learner)/dashboard/page.tsx",
  "app/[org]/(learner)/paths/[pathId]/page.tsx",
  "app/api/attempt-requests/[id]/route.ts",
  "app/api/attempt-requests/bulk/route.ts",
  "app/api/attempt-requests/route.ts",
  "app/api/attempts/[attemptId]/result-stored/route.ts",
  "app/api/integrations/learner-summary/route.ts",
  "lib/attempts/force-restart.ts",
  "lib/attempts/grant.ts",
  "lib/integrations/progress.ts",
  "lib/manager/insights.ts",
  "lib/scoring/attempt-kind.ts",
  "lib/scoring/status.ts",
];

console.log("\n(vii) ADR 0024 step 41: computeScoring is called by contextResult only; today's direct callers are on PENDING_0024");
{
  /** A call of computeScoring (not its definition, an import, a re-export or a mention in a string). */
  const directCall = /(?<!function\s)(?<![\w$.'"`])computeScoring\s*\(/;
  const RULE_OWNER = "lib/scoring/context.ts";
  const DEFINITION = "lib/scoring/policy.ts";
  const callers = [...sources.entries()].filter(([f, s]) => f !== DEFINITION && directCall.test(s)).map(([f]) => f).sort();
  eq("contextResult (lib/scoring/context.ts) calls computeScoring", callers.includes(RULE_OWNER), true);
  eq("every other direct caller is on PENDING_0024, and the list names only direct callers",
    callers.filter((f) => f !== RULE_OWNER), [...PENDING_0024].sort());
  eq("PENDING_0024 has no duplicate and never names the rule's owner or the definition",
    [new Set(PENDING_0024).size === PENDING_0024.length, PENDING_0024.includes(RULE_OWNER), PENDING_0024.includes(DEFINITION)], [true, false, false]);
  eq("PENDING_0024 never grows: at most its 20 files of 2026-11-14", PENDING_0024.length <= 20, true);

  // H3 (the ADR's note of 2026-11-14): the forms that call computeScoring
  // under another name, which the scan by name above cannot see, are refused
  // outside the allow-list.
  const ALLOWED = new Set([RULE_OWNER, DEFINITION, ...PENDING_0024]);
  const SCORING_MODULES = ["lib/scoring/policy", "lib/scoring/status"];
  /** A module specifier as a repository path without its extension, or null for a package. */
  const resolveSpec = (file: string, spec: string): string | null => {
    let p: string;
    if (spec.startsWith("@/")) p = spec.slice(2);
    else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    else return null;
    return p.replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
  };
  /** Every form in a file's code (comments blanked) that can call computeScoring under another name. */
  const indirectForms = (file: string, src: string): string[] => {
    const found: string[] = [];
    if (/\bcomputeScoring\s+as\s+[A-Za-z_$]/.test(src)) found.push("computeScoring as");
    if (/(?<![\w$.'"`])computeScoring\s*\.\s*(?:bind|call|apply)\b/.test(src)) found.push("computeScoring.bind/call/apply");
    for (const m of src.matchAll(/\bimport\s+\*\s+as\s+[\w$]+\s+from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bexport\s+\*\s+(?:as\s+[\w$]+\s+)?from\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = resolveSpec(file, m[1] ?? m[2] ?? m[3] ?? m[4]);
      if (target && SCORING_MODULES.includes(target)) found.push(`the whole of ${target}`);
    }
    return found;
  };
  const indirect = [...sources.entries()]
    .filter(([f]) => !ALLOWED.has(f))
    .flatMap(([f, src]) => indirectForms(f, src).map((x) => `${f}: ${x}`))
    .sort();
  eq("no file outside the allow-list aliases computeScoring, binds it, or imports lib/scoring/policy or lib/scoring/status whole",
    indirect, []);
  eq("control: each indirect form is found, and a named import is not one",
    [
      indirectForms("lib/x.ts", 'import { computeScoring as cs } from "@/lib/scoring/policy";'),
      indirectForms("lib/x.ts", 'export { computeScoring as score } from "./scoring/status";'),
      indirectForms("lib/x.ts", "const f = computeScoring.bind(null, rows);"),
      indirectForms("lib/x.ts", "computeScoring.call(undefined, rows, policy);"),
      indirectForms("app/x/page.tsx", 'import * as policy from "@/lib/scoring/policy";'),
      indirectForms("lib/scoring/x.ts", 'import * as st from "./status";'),
      indirectForms("lib/x.ts", 'const m = await import("@/lib/scoring/status");'),
      indirectForms("lib/x.ts", 'export * from "@/lib/scoring/policy";'),
      indirectForms("lib/x.ts", 'const p = require("../lib/scoring/policy");'),
      indirectForms("lib/x.ts", 'import { computeScoring } from "@/lib/scoring/policy";'),
      indirectForms("lib/x.ts", 'import * as other from "@/lib/scoring/context";'),
    ],
    [
      ["computeScoring as"], ["computeScoring as"], ["computeScoring.bind/call/apply"], ["computeScoring.bind/call/apply"],
      ["the whole of lib/scoring/policy"], ["the whole of lib/scoring/status"], ["the whole of lib/scoring/status"],
      ["the whole of lib/scoring/policy"], ["the whole of lib/scoring/policy"], [], [],
    ]);
  // The scan agrees with block (i)'s own reading of the call sites, so the
  // two cannot drift: block (i)'s callsIn sees a computeScoring call in
  // exactly the files above.
  const viaCallsIn = [...sources.entries()]
    .filter(([f, s]) => f !== DEFINITION && callsIn(s).some((c) => c.startsWith("computeScoring(")))
    .map(([f]) => f)
    .sort();
  eq("block (i)'s callsIn finds the same computeScoring callers", viaCallsIn, callers);
  // The control: a direct call is found, and the definition, an import and a
  // re-export are not calls.
  eq("control: the pattern finds a call and skips the definition, an import and a re-export",
    [
      directCall.test("const s = computeScoring(rows, policy, ids);"),
      directCall.test("export function computeScoring(attempts: A[]) {"),
      directCall.test('import { computeScoring } from "./policy";'),
      directCall.test("export { attemptCounts, computeScoring, courseStatus };"),
    ],
    [true, false, false, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
