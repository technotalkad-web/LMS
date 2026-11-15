/**
 * Guard for ADR 0024 step 45 and step 62's row "journey-credit-sites.test.ts"
 * (phase 2 slice P2-4; decision A27, build note N18): no file outside
 * lib/journey/ derives a journey count from the number of
 * journey_day_progress rows or matches a credit by day_number, and every
 * caller of computeJourneyState passes `creditedDays` from creditedDaysFor
 * (or, for the two journey_reminder_counts readers, reminderCreditedDays).
 *
 * It reads the sources, not a database. Over the .ts and .tsx files of app/,
 * lib/ and components/ (lib/journey/ left out by name: it holds the twin, the
 * reader and their number fallback), parsed with the TypeScript parser:
 *
 *   (1) every computeJourneyState call (by its imported name or an alias)
 *       takes an object literal that names no `completedCount` and names
 *       `creditedDays` with one of: a call of creditedDaysFor or
 *       reminderCreditedDays; a const in scope whose initializer is such a
 *       call; or `<x>.credited_days` in a file of CARRIED, whose source file
 *       assigns `credited_days:` from a creditedDaysFor call (the journey
 *       admin page builds the client's rows on the server). The callers are
 *       pinned by file and count (P2-N3's twelve and the dashboard's, less
 *       the launch page's, which P2-6 removed: the launch decides through
 *       launch_context), so a new caller is listed here and held to the rule.
 *   (2) the string "journey_day_progress" in code (a `.from(...)`, a helper's
 *       table argument, anything) names a read of the credits; outside
 *       lib/journey/ only NOT_CREDIT_READERS may hold one, each pinned to its
 *       count with its reason. So no count read (`{ count: "exact" }`), no
 *       `rows.length` of a direct read and no per-enrolment count loop can
 *       come back: credits are read through lib/journey/credits-read.ts.
 *   (3) a file that reads credits (imports lib/journey/credits-read) never
 *       touches a row's `day_number` (a property access, an element access
 *       or a destructuring): a credit is matched by its day id inside
 *       creditedDaysFor. The one dated PENDING entry is the CRM feed's
 *       per-day lookup by day_number in lib/integrations/progress.ts, which
 *       phase 9a empties (the phase table prices it there); pinned to its
 *       exact count, and the test fails when it is stale.
 *   (4) a file that calls creditedDaysFor imports readJourneyCredits: the
 *       rows and the version's day_ids come from the one reader, with its
 *       fallback.
 *   (5) no count is taken from the reader's rows: (a) no `.length` or
 *       `.size` of an expression that holds a `.rowsOf(...)` call, or of a
 *       const in scope bound to one; (b) every property assignment named
 *       daysDone, days_completed or completed_count (the journey count
 *       fields of Learner Analytics, the Report Card and the CRM feeds) is a
 *       `<state>.completedCount`; (c) reminderCreditedDays is called only by
 *       the two journey_reminder_counts readers (REMINDER_FILES), on a const
 *       taken from reminderCountsFrom's countOf, so a failed read never
 *       reaches it as "nothing done".
 *   (6) every creditedDaysFor and creditCoursesFor call (the two matchings
 *       of credits to course days, by their imported names or an alias)
 *       takes the reader's answers: its first argument an object literal
 *       whose `day_ids` is a `<credits>.dayIdsOf(...)` call, its second a
 *       `<credits>.rowsOf(...)` call or a const bound to one. So no caller
 *       passes `day_ids: null` (by number on a database with 0107) or rows
 *       of its own. creditCoursesFor is no source of `creditedDays` (rule 1).
 *
 * Not counts, and left as they are (named in the ADR's P2-4 report): the
 * journey page's streak and the Report Card's days in the period and "last
 * active" read the credits' completed_at dates; lib/lrs/sweep.ts sends one
 * statement per credit row with its number as the label (rule 2's entry).
 *
 * Known limits (forms not followed; none exists in the tree today): a
 * `creditedDays` value built in another function and passed in, a `let`
 * reassigned, a table name built at run time, `.js`/`.mjs` sources under
 * app/ and lib/; for (5b), a shorthand property (lib/courses/progress-view.ts
 * returns `daysDone` from its parameter, which its one caller, Learner
 * Analytics, passes as `j.daysDone`, held by (5b) where it is assigned); for
 * (5a), a count two consts away from the rowsOf call.
 *
 * Run:  npx tsx tests/unit/journey-credit-sites.test.ts   (or npm run test:unit)
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
const SCAN_DIRS = ["app", "lib", "components"];
const EXCLUDED = ["lib/journey/"];
const TWIN = "computeJourneyState";
const SOURCES = new Set(["creditedDaysFor", "reminderCreditedDays"]);
/** The matchings of credits to course days that rule (6) holds to the reader's answers. */
const MATCHERS = new Set(["creditedDaysFor", "creditCoursesFor"]);
const TABLE = "journey_day_progress";
const READER_MODULE = /(^|\/)lib\/journey\/credits-read$|^@\/lib\/journey\/credits-read$|(^|\/)journey\/credits-read$/;

