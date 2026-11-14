/**
 * Guard for ADR 0024 steps 49, 62, 80 and 81 as phase 2 slice P2-3 builds
 * them: a Preview (a staff member's by-role row since the 0107 paste, a
 * Preview by mode from P2-5) never reaches a tenant LRS, a CRM feed or an
 * official report through a raw `course_attempts` read.
 *
 * It reads the sources, not a database. The files are parsed with the
 * TypeScript parser; a read site is a call `.from("course_attempts")`, a
 * call that passes the literal table name to a helper (the analytics
 * page's `fetchByIds(svc, "course_attempts", …)`), or a `.select(…)` whose
 * text embeds `course_attempts(` or `course_attempts!inner(` (the tenant
 * LRS statements source). A site whose chain calls insert, update, upsert
 * or delete is a write and is not read here. A read is filtered when it
 * sits inside `withoutPreviews(…, apply)` (or, for a helper call, passes a
 * function that calls it) and `apply` is the parameter of the function
 * given to `readWithContextFilter(state, (apply) => …)`, the one fallback
 * (`lib/scoring/context-read.ts`): on a database without 0107 it reads
 * today's select once (`docs/ARCHITECTURE.md` principle 6). A read inside
 * `individualContextOnly(…)` takes the Individual context only, which
 * leaves previews out by construction (step 49; which files is
 * tests/unit/enrolment-definition.test.ts (e)).
 *
 *   (a) the tenant LRS: every course_attempts read under lib/lrs/
 *       (lib/lrs/abandoned.ts included) is filtered, except the listed
 *       selects of a database without 0103 (which has no 0107 either);
 *       every loadAttemptContexts call there passes its caller's decision;
 *       the sweep's state is one per run; the live mirror's organisation
 *       read is filtered. The callers of enqueueAbandonedStatements are
 *       scanned in tests/unit/lrs-abandon-sites.test.ts, extended by this
 *       slice, not copied here.
 *   (b) the raw readers (step 49's row): every course_attempts read under
 *       lib/manager/, lib/attention/, lib/integrations/, the admin pages
 *       (app/[org]/(admin)/), the CRM routes (app/api/integrations/) and
 *       the two learners CSV routes is filtered or takes the Individual
 *       context, except the listed exemptions with their reason and phase;
 *       READERS lists every reader of items 1 to 1c of the plan, so a new
 *       reader fails here until it is filtered and listed.
 *   (c) the dated interim limits the plan records (P2-3 item 1c).
 *   (d) no ContextFilterState lives at module level (a decision made before
 *       a paste must not outlive its request).
 *   (e) step 81: only lib/preview/purge.ts may name purge_preview_data (no
 *       application file names it today), and no workflow names it.
 *   (f) planted sources: the scanner flags what it must.
 *
 * Phase P adds its Preview Reports scans here (no file outside lib/preview/,
 * the launch page, the two preview routes and Preview Reports reads
 * preview_runs or asks contextResult for a preview key).
 *
 * Run:  npx tsx tests/unit/preview-isolation-sites.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
}
const parse = (name: string, src: string) =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(name) ? ts.ScriptKind.TSX : /\.m?js$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const files: string[] = [];
for (const d of ["app", "lib", "components"]) walk(path.join(root, d), files);
const sources = new Map<string, string>(files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));

// ---------------------------------------------------------------------------
// The scanner. Pure over (file name, text), so the planted cases of (f) run
// through exactly the code that reads the repository.
// ---------------------------------------------------------------------------
const TABLE = "course_attempts";
const EMBED = /\bcourse_attempts(?:!inner)?\(/;
type Filter = "preview" | "individual" | "none";
type Site = { file: string; fn: string; line: number; kind: "read" | "write"; filter: Filter; column: string | null };

const calleeName = (c: ts.CallExpression): string | null =>
  ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null;
const isStr = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
const within = (inner: ts.Node, outer: ts.Node) => inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();
const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

/** The nearest named function around `n`: a declaration's name, or the variable a function is assigned to. */
function fnName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return "(module)";
}

