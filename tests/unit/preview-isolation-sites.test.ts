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
 * (`lib/scoring/context-read.ts`), with `state` a variable, a property or a
 * fresh `{ applies: null }`: on a database without 0107 it reads today's
 * select once (`docs/ARCHITECTURE.md` principle 6). A read inside
 * `individualContextOnly(state, …)` (the same rule for its state) takes the
 * Individual context only, which leaves previews out by construction (step
 * 49; which files is tests/unit/enrolment-definition.test.ts (e)). A read
 * that selects previews only (`.eq("context_kind", "preview")`) outside
 * every fallback is the drain's check (only-previews).
 *
 *   (a) the tenant LRS: every course_attempts read under lib/lrs/
 *       (lib/lrs/abandoned.ts included) is filtered, except the listed
 *       selects of a database without 0103 (which has no 0107 either);
 *       every loadAttemptContexts call there passes its caller's decision;
 *       the sweep's state is one per run; the live mirror's organisation
 *       read is filtered; the outbox drainer parks a Preview's rows before
 *       any post ("Resend all history" sets every row back to pending), and
 *       its preview path (previewRowIds and the statement that calls it)
 *       deletes nothing and writes only next_attempt_at and last_error
 *       (preview data is deleted by hand only; reading R26). The callers
 *       of enqueueAbandonedStatements are scanned in
 *       tests/unit/lrs-abandon-sites.test.ts, extended by this slice, not
 *       copied here.
 *   (b) the raw readers (step 49's row): every course_attempts read under
 *       lib/manager/, lib/attention/, lib/integrations/, lib/interactions/,
 *       the admin pages (app/[org]/(admin)/), the Report Card pages
 *       (app/[org]/(learner)/team-performance/), the CRM routes
 *       (app/api/integrations/) and the two learners CSV routes is filtered
 *       or takes the Individual context, except the listed exemptions with
 *       their reason and phase; READERS lists every reader of items 1 to 1c
 *       of the plan, so a new reader fails here until it is filtered and
 *       listed.
 *   (c) the dated interim limits the plan records (P2-3 item 1c).
 *   (d) no ContextFilterState lives at module level (a decision made before
 *       a paste must not outlive its request); every `applies:` an object
 *       literal writes under app/, lib/ and components/ is `null`, and only
 *       the fallback (lib/scoring/attempt-kind.ts) assigns `.applies`.
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
/** "only-previews": the read selects previews only (`.eq("context_kind", "preview")`) outside every fallback (the drain's check). */
type Filter = "preview" | "individual" | "only-previews" | "none";
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

const propText = (n: ts.PropertyName): string | null => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null);

/**
 * A fallback's state argument as the readers pass it: a variable or a
 * property (a decision handed in), or a fresh `{ applies: null }`. A literal
 * that decides (`{ applies: false }`, which never filters) or any other
 * expression does not count as decided by the fallback.
 */
function stateHandedIn(n: ts.Expression | undefined): boolean {
  if (!n) return false;
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) return true;
  if (!ts.isObjectLiteralExpression(n) || n.properties.length !== 1) return false;
  const p = n.properties[0];
  return ts.isPropertyAssignment(p) && propText(p.name) === "applies" && p.initializer.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * Whether `w`, a `withoutPreviews(query, apply, column?)` call, takes its
 * `apply` from the function given to `readWithContextFilter(state, fn)`,
 * that function also holds the site, and `state` is handed in or fresh
 * (stateHandedIn).
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
      stateHandedIn(call.arguments[0]) &&
      call.arguments[1] === p && within(site, p)
    );
  }
  return false;
}

/** The fallbacks: on a database without the column each re-reads without the filter. */
const FALLBACKS = new Set(["readWithContextFilter", "readWithOptionalFilter", "individualContextOnly"]);

/**
 * Whether the site's chain selects previews only (`.eq("context_kind",
 * "preview")`) outside every fallback. Inside one the re-read would drop the
 * filter and select every attempt, so it does not count.
 */