/**
 * The callers of computeJourneyState, by file and count (P2-N3, and the
 * dashboard's banner since P2-4). The launch page left the list in P2-6: its
 * own journey block is gone, and the launch is decided by launch_context's
 * facts and the resolver (lib/attempts/launch-context.ts), which reads no
 * credit rows and calls no twin.
 */
const CALLERS: Record<string, number> = {
  "app/[org]/(admin)/analytics/page.tsx": 1,
  "app/[org]/(admin)/journey-admin/journey-client.tsx": 2,
  "app/[org]/(admin)/journey-admin/page.tsx": 1,
  "app/[org]/(learner)/dashboard/page.tsx": 1,
  "app/[org]/(learner)/journey/page.tsx": 1,
  "app/api/cron/journey-nudges/route.ts": 1,
  "app/api/integrations/learner-summary/route.ts": 1,
  "lib/auth/course-access.ts": 1,
  "lib/integrations/progress.ts": 1,
  "lib/manager/actions.ts": 1,
  "lib/manager/insights.ts": 1,
};

/** Files whose `<x>.credited_days` is accepted, with the file that fills the field from creditedDaysFor. */
const CARRIED: Record<string, string> = {
  "app/[org]/(admin)/journey-admin/journey-client.tsx": "app/[org]/(admin)/journey-admin/page.tsx",
  "app/[org]/(admin)/journey-admin/page.tsx": "app/[org]/(admin)/journey-admin/page.tsx",
};

/** Readers of journey_day_progress outside lib/journey/ that are not credit counts, each with its reason. */
const NOT_CREDIT_READERS: Record<string, { sites: number; why: string; deferred?: { since: string; what: string } }> = {
  "lib/lrs/sweep.ts": {
    sites: 1,
    why: "the tenant LRS day statements: one write-once statement per credit row, keyed by the row's id, with the day's number at credit time as its label (step 93); no count and no match",
    // Not built by P2-4, recorded so it is not lost: the ADR's phase 2 plan
    // names no slice for it.
    deferred: {
      since: "2026-11-15",
      what: "step 45: this source does not send legacy_cross_context credits as attempt-backed days; unbuilt, and no slice of the phase 2 plan names it",
    },
  },
};

/** The two journey_reminder_counts readers, the only callers of reminderCreditedDays (rule 5c). */
const REMINDER_FILES = new Set(["app/api/cron/journey-nudges/route.ts", "lib/manager/actions.ts"]);
/** The journey count fields that must be the twin's completedCount (rule 5b). */
const COUNT_FIELDS = new Set(["daysDone", "days_completed", "completed_count"]);

/** The one dated pending entry of rule (3), pinned to its exact count of day_number sites. */
const PENDING: Record<string, { since: string; until: string; sites: number }> = {
  "lib/integrations/progress.ts": {
    since: "2026-11-15",
    until: "emptied by phase 9a (ADR 0024 step 93: the CRM days[] looks credits up by day id and gains an additive day_id)",
    sites: 3,
  },
};

const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (EXCLUDED.some((x) => `${rel(p)}/`.startsWith(x))) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
}