/** The whole call chain a node starts: `.from(…).select(…).eq(…)…` up to its last call. */
function chainOf(n: ts.Node): ts.Node {
  let cur = n;
  for (;;) {
    const p = cur.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === cur && p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p) cur = p.parent;
    else return cur;
  }
}
function chainMethods(n: ts.Node): string[] {
  const out: string[] = [];
  const visit = (x: ts.Node) => {
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
      out.push(x.expression.name.text);
      visit(x.expression.expression);
    }
  };
  visit(n);
  return out;
}

/**
 * Whether `w`, a `withoutPreviews(query, apply, column?)` call, takes its
 * `apply` from the function given to `readWithContextFilter(state, fn)` and
 * that function also holds the site.
 */
function decidedByFallback(w: ts.CallExpression, site: ts.Node): boolean {
  const apply = w.arguments[1];
  if (!apply || !ts.isIdentifier(apply)) return false;
  for (let p: ts.Node | undefined = w.parent; p; p = p.parent) {
    if (!isFn(p)) continue;
    const params = p.parameters;
    if (!params.some((q) => ts.isIdentifier(q.name) && q.name.text === apply.text)) continue;
    const call = p.parent;
    return (
      params.length === 1 &&
      !!call && ts.isCallExpression(call) && calleeName(call) === "readWithContextFilter" &&
      call.arguments[1] === p && within(site, p)
    );
  }
  return false;
}

function filterOf(site: ts.Node, helperCall: boolean): { filter: Filter; column: string | null } {
  const candidates: ts.CallExpression[] = [];
  for (let p: ts.Node | undefined = site.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && calleeName(p) === "withoutPreviews" && p.arguments[0] && within(site, p.arguments[0])) candidates.push(p);
    if (ts.isCallExpression(p) && calleeName(p) === "individualContextOnly") return { filter: "individual", column: null };
  }
  if (helperCall) {
    const visit = (x: ts.Node) => {
      if (ts.isCallExpression(x) && calleeName(x) === "withoutPreviews") candidates.push(x);
      ts.forEachChild(x, visit);
    };
    ts.forEachChild(site, visit);
  }
  for (const w of candidates) {
    if (decidedByFallback(w, site)) {
      const col = w.arguments[2];
      return { filter: "preview", column: col === undefined ? "context_kind" : isStr(col) ? col.text : "?" };
    }
  }
  return { filter: "none", column: null };
}

