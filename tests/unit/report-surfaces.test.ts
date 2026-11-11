/**
 * ADR 0014 PR 1b, the admin report surfaces: source checks.
 *
 * The course learners CSV export and the path learners CSV export
 * authenticate through the cookie-bound server client, which has no unit rig,
 * so under the route-test reading each is
 * proven by its pure twin (grantSnapshotForUsers and officialRetakeState for
 * the course CSV, standingVerdictOf for the path CSV; unit-tested in
 * scoring-status.test.ts and official-history.test.ts), by these source
 * checks of the wiring, and by spec 61 on staging. The admin pages
 * (cookie-client Server Components, no React rig) get wiring checks in
 * the same style. Sources are read with comments blanked (strings kept), so a
 * comment naming a helper is not a call. No database, no network.
 *
 *   (i)   the course learners CSV: the strict grant read and its 503, the
 *         eight new columns in order, the strict grants into
 *         officialStatuses, the retake-aware progress, the visit reader;
 *   (ii)  the path learners CSV (PX): the standing verdict, the per-step
 *         progress without retakeIds, the revision-aware folds;
 *   (iii) the admin Learners page: the strict read used two ways, the
 *         "retake reset, no grant" predicate, the History expander;
 *   (iv)  the path Learners and path Reports pages, the org Reports page (its
 *         paged read in id order, and its score folds evaluated from the
 *         source against rows), the
 *         Course Reports tile, the journey-admin and learning-paths selects;
 *   (v)   Analytics: the mapper, the folds, step 10 on the row and the lens,
 *         the roll-ups without retakeIds, the Due cell, the visit reads.
 *
 * Run:  npx tsx tests/unit/report-surfaces.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { excludeAbandoned } from "../../lib/scoring/policy";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
/** A source with line and block comments blanked (strings kept) and LF line ends. */
function code(rel: string): string {
  const raw = fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/* ---- a small bracket-aware reader for array literals and call arguments ---- */
function skipString(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === q) return i + 1;
    if (q === "`" && ch === "$" && s[i + 1] === "{") { i = skipBalanced(s, i + 1); continue; }
    i++;
  }
  return i;
}
/** `s[i]` is an opener; returns the index just after its matching closer. */
function skipBalanced(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(s, i); continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}
/** The top-level comma-separated items between the opener at `open` and its closer. */
function items(s: string, open: number): string[] {
  if (open < 0) return [];
  const body = s.slice(open + 1, skipBalanced(s, open) - 1);
  const out: string[] = [];
  let depth = 0, start = 0, i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(body, i); continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { out.push(body.slice(start, i).trim()); start = i + 1; }
    i++;
  }
  const last = body.slice(start).trim();
  if (last) out.push(last);
  return out;
}
/** The argument lists of every call of `fn(` in `src`. */
function callArgs(src: string, fn: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${fn}\\(`, "g");
  for (const m of src.matchAll(re)) out.push(items(src, (m.index ?? 0) + m[0].length - 1));
  return out;
}
/**
 * The narrower-select fallback around one course_attempts select, keyed on a
 * columns constant naming `status`: readWithOptionalColumn, or its paged form
 * readPagedWithOptionalColumn (the closure then takes `from, to` and the
 * options follow the constant; ADR 0020's chunked reads of the enrolled set).
 */
function fallbackSelect(src: string, constant: string): boolean {
  const decl = new RegExp(`const ${constant} =\\s*"[^"]*\\bstatus\\b[^"]*";`).test(src);
  const read = new RegExp(
    `read(?:Paged)?WithOptionalColumn<[^>]*>\\(\\s*"is_revision",\\s*\\(columns(?:, from, to)?\\)[^=]*?=>\\s*[\\s\\S]{0,40}?\\.from\\("course_attempts"\\)\\s*\\.select\\(columns\\)[\\s\\S]{0,400}?,\\s*${constant}\\s*[,)]`
  ).test(src);
  return decl && read;
}

const CSV = "app/api/courses/[courseId]/learners/export/route.ts";
const PX = "app/api/learning-paths/[id]/learners/export/route.ts";
const LP = "app/[org]/(admin)/library/[courseId]/learners/page.tsx";
const PL = "app/[org]/(admin)/learning-paths/[pathId]/learners/page.tsx";
const PR = "app/[org]/(admin)/learning-paths/[pathId]/reports/page.tsx";
const ORG_REPORTS = "app/[org]/(admin)/reports/page.tsx";
const COURSE_REPORTS = "app/[org]/(admin)/library/[courseId]/reports/page.tsx";
const JOURNEY_ADMIN = "app/[org]/(admin)/journey-admin/page.tsx";
const PATHS_LIST = "app/[org]/(admin)/learning-paths/page.tsx";
const ANALYTICS = "app/[org]/(admin)/analytics/page.tsx";

console.log("\n(i) the course learners CSV (cookie-client route; twins grantSnapshotForUsers, officialRetakeState)");
{
  const src = code(CSV);
  eq("the attempts select names is_revision with the fallback (ATTEMPT_COLUMNS names status)", fallbackSelect(src, "ATTEMPT_COLUMNS"), true);
  eq("the attempt row type carries is_revision", /is_revision\?: boolean \| null;/.test(src), true);
  const at = src.indexOf("grantSnapshotForUsers(");
  eq("grantSnapshotForUsers(svc, org.id, [courseId], enrolledUserIds): the ADR's argument order, the service client", /grantSnapshotForUsers\(svc, org\.id, \[courseId\], enrolledUserIds\)/.test(src), true);
  const tryAt = src.lastIndexOf("try {", at);
  const catchAt = src.indexOf("} catch (e) {", at);
  const catchBody = catchAt < 0 ? "" : src.slice(catchAt, skipBalanced(src, src.indexOf("{", catchAt + 2)));
  eq("…inside a try (nothing else between the try and the call)", tryAt >= 0 && /^try \{\s*snapshots = await $/.test(src.slice(tryAt, at)), true);
  eq("…whose catch answers 503 history_unavailable on GrantReadError", /GrantReadError/.test(catchBody) && /NextResponse\.json\(\{ error: "history_unavailable" \}, \{ status: 503 \}\)/.test(catchBody), true);
  const at503 = src.indexOf('{ status: 503 }');
  eq("…before the rows exist or any row is pushed (no file written)", at503 > 0 && at503 < src.indexOf("const rows") && at503 < src.indexOf("rows.push("), true);
  eq("the fail-soft grant reader is gone from the CSV", /fetchGrantRetakeIdsForUsers/.test(src), false);
  const header = items(src, src.indexOf("[", src.indexOf("const header =")));
  const names = header.map((h) => { try { return JSON.parse(h) as string; } catch { return h; } });
  const last = names.indexOf("Last activity (ISO)");
  eq("the eight new headers, in order, after \"Last activity (ISO)\" and before \"Enrolled via\"", names.slice(last + 1), [
    "Revisits", "Last revisit (ISO)", "Official retake", "Previous official score (%)", "Previous official status",
    "Granted by", "Granted at (ISO)", "Grant reason", "Enrolled via",
  ]);
  const pushes = callArgs(src, "rows\\.push");
  const row = pushes.length === 1 ? items(pushes[0][0], 0) : [];
  eq("one rows.push, and its row has as many cells as the header", [pushes.length, row.length], [1, header.length]);
  eq("the visit cells: the count (\"N+\" past the cap), then the last revisit", [row[last + 1], row[last + 2]], [
    'visit ? `${visit.count}${visits.capped ? "+" : ""}` : ""',
    'visit?.last ?? ""',
  ]);
  eq("Official retake reads none / in progress / completed", row[last + 3], 'retake ? (retake.state === "in_progress" ? "in progress" : retake.state) : "none"');
  eq("Previous official …: filled only once a granted retake completed", /const previous = retake\?\.state === "completed" \? retake\.previous : null;/.test(src), true);
  eq("Granted by: the decider's email, \"a former administrator\" when null", row[last + 6].includes('"a former administrator"') && row[last + 6].includes("deciderEmail.get(grant.decidedBy)"), true);
  eq("Grant reason: decision_note, else the learner's reason", row[last + 8], 'grant ? grant.decisionNote ?? grant.reason ?? "" : ""');
  const os = callArgs(src, "officialStatuses");
  eq("officialStatuses gets the strict snapshot's retake ids ({ grants: … })", os.length === 1 && os[0][3] === "{ grants: retakeIdsByPair }", true);
  eq("…built from the snapshot, keyed as the snapshot is", /const retakeIdsByPair = new Map<string, ReadonlySet<string>>\(\[\.\.\.snapshots\]\.map\(\(\[k, s\]\) => \[k, s\.retakeIds\]\)\);/.test(src), true);
  const cp = callArgs(src, "courseProgress");
  eq("courseProgress gets { retakeIds } (Progress (%) reads the retake's figure)", cp.length === 1 && /^\{ retakeIds: snapshotOf\(uid\)\.retakeIds \}$/.test(cp[0][2] ?? ""), true);
  eq("the chain through officialHistory + officialRetakeState over the snapshot rows", /officialHistory\(\s*attempts\.filter\(\(a\) => a\.user_id === uid\),\s*snapshotOf\(uid\)\.rows\s*\)/.test(src) && /officialRetakeState\(history\)/.test(src), true);
  eq("the visit counts through the service client over the enrolled learners", /fetchRevisionVisitStats\(svc, \{ orgId: org\.id, courseIds: \[courseId\], userIds: enrolledUserIds \}\)/.test(src), true);
  eq("Attempts and Last activity come from excludeAbandoned (revision rows dropped once the select carries the flag)", /const liveAttempts = excludeAbandoned\(myAttempts\);/.test(src) && /String\(liveAttempts\.length\)/.test(src), true);
}

console.log("\n(ii) the path learners CSV, PX (cookie-client route; twin standingVerdictOf)");
{
  const src = code(PX);
  eq("the attempts select names is_revision with the fallback", fallbackSelect(src, "ATTEMPT_COLUMNS"), true);
  eq("the final step's verdict is the STANDING one (standingVerdictOf), never statusOf", /standingVerdictOf\(official, uid, lastStepCourseId\)/.test(src) && !/\bstatusOf\(/.test(src), true);
  const cp = callArgs(src, "courseProgress");
  eq("the per-step courseProgress (it feeds pathProgress) passes exactly two arguments, no retakeIds", cp.map((a) => a.length), [2]);
  eq("the not-started test is the courseStatus rule (excludeAbandoned)", /coursesDone === 0 && excludeAbandoned\(myAttempts\)\.length === 0/.test(src), true);
  eq("the done-steps fold skips revision rows", /for \(const a of myAttempts\) \{\s*if \(isRevisionAttempt\(a\)\) continue;/.test(src), true);
  eq("lastTouched folds excludeAbandoned rows (the select carries the flag)", /excludeAbandoned\(myAttempts\)\s*\.map\(\(a\) => a\.completed_at \?\? a\.started_at\)/.test(src), true);
  eq("officialStatuses reads its grants through the service client, fail-soft (no { grants })", callArgs(src, "officialStatuses").map((a) => [a[0], a.length]), [["svc", 3]]);
}

console.log("\n(iii) the admin Learners page, LP");
{
  const src = code(LP);
  eq("the attempts select names is_revision with the fallback", fallbackSelect(src, "ATTEMPT_COLUMNS"), true);
  const at = src.indexOf("grantSnapshotForUsers(svc, org.id, [c.id], enrolledUserIds)");
  const tryAt = src.lastIndexOf("try {", at);
  const block = at < 0 ? "" : src.slice(tryAt, src.indexOf("}", src.indexOf("} catch", at) + 8) + 1);
  eq("one strict bulk grant read in a try; GrantReadError sets historyUnavailable", at > 0 && /if \(!\(e instanceof GrantReadError\)\) throw e;[\s\S]*historyUnavailable = true;/.test(block), true);
  eq("the fail-soft grant reader is gone from LP", /fetchGrantRetakeIdsForUsers/.test(src), false);
  eq("computeScoring and courseProgress read the snapshot's retake ids (step 10 on the row)", /computeScoring\(myAttempts, scoringPolicy, snapshot\.retakeIds\)/.test(src) && /courseProgress\(myAttempts, unitCountByVersion, \{ retakeIds: snapshot\.retakeIds \}\)/.test(src), true);
  eq("the chain: officialHistory over the snapshot rows, then officialRetakeState", /officialHistory\(myAttempts, snapshot\.rows\)/.test(src) && /officialRetakeState\(history\)/.test(src), true);
  eq("\"retake reset, no grant\": ADR 0014:186's three clauses over the strict snapshot, only when the history was read", /const resetNoGrant =\s*!historyUnavailable &&\s*history\.reset\.length > 0 &&\s*snapshot\.unusedGrant === null &&\s*!myAttempts\.some\(\(a\) => snapshot\.retakeIds\.has\(a\.id\) && a\.status !== "abandoned"\);/.test(src), true);
  eq("…\"holds no unexpired unused grant\" is the strict snapshot's unusedGrant (grantSnapshotOf)", /snapshot\.unusedGrant === null &&/.test(src), true);
  eq("…never the fail-soft fetchUnusedGrantsForUsers map", /fetchUnusedGrantsForUsers|unusedByUser|holdsUnexpired/.test(src), false);
  eq("the reset suffix carries the label", src.includes('reset{r.resetNoGrant ? " (retake reset, no grant)" : ""}'), true);
  eq("the legacy \"· N revisions\" suffix is gone", /practiceAttempts|revisions/.test(src), false);
  eq("the result cell: \"<standing> → retake in progress\" and \"<previous> → <current>\"", src.includes("→ retake in progress`") && src.includes("`${resultLabel(r.retake.previous)} → ${resultLabel(r.retake.current)}`"), true);
  eq("…\"Passed / Not passed / Completed\" with \"N %\" from a 0..1 score", /e\.status === "passed" \? "Passed" : e\.status === "failed" \? "Not passed" : "Completed"/.test(src) && /\$\{Math\.round\(e\.score \* 100\)\} %/.test(src), true);
  const visitsAt = src.indexOf("fetchRevisionVisitStats(");
  eq("the visit read: service client, this course, this page's learners only (after the slice)", visitsAt > src.indexOf("const slice = sorted.slice(") && /fetchRevisionVisitStats\(svc, \{ orgId: org\.id, courseIds: \[c\.id\], userIds: slice\.map\(\(r\) => r\.user_id\) \}\)/.test(src), true);
  eq("a Revisits column after Attempts, and a History column", /label="Attempts"[\s\S]*?Revisits\s*<\/th>[\s\S]*?label="Last activity"[\s\S]*?>History<\/th>/.test(src), true);
  eq("the History cell: the text alone when unavailable", /if \(unavailable\) return <span className="text-amber-800">History unavailable\. Please reload\.<\/span>;/.test(src), true);
  eq("…a server-rendered <details> (no client component)", /<details>[\s\S]*<summary[^>]*>History<\/summary>/.test(src) && !/"use client"/.test(src), true);
  for (const text of ["· Official result", "· Replaced by a granted retake on ", "Official retake in progress", "· Granted retake, reset by a module update", "Granted by ", "a former administrator", " after a module update"]) {
    eq(`…names "${text}"`, src.includes(text), true);
  }
  eq("…every line links to the attempt page", /<Link href=\{attemptHref\(l\.attemptId\)\}/.test(src) && src.includes("`/${orgSlug}/courses/${c.id}/attempts/${attemptId}`"), true);
  eq("…deciders resolved to emails in one read (resolveEmails over the page's decider ids)", /resolveEmails\(svc, deciderIds\)/.test(src), true);
}

console.log("\n(iv) the path pages, the org Reports page, the Course Reports tile, journey-admin, the learning-paths list");
{
  const pl = code(PL);
  eq("PL: the select names is_revision with the fallback", fallbackSelect(pl, "ATTEMPT_COLUMNS"), true);
  eq("PL: the final step's STANDING verdict, never statusOf", /standingVerdictOf\(official, uid, lastStepCourseId\)/.test(pl) && !/\bstatusOf\(/.test(pl), true);
  eq("PL: the not-started test is excludeAbandoned; the done fold skips revision rows", /coursesDone === 0 && excludeAbandoned\(myAttempts\)\.length === 0/.test(pl) && /for \(const a of myAttempts\) \{\s*if \(isRevisionAttempt\(a\)\) continue;/.test(pl), true);
  const pr = code(PR);
  eq("PR: both selects name is_revision with the fallback", fallbackSelect(pr, "PATH_ATTEMPT_COLUMNS") && fallbackSelect(pr, "ALL_ATTEMPT_COLUMNS"), true);
  eq("PR: the aggregation loop skips revision rows first", /for \(const a of attempts\) \{\s*if \(isRevisionAttempt\(a\)\) continue;/.test(pr), true);
  eq("PR: per-step passed / failed from the STANDING verdict, never statusOf", /const verdict = standingVerdictOf\(official, uid, cid\);\s*agg\.passed = verdict === "passed";\s*agg\.failed = verdict === "failed";/.test(pr) && !/\bstatusOf\(/.test(pr), true);

  const or = code(ORG_REPORTS);
  eq("org Reports: the select names is_revision with the fallback, the first page deciding", /const ATTEMPT_COLUMNS =\s*"[^"]*\bstatus\b[^"]*";/.test(or) && /readPagedWithOptionalColumn<unknown>\(\s*"is_revision",[\s\S]{0,200}?ATTEMPT_COLUMNS,\s*\{ maxPages: 500 \}\s*\)/.test(or), true);
  eq("org Reports: the pages are taken in id order, so they are disjoint",
    /readPagedWithOptionalColumn<unknown>\(\s*"is_revision",\s*\(columns, f, t\) => supabase\.from\("course_attempts"\)\.select\(columns\)\.eq\("organization_id", org\.id\)\.order\("id"\)\.range\(f, t\),/.test(or), true);

  // Every score fold on the page counts only the rows
  // that count for scoring (excludeAbandoned: no revision visit, no reset
  // attempt), so a revision row's score never enters a KPI (ADR 0014: revision
  // visits are never scored). The folds are read from the source and run on rows.
  const liveDecl = or.match(/const liveAttempts = (excludeAbandoned\(attempts\));/);
  const kpi = or.match(/const scoredAll = ([^;]*);\s*const avgScoreOverall =([^;]*);/);
  const course = or.match(/const myLive = (excludeAbandoned\(myAttempts\));[\s\S]{0,200}?const scored = ([^;]*);\s*const avgScore =([^;]*);/);
  eq("org Reports: the folds are found (liveAttempts, the Avg score KPI, the per-course Avg score)", [!!liveDecl, !!kpi, !!course], [true, true, true]);
  eq("…the Avg score KPI folds liveAttempts, the excludeAbandoned rows", kpi?.[1] ?? null, 'liveAttempts.filter((a) => typeof a.score === "number")');
  eq("…and the per-course Avg score folds myLive, the course's excludeAbandoned rows (unchanged)", course?.[2] ?? null, 'myLive.filter((a) => typeof a.score === "number")');
  type ScoreRow = { user_id: string; status: string; score: number | null; is_revision?: boolean | null };
  const overall = (attempts: ScoreRow[]): number | null =>
    kpi && liveDecl
      ? (new Function("excludeAbandoned", "attempts", `const liveAttempts = ${liveDecl[1]}; const scoredAll = ${kpi[1]}; return (${kpi[2]});`)(excludeAbandoned, attempts) as number | null)
      : -1;
  const perCourse = (myAttempts: ScoreRow[]): number | null =>
    course
      ? (new Function("excludeAbandoned", "myAttempts", `const myLive = ${course[1]}; const scored = ${course[2]}; return (${course[3]});`)(excludeAbandoned, myAttempts) as number | null)
      : -1;
  const rows: ScoreRow[] = [
    { user_id: "u1", status: "passed", score: 0.8, is_revision: false },
    { user_id: "u1", status: "completed", score: 0.2, is_revision: true },
    { user_id: "u1", status: "abandoned", score: 0.1, is_revision: false },
    { user_id: "u2", status: "passed", score: 0.6 },
    // A live, non-revision row with no score: it stays in
    // liveAttempts but never in scoredAll, so the mean's denominator is pinned
    // to the scored rows (dividing by liveAttempts.length would read 46.7 %).
    { user_id: "u3", status: "completed", score: null, is_revision: false },
  ];
  const round = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  eq("…evaluated from the source: official 80 % and 60 % (a pre-0103 row), a revision visit's 20 %, a reset attempt's 10 %, a live row with no score → the KPI reads 70 %",
    round(overall(rows)), 0.7);
  eq("…the per-course Avg score over the same rows reads the same 70 %", round(perCourse(rows)), 0.7);
  eq("…an organisation whose only scored row is a revision visit reads \"-\" (null), never its score", overall([rows[1]]), null);
  // The live row with no score alone:
  // only the empty-set guards decide, so the tile and the per-course figure
  // read "-" (null), never NaN. eq compares JSON text and JSON.stringify(NaN)
  // is "null", so each value is compared through String(): "NaN" is not "null".
  eq("…an organisation, or a course, whose live rows carry no score yet reads \"-\" (null) on the tile and on the per-course figure, never NaN",
    [overall([rows[4]]), perCourse([rows[4]])].map((v) => String(v)), ["null", "null"]);

  eq("org Reports: still the service client after canViewReports (data_analyst is RLS-plain)", /if \(!canViewReports\(role\)\)[\s\S]*?const supabase = createServiceClient\(/.test(or), true);
  eq("org Reports: the in-progress count and the open-progress mean skip revision rows", (or.match(/a\.status !== "abandoned" &&\s*!isRevisionAttempt\(a\)/g) ?? []).length, 2);
  eq("org Reports: the total reset count is attemptCounts' (a revision row is never a reset)", /resetAttempts: attemptCounts\(attempts\)\.reset,/.test(or), true);

  const cr = code(COURSE_REPORTS);
  eq("Course Reports: the tile reads fetchCourseRevisitSummary through the service client, last 30 days", /fetchCourseRevisitSummary\(svc, \{\s*orgId: org\.id,\s*courseId: c\.id,\s*sinceIso: new Date\(Date\.now\(\) - 30 \* 86_400_000\)\.toISOString\(\),\s*\}\)/.test(cr), true);
  eq("…absent on a database without 0103, \"—\" on a failed read", /\{!revisits\.missing && \(/.test(cr) && /revisits\.failed \? "—"/.test(cr), true);

  const ja = code(JOURNEY_ADMIN);
  eq("journey-admin: the select names is_revision with the fallback; courseProgress takes two arguments", fallbackSelect(ja, "ATTEMPT_COLUMNS") && JSON.stringify(callArgs(ja, "courseProgress").map((a) => a.length)) === "[2]", true);
  const lp = code(PATHS_LIST);
  eq("learning-paths: the select names is_revision with the fallback; courseProgress takes two arguments", fallbackSelect(lp, "ATTEMPT_COLUMNS") && JSON.stringify(callArgs(lp, "courseProgress").map((a) => a.length)) === "[2]", true);
}

console.log("\n(v) Analytics");
{
  const src = code(ANALYTICS);
  eq("the explicit select names is_revision through readWithOptionalColumn around fetchByIds", /const ATTEMPT_COLUMNS =\s*"[^"]*\bstatus\b[^"]*";/.test(src) && /readWithOptionalColumn<AttemptRow\[\]>\(\s*"is_revision",[\s\S]{0,200}?fetchByIds<AttemptRow>\(\s*svc,\s*"course_attempts",\s*columns,/.test(src), true);
  eq("…a missing column stops the read at its first page", /return isMissingColumn\(e, "is_revision"\);/.test(src) && /if \(error && onError\?\.\(error\)\) return out;/.test(src), true);
  eq("toScorable carries is_revision (the mapper predicate)", /const toScorable = \(a: AttemptRow\) => \(\{[\s\S]*?is_revision: a\.is_revision \?\? null,[\s\S]*?\}\);/.test(src), true);
  eq("the lastActive fold and latestByCourse skip revision rows", /for \(const a of my\) \{\s*if \(isRevisionAttempt\(a\)\) continue;\s*const t = a\.last_activity_at/.test(src) && /const latestByCourse = new Map<string, AttemptRow>\(\);\s*for \(const a of my\) \{\s*if \(isRevisionAttempt\(a\)\) continue;/.test(src), true);
  eq("hasStarted ignores revision rows; the learner's attempts are attemptCounts' live count", /my\.some\(\(a\) => a\.status !== "abandoned" && !isRevisionAttempt\(a\)\)/.test(src) && /attempts: attemptCounts\(my\)\.live,/.test(src), true);
  eq("the per-learner table: attempts, live and Last activity skip revision rows", /if \(!revision\) row\.attempts\+\+;/.test(src) && /if \(!revision && a\.status !== "abandoned"\) row\.live\+\+;/.test(src) && /const t = !revision && a\.status !== "abandoned" \? a\.last_activity_at/.test(src), true);
  eq("the table's progress is the display one (with retakeIds)", /row\.progress = courseProgress\(list, unitCountByVersion, \{ retakeIds \}\);/.test(src), true);
  eq("progressOf, the roll-ups' input, computes its own two-argument courseProgress", /const progressOf = \(cid: string\): CourseProgressView =>\s*courseProgress\(attemptsOfCourse\.get\(cid\) \?\? \[\], unitCountByVersion\);/.test(src), true);
  eq("the row reads \"In progress\" while a granted retake runs, before the done branch (attemptsOfCourse.get(cid) ?? [])", /const list = attemptsOfCourse\.get\(cid\) \?\? \[\];\s*const retakeLive = hasLiveGrantedRetake\(list, grants\.get\(`\$\{list\[0\]\?\.user_id \?\? ""\}:\$\{cid\}`\) \?\? new Set<string>\(\)\);\s*row\.status = retakeLive\s*\? "In progress"\s*: done\.has\(cid\)/.test(src), true);
  eq("the Due cell keeps done (a standing result is never overdue during a retake)", /const isOver = !!due && due < nowIso && !done\.has\(cid\);/.test(src), true);
  eq("the lens cell: a live retake takes the progress branch, with retakeIds", /lens = done\.has\(lensCourse\) && !lensRetakeLive/.test(src) && /courseProgress\(lensRows, unitCountByVersion, \{ retakeIds: lensRetakeIds \}\)/.test(src), true);
  const cp = callArgs(src, "courseProgress");
  eq("courseProgress: three calls; only the two display calls pass a third argument", [cp.length, cp.filter((a) => a.length === 3).length], [3, 2]);
  eq("the \"· last revisit\" read: one, service client, bounded to the inactive learners", /fetchRevisionVisitStats\(svc, \{ orgId: org\.id, userIds: inactiveIds \}\)/.test(src) && /const inactiveIds = stats\.filter\(\(s\) => s\.reasons\.some\(\(r\) => INACTIVE_REASON\.test\(r\)\)\)/.test(src) && src.includes("· last revisit ${last.slice(0, 10)}"), true);
  eq("the per-course Revisits for the drilled-down learner: one read, one user", /fetchRevisionVisitStats\(svc, \{ orgId: org\.id, userIds: \[s\.userId\] \}\)/.test(src), true);
  eq("still the service client after canViewReports (data_analyst is RLS-plain)", /if \(!canViewReports\(role\)\) redirect[\s\S]*?const svc = svcClient\(\);/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