// ---------------------------------------------------------------------------
// The scanner. Pure over (file name, text), so the planted cases of (b) run
// through exactly the code that reads the repository.
// ---------------------------------------------------------------------------
type TwinCall = { line: number; problems: string[] };
type FileScan = {
  twinCalls: TwinCall[];
  tableSites: number[];
  dayNumberSites: number[];
  importsReader: boolean;
  importsReadJourneyCredits: boolean;
  callsCreditedDaysFor: boolean;
  /** Initializers of `credited_days:` property assignments: whether each holds a creditedDaysFor call. */
  carriesCreditedDays: boolean[];
  /** Rules (5) and (6): each a line and its problem. */
  countProblems: Array<{ line: number; problem: string }>;
  /** The creditedDaysFor, creditCoursesFor and reminderCreditedDays calls rules (6) and (5c) checked. */
  creditedCalls: number;
  creditCourseCalls: number;
  reminderCalls: number;
};

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const propText = (n: ts.PropertyName | undefined): string | null =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

function scanFile(file: string, text: string, carrierSources: (f: string) => boolean[] = () => []): FileScan {
  const sf = parse(file, text);
  const twinNames = new Set<string>();
  const sourceNames = new Map<string, string>(); // local name → imported name (creditedDaysFor / creditCoursesFor / reminderCreditedDays)
  let importsReader = false;
  let importsReadJourneyCredits = false;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const mod = st.moduleSpecifier.text;
    if (READER_MODULE.test(mod)) importsReader = true;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === TWIN) twinNames.add(el.name.text);
        if (SOURCES.has(imported) || MATCHERS.has(imported)) sourceNames.set(el.name.text, imported);
        if (imported === "readJourneyCredits" && READER_MODULE.test(mod)) importsReadJourneyCredits = true;
      }
    }
  }
  const calleeIs = (call: ts.CallExpression, names: (n: string) => boolean): boolean => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return names(e.text);
    if (ts.isPropertyAccessExpression(e)) return names(e.name.text);
    return false;
  };
  const isTwin = (c: ts.CallExpression) => calleeIs(c, (n) => n === TWIN || twinNames.has(n));
  // A source of creditedDays (rule 1): an alias resolves to its imported name, so creditCoursesFor never is one.
  const isSource = (c: ts.CallExpression) => calleeIs(c, (n) => SOURCES.has(sourceNames.get(n) ?? n));
  const containsSource = (n: ts.Node): boolean => {
    let found = false;
    const v = (x: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(x) && calleeIs(x, (k) => k === "creditedDaysFor" || sourceNames.get(k) === "creditedDaysFor")) found = true;
      else ts.forEachChild(x, v);
    };
    v(n);
    return found;
  };

  /** The declaration of `name` in scope at `at`: a const's initializer, a parameter, or nothing found. */
  function binding(name: string, at: ts.Node): { kind: "const"; init: ts.Expression | undefined } | { kind: "let" } | { kind: "param" } | { kind: "none" } {
    for (let p: ts.Node | undefined = at.parent; p; p = p.parent) {
      if (isFn(p) && p.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === name)) return { kind: "param" };
      const stmts = ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) ? p.statements : ts.isCaseClause(p) || ts.isDefaultClause(p) ? p.statements : null;
      if (!stmts) continue;
      for (const s of stmts) {
        if (!ts.isVariableStatement(s)) continue;
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) {
            return s.declarationList.flags & ts.NodeFlags.Const ? { kind: "const", init: d.initializer } : { kind: "let" };
          }
        }
      }
    }
    return { kind: "none" };
  }

  function sourceProblem(value: ts.Expression, at: ts.Node): string | null {
    const v = ts.isParenthesizedExpression(value) ? value.expression : value;
    if (ts.isCallExpression(v) && isSource(v)) return null;
    if (ts.isIdentifier(v)) {
      const b = binding(v.text, at);
      if (b.kind === "const" && b.init && ts.isCallExpression(b.init) && isSource(b.init)) return null;
      if (b.kind === "param") return `creditedDays: \`${v.text}\` is a parameter, which the scan cannot follow`;
      if (b.kind === "let") return `creditedDays: \`${v.text}\` is a let, which the scan cannot follow`;
      return `creditedDays: \`${v.text}\` is not a const holding creditedDaysFor(...) or reminderCreditedDays(...)`;
    }
    if (ts.isPropertyAccessExpression(v) && v.name.text === "credited_days") {
      const carrier = CARRIED[file];
      if (!carrier) return "creditedDays: `.credited_days` outside a file listed in CARRIED";
      const assigns = carrierSources(carrier);
      return assigns.length > 0 && assigns.every(Boolean) ? null : `creditedDays: ${carrier} does not fill credited_days from creditedDaysFor`;
    }
    return `creditedDays: \`${v.getText(sf)}\` is not from creditedDaysFor or reminderCreditedDays`;
  }

  const out: FileScan = {
    twinCalls: [], tableSites: [], dayNumberSites: [],
    importsReader, importsReadJourneyCredits, callsCreditedDaysFor: false, carriesCreditedDays: [], countProblems: [],
    creditedCalls: 0, creditCourseCalls: 0, reminderCalls: 0,
  };

  // Rules (5) and (6).
  const unparen = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unparen(e.expression) : e);
  const isMethodCall = (x: ts.Node, method: string): boolean =>
    ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === method;
  const holdsMethodCall = (n: ts.Node, method: string): boolean => {
    let found = false;
    const v = (x: ts.Node) => {
      if (found) return;
      if (isMethodCall(x, method)) found = true;
      else ts.forEachChild(x, v);
    };
    v(n);
    return found;
  };
  /** A const in scope at `at` named `name` whose initializer satisfies `test`. */
  const constWhose = (name: string, at: ts.Node, test: (init: ts.Expression) => boolean): boolean => {
    const b = binding(name, at);
    return b.kind === "const" && !!b.init && test(b.init);
  };
  const isRows = (e: ts.Expression, at: ts.Node): boolean => {
    const v = unparen(e);
    if (isMethodCall(v, "rowsOf")) return true;
    return ts.isIdentifier(v) && constWhose(v.text, at, (init) => isMethodCall(unparen(init), "rowsOf"));
  };
  /** The matching a call names (creditedDaysFor or creditCoursesFor, by its imported name), or null. */
  const matcherOf = (c: ts.CallExpression): string | null => {
    const e = c.expression;
    const k = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    if (k === null) return null;
    const imported = sourceNames.get(k) ?? k;
    return MATCHERS.has(imported) ? imported : null;
  };
  const isReminderCreditedDays = (c: ts.CallExpression) => calleeIs(c, (k) => k === "reminderCreditedDays" || sourceNames.get(k) === "reminderCreditedDays");
  const countRules = (n: ts.Node) => {
    const line = () => lineOf(sf, n);
    // (5a) a count of the reader's rows
    if (ts.isPropertyAccessExpression(n) && (n.name.text === "length" || n.name.text === "size")) {
      const target = unparen(n.expression);
      if (holdsMethodCall(target, "rowsOf") || (ts.isIdentifier(target) && constWhose(target.text, n, (init) => holdsMethodCall(init, "rowsOf")))) {
        out.countProblems.push({ line: line(), problem: `\`.${n.name.text}\` of the credit reader's rows (a row count; read the twin's completedCount)` });
      }
    }
    // (5b) a journey count field is the twin's completedCount
    if (ts.isPropertyAssignment(n)) {
      const name = propText(n.name);
      const v = unparen(n.initializer);
      if (name && COUNT_FIELDS.has(name) && !(ts.isPropertyAccessExpression(v) && v.name.text === "completedCount")) {
        out.countProblems.push({ line: line(), problem: `${name} is not \`<state>.completedCount\`` });
      }
    }
    // (5c) reminderCreditedDays: the two reminder readers only, on a row from countOf
    if (ts.isCallExpression(n) && isReminderCreditedDays(n)) {
      out.reminderCalls++;
      const a0 = n.arguments[0] ? unparen(n.arguments[0]) : undefined;
      if (!REMINDER_FILES.has(file)) out.countProblems.push({ line: line(), problem: "reminderCreditedDays outside the two journey_reminder_counts readers" });
      else if (!a0 || !ts.isIdentifier(a0) || !constWhose(a0.text, n, (init) => holdsMethodCall(init, "countOf"))) {
        out.countProblems.push({ line: line(), problem: "reminderCreditedDays on a row that is not a const taken from reminderCountsFrom's countOf" });
      }
    }
    // (6) creditedDaysFor and creditCoursesFor take the reader's answers
    const fn = ts.isCallExpression(n) ? matcherOf(n) : null;
    if (ts.isCallExpression(n) && fn) {
      if (fn === "creditedDaysFor") out.creditedCalls++;
      else out.creditCourseCalls++;
      const [a0, a1] = n.arguments;
      const v0 = a0 ? unparen(a0) : undefined;
      const dayIds = v0 && ts.isObjectLiteralExpression(v0)
        ? v0.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propText(p.name) === "day_ids")
        : undefined;
      const spread = v0 && ts.isObjectLiteralExpression(v0) && v0.properties.some((p) => ts.isSpreadAssignment(p));
      if (!dayIds || spread || !isMethodCall(unparen(dayIds.initializer), "dayIdsOf")) {
        out.countProblems.push({ line: line(), problem: `${fn}'s day_ids is not \`<credits>.dayIdsOf(...)\` in an object literal` });
      }
      if (!a1 || !isRows(a1, n)) {
        out.countProblems.push({ line: line(), problem: `${fn}'s rows are not \`<credits>.rowsOf(...)\` or a const bound to it` });
      }
    }
  };

  const visit = (n: ts.Node) => {
    countRules(n);
    if (ts.isCallExpression(n) && isTwin(n)) {
      const problems: string[] = [];
      const arg = n.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) problems.push("the argument is not an object literal, which the scan cannot read");
      else {
        let credited = false;
        for (const p of arg.properties) {
          if (ts.isSpreadAssignment(p)) { problems.push("a spread in the argument, which the scan cannot read"); continue; }
          const name = ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) ? propText(p.name) : null;
          if (name === "completedCount") problems.push("passes completedCount (a row count), not creditedDays");
          if (name !== "creditedDays") continue;
          credited = true;
          const value = ts.isShorthandPropertyAssignment(p) ? p.name : ts.isPropertyAssignment(p) ? p.initializer : null;
          const problem = value ? sourceProblem(value, n) : "creditedDays: unreadable";
          if (problem) problems.push(problem);
        }
        if (!credited) problems.push("names no creditedDays");
      }
      out.twinCalls.push({ line: lineOf(sf, n), problems });
    }
    if (ts.isCallExpression(n) && calleeIs(n, (k) => k === "creditedDaysFor" || sourceNames.get(k) === "creditedDaysFor")) out.callsCreditedDaysFor = true;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === TABLE && !ts.isImportDeclaration(n.parent)) {
      out.tableSites.push(lineOf(sf, n));
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "day_number") out.dayNumberSites.push(lineOf(sf, n));
    if (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression)) && n.argumentExpression.text === "day_number") {
      out.dayNumberSites.push(lineOf(sf, n));
    }
    if (ts.isBindingElement(n) && ((n.propertyName && propText(n.propertyName) === "day_number") || (!n.propertyName && ts.isIdentifier(n.name) && n.name.text === "day_number"))) {
      out.dayNumberSites.push(lineOf(sf, n));
    }
    if (ts.isPropertyAssignment(n) && propText(n.name) === "credited_days") out.carriesCreditedDays.push(containsSource(n.initializer));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The problems of one file under rules (1) to (6), with the lists above. */
