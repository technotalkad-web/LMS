/**
 * The engagement readers of ADR 0014 step 12 (step 17's "engagement-reader
 * fixture" and its listing of every fold into a last-active, last-access or
 * last-touched value under app/ and lib/). No database.
 *
 *   (a) the fixture: one learner, an official attempt completed on day 0, a
 *       flagged revision row active on day 14 and an abandoned row on day 7.
 *       The pure folds the readers are built from (excludeAbandoned,
 *       attemptCounts, isRevisionAttempt, courseProgress, maxIso, daysAgo)
 *       answer day 0 (day 7 for the engagement value, which keeps a reset
 *       attempt), never day 14; they count one attempt and take no progress
 *       from the revision row;
 *   (b) a source scan: every `last_activity_at ?? … completed_at ?? …
 *       started_at` chain, every `completed_at ?? started_at` fold, every
 *       `maxIso(` and every "open / in-progress row" test under app/ and
 *       lib/ is in the hand list below. Each engagement fold and each pick
 *       sits behind a guard that tests isRevisionAttempt( (or a flag local
 *       from it), excludeAbandoned( or `is_revision !== true`; a fold guarded
 *       only by excludeAbandoned( passes only when its file reads the
 *       attempts with is_revision (the fallback) or select("*") (the stronger
 *       predicate); the rest are classified with the reason
 *       they are not an attempt-row engagement fold. The scan fails on an
 *       unlisted line, so a new reader cannot slip in.
 *
 * Run:  npx tsx tests/unit/engagement-readers.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { attemptCounts, excludeAbandoned, isRevisionAttempt } from "../../lib/scoring/policy";
import { courseProgress } from "../../lib/courses/progress-view";
import { daysAgo, maxIso, DAY } from "../../lib/manager/derive";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\n(a) the engagement-reader fixture: the pure folds answer day 0");
{
  const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * DAY).toISOString();
  type Row = {
    id: string; course_version_id: string; status: string | null; is_revision: boolean | null;
    completion_status: string; success_status: string; score: number | null;
    started_at: string; completed_at: string | null; last_activity_at: string | null; progress_pct: number | null;
  };
  const official: Row = { id: "a1", course_version_id: "v1", status: "passed", is_revision: false, completion_status: "completed", success_status: "passed", score: 0.85, started_at: day(0), completed_at: day(0), last_activity_at: day(0), progress_pct: 100 };
  const abandoned: Row = { id: "a2", course_version_id: "v1", status: "abandoned", is_revision: false, completion_status: "in_progress", success_status: "unknown", score: null, started_at: day(7), completed_at: null, last_activity_at: day(7), progress_pct: 20 };
  const revision: Row = { id: "a3", course_version_id: "v1", status: "in_progress", is_revision: true, completion_status: "in_progress", success_status: "unknown", score: null, started_at: day(14), completed_at: null, last_activity_at: day(14), progress_pct: 40 };
  const rows = [official, abandoned, revision];

  eq("isRevisionAttempt marks only the flagged row", rows.map(isRevisionAttempt), [false, false, true]);
  eq("excludeAbandoned keeps only the official attempt", excludeAbandoned(rows).map((a) => a.id), ["a1"]);
  eq("attemptCounts: one live attempt, one reset, the revision row in neither", attemptCounts(rows), { live: 1, reset: 1 });

  // The fold every reader runs (analytics, the CRM feeds, the Report Card):
  // last_activity_at ?? completed_at ?? started_at, over the rows its guard keeps.
  const fold = (list: Row[]) => list.reduce<string | null>((acc, a) => maxIso(acc, a.last_activity_at ?? a.completed_at ?? a.started_at), null);
  eq("the isRevisionAttempt-guarded engagement fold (it keeps a reset attempt, ADR 0004) answers day 7, never the revision row's day 14",
    fold(rows.filter((a) => !isRevisionAttempt(a))), day(7));
  eq("the excludeAbandoned-guarded fold (last touched / last activity) answers day 0", fold(excludeAbandoned(rows)), day(0));
  eq("…and the Report Card's nested maxIso chain answers the same",
    excludeAbandoned(rows).reduce<string | null>((acc, a) => maxIso(acc, maxIso(a.last_activity_at, maxIso(a.completed_at, a.started_at))), null), day(0));
  eq("the unguarded fold would answer day 14 (the regression the guards prevent)", fold(rows), day(14));
  eq("daysAgo from day 20: 20 days idle on the guarded value, so 'inactive 14d' fires", daysAgo(fold(excludeAbandoned(rows)), Date.parse(day(20))), 20);

  const view = courseProgress(rows, new Map([["v1", 10]]));
  eq("courseProgress: done from the official attempt, no source, so no progress from the revision row's 40 %",
    { done: view.done, pct: view.pct, started: view.started }, { done: true, pct: 100, started: true });
  const onlyRevision = courseProgress([revision], new Map([["v1", 10]]));
  eq("courseProgress over the revision row alone: not started, no pct", { done: onlyRevision.done, pct: onlyRevision.pct, started: onlyRevision.started }, { done: false, pct: null, started: false });
}

console.log("\n(b) every engagement fold and open-row pick under app/ and lib/ skips revision rows");
{
  const root = path.resolve(__dirname, "../..");
  function walk(dir: string, out: string[]): void {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  }
  const files: string[] = [];
  for (const d of ["app", "lib"]) walk(path.join(root, d), files);
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const sources = new Map<string, string>(
    files.map((f) => {
      const raw = fs.readFileSync(f, "utf8");
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
      return [rel(f), code];
    })
  );

  /** The same predicate as revision-listing.test.ts's selectsFlag (the paged form included). */
  const selectsFlag = (src: string) =>
    (/read(?:Paged)?WithOptionalColumn<[^>]*>\(\s*"is_revision",/.test(src) &&
      /\.from\(\s*"course_attempts"\s*\)\s*\.select\(\s*(?:columns|cols)\s*\)|fetchByIds<AttemptRow>\(\s*svc,\s*"course_attempts",\s*columns,/.test(src)) ||
    /\.from\(\s*"course_attempts"\s*\)\s*\.select\(\s*"\*"\s*\)/.test(src);

  /** The lines the scan collects: the fold chains, maxIso calls and the open-row tests. */
  const PATTERNS = [
    /\b\w+\.last_activity_at \?\? \w+\.completed_at \?\? \w+\.started_at/,
    /\b\w+\.last_activity_at \?\? \w+\.started_at/,
    /(?<!last_activity_at \?\? \w+\.)\b\w+\.completed_at \?\? \w+\.started_at/,
    /(?<!(?:function|const)\s)\bmaxIso\(/,
    /\bcompletion_status === "in_progress"|\bcompletion_status !== "completed"/,
  ];
  type Kind = "fold" | "pick" | "not-a-fold";
  type Site = { kind: Kind; guard?: RegExp; abandonedOnly?: boolean; why?: string };
  const key = (file: string, line: string) => `${file} :: ${line}`;
  const S = (file: string, line: string, site: Site): [string, Site] => [key(file, line), site];

  const SITES = new Map<string, Site>([
    // ---- engagement folds (last active / last access / last touched / last activity) ----
    S("app/[org]/(admin)/analytics/page.tsx", "const t = a.last_activity_at ?? a.completed_at ?? a.started_at;",
      { kind: "fold", guard: /for \(const a of my\) \{\s*if \(isRevisionAttempt\(a\)\) continue;\s*const t = a\.last_activity_at \?\? a\.completed_at \?\? a\.started_at;/ }),
    S("app/[org]/(admin)/analytics/page.tsx", 'const t = a.last_activity_at ?? a.completed_at ?? a.started_at ?? "";',
      { kind: "fold", guard: /const latestByCourse = new Map<string, AttemptRow>\(\);\s*for \(const a of my\) \{\s*if \(isRevisionAttempt\(a\)\) continue;/ }),
    S("app/[org]/(admin)/analytics/page.tsx", 'const pt = prev ? prev.last_activity_at ?? prev.completed_at ?? prev.started_at ?? "" : "";',
      { kind: "fold", guard: /const latestByCourse = new Map<string, AttemptRow>\(\);\s*for \(const a of my\) \{\s*if \(isRevisionAttempt\(a\)\) continue;[\s\S]{0,400}const pt = prev/ }),
    S("app/[org]/(admin)/analytics/page.tsx", "const t = !revision && a.status !== \"abandoned\" ? a.last_activity_at ?? a.completed_at ?? a.started_at : null;",
      { kind: "fold", guard: /const revision = isRevisionAttempt\(a\);[\s\S]{0,500}const t = !revision && a\.status !== "abandoned" \?/ }),
    S("lib/integrations/progress.ts", "row.last = maxIso(row.last, a.last_activity_at ?? a.completed_at ?? a.started_at);",
      { kind: "fold", guard: /if \(isRevisionAttempt\(a\)\) continue;\s*row\.n\+\+;[\s\S]{0,700}row\.last = maxIso\(row\.last,/ }),
    S("app/api/integrations/learner-summary/route.ts", "const t = a.last_activity_at ?? a.completed_at ?? a.started_at;",
      { kind: "fold", guard: /const revision = isRevisionAttempt\(a\);\s*const t = a\.last_activity_at \?\? a\.completed_at \?\? a\.started_at;\s*if \(!revision && t/ }),
    S("lib/manager/insights.ts", "lastActive = maxIso(lastActive, maxIso(a.last_activity_at, maxIso(a.completed_at, a.started_at)));",
      { kind: "fold", guard: /for \(const a of my\) \{\s*if \(isRevisionAttempt\(a\)\) continue;\s*lastActive = maxIso\(lastActive,/ }),
    S("lib/manager/insights.ts", "lastActivity = maxIso(lastActivity, maxIso(a.last_activity_at, maxIso(a.completed_at, a.started_at)));",
      { kind: "fold", abandonedOnly: true, guard: /for \(const a of excludeAbandoned\(list\)\) \{\s*startedAt = minIso\(startedAt, a\.started_at\);\s*lastActivity = maxIso\(lastActivity,/ }),
    S("app/[org]/(admin)/library/[courseId]/learners/page.tsx", ".map((a) => a.completed_at ?? a.started_at)",
      { kind: "fold", abandonedOnly: true, guard: /const lastTouched =\s*excludeAbandoned\(myAttempts\)\s*\.map\(\(a\) => a\.completed_at \?\? a\.started_at\)/ }),
    S("app/api/courses/[courseId]/learners/export/route.ts", ".map((a) => a.completed_at ?? a.started_at)",
      { kind: "fold", abandonedOnly: true, guard: /const liveAttempts = excludeAbandoned\(myAttempts\);\s*const lastTouched =\s*liveAttempts\s*\.map\(\(a\) => a\.completed_at \?\? a\.started_at\)/ }),
    S("app/[org]/(admin)/reports/page.tsx", ".map((a) => a.completed_at ?? a.started_at)",
      { kind: "fold", abandonedOnly: true, guard: /const myLive = excludeAbandoned\(myAttempts\);[\s\S]{0,1600}const lastActivity =\s*myLive\s*\.map\(\(a\) => a\.completed_at \?\? a\.started_at\)/ }),
    S("app/[org]/(admin)/learning-paths/[pathId]/learners/page.tsx", ".map((a) => a.completed_at ?? a.started_at)",
      { kind: "fold", abandonedOnly: true, guard: /const lastTouched =\s*excludeAbandoned\(myAttempts\)\s*\.map\(\(a\) => a\.completed_at \?\? a\.started_at\)/ }),
    S("app/api/learning-paths/[id]/learners/export/route.ts", ".map((a) => a.completed_at ?? a.started_at)",
      { kind: "fold", abandonedOnly: true, guard: /const lastTouched =\s*excludeAbandoned\(myAttempts\)\s*\.map\(\(a\) => a\.completed_at \?\? a\.started_at\)/ }),
    S("app/[org]/(admin)/learning-paths/[pathId]/reports/page.tsx", "const act = a.completed_at ?? a.started_at ?? null;",
      { kind: "fold", guard: /for \(const a of attempts\) \{\s*if \(isRevisionAttempt\(a\)\) continue;[\s\S]{0,1600}const act = a\.completed_at \?\? a\.started_at \?\? null;/ }),

    // ---- the open / in-progress row picks and counts ----
    S("app/[org]/(learner)/dashboard/page.tsx", 'a.completion_status === "in_progress" &&',
      { kind: "pick", guard: /function progressForCourse\([\s\S]{0,300}a\.completion_status === "in_progress" &&\s*a\.status !== "abandoned" &&\s*!isRevisionAttempt\(a\)/ }),
    S("app/[org]/(learner)/courses/page.tsx", 'a.completion_status === "in_progress" &&',
      { kind: "pick", guard: /const open = attempts\s*\.filter\(\(a\) => \{[\s\S]{0,200}a\.completion_status === "in_progress" &&\s*a\.status !== "abandoned" &&\s*!isRevisionAttempt\(a\)/ }),
    S("lib/integrations/progress.ts", 'if (!abandoned && a.completion_status === "in_progress" && (a.started_at ?? "") >= row.progressAt) {',
      { kind: "pick", guard: /if \(isRevisionAttempt\(a\)\) continue;[\s\S]{0,400}if \(!abandoned && a\.completion_status === "in_progress"/ }),
    S("app/api/integrations/learner-summary/route.ts", 'if (!abandoned && a.completion_status === "in_progress" && (a.started_at ?? "") >= row.progressAt) {',
      { kind: "pick", guard: /if \(revision\) continue;[\s\S]{0,400}if \(!abandoned && a\.completion_status === "in_progress"/ }),
    S("lib/courses/progress-view.ts", '.filter((a) => !isDoneAttempt(a) && a.completion_status !== "completed")',
      { kind: "pick", guard: /const attempts = all\.filter\(\(a\) => a\.status !== "abandoned" && a\.is_revision !== true\);/ }),
    S("app/[org]/(admin)/reports/page.tsx", 'a.completion_status !== "completed" &&',
      { kind: "pick", guard: /const inProgress = myAttempts\.filter\([\s\S]{0,200}a\.status !== "abandoned" &&\s*!isRevisionAttempt\(a\)\s*\)[\s\S]*const openWithProgress = myAttempts\.filter\([\s\S]{0,200}a\.status !== "abandoned" &&\s*!isRevisionAttempt\(a\) &&/ }),
    S("app/[org]/(learner)/courses/[courseId]/page.tsx", 'attempt.completion_status === "in_progress" &&',
      { kind: "pick", guard: /const attemptRows = attempts\.filter\(\(a\) => !isRevisionAttempt\(a\)\);/, why: "the per-row progress badge of 'My attempts', whose list excludes revision rows" }),
    // The path page's step state and the dashboard path tile's started test:
    // an open revision visit's row never marks
    // a step in progress or starts a path.
    S("app/[org]/(learner)/paths/[pathId]/page.tsx", '} else if (list.some((a) => a.completion_status === "in_progress" && a.status !== "abandoned" && !isRevisionAttempt(a))) {',
      { kind: "pick", guard: /\} else if \(list\.some\(\(a\) => a\.completion_status === "in_progress" && a\.status !== "abandoned" && !isRevisionAttempt\(a\)\)\) \{\s*inProgressCourseIds\.add\(cid\);/, why: "a path step's in-progress state test: an open revision visit's row never marks a step in progress" }),
    S("app/[org]/(learner)/dashboard/page.tsx", 'a.learning_path_id === p.id && a.completion_status !== "completed" && a.status !== "abandoned" && !isRevisionAttempt(a)',
      { kind: "pick", guard: /const started =\s*done > 0 \|\|\s*attempts\.some\(\s*\(a\) =>\s*a\.learning_path_id === p\.id && a\.completion_status !== "completed" && a\.status !== "abandoned" && !isRevisionAttempt\(a\)\s*\);/, why: "the path tile's started test: an open revision visit's row never starts a path" }),

    // ---- not an attempt-row engagement fold or pick (each with its reason) ----
    S("lib/courses/slot-routing.ts", 'const activityOf = (a: SlotAttempt) => a.last_activity_at ?? a.started_at ?? "";',
      { kind: "not-a-fold", why: "the language slot routing's ordering key (PR 1a); its in-progress rows drop is_revision first", guard: /const inProgress = input\.inProgress\.filter\(\(a\) => a\.is_revision !== true\);/ }),
    S("lib/scoring/official-history.ts", "const ka = ts(a.completed_at ?? a.started_at);", { kind: "not-a-fold", why: "the chain's ordering key (step 7), over non-revision rows only" }),
    S("lib/scoring/official-history.ts", "const kb = ts(b.completed_at ?? b.started_at);", { kind: "not-a-fold", why: "the chain's ordering key (step 7)" }),
    S("lib/scoring/official-history.ts", "completedAt: (a.completed_at ?? a.started_at) as string,", { kind: "not-a-fold", why: "a chain entry's date, a completed non-revision row" }),
    S("lib/scoring/policy.ts", "const ka = ts(a.completed_at ?? a.started_at);", { kind: "not-a-fold", why: "computeScoring's ordering key; flagged rows are filtered before it" }),
    S("lib/scoring/policy.ts", "const kb = ts(b.completed_at ?? b.started_at);", { kind: "not-a-fold", why: "computeScoring's ordering key" }),
    S("lib/integrations/progress.ts", "if (complete) for (const c of doneSteps) completedAt = maxIso(completedAt, doneAt.get(c) ?? null);",
      { kind: "not-a-fold", why: "a path's completion date over its done steps (officialDone), not attempt rows" }),
    S("lib/manager/insights.ts", "const last = maxIso(lastRevisitByUser.get(uid) ?? null, s.last);",
      { kind: "not-a-fold", why: "the 'Last revisit' date over revision_visits aggregates, by design (ADR 0014:199)" }),
    S("lib/manager/insights.ts", "for (const j of journeysByUser.get(uid) ?? []) for (const d of j.dayCompletions) lastActive = maxIso(lastActive, d || null);",
      { kind: "not-a-fold", why: "journey day completions, which a revisit never writes (ADR 0014 step 12)" }),
    S("app/[org]/(learner)/courses/[courseId]/attempts/[attemptId]/page.tsx", 'const isReset = a.status === "abandoned" && a.completion_status !== "completed";',
      { kind: "not-a-fold", why: "one attempt's own label" }),
    S("lib/xapi/process-statement.ts", 'if (isOutcome && aboutAu && r.completion_status !== "completed") {',
      { kind: "not-a-fold", why: "the statement processor's completion rule; revision rows never reach it (R-5)" }),
  ]);

  const found: string[] = [];
  for (const [file, src] of sources) {
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (t && PATTERNS.some((re) => re.test(t))) found.push(key(file, t));
    }
  }
  const uniqueFound = [...new Set(found)].sort();
  eq("every fold, maxIso and open-row line under app/ and lib/ is in the hand list (and the list names only such lines)", uniqueFound, [...SITES.keys()].sort());
  eq("non-vacuous: the scan collects the hand list's lines", uniqueFound.length >= 30, true);

  for (const [k, site] of SITES) {
    const file = k.split(" :: ")[0];
    const src = sources.get(file) ?? "";
    if (site.guard) eq(`${k.slice(0, 140)}: ${site.kind === "not-a-fold" ? "its reason holds" : "guarded"}`, site.guard.test(src), true);
    if (site.kind !== "not-a-fold" && !site.guard) eq(`${k}: a fold or pick names its guard`, false, true);
    if (site.abandonedOnly) eq(`${file}: guarded by excludeAbandoned( only, so its select names is_revision (fallback) or is select("*")`, selectsFlag(src), true);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