function previewsOnly(site: ts.Node): boolean {
  let eqPreview = false;
  const visit = (x: ts.Node) => {
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
      const [a0, a1] = x.arguments;
      if (x.expression.name.text === "eq" && isStr(a0) && a0.text === "context_kind" && isStr(a1) && a1.text === "preview") eqPreview = true;
      visit(x.expression.expression);
    }
  };
  visit(chainOf(site));
  if (!eqPreview) return false;
  for (let p: ts.Node | undefined = site.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && FALLBACKS.has(calleeName(p) ?? "")) return false;
  }
  return true;
}

function filterOf(site: ts.Node, helperCall: boolean): { filter: Filter; column: string | null } {
  const candidates: ts.CallExpression[] = [];
  for (let p: ts.Node | undefined = site.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && calleeName(p) === "withoutPreviews" && p.arguments[0] && within(site, p.arguments[0])) candidates.push(p);
    if (ts.isCallExpression(p) && calleeName(p) === "individualContextOnly") {
      return stateHandedIn(p.arguments[0]) ? { filter: "individual", column: null } : { filter: "none", column: null };
    }
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
  if (!helperCall && previewsOnly(site)) return { filter: "only-previews", column: null };
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

/**
 * The outbox drainer's preview path: the function previewRowIds and the
 * statement of the calling function's body that holds its call (the block
 * that consumes its answer). Answers whether both were found, every
 * `.delete(…)` call inside them, and the keys of every `.update({ … })` they
 * write. Preview data is kept until an authorised admin deletes it by hand
 * and the by-role rows are preserved (ADR 0024 line "Preview data", reading
 * R26), so the path parks a Preview's rows and never deletes them; the
 * route's other delete (an org whose forwarding is off) is outside it. Pure
 * over (file name, text), so (f) plants through it.
 */
function previewPath(file: string, src: string): { found: boolean; deletes: string[]; updates: string[][] } {
  const sf = parse(file, src);
  const at: { fn?: ts.Node; consumer?: ts.Node } = {};
  const find = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "previewRowIds") at.fn = n;
    if (ts.isCallExpression(n) && calleeName(n) === "previewRowIds") {
      let s: ts.Node = n;
      while (s.parent && !(ts.isBlock(s.parent) && isFn(s.parent.parent))) s = s.parent;
      if (s.parent) at.consumer = s;
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  const deletes: string[] = [];
  const updates: string[][] = [];
  const visit = (x: ts.Node) => {
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
      const name = x.expression.name.text;
      if (name === "delete") deletes.push(`${fnName(x)}:${sf.getLineAndCharacterOfPosition(x.getStart()).line + 1}`);
      const a0 = x.arguments[0];
      if (name === "update") updates.push(a0 && ts.isObjectLiteralExpression(a0) ? a0.properties.map((p) => (p.name ? p.name.getText(sf) : "…")) : ["?"]);
    }
    ts.forEachChild(x, visit);
  };
  for (const root of [at.fn, at.consumer]) if (root) visit(root);
  return { found: !!at.fn && !!at.consumer, deletes, updates };
}

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

  // The outbox drainer: rows queued before the sources dropped previews, rows
  // "Resend all history" sets back to pending, and points or journey-day rows
  // that name a preview's attempt are parked before any post, never posted
  // and never deleted (behaviour: tests/unit/lrs-forward.test.ts).
  const DRAINER = "app/api/cron/lrs-forward/route.ts";
  eq("the drainer: one course_attempts read, previews only and outside every fallback (whose re-read would select every attempt)",
    reads.filter((s) => s.file === DRAINER).map(key), [`${DRAINER} :: previewRowIds :: only-previews`]);
  const drainer = read(DRAINER);
  eq("…the due select names attempt_id; a missing context_kind reads as no previews; the check runs before the batch is grouped and posted",
    /\.select\("id, organization_id, statement_id, payload, attempts, attempt_id"\)/.test(drainer) &&
      /if \(isMissingColumn\(error, "context_kind"\)\) return \{ ids: new Set\(\) \};/.test(drainer) &&
      drainer.indexOf("await previewRowIds(db, rows)") > 0 &&
      drainer.indexOf("await previewRowIds(db, rows)") < drainer.indexOf("const byOrg = new Map"), true);
  eq("…its preview path (previewRowIds and the statement that calls it) deletes nothing: its one write parks (next_attempt_at, last_error), status and attempts untouched",
    previewPath(DRAINER, drainer), { found: true, deletes: [], updates: [["next_attempt_at", "last_error"]] });
}

