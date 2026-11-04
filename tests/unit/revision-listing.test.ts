/**
 * Listing tests for ADR 0014 step 17, scoped to the files PR 1a touches:
 * reads the sources under app/, lib/ and components/, no database.
 *
 *   (i)   every computeScoring, attemptCounts, hasLiveGrantedRetake,
 *         latestResetRetake and officialHistory call site in the PR 1a files
 *         feeds the helper rows that carry `status` and `is_revision` (the
 *         narrower-select fallback for is_revision) or rows read with
 *         select("*"); every other file that calls them is on the dated
 *         PENDING_1B allow-list, which PR 1b empties (step 7 rewrites those
 *         surfaces), so a new caller cannot slip in unlisted;
 *   (ii)  both gamification_record_activity call sites carry the revision
 *         gate (`officialRun` starts with the row's flag);
 *   (iii) no `.delete()` touches course_attempts, xapi_statements, xp_events
 *         or revision_visits under app/, lib/ and components/.
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

const HELPERS = ["computeScoring", "attemptCounts", "hasLiveGrantedRetake", "latestResetRetake", "officialHistory"];
/** A call and its first argument: an identifier, or "…" for an expression such as `(rows ?? []) as …`. */
const callRe = new RegExp(`(?<!function\\s)\\b(${HELPERS.join("|")})\\(\\s*([A-Za-z_$][\\w$.]*|\\()`, "g");
const callsIn = (src: string) => [...src.matchAll(callRe)].map((m) => `${m[1]}(${m[2] === "(" ? "…" : m[2]})`);

/** The definitions (and the re-export module) are not call sites. */
const DEFINITIONS = ["lib/scoring/policy.ts", "lib/scoring/official-history.ts"];

/**
 * PR 1a's files, each call site and the read that feeds it. The
 * predicate is on the source: the columns constant names `status`, the
 * select adds `is_revision`, and a missing is_revision column retries without
 * it (isMissingColumn), or the rows are read with select("*").
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
    calls: ["computeScoring(attempts)"],
    feeds: [
      ["KIND_LIST_COLUMNS names status", /const KIND_LIST_COLUMNS = "[^"]*\bstatus\b[^"]*";/],
      ["the read adds is_revision with the fallback", /listFor\(`\$\{KIND_LIST_COLUMNS\}, is_revision`\);\s*if \(rowsErr && isMissingColumn\(rowsErr, "is_revision"\)\)/],
      ["computeScoring gets those rows", /const attempts = \(rows \?\? \[\]\) as ScorableAttempt\[\];[\s\S]*?computeScoring\(attempts, policy, retakeIds\)/],
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
    calls: ["computeScoring(attempts)", "latestResetRetake(attempts)"],
    feeds: [
      ["attempts are read with select(\"*\")", /\.from\("course_attempts"\)\s*\.select\("\*"\)\s*\.eq\("user_id", user\.id\)/],
      ["…into `attempts`", /const attempts = \(attemptsResp\.data \?\? \[\]\) as Attempt\[\];/],
    ],
  },
  // Touched by PR 1a, no scoring call: listed so a new one must be checked here.
  "app/api/xapi/statements/route.ts": { calls: [], feeds: [] },
  "app/api/scorm/[attemptId]/commit/route.ts": { calls: [], feeds: [] },
  "app/api/courses/[courseId]/language-preference/route.ts": { calls: [], feeds: [] },
};

/**
 * PENDING_1B (2026-10-29): the files PR 1a does not touch that call the
 * helpers. Their reads are step 7's (labels, counts, history, the CRM
 * fields); PR 1b brings each to the rule above and removes it from this list.
 */
const PENDING_1B = [
  "app/[org]/(admin)/analytics/page.tsx",
  "app/[org]/(admin)/attempt-requests/page.tsx",
  "app/[org]/(admin)/library/[courseId]/learners/page.tsx",
  "app/[org]/(admin)/reports/page.tsx",
  "app/[org]/(learner)/courses/page.tsx",
  "app/[org]/(learner)/dashboard/page.tsx",
  "app/[org]/(learner)/paths/[pathId]/page.tsx",
  "app/api/attempt-requests/bulk/route.ts",
  "app/api/attempt-requests/route.ts",
  "app/api/integrations/learner-summary/route.ts",
  "lib/attempts/grant.ts",
  "lib/integrations/progress.ts",
  "lib/manager/insights.ts",
  "lib/scoring/status.ts",
].sort();

console.log("\n(i) the scoring helpers' call sites in PR 1a's files read status and is_revision");
{
  for (const [file, spec] of Object.entries(SCOPED)) {
    const src = sources.get(file) ?? "";
    eq(`${file}: exists`, src.length > 0, true);
    eq(`${file}: its helper calls are exactly the listed ones`, callsIn(src).sort(), [...spec.calls].sort());
    for (const [what, re] of spec.feeds) eq(`${file}: ${what}`, re.test(src), true);
  }
  const callers = [...sources.entries()].filter(([f, s]) => !DEFINITIONS.includes(f) && callsIn(s).length > 0).map(([f]) => f).sort();
  const outside = callers.filter((f) => !(f in SCOPED));
  eq("every other caller is on the dated PENDING_1B allow-list, and the list names only callers", outside, PENDING_1B);
  eq("non-vacuous: the scan finds the PR 1a callers", callers.filter((f) => f in SCOPED).length >= 4, true);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