function scan(file: string, src: string): Site[] {
  const sf = parse(file, src);
  const out: Site[] = [];
  const add = (node: ts.Node, helperCall: boolean) => {
    const chain = chainOf(node);
    const write = chainMethods(chain).some((m) => ["insert", "update", "upsert", "delete"].includes(m));
    const { filter, column } = write ? { filter: "none" as Filter, column: null } : filterOf(node, helperCall);
    out.push({
      file,
      fn: fnName(node),
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      kind: write ? "write" : "read",
      filter,
      column,
    });
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const a0 = n.arguments[0];
      if (name === "from" && ts.isPropertyAccessExpression(n.expression) && isStr(a0) && a0.text === TABLE) add(n, false);
      else if (name === "select" && ts.isPropertyAccessExpression(n.expression) && isStr(a0) && EMBED.test(a0.text)) add(n, false);
      else if (name !== "from" && n.arguments.some((a) => isStr(a) && a.text === TABLE)) add(n, true);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const key = (s: Site) => `${s.file} :: ${s.fn} :: ${s.filter}${s.column && s.column !== "context_kind" ? ` (${s.column})` : ""}`;
const allSites: Site[] = [];
for (const [file, src] of sources) if (src.includes(TABLE)) allSites.push(...scan(file, src));
const reads = allSites.filter((s) => s.kind === "read");

// ---------------------------------------------------------------------------
console.log("\n(a) the tenant LRS: every course_attempts read under lib/lrs/ drops previews");
{
  const LRS_READS = [
    "lib/lrs/abandoned.ts :: enqueueAbandonedStatements :: preview",
    "lib/lrs/context.ts :: loadAttemptContexts :: none",
    "lib/lrs/context.ts :: loadAttemptContexts :: none",
    "lib/lrs/context.ts :: loadAttemptContexts :: preview",
    "lib/lrs/context.ts :: loadAttemptContexts :: preview",
    "lib/lrs/context.ts :: loadSiblings :: none",
    "lib/lrs/context.ts :: loadSiblings :: preview",
    "lib/lrs/enqueue.ts :: orgForAttempt :: preview",
    "lib/lrs/sweep.ts :: srcAttempts :: preview",
    "lib/lrs/sweep.ts :: srcPathSteps :: preview",
    "lib/lrs/sweep.ts :: srcPathSteps :: preview",
    "lib/lrs/sweep.ts :: srcScorm :: preview",
    "lib/lrs/sweep.ts :: srcStatements :: preview (course_attempts.context_kind)",
  ];
  const lrs = reads.filter((s) => s.file.startsWith("lib/lrs/"));
  eq("every course_attempts read under lib/lrs/, with its filter", lrs.map(key).sort(), [...LRS_READS].sort());

  // The unfiltered reads are today's selects of a database without 0103
  // (which has no 0107 either): each sits after a readOrMissing tier that
  // answered "missing" on is_revision.
  const ctx = read("lib/lrs/context.ts");
  const fallbacks = lrs.filter((s) => s.filter === "none");
  eq("the unfiltered reads are exactly the pre-0103 tiers: loadSiblings' safe() select and loadAttemptContexts' two older tiers", fallbacks.map((s) => s.fn), ["loadSiblings", "loadAttemptContexts", "loadAttemptContexts"]);
  const sibAt = ctx.indexOf("async function loadSiblings(");
  const sib = ctx.slice(sibAt, ctx.indexOf("export type LearnerDims", sibAt));
  eq("loadSiblings: the unfiltered select runs only after a missing is_revision (a failed tier throws first)",
    /if \("data" in flagged\) return flagged\.data;\s*if \("failed" in flagged\) throw new ContextReadError\("siblings"\);\s*return safe<Row\[\]>\(/.test(sib), true);
  const lacAt = ctx.indexOf("export async function loadAttemptContexts(");
  const lac = ctx.slice(lacAt, ctx.indexOf("const orgIds =", lacAt));
  eq("loadAttemptContexts: the older tiers run only when the first tier answered no data",
    /if \("failed" in flagged\) throw new ContextReadError\("attempts"\);\s*const attempts =\s*\("data" in flagged \? flagged\.data : null\) \?\?/.test(lac), true);
  eq("loadAttemptContexts takes the caller's decision (a fresh one when none is passed) and gives it to loadSiblings",
    /previews: ContextFilterState = \{ applies: null \}\s*\): Promise<Map<string, AttemptContext>>/.test(ctx) && /loadSiblings\(svc, userIds, courseIds, previews\)/.test(ctx), true);

  // Every loadAttemptContexts call under lib/lrs/ passes its caller's state.
  const calls: string[] = [];
  for (const [file, src] of sources) {
    if (!file.startsWith("lib/lrs/") && !file.startsWith("app/") && !file.startsWith("lib/")) continue;
    const sf = parse(file, src);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && calleeName(n) === "loadAttemptContexts") calls.push(`${file} :: ${fnName(n)} :: ${n.arguments[3]?.getText(sf) ?? "(none)"}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  eq("every loadAttemptContexts call passes its caller's decision", calls.sort(), [
    "lib/lrs/abandoned.ts :: enqueueAbandonedStatements :: previews",
    "lib/lrs/enqueue.ts :: enrichForOutbox :: previews",
    "lib/lrs/sweep.ts :: srcAttempts :: env.previews",
    "lib/lrs/sweep.ts :: srcPathSteps :: env.previews",
    "lib/lrs/sweep.ts :: srcScorm :: env.previews",
    "lib/lrs/sweep.ts :: srcStatements :: env.previews",
  ]);

  const sweep = read("lib/lrs/sweep.ts");
  eq("the sweep: one decision per run (Env.previews), set fresh where each run's Env is built",
    /previews: ContextFilterState;/.test(sweep) &&
      (sweep.match(/previews: \{ applies: null \}/g) ?? []).length === 2 &&
      /const env: Env = \{ db, orgId, org, groups, chunk, previews: \{ applies: null \} \};/.test(sweep) &&
      /RUNNERS\[source\]\(\{ db, orgId, org, groups, chunk, previews: \{ applies: null \} \}, cursor\)/.test(sweep), true);
  eq("the sweep's attempt sources are exactly the four that read attempts (the others read xp_events, journeys, badges, ratings, assignments)",
    [...new Set(lrs.filter((s) => s.file === "lib/lrs/sweep.ts").map((s) => s.fn))].sort(), ["srcAttempts", "srcPathSteps", "srcScorm", "srcStatements"]);
  eq("…and RUNNERS still names each of them (\"Resend all history\" runs the same sources from the beginning of time)",
    ["statements: srcStatements", "attempts: srcAttempts", "path_steps: srcPathSteps", "scorm: srcScorm"].every((x) => sweep.includes(x)), true);

  const enq = read("lib/lrs/enqueue.ts");
  eq("the live mirror: the organisation read comes first and carries the call's decision; a preview's null org returns before any config read or enqueue",
    /const previews: ContextFilterState = \{ applies: null \};\s*const orgId = await orgForAttempt\(attemptId, previews\);\s*if \(!orgId\) return;\s*const cfg = await loadLrsConfig\(orgId\);/.test(enq) &&
      /await enrichForOutbox\(attemptId, statements, statementProfileOf\(cfg\), previews\)/.test(enq), true);
}

// ---------------------------------------------------------------------------
console.log("\n(b) the raw readers (step 49's row): every course_attempts read on an admin, manager, attention or CRM surface drops previews");
const RAW_SCOPE = (f: string) =>
  f.startsWith("lib/manager/") ||
  f.startsWith("lib/attention/") ||
  f.startsWith("lib/integrations/") ||
  f.startsWith("app/[org]/(admin)/") ||
  f.startsWith("app/api/integrations/") ||
  f === "app/api/learning-paths/[id]/learners/export/route.ts" ||
  f === "app/api/courses/[courseId]/learners/export/route.ts";
/** Every reader of items 1 to 1c of the plan (P2-3), and the Individual readers of phase 1. */
const READERS: Array<[string, string]> = [
  // Item 1: both CRM feeds, Learner Analytics, the Report Card.
  ["lib/integrations/progress.ts :: usersMatchingAttempts :: preview", "item 1: the CRM progress feed's pre-selection"],
  ["lib/integrations/progress.ts :: buildProgress :: preview", "item 1: the CRM progress feed"],
  ["app/api/integrations/learner-summary/route.ts :: GET :: preview", "item 1: the CRM learner-summary feed"],
  ["app/[org]/(admin)/analytics/page.tsx :: AnalyticsPage :: preview", "item 1: Learner Analytics' tally and last activity (one read feeds every fold)"],
  ["lib/manager/insights.ts :: fetchAttemptRows :: preview", "item 1: the Report Card's engagement read"],
  // Item 1c: step 49's raw-reader row.
  ["app/[org]/(admin)/reports/page.tsx :: ReportsPage :: preview", "item 1c: the org Reports attempts read"],
  ["app/[org]/(admin)/reports/page.tsx :: ReportsPage :: preview", "item 1c: the org Reports ignored-pass read"],
  ["app/[org]/(admin)/attempt-requests/page.tsx :: AttemptRequestsPage :: preview", "item 1c"],
  ["app/[org]/(admin)/journey-admin/page.tsx :: JourneyAdminPage :: preview", "item 1c"],
  ["app/[org]/(admin)/learning-paths/page.tsx :: LearningPathsPage :: preview", "item 1c"],
  ["app/[org]/(admin)/learning-paths/[pathId]/learners/page.tsx :: PathLearnersPage :: preview", "item 1c"],
  ["app/[org]/(admin)/learning-paths/[pathId]/reports/page.tsx :: PathReportsPage :: preview", "item 1c: the path-context read"],
  ["app/[org]/(admin)/learning-paths/[pathId]/reports/page.tsx :: PathReportsPage :: preview", "item 1c: the official-verdict read"],
  ["app/api/learning-paths/[id]/learners/export/route.ts :: GET :: preview", "item 1c: the path learners CSV"],
  ["lib/attention/collect.ts :: ignoredPassItems :: preview", "item 1c: the Attention Center's ignored-pass items"],
  // Phase 1 (step 49): the Individual product's reads; a preview is not Individual.
  ["app/[org]/(admin)/library/[courseId]/learners/page.tsx :: LearnersPage :: individual", "phase 1: the Individual context only"],
  ["app/api/courses/[courseId]/learners/export/route.ts :: GET :: individual", "phase 1: the Individual context only"],
];
/** In scope, not filtered by this slice: each with its reason and the phase that closes it. */
const EXEMPT: Array<[string, string]> = [
  ["lib/integrations/webhook.ts :: fireCompletionWebhookForAttempt :: none",
    "the completion webhook of one attempt, not a feed: P2-5 item 5 (step 60) keeps the write routes from calling it for a preview, and phase 3 fires it from the writer's official claim (step 80's webhook row)"],
  ["lib/integrations/webhook-hold.ts :: heldWebhookPage :: none",
    "the held-webhook sweep and the Attention count built on it select completions by the webhook latch; phase 3 moves the webhook onto the writer, which skips previews (step 80's webhook row)"],
];
{
  const raw = reads.filter((s) => RAW_SCOPE(s.file));
  const want = [...READERS, ...EXEMPT].map(([k]) => k).sort();
  eq("every course_attempts read in scope, with its filter: READERS and EXEMPT, nothing else", raw.map(key).sort(), want);
  eq("no listed reader reads without a filter", READERS.filter(([k]) => k.endsWith(":: none")).map(([k]) => k), []);
  eq("non-vacuous: the scan found the plan's item 1 and 1c readers", raw.filter((s) => s.filter === "preview").length, 15);
  const writes = allSites.filter((s) => s.kind === "write" && RAW_SCOPE(s.file)).map((s) => `${s.file} :: ${s.fn}`);
  eq("the only write in scope is the webhook latch (not a read)", writes, ["lib/integrations/webhook.ts :: fireCompletionWebhookForAttempt"]);
  // The progress route shares one decision for the pre-selection and every batch.
  const route = read("app/api/integrations/progress/route.ts");
  eq("the CRM progress route: one decision for the request, passed to the pre-selection and every buildProgress call",
    /const previews: ContextFilterState = \{ applies: null \};/.test(route) &&
      /usersMatchingAttempts\(svc, orgId, f, previews\)/.test(route) &&
      (route.match(/buildProgress\([^;]*, f, tz, previews\)/g) ?? []).length === 2, true);
}

// ---------------------------------------------------------------------------
console.log("\n(c) the interim limits recorded by P2-3 (item 1c), each with the phase that ends it");
/**
 * INTERIM_0024 (2026-11-15, ADR 0024 P2-3 item 1c): until their own phases,
 * an enrolled staff member's Preview still counts as their own record here.
 * Each entry leaves this list in the pull request of its phase.
 *   - the reminders cron's completed-pairs read: a staff member who
 *     previewed an assigned course to completion gets no reminder for it;
 *     phase 7 moves the cron to the Individual rule (step 49's reminders row);
 *   - their own learner pages: the files on PENDING_0024
 *     (tests/unit/revision-listing.test.ts), phase 6.
 */
{
  const reminders = read("app/api/cron/reminders/route.ts");
  const sites = scan("app/api/cron/reminders/route.ts", reminders).filter((s) => s.kind === "read");
  eq("the reminders cron (phase 7): one course_attempts read, not yet filtered (this entry leaves when phase 7 filters it)",
    sites.map((s) => `${s.fn} :: ${s.filter}`), ["POST :: none"]);
  const listing = read("tests/unit/revision-listing.test.ts");
  eq("the learner pages (phase 6): PENDING_0024 still holds the learner dashboard and course pages",
    ["app/[org]/(learner)/dashboard/page.tsx", "app/[org]/(learner)/courses/[courseId]/page.tsx"].every((f) => listing.includes(`"${f}"`)), true);
}

// ---------------------------------------------------------------------------
console.log("\n(d) no preview decision lives at module level");
{
  const top: string[] = [];
  for (const [file, src] of sources) {
    if (!src.includes("applies: null")) continue;
    const sf = parse(file, src);
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st) && /applies:\s*null/.test(st.getText(sf))) top.push(file);
    }
  }
  eq("no top-level `{ applies: null }`: a decision made before a paste must not outlive its request", top, []);
}

// ---------------------------------------------------------------------------
console.log("\n(e) step 81: only lib/preview/purge.ts may name purge_preview_data");
{
  /** The code without comments (strings and identifiers kept). */
  const code = (file: string, src: string) => ts.createPrinter({ removeComments: true }).printFile(parse(file, src));
  const naming = [...sources].filter(([file, src]) => src.includes("purge_preview_data") && code(file, src).includes("purge_preview_data")).map(([f]) => f);
  eq("no application file (app/, lib/, components/) but lib/preview/purge.ts names it", naming.filter((f) => f !== "lib/preview/purge.ts"), []);
  const wf = path.join(root, ".github/workflows");
  const yml = fs.existsSync(wf) ? fs.readdirSync(wf).filter((f) => /\.ya?ml$/.test(f) && fs.readFileSync(path.join(wf, f), "utf8").includes("purge_preview_data")) : [];
  eq("no workflow names it (nothing deletes Preview data on a schedule)", yml, []);
  eq("today no application file names it at all (lib/preview/ comes in phase P)", naming, []);
}

// ---------------------------------------------------------------------------
console.log("\n(f) planted sources: the scanner flags what it must");
{
  const one = (src: string) => scan("planted.ts", src).map((s) => `${s.kind}:${s.filter}${s.column && s.column !== "context_kind" ? `(${s.column})` : ""}`);
  eq("a plain read: none", one(`async function f(db) { return db.from("course_attempts").select("id").eq("id", x); }`), ["read:none"]);
  eq("a write is not a read", one(`async function f(db) { await db.from("course_attempts").update({ a: 1 }).eq("id", x); }`), ["write:none"]);
  eq("the filter through the fallback: preview",
    one(`async function f(db, s) { return readWithContextFilter(s, (apply) => withoutPreviews(db.from("course_attempts").select("id"), apply).limit(1)); }`), ["read:preview"]);
  eq("withoutPreviews without the fallback: none",
    one(`async function f(db, apply) { return withoutPreviews(db.from("course_attempts").select("id"), apply); }`), ["read:none"]);
  eq("withoutPreviews with a hard-coded true: none",
    one(`async function f(db, s) { return readWithContextFilter(s, (apply) => withoutPreviews(db.from("course_attempts").select("id"), true)); }`), ["read:none"]);
  eq("the fallback whose read never filters: none",
    one(`async function f(db, s) { return readWithContextFilter(s, (apply) => db.from("course_attempts").select("id")); }`), ["read:none"]);
  eq("an apply that is not the fallback's parameter: none",
    one(`async function f(db, s, other) { return readWithContextFilter(s, (apply) => withoutPreviews(db.from("course_attempts").select("id"), other)); }`), ["read:none"]);
  eq("the query outside withoutPreviews' first argument: none",
    one(`async function f(db, s) { const q = db.from("course_attempts").select("id"); return readWithContextFilter(s, (apply) => withoutPreviews(other, apply)); }`), ["read:none"]);
  eq("an embed through the fallback, with its column",
    one(`async function f(db, s) { return readWithContextFilter(s, (apply) => withoutPreviews(db.from("xapi_statements").select("id, course_attempts!inner(organization_id)"), apply, "course_attempts.context_kind")); }`),
    ["read:preview(course_attempts.context_kind)"]);
  eq("an unfiltered embed: none", one(`async function f(db) { return db.from("xapi_statements").select("id, course_attempts!inner(organization_id)"); }`), ["read:none"]);
  eq("a helper given the table, with the filter in its apply",
    one(`async function f(svc, s) { return readWithContextFilter(s, async (apply) => ({ data: await fetchByIds(svc, "course_attempts", "id", "user_id", ids, (q) => withoutPreviews(q, apply)), error: null })); }`), ["read:preview"]);
  eq("a helper given the table, no filter: none", one(`async function f(svc) { return fetchByIds(svc, "course_attempts", "id", "user_id", ids); }`), ["read:none"]);
  eq("the Individual filter: individual",
    one(`async function f(db, st) { return individualContextOnly(st, (c, a, b, only) => { const q = db.from("course_attempts").select(c); return only ? q.eq("context_kind", "individual") : q; }); }`), ["read:individual"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