// ---------------------------------------------------------------------------
console.log("\n(b) the raw readers (step 49's row): every course_attempts read on an admin, manager, attention or CRM surface drops previews");
const RAW_SCOPE = (f: string) =>
  f.startsWith("lib/manager/") ||
  f.startsWith("lib/attention/") ||
  f.startsWith("lib/integrations/") ||
  f.startsWith("lib/interactions/") ||
  f.startsWith("app/[org]/(admin)/") ||
  f.startsWith("app/[org]/(learner)/team-performance/") ||
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
    "the held-webhook sweep and the Attention count built on it: P2-5 item 5b adds the preview filter (the entry then moves to READERS); phase 3's writer replaces it"],
  ["lib/interactions/labels.ts :: readChunk :: none",
    "question labels only: the text a stored statement gives a question id, through an attempts embed by version; no learner identity, no count and no date (no phase: not a learner record)"],
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
/** The one file that may decide a filter state (readWithOptionalFilter). */
const DECIDER = "lib/scoring/attempt-kind.ts";
/**
 * Every `applies` a source writes. An object literal's `applies:` must be
 * `null` (a fresh decision; `{ applies: false }` would never filter), a
 * shorthand `{ applies }` is not allowed, and an assignment to `.applies` or
 * `["applies"]` is allowed only in DECIDER. A type's `applies:` is a
 * property signature, not a write, and is not read. Pure over (file, text),
 * so (f) plants through it.
 */