function problemsOf(file: string, s: FileScan): string[] {
  const out: string[] = [];
  for (const c of s.twinCalls) for (const p of c.problems) out.push(`${file}:${c.line}: ${p}`);
  if (s.tableSites.length && !(file in NOT_CREDIT_READERS)) {
    out.push(`${file}:${s.tableSites.join(",")}: reads ${TABLE} outside lib/journey/ (read credits through lib/journey/credits-read.ts)`);
  }
  if (s.importsReader && s.dayNumberSites.length && !(file in PENDING)) {
    out.push(`${file}:${s.dayNumberSites.join(",")}: a credit's day_number is read beside the credits reader (match by day id, in creditedDaysFor)`);
  }
  if (s.callsCreditedDaysFor && !s.importsReadJourneyCredits) out.push(`${file}: calls creditedDaysFor without the credits reader`);
  for (const c of s.countProblems) out.push(`${file}:${c.line}: ${c.problem}`);
  return out;
}

// ---------------------------------------------------------------------------
// (a) the repository
// ---------------------------------------------------------------------------
const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(root, d), files);
const texts = new Map(files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));
const scans = new Map<string, FileScan>();
const carrierSources = (f: string) => scans.get(f)?.carriesCreditedDays ?? scanFile(f, texts.get(f) ?? "").carriesCreditedDays;
for (const [f, t] of texts) scans.set(f, scanFile(f, t, carrierSources));