function stateWrites(file: string, src: string): { fresh: number; assigned: number; violations: string[] } {
  const sf = parse(file, src);
  const out = { fresh: 0, assigned: 0, violations: [] as string[] };
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && propText(n.name) === "applies") {
      if (n.initializer.kind === ts.SyntaxKind.NullKeyword) out.fresh++;
      else out.violations.push(`${at(n)} applies: ${n.initializer.getText(sf)}`);
    } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === "applies") {
      out.violations.push(`${at(n)} { applies }`);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ((ts.isPropertyAccessExpression(n.left) && n.left.name.text === "applies") ||
        (ts.isElementAccessExpression(n.left) && isStr(n.left.argumentExpression) && n.left.argumentExpression.text === "applies"))
    ) {
      if (file === DECIDER) out.assigned++;
      else out.violations.push(`${at(n)} ${n.getText(sf)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

console.log("\n(d) no preview decision lives at module level, and none is made outside the fallback");
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

  let fresh = 0, assigned = 0;
  const violations: string[] = [];
  for (const [file, src] of sources) {
    if (!src.includes("applies")) continue;
    const w = stateWrites(file, src);
    fresh += w.fresh;
    assigned += w.assigned;
    violations.push(...w.violations);
  }
  eq("every `applies:` an object literal writes under app/, lib/ and components/ is null, and only the fallback assigns `.applies`", violations, []);
  eq("non-vacuous: the fresh states were found (more than 20), and the fallback's two assignments", [fresh > 20, assigned], [true, 2]);
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

  // The state the fallback is given (finding M10 of the P2-3 review).
  const through = (state: string) =>
    one(`async function f(db, s, env) { return readWithContextFilter(${state}, (apply) => withoutPreviews(db.from("course_attempts").select("id"), apply)); }`);
  eq("a state handed in (a variable, a property) or a fresh { applies: null }: preview",
    [through("s"), through("env.previews"), through("{ applies: null }")], [["read:preview"], ["read:preview"], ["read:preview"]]);
  eq("a decided literal ({ applies: false } never filters, { applies: true }) or a call: none",
    [through("{ applies: false }"), through("{ applies: true }"), through("fresh()"), through("{ applies: null, other: 1 }")],
    [["read:none"], ["read:none"], ["read:none"], ["read:none"]]);
  eq("the Individual filter given a decided literal: none",
    one(`async function f(db) { return individualContextOnly({ applies: false }, (c, a, b, only) => db.from("course_attempts").select(c)); }`), ["read:none"]);

  // The drain's check: previews only, outside every fallback.
  eq("a previews-only select: only-previews",
    one(`async function f(db, ids) { return db.from("course_attempts").select("id").in("id", ids).eq("context_kind", "preview"); }`), ["read:only-previews"]);
  eq("a previews-only select inside the fallback (its re-read selects every attempt): none",
    one(`async function f(db, s) { return readWithContextFilter(s, (apply) => db.from("course_attempts").select("id").eq("context_kind", "preview")); }`), ["read:none"]);
  eq("another context_kind value: none",
    one(`async function f(db) { return db.from("course_attempts").select("id").eq("context_kind", "individual"); }`), ["read:none"]);

  // The drainer's preview path: a delete put back where the park is, or into previewRowIds, is flagged.
  const drain = (consume: string, inFn = "") =>
    previewPath("planted.ts", `async function previewRowIds(db, rows) { ${inFn} const { data } = await db.from("course_attempts").select("id").in("id", ids).eq("context_kind", "preview"); return { ids: new Set() }; }
export async function POST() {
  let rows = [];
  if (rows.some((r) => r.attempt_id)) {
    const check = await previewRowIds(db, rows);
    if (check.ids.size > 0) { ${consume} }
  }
  await db.from("lrs_forward_outbox").delete().in("id", off);
}`);
  const PARK = `await db.from("lrs_forward_outbox").update({ next_attempt_at: PARK_UNTIL, last_error: PARK_REASON }).in("id", part);`;
  eq("the park as the route writes it (the delete for an org whose forwarding is off is outside the path): nothing flagged",
    drain(PARK), { found: true, deletes: [], updates: [["next_attempt_at", "last_error"]] });
  eq("the delete put back in place of the park: flagged",
    drain(`await db.from("lrs_forward_outbox").delete().in("id", [...check.ids]);`), { found: true, deletes: ["POST:6"], updates: [] });
  eq("a delete inside previewRowIds: flagged",
    drain(PARK, `await db.from("lrs_forward_outbox").delete().in("attempt_id", ids);`).deletes, ["previewRowIds:1"]);
  eq("a park that also writes status (a dead letter would breach ops health): its keys show it",
    drain(`await db.from("lrs_forward_outbox").update({ status: "dead", next_attempt_at: PARK_UNTIL, last_error: PARK_REASON }).in("id", part);`).updates, [["status", "next_attempt_at", "last_error"]]);
  eq("a source without previewRowIds or its call: not found",
    [previewPath("planted.ts", `export async function POST() { await db.from("lrs_forward_outbox").delete().in("id", ids); }`).found,
      previewPath("planted.ts", `async function previewRowIds() { return { ids: new Set() }; }`).found], [false, false]);

  // Writes to a state (finding M11 of the P2-3 review: env.previews.applies = false in sweepOrg).
  const writes = (src: string, file = "planted.ts") => stateWrites(file, src).violations.length;
  eq("an assignment to .applies outside the fallback, in every form: flagged",
    [writes(`function f(env) { env.previews.applies = false; }`), writes(`function f(s) { s["applies"] = true; }`), writes(`function f(s) { s.applies ??= false; }`)], [1, 1, 1]);
  eq("a decided literal, a spread over a state and a shorthand: flagged",
    [writes(`const s = { applies: false };`), writes(`function f(s) { return { ...s, applies: true }; }`), writes(`function f(applies) { return { applies }; }`)], [1, 1, 1]);
  eq("a fresh literal, a type's property and the fallback's own assignment: not flagged",
    [writes(`type T = { applies: boolean | null }; function f() { const s: T = { applies: null }; return s; }`), writes(`function f(s) { s.applies = true; }`, DECIDER)], [0, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