console.log("\n(a) the repository");
{
  const callers = Object.fromEntries([...scans].filter(([, s]) => s.twinCalls.length).map(([f, s]) => [f, s.twinCalls.length]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  eq("the callers of computeJourneyState, by file and count (P2-N3's twelve calls and the dashboard's, less the launch page's since P2-6)", callers, CALLERS);
  const problems = [...scans].flatMap(([f, s]) => problemsOf(f, s));
  eq("rules (1) to (6) hold in every file", problems, []);
  // Non-vacuous: rule (6) saw every creditedDaysFor call and the journey
  // page's creditCoursesFor call (since P2-6 the done-day links open the
  // credit row's course; course-access grants on the credit rows themselves
  // and no longer matches them to course days), and (5c) both reminder calls.
  const seen = (k: "creditedCalls" | "creditCourseCalls" | "reminderCalls") =>
    Object.fromEntries([...scans].filter(([, s]) => s[k] > 0).map(([f, s]) => [f, s[k]]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  eq("rule (6) checked the creditedDaysFor call of every file that reads credits", Object.keys(seen("creditedCalls")),
    [...scans].filter(([, s]) => s.importsReadJourneyCredits).map(([f]) => f).sort((a, b) => a.localeCompare(b)));
  eq("rule (6) checked the one creditCoursesFor call, the journey page's", seen("creditCourseCalls"), { "app/[org]/(learner)/journey/page.tsx": 1 });
  eq("rule (5c) checked the two reminder readers' calls", seen("reminderCalls"), Object.fromEntries([...REMINDER_FILES].sort().map((f) => [f, 1])));
  for (const [f, n] of Object.entries(NOT_CREDIT_READERS)) {
    eq(`${f}: exactly ${n.sites} read of ${TABLE}, not a credit count (${n.why})`, scans.get(f)?.tableSites.length ?? 0, n.sites);
    if (n.deferred) console.log(`  note: ${f}, deferred since ${n.deferred.since}: ${n.deferred.what}`);
  }
  for (const [f, p] of Object.entries(PENDING)) {
    const s = scans.get(f);
    eq(`${f}: reads credits through the reader and holds exactly ${p.sites} day_number sites, pending since ${p.since}, ${p.until}`,
      [s?.importsReader ?? false, s?.dayNumberSites.length ?? 0], [true, p.sites]);
    if (s?.dayNumberSites.length) console.log(`  note: pending since ${p.since}: ${s.dayNumberSites.map((l) => `${f}:${l}`).join(", ")}`);
  }
  for (const [f, src] of Object.entries(CARRIED)) {
    const assigns = scans.get(src)?.carriesCreditedDays ?? [];
    eq(`${f}: its credited_days is filled in ${src} from creditedDaysFor`, assigns.length > 0 && assigns.every(Boolean), true);
  }
  eq("the reader is the one file under lib/journey/ that reads the credits",
    fs.readdirSync(path.join(root, "lib/journey")).filter((f) => /\.(ts|tsx)$/.test(f) && fs.readFileSync(path.join(root, "lib/journey", f), "utf8").includes(`.from("${TABLE}")`)),
    ["credits-read.ts"]);
}

// ---------------------------------------------------------------------------
// (b) planted cases: the scanner flags each form it must
// ---------------------------------------------------------------------------
console.log("\n(b) planted cases");
{
  const F = "app/planted/page.tsx";
  const IMPORTS = `import { computeJourneyState, creditCoursesFor, creditedDaysFor, reminderCreditedDays } from "@/lib/journey/journey";\nimport { readJourneyCredits } from "@/lib/journey/credits-read";\n`;
  const run = (body: string, file = F) => problemsOf(file, scanFile(file, `${IMPORTS}${body}`));
  const ARGS = "startDate: s, today: t, daysTotal: 5, countSundays: false, courseDays: cd";
  // creditedDaysFor as the reader answers it (rule 6).
  const CDF = "creditedDaysFor({ days: v.days, days_total: v.days_total, day_ids: credits.dayIdsOf(e.version_id) }, credits.rowsOf(e.id))";

  eq("a row count as completedCount is flagged (and no creditedDays)",
    run(`computeJourneyState({ ${ARGS}, completedCount: rows.length });`).map((p) => p.replace(/^.*?: /, "")),
    ["passes completedCount (a row count), not creditedDays", "names no creditedDays"]);
  eq("creditedDays from the number of rows is flagged",
    run(`computeJourneyState({ ${ARGS}, creditedDays: rows.map((r) => r.n) });`).length, 1);
  eq("creditedDays from creditedDaysFor(...) passes",
    run(`computeJourneyState({ ${ARGS}, creditedDays: ${CDF} });`), []);
  eq("…from reminderCreditedDays(...) passes, in a reminder reader on a row from countOf",
    run(`function f() { const cnt = counts.ok ? counts.countOf(e.id) : null; if (!cnt) return; return computeJourneyState({ ${ARGS}, creditedDays: reminderCreditedDays(cnt, cd) }); }`, "lib/manager/actions.ts"), []);
  eq("…a const in scope holding creditedDaysFor(...) passes, shorthand included",
    run(`function f() { const creditedDays = ${CDF}; return computeJourneyState({ ${ARGS}, creditedDays }); }`), []);
  eq("…the same name declared in another function only is flagged",
    run(`function a() { const creditedDays = ${CDF}; return creditedDays; }\nfunction b() { const creditedDays = [1, 2]; return computeJourneyState({ ${ARGS}, creditedDays }); }`).length, 1);
  eq("…a parameter is flagged (cannot be followed)",
    run(`function f(creditedDays: number[]) { return computeJourneyState({ ${ARGS}, creditedDays }); }`).map((p) => p.replace(/^.*?: /, "")),
    ["creditedDays: `creditedDays` is a parameter, which the scan cannot follow"]);
  eq("…an aliased import of the twin is followed",
    problemsOf(F, scanFile(F, `import { computeJourneyState as cjs } from "@/lib/journey/journey";\ncjs({ ${ARGS}, completedCount: 3 });`)).length, 2);
  eq("`.credited_days` in a file not listed in CARRIED is flagged",
    run(`computeJourneyState({ ${ARGS}, creditedDays: e.credited_days });`).map((p) => p.replace(/^.*?: /, "")),
    ["creditedDays: `.credited_days` outside a file listed in CARRIED"]);
  eq("a spread argument is flagged", run(`computeJourneyState({ ...opts, creditedDays: ${CDF} });`).length, 1);

  eq("a count read of the table is flagged",
    run(`const { count } = await svc.from("journey_day_progress").select("id", { count: "exact", head: true }).eq("enrollment_id", id);`).length, 1);
  eq("…a helper given the table name is flagged",
    run(`const rows = await fetchByIds(svc, "journey_day_progress", "enrollment_id", "enrollment_id", ids);`).length, 1);
  eq("…a direct read in a NOT_CREDIT_READERS file passes", run(`await db.from("journey_day_progress").select("id");`, "lib/lrs/sweep.ts"), []);

  eq("a credit's day_number beside the reader is flagged (property, element, destructuring)",
    run(`const a = r.day_number;\nconst b = r["day_number"];\nconst { day_number } = r;`).map((p) => p.split(": ")[0]), [`${F}:3,4,5`]);
  eq("…day_number in a file that does not read credits is not this rule's",
    problemsOf(F, scanFile(F, `const a = d.day_number;`)), []);
  eq("…in the pending file it passes (pinned by count above)", run(`m.set(r.day_number, at);`, "lib/integrations/progress.ts"), []);
  eq("creditedDaysFor without the reader's import is flagged",
    problemsOf(F, scanFile(F, `import { creditedDaysFor } from "@/lib/journey/journey";\nconst c = ${CDF};`)).map((p) => p.replace(/^.*?: /, "")),
    ["calls creditedDaysFor without the credits reader"]);

  // Rule (5): no count of the reader's rows.
  const why = (ps: string[]) => ps.map((p) => p.replace(/^.*?:\d+: /, ""));
  eq("(5a) `.length` of the reader's rows is flagged (a field, a banner day)",
    why(run(`const j = { daysDone: s.completedCount, n: credits.rowsOf(e.id).length };\nconst day = Math.min(5, credits.rowsOf(j.id).length + 1);`)),
    ["`.length` of the credit reader's rows (a row count; read the twin's completedCount)", "`.length` of the credit reader's rows (a row count; read the twin's completedCount)"]);
  eq("…`.size` of a set built from them, and `.length` of a const bound to them, are flagged",
    run(`const rows = credits.rowsOf(e.id);\nconst a = rows.length;\nconst b = new Set(credits.rowsOf(e.id).map((r) => r.day_id)).size;`).length, 2);
  eq("…`.length` of other lists passes", run(`const a = courseDays.length + enrollments.length;`), []);
  eq("(5b) a journey count field from anything but `<state>.completedCount` is flagged, each name",
    why(run(`const j = { daysDone: done.length, days_completed: done.size, completed_count: n };`)),
    ["daysDone is not `<state>.completedCount`", "days_completed is not `<state>.completedCount`", "completed_count is not `<state>.completedCount`"]);
  eq("…`<state>.completedCount` passes", run(`const j = { daysDone: state.completedCount, days_completed: st.completedCount };`), []);
  eq("(5c) reminderCreditedDays outside the two reminder readers is flagged (a count passed as done)",
    why(run(`const c = reminderCreditedDays({ done: n }, cd);`)), ["reminderCreditedDays outside the two journey_reminder_counts readers"]);
  eq("…in a reminder reader, on a row that is not from countOf (failing open) is flagged",
    why(run(`function f() { const cnt = { done: 0, done_today: false }; return reminderCreditedDays(cnt, cd); }`, "app/api/cron/journey-nudges/route.ts")),
    ["reminderCreditedDays on a row that is not a const taken from reminderCountsFrom's countOf"]);

  // Rule (6): creditedDaysFor takes the reader's answers.
  eq("(6) day_ids: null (by number on a database with 0107) is flagged",
    why(run(`const c = creditedDaysFor({ days: v.days, days_total: 5, day_ids: null }, credits.rowsOf(e.id));`)),
    ["creditedDaysFor's day_ids is not `<credits>.dayIdsOf(...)` in an object literal"]);
  eq("…a version object passed whole, and rows of the caller's own, are flagged",
    why(run(`const c = creditedDaysFor(v, rows);`)),
    ["creditedDaysFor's day_ids is not `<credits>.dayIdsOf(...)` in an object literal", "creditedDaysFor's rows are not `<credits>.rowsOf(...)` or a const bound to it"]);
  eq("…a spread over the version is flagged",
    why(run(`const c = creditedDaysFor({ ...v, day_ids: credits.dayIdsOf(id) }, credits.rowsOf(e.id));`)).length, 1);
  eq("…the rows as a const bound to rowsOf pass",
    run(`function f() { const progress = credits.rowsOf(e.id); return creditedDaysFor({ days: v.days, days_total: 5, day_ids: credits.dayIdsOf(e.version_id) }, progress); }`), []);
  eq("…creditCoursesFor is held to the same contract: day_ids: null is flagged, by its name",
    why(run(`const m = creditCoursesFor({ days: v.days, days_total: 5, day_ids: null }, credits.rowsOf(e.id));`)),
    ["creditCoursesFor's day_ids is not `<credits>.dayIdsOf(...)` in an object literal"]);
  eq("…creditCoursesFor as the reader answers it passes",
    run(`const m = creditCoursesFor({ days: v.days, days_total: 5, day_ids: credits.dayIdsOf(e.version_id) }, credits.rowsOf(e.id));`), []);
  eq("…an aliased import of creditCoursesFor is followed (a version passed whole, rows of its own)",
    why(problemsOf(F, scanFile(F, `import { creditCoursesFor as ccf } from "@/lib/journey/journey";\nconst m = ccf(v, rows);`))),
    ["creditCoursesFor's day_ids is not `<credits>.dayIdsOf(...)` in an object literal", "creditCoursesFor's rows are not `<credits>.rowsOf(...)` or a const bound to it"]);
  eq("(1) creditCoursesFor is no source of creditedDays",
    why(run(`computeJourneyState({ ${ARGS}, creditedDays: creditCoursesFor({ days: v.days, days_total: 5, day_ids: credits.dayIdsOf(e.version_id) }, credits.rowsOf(e.id)) });`)),
    ["creditedDays: `creditCoursesFor({ days: v.days, days_total: 5, day_ids: credits.dayIdsOf(e.version_id) }, credits.rowsOf(e.id))` is not from creditedDaysFor or reminderCreditedDays"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
