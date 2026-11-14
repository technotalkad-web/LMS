/**
 * Guard for ADR 0024 steps 20, 23, 62 and 64 (phase 2 slice P2-2): every
 * insert into course_attempts names its learning context, so 0107's
 * paste-window derive trigger (course_attempts_context_derive, which counts
 * each firing in context_derive_log and which 0108 drops) is never what
 * gives a row its context.
 *
 * It reads the sources, not a database. Over the .ts, .tsx, .js and .mjs
 * files of app/, lib/, tests/ and scripts/ (node_modules and
 * scripts/migration-rehearsal/ left out by name: the rehearsal seeds states
 * from before 0107 on purpose), parsed with the TypeScript parser, an insert
 * is:
 *
 *   - a supabase-js chain `.from("course_attempts")...insert(` or
 *     `.upsert(` (also `["insert"](`), followed across lines, through a
 *     variable (declared or assigned) that holds the `.from(...)` chain or
 *     an arrow function whose body is that chain, and through a constant
 *     that holds the table name inside `.from(...)`;
 *   - a REST write: any call whose URL (a literal, a template, a `+`
 *     concatenation, `new URL(...)`, or a variable holding one of these) is
 *     `/course_attempts...` or holds `/rest/v1/course_attempts`, with
 *     `method: "POST"` or `"PUT"` (PostgREST answers a PUT as an upsert);
 *     a call named post or put (Playwright's request.post, axios.post, a
 *     helper of that name) is that method, its rows the options' `data` or
 *     `body`, else its second argument. A call with no method is a GET and
 *     not an insert; a method the scan cannot read (not a literal, a
 *     shorthand, or behind a spread) is flagged, never taken for a GET;
 *   - a batch-like call: any named call (`batch(...)`, `helpers.batch(...)`,
 *     spec 64's `ins(...)` form) whose first argument is the literal table
 *     name and that has a second argument, read as the rows. This fails
 *     closed: a read or delete helper written that way is flagged too, and
 *     takes the table another way.
 *
 * The inserted rows (the insert's argument, the body inside JSON.stringify,
 * the batch's rows) are object literals, or a variable followed in scope to
 * its declaration, its assignments and every `.push(...)` on it; a variable
 * that is a parameter, an import, or a loop or catch binding cannot be
 * followed and is flagged. Each row must:
 *
 *   (1) name `context_kind` with a value (a literal null or undefined is no
 *       context: the derive trigger fills it), or spread
 *       `fixtureAttemptContext(...)`, the helper of both harnesses
 *       (tests/e2e/helpers/supabase.ts, re-exported by
 *       tests/bot/lifecycle/p0-helpers.ts), imported from one of them;
 *   (2) when it names an enrolment tag or the literal kind 'journey', name
 *       `journey_day_id` (step 62);
 *   (3) when it is a preview (the literal kind 'preview' or is_preview:
 *       true), name `preview_kind` and no official tag (learning_path_id,
 *       journey_enrollment_id, journey_day) (steps 6 and 62);
 *   (4) in app/ and lib/, when it is a journey row by (2), also name
 *       `journey_version_id`, not as a literal null (steps 13 and 23; a
 *       fixture under tests/ or scripts/ may leave it null, the legal
 *       "pinned version only" value). A preview of a journey test run names
 *       a day id and no enrolment, so it is not a journey row here.
 *
 * A row that spreads the helper names none of the context columns beside it
 * (context_kind, context_key, preview_kind, preview_run_id,
 * journey_version_id, journey_day_id and the official tags) and no literal
 * `is_preview: true`, and spreads nothing after it: the flags go to the
 * helper, which answers the whole context. The helper is for tests/ and
 * scripts/ only. It holds a row to 0107's shape check itself, proven by
 * section (c) against a transcription of the check tied to 0107's text: a
 * journey row gets journey_day_id or throws (rule 2); a preview row is the
 * by-role kind, legacy_role, with no official tag and no day id, or throws
 * (rule 3; step 6: a new preview never carries an official tag, though the
 * check admits one on a legacy_role row). A row whose kind is computed (not
 * a string literal) is held to (1), (2) and (4) by this scan; P2-6 states
 * how the launch page's computed kinds are read.
 *
 * Known limits (forms not followed; none exists in the tree today): a
 * builder or URL passed in as a parameter, returned by a function with a
 * block body, or held in an object property; a table name built at run
 * time, or held in a variable outside `.from(...)` (a batch-like call needs
 * the literal); a URL path inside a substitution (`${base}/course_attempts`
 * is read, `${attemptsPath}` is not); a call through an unnamed callee
 * (`(0, f)(...)`); `.cjs`, `.cts`, `.mts` and `.jsx` files (the plan names
 * four extensions); writes made by database functions (`.rpc(...)`), which
 * the database's own guards cover.
 *
 * Exceptions, each listed with its date and reason:
 *   - PENDING: the launch page, until P2-6 names the context on both of its
 *     inserts. Pinned to exactly its two open inserts; the test fails when a
 *     pending file no longer needs the entry.
 *   - REFUSED: spec 55's two inserts made on a learner's own session, which
 *     the database must refuse; they are not fixtures (step 64) and stay as
 *     they are. Pinned to exactly that receiver and count.
 *
 * Also: (d) every journey_versions insert of a fixture in tests/ and
 * scripts/ writes day_ids with day_ids_source 'editor' (P2-N9: 0108 sets
 * day_ids not null and drops the trigger that fills it).
 *
 * Run:  npx tsx tests/unit/attempt-insert-sites.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fixtureAttemptContext } from "../e2e/helpers/supabase";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const atLeast = (n: string, got: number, min: number) => {
  if (got >= min) { pass++; console.log(`  ✓ ${n} (${got} ≥ ${min})`); } else { fail++; console.log(`  ✗ ${n} — got ${got}, want at least ${min}`); }
};

const root = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["app", "lib", "tests", "scripts"];
/** Left out by name: its SQL and case files seed states from before 0107 on purpose. */
const EXCLUDED = ["scripts/migration-rehearsal/"];
const TABLE = "course_attempts";
const HELPER = "fixtureAttemptContext";
const HELPER_MODULES = ["tests/e2e/helpers/supabase.ts", "tests/bot/lifecycle/p0-helpers.ts"];
const OFFICIAL_TAGS = ["learning_path_id", "journey_enrollment_id", "journey_day"];
/** The columns the helper answers: a row that spreads it names none of them beside it. */
const HELPER_OWNED = ["context_kind", "context_key", "preview_kind", "preview_run_id", "journey_version_id", "journey_day_id", ...OFFICIAL_TAGS];
/** A URL path of the table: PostgREST's `/course_attempts...` (a REST helper's) or a full `/rest/v1/course_attempts...`. */
const REST_PATH = /^\/course_attempts(?![\w])\S*$/;
const REST_V1 = /^\S*\/rest\/v1\/course_attempts(?![\w])\S*$/;

const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (EXCLUDED.some((x) => `${rel(p)}/`.startsWith(x))) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
}

// ---------------------------------------------------------------------------
// The scanner. Pure over (file name, text), so the planted cases of (b) run
// through exactly the code that reads the repository.
// ---------------------------------------------------------------------------
type SiteKind = "chain" | "rest" | "batch";
type Site = { file: string; line: number; kind: SiteKind; receiver: string; helper: boolean; problems: string[] };

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ||
        ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    else return e;
  }
}

function literalText(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : null;
}

/** A literal null, undefined or `void ...`: the column is then not given. */
function isNullish(e: ts.Expression | null | undefined): boolean {
  if (!e) return false;
  const u = unwrap(e);
  return u.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(u) || (ts.isIdentifier(u) && u.text === "undefined");
}

/**
 * A URL argument's text, with `${}` for each substitution; `new URL(path, base)`
 * is read as its path, and a variable as the first initializer or assignment
 * of that name that is a URL of the table (by name, file-wide: detection
 * over-reads on purpose).
 */
function urlText(e: ts.Expression | undefined, idx?: FileIndex, depth = 0): string | null {
  if (!e || depth > 3) return null;
  const u = unwrap(e);
  const lit = literalText(u);
  if (lit !== null) return lit;
  if (ts.isTemplateExpression(u)) return u.head.text + u.templateSpans.map((s) => "${}" + s.literal.text).join("");
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (urlText(u.left, idx, depth + 1) ?? "${}") + (urlText(u.right, idx, depth + 1) ?? "${}");
  }
  if (ts.isNewExpression(u) && ts.isIdentifier(u.expression) && u.expression.text === "URL") return urlText(u.arguments?.[0], idx, depth + 1);
  if (ts.isIdentifier(u) && idx) {
    for (const init of idx.decls.get(u.text) ?? []) {
      const t = urlText(init, idx, depth + 1);
      if (t !== null && (REST_PATH.test(t) || REST_V1.test(t))) return t;
    }
  }
  return null;
}

function propName(n: ts.PropertyName): string | null {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null;
}

function calleeName(c: ts.CallExpression): string | null {
  const e = unwrap(c.expression);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e)) return literalText(e.argumentExpression);
  return null;
}

/**
 * The declaration a name refers to at this point, by the scopes around it:
 * a parameter, a variable (or a for, catch, function or class binding), or
 * null (an import, a global, or a `var` the walk does not hoist).
 */
function bindingOf(id: ts.Identifier): ts.Node | null {
  const name = id.text;
  const declares = (b: ts.BindingName): boolean =>
    ts.isIdentifier(b) ? b.text === name : (b.elements as ts.NodeArray<ts.ArrayBindingElement>).some((el) => ts.isBindingElement(el) && declares(el.name));
  const inList = (l: ts.VariableDeclarationList) => l.declarations.find((d) => declares(d.name)) ?? null;
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) {
      const param = p.parameters.find((q) => declares(q.name));
      if (param) return param;
    }
    if ((ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer && ts.isVariableDeclarationList(p.initializer)) {
      const d = inList(p.initializer);
      if (d) return d;
    }
    if (ts.isCatchClause(p) && p.variableDeclaration && declares(p.variableDeclaration.name)) return p.variableDeclaration;
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      for (const st of p.statements) {
        if (ts.isVariableStatement(st)) {
          const d = inList(st.declarationList);
          if (d) return d;
        }
        if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return st;
      }
    }
  }
  return null;
}

type FileIndex = {
  /** By name, file-wide: initializers and assignments, to find what a write is made on (over-reads on purpose: more is counted, never less). */
  decls: Map<string, ts.Expression[]>;
  /** By declaration, in scope: assignments and `.push(...)` arguments, to read the rows themselves. */
  assigns: Map<ts.Node, ts.Expression[]>;
  pushes: Map<ts.Node, ts.Expression[]>;
  helperImported: boolean;
};

function indexFile(file: string, sf: ts.SourceFile): FileIndex {
  const decls = new Map<string, ts.Expression[]>();
  const assigns = new Map<ts.Node, ts.Expression[]>();
  const pushes = new Map<ts.Node, ts.Expression[]>();
  const addTo = <K>(m: Map<K, ts.Expression[]>, k: K, ...es: ts.Expression[]) => m.set(k, [...(m.get(k) ?? []), ...es]);
  let helperImported = HELPER_MODULES.includes(file);
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) addTo(decls, n.name.text, n.initializer);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(n.left))) {
      const id = unwrap(n.left) as ts.Identifier;
      addTo(decls, id.text, n.right);
      const b = bindingOf(id);
      if (b) addTo(assigns, b, n.right);
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push" && ts.isIdentifier(unwrap(callee.expression))) {
        const b = bindingOf(unwrap(callee.expression) as ts.Identifier);
        if (b) addTo(pushes, b, ...n.arguments);
      }
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const named = n.importClause?.namedBindings;
      const names = named && ts.isNamedImports(named) ? named.elements.map((el) => (el.propertyName ?? el.name).text) : [];
      if (names.includes(HELPER)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), n.moduleSpecifier.text));
        if (HELPER_MODULES.some((m) => m === target || m === `${target}.ts`)) helperImported = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { decls, assigns, pushes, helperImported };
}

/** The table a `.from(...)` names: a literal, or a variable whose initializer or assignment is the literal table name. */
function tableOf(e: ts.Expression | undefined, idx: FileIndex): string | null {
  const lit = literalText(e);
  if (lit !== null || !e) return lit;
  const u = unwrap(e);
  if (ts.isIdentifier(u) && (idx.decls.get(u.text) ?? []).some((init) => literalText(init) === TABLE)) return TABLE;
  return null;
}

/** The `.from("course_attempts")` call a write is made on, if any (through variables and an arrow function's expression body). */
function fromCallIn(e: ts.Expression, idx: FileIndex, seen = new Set<string>()): ts.CallExpression | null {
  let cur: ts.Expression = e;
  for (;;) {
    cur = unwrap(cur);
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "from" && tableOf(cur.arguments[0], idx) === TABLE) return cur;
      cur = callee;
    } else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isArrowFunction(cur) && !ts.isBlock(cur.body)) {
      cur = cur.body;
    } else if (ts.isIdentifier(cur)) {
      if (seen.has(cur.text)) return null;
      seen.add(cur.text);
      for (const init of idx.decls.get(cur.text) ?? []) {
        const found = fromCallIn(init, idx, seen);
        if (found) return found;
      }
      return null;
    } else {
      return null;
    }
  }
}

type Verdict = { problems: string[]; rows: number; helper: boolean };

const isTrue = (e: ts.Expression | null | undefined) => !!e && unwrap(e).kind === ts.SyntaxKind.TrueKeyword;
const APP_OR_LIB = /^(app|lib)\//;

function checkObject(obj: ts.ObjectLiteralExpression, file: string): Verdict {
  const props = new Map<string, ts.Expression | null>();
  let helperAt = -1;
  let lastOtherSpread = -1;
  obj.properties.forEach((p, i) => {
    if (ts.isPropertyAssignment(p)) {
      const name = propName(p.name);
      if (name) props.set(name, p.initializer);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      props.set(p.name.text, null);
    } else if (ts.isSpreadAssignment(p)) {
      const s = unwrap(p.expression);
      if (ts.isCallExpression(s) && ts.isIdentifier(unwrap(s.expression)) && (unwrap(s.expression) as ts.Identifier).text === HELPER) helperAt = i;
      else lastOtherSpread = i;
    }
  });
  const helper = helperAt >= 0;
  /** Named with a value: a shorthand or any expression counts; a literal null or undefined does not. */
  const named = (k: string) => props.has(k) && !isNullish(props.get(k));
  const problems: string[] = [];
  if (helper) {
    const beside = HELPER_OWNED.filter((c) => props.has(c));
    if (beside.length) problems.push(`names ${beside.join(", ")} beside ${HELPER}; pass the flags to the helper`);
    if (isTrue(props.get("is_preview"))) problems.push(`names is_preview: true beside ${HELPER}; pass the flags to the helper`);
    if (lastOtherSpread > helperAt) problems.push(`spreads another object after ${HELPER}; spread the helper last`);
    if (APP_OR_LIB.test(file)) problems.push(`${HELPER} is a fixture helper (tests/ and scripts/ only)`);
  } else {
    if (!named("context_kind")) problems.push("names no context_kind");
    const kind = literalText(props.get("context_kind") ?? undefined);
    const journey = kind === "journey" || named("journey_enrollment_id");
    if (journey && !named("journey_day_id")) problems.push("a journey insert names no journey_day_id");
    if (journey && APP_OR_LIB.test(file) && !named("journey_version_id")) {
      problems.push("a journey insert in app/ or lib/ names no journey_version_id (steps 13 and 23)");
    }
    if (kind === "preview" || isTrue(props.get("is_preview"))) {
      if (!named("preview_kind")) problems.push("a preview insert names no preview_kind");
      const tags = OFFICIAL_TAGS.filter(named);
      if (tags.length) problems.push(`a preview insert names an official tag (${tags.join(", ")})`);
    }
  }
  return { problems, rows: 1, helper };
}

const unreadable = (why: string): Verdict => ({ problems: [why], rows: 0, helper: false });

function checkRows(e: ts.Expression | undefined, idx: FileIndex, file: string, depth = 0): Verdict {
  if (!e) return unreadable("the insert has no rows argument");
  const u = unwrap(e);
  const merge = (vs: Verdict[]): Verdict => ({
    problems: vs.flatMap((v) => v.problems),
    rows: vs.reduce((n, v) => n + v.rows, 0),
    helper: vs.length > 0 && vs.every((v) => v.helper),
  });
  if (ts.isObjectLiteralExpression(u)) return checkObject(u, file);
  if (ts.isArrayLiteralExpression(u)) {
    return merge(u.elements.map((el) => checkRows(ts.isSpreadElement(el) ? el.expression : el, idx, file, depth + 1)));
  }
  if (ts.isCallExpression(u) && u.expression.getText() === "JSON.stringify") return checkRows(u.arguments[0], idx, file, depth + 1);
  if (ts.isIdentifier(u) && depth < 4) {
    // Read in scope: the declaration this name refers to here, never another
    // function's variable of the same name.
    const b = bindingOf(u);
    if (b && ts.isParameter(b)) return unreadable(`the rows in \`${u.text}\` are a parameter, which the scan cannot follow`);
    const followable = b && ts.isVariableDeclaration(b) && ts.isIdentifier(b.name) && ts.isVariableDeclarationList(b.parent) &&
      !ts.isForOfStatement(b.parent.parent) && !ts.isForInStatement(b.parent.parent);
    if (!followable) return unreadable(`the rows in \`${u.text}\` are not a variable declared in scope that the scan can follow`);
    const sources = [...(b.initializer ? [b.initializer] : []), ...(idx.assigns.get(b) ?? []), ...(idx.pushes.get(b) ?? [])];
    const v = merge(sources.map((s) => checkRows(s, idx, file, depth + 1)));
    if (v.rows === 0) v.problems.push(`the rows in \`${u.text}\` cannot be found (no object literal assigned or pushed)`);
    return v;
  }
  return unreadable(`the rows (\`${u.getText().slice(0, 60)}\`) are not an object literal, an array of them or a variable the scan can follow`);
}

/** The rows a request's options carry: `body` (fetch, rest) or `data` (Playwright), written out or as a shorthand. */
function rowsOption(opts: ts.Expression | undefined): ts.Expression | undefined {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
  for (const k of ["body", "data"]) {
    for (const p of opts.properties) {
      if (ts.isPropertyAssignment(p) && propName(p.name) === k) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === k) return p.name;
    }
  }
  return undefined;
}

/** Every insert into course_attempts in one file, with what is wrong with each. */
function scanSource(file: string, text: string): Site[] {
  const sf = parse(file, text);
  const idx = indexFile(file, sf);
  const sites: Site[] = [];
  const add = (node: ts.Node, kind: SiteKind, receiver: string, rows: Verdict, extra: string[] = []) => {
    const problems = [...extra, ...rows.problems];
    if (rows.helper && !idx.helperImported) problems.push(`${HELPER} is not imported from ${HELPER_MODULES.join(" or ")}`);
    sites.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind, receiver, helper: rows.helper, problems });
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const name = calleeName(n);
      // (1) supabase-js chains.
      if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && (name === "insert" || name === "upsert")) {
        const from = fromCallIn(callee.expression, idx);
        if (from) {
          const on = unwrap(from.expression) as ts.PropertyAccessExpression;
          add(n, "chain", on.expression.getText(sf), checkRows(n.arguments[0], idx, file));
        }
      }
      // (2) REST writes. A URL has no white space (a test's name that
      // mentions the path is not one).
      const url = urlText(n.arguments[0], idx);
      if (url !== null && (REST_PATH.test(url) || REST_V1.test(url))) {
        const receiver = name ?? "?";
        const second = n.arguments[1];
        const opts = second ? unwrap(second) : undefined;
        if (name === "post" || name === "put") {
          // A call named for the verb: its rows are the options' data or
          // body, else its second argument (axios's form); none is flagged.
          add(n, "rest", receiver, checkRows(rowsOption(opts) ?? second, idx, file));
        } else if (opts && !ts.isObjectLiteralExpression(opts)) {
          add(n, "rest", receiver, unreadable("the request options are not an object literal, so the method cannot be read"));
        } else if (opts) {
          const ps = opts.properties;
          const lastAt = (f: (p: ts.ObjectLiteralElementLike) => boolean) => ps.reduce((at, p, i) => (f(p) ? i : at), -1);
          const methodAt = lastAt((p) => ts.isPropertyAssignment(p) && propName(p.name) === "method");
          // A spread, or a shorthand method, hides the method unless a
          // literal one is written after it.
          const hiddenAt = lastAt((p) => ts.isSpreadAssignment(p) || (ts.isShorthandPropertyAssignment(p) && p.name.text === "method"));
          const m = methodAt > hiddenAt ? literalText((ps[methodAt] as ts.PropertyAssignment).initializer) : hiddenAt >= 0 ? null : "GET";
          if (m === null) add(n, "rest", receiver, unreadable("the method cannot be read (not a string literal, a shorthand, or behind a spread)"));
          else if (/^(post|put)$/i.test(m)) add(n, "rest", receiver, checkRows(rowsOption(opts), idx, file));
        }
      }
      // (3) batch-like calls: any named call with the literal table name and rows.
      if (name !== null && name !== "from" && n.arguments.length >= 2 && literalText(n.arguments[0]) === TABLE) {
        add(n, "batch", name, checkRows(n.arguments[1], idx, file));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

// ---------------------------------------------------------------------------
// Exceptions.
// ---------------------------------------------------------------------------
/** Files whose inserts may stay open until a named slice; each pinned to its exact count of open inserts. */
const PENDING: Record<string, { since: string; until: string; sites: number }> = {
  "app/[org]/(learner)/courses/[courseId]/launch/page.tsx": {
    since: "2026-11-14",
    until: "emptied by P2-6 (ADR 0024 step 23: both launch inserts name context_kind with the tags)",
    sites: 2,
  },
};
/** Inserts the database must refuse, on a learner's own session: not fixtures (ADR 0024 step 64). */
const REFUSED: Record<string, { receiver: string; sites: number; why: string }> = {
  "tests/bot/lifecycle/55-attempt-row-guard.spec.ts": {
    receiver: "s.learnerDb!",
    sites: 2,
    why: "cases (c) and (d): a learner's POST of a forged row, refused by the database; they stay as they are",
  },
};
/** Floors: the sites the plan names (P2-2 item 1), so a scan that silently finds less fails. */
const FLOORS: Record<string, number> = {
  "app/[org]/(learner)/courses/[courseId]/launch/page.tsx": 2,
  "tests/bot/lifecycle/32-language-switch.spec.ts": 1,
  "tests/bot/lifecycle/34-version-modes.spec.ts": 2,
  "tests/bot/lifecycle/45-lrs-analytics.spec.ts": 1,
  "tests/bot/lifecycle/46-lrs-real-lrs.spec.ts": 2,
  "tests/bot/lifecycle/55-attempt-row-guard.spec.ts": 2,
  "tests/bot/lifecycle/58-kivo-release-a-xapi-lang.spec.ts": 1,
  "tests/bot/lifecycle/60-revision-grant-flow.spec.ts": 2,
  "tests/bot/lifecycle/65-learner-feedback.spec.ts": 1,
  "tests/e2e/attempts/consume-grant.spec.ts": 1,
  "tests/mobile/audit.mjs": 1,
  "scripts/demo/seed-demo.mjs": 1,
};

/** Pending files none of whose inserts is still open: each must leave the list. */
const stalePending = (found: Site[], pending: string[]) =>
  pending.filter((f) => !found.some((s) => s.file === f && s.problems.length > 0));

// ---------------------------------------------------------------------------
// (a) The repository.
// ---------------------------------------------------------------------------
const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(root, d), files);
const sources = new Map<string, string>(files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));
const sites = [...sources].flatMap(([file, text]) => scanSource(file, text));
const show = (s: Site) => `${s.file}:${s.line} (${s.kind} on ${s.receiver}): ${s.problems.join("; ")}`;

console.log(`\n(a) every course_attempts insert in ${SCAN_DIRS.join("/, ")}/ names its context (ADR 0024 steps 23, 62, 64)`);
{
  eq("scripts/migration-rehearsal/ is left out by name", [...sources.keys()].some((f) => f.startsWith("scripts/migration-rehearsal/")), false);
  atLeast("files read", sources.size, 500);
  atLeast("inserts found", sites.length, Object.values(FLOORS).reduce((a, b) => a + b, 0));
  atLeast("supabase-js chains", sites.filter((s) => s.kind === "chain").length, 15);
  atLeast("REST POSTs", sites.filter((s) => s.kind === "rest").length, 1);
  atLeast("batch calls", sites.filter((s) => s.kind === "batch").length, 1);
  for (const [file, min] of Object.entries(FLOORS)) {
    atLeast(`${file}: inserts found`, sites.filter((s) => s.file === file).length, min);
  }

  const refused = (s: Site) => REFUSED[s.file]?.receiver === s.receiver;
  for (const [file, r] of Object.entries(REFUSED)) {
    eq(`${file}: exactly ${r.sites} refused learner inserts on ${r.receiver} (${r.why})`,
      sites.filter((s) => s.file === file && refused(s)).length, r.sites);
  }
  const open = sites.filter((s) => s.problems.length > 0 && !refused(s));
  eq("no insert outside the pending list names no context (or breaks rules 2 to 4, or the helper's rules)",
    open.filter((s) => !(s.file in PENDING)).map(show), []);
  eq("the pending list holds only files that still need it",
    stalePending(sites.filter((s) => !refused(s)), Object.keys(PENDING)), []);
  for (const [file, p] of Object.entries(PENDING)) {
    const pendingOpen = open.filter((s) => s.file === file);
    eq(`${file}: exactly ${p.sites} open inserts, pending since ${p.since}, ${p.until} (no further one hides behind the entry)`,
      pendingOpen.length, p.sites);
    if (pendingOpen.length) console.log(`  note: pending since ${p.since}: ${pendingOpen.map((s) => `${s.file}:${s.line}`).join(", ")}`);
  }
  eq("the fixture inserts P2-2 item 1 names (specs 32, 34, 45, 46, 58, 60, 65, consume-grant) spread the helper",
    sites.filter((s) => s.file in FLOORS && /^tests\/(bot|e2e)\//.test(s.file) && !refused(s) && s.kind === "chain" && !s.helper).map(show), []);
}

// ---------------------------------------------------------------------------
// (b) Planted cases, through the same scanner.
// ---------------------------------------------------------------------------
console.log("\n(b) planted cases");
{
  const verdict = (code: string, file = "tests/bot/lifecycle/planted.spec.ts") =>
    scanSource(file, code).map((s) => ({ kind: s.kind, ok: s.problems.length === 0 }));
  const problemsOf = (code: string, file = "tests/bot/lifecycle/planted.spec.ts") =>
    scanSource(file, code).flatMap((s) => s.problems);

  eq("a chain across lines without context_kind is flagged",
    verdict(`await svc()\n  .from("course_attempts")\n  .insert({\n    user_id: u.id,\n    status: "in_progress",\n  })\n  .select("id");`),
    [{ kind: "chain", ok: false }]);
  eq("an upsert without context_kind is flagged",
    verdict(`await db.from("course_attempts").upsert({ id, status: "passed" });`), [{ kind: "chain", ok: false }]);
  eq("a chain through a variable is flagged",
    verdict(`const q = db.from("course_attempts");\nawait q.insert({ user_id: u.id });`), [{ kind: "chain", ok: false }]);
  eq("a chain naming context_kind passes",
    verdict(`await svc().from("course_attempts").insert({ user_id: u.id, context_kind: "individual" });`), [{ kind: "chain", ok: true }]);
  eq("a chain spreading the helper, imported from p0-helpers, passes",
    verdict(`import { fixtureAttemptContext } from "./p0-helpers";\nconst row = { user_id: u.id };\nawait svc().from("course_attempts").insert({ ...row, ...fixtureAttemptContext(row) });`),
    [{ kind: "chain", ok: true }]);
  eq("the same chain in the e2e harness, imported from helpers/supabase, passes",
    verdict(`import { fixtureAttemptContext } from "../helpers/supabase";\nawait svc().from("course_attempts").insert({ ...row, ...fixtureAttemptContext(row) });`, "tests/e2e/attempts/planted.spec.ts"),
    [{ kind: "chain", ok: true }]);
  eq("a helper of that name from another module is flagged",
    problemsOf(`import { fixtureAttemptContext } from "./elsewhere";\nawait db.from("course_attempts").insert({ ...fixtureAttemptContext(row) });`),
    [`${HELPER} is not imported from ${HELPER_MODULES.join(" or ")}`]);
  eq("rows the scan cannot follow are flagged",
    verdict(`await db.from("course_attempts").insert(rows.map(toRow));`), [{ kind: "chain", ok: false }]);
  eq("a select, an update and a delete are not inserts",
    verdict(`await db.from("course_attempts").select("id");\nawait db.from("course_attempts").update({ status: "abandoned" }).eq("id", id);\nawait db.from("course_attempts").delete().eq("id", id);`),
    []);
  eq("an insert into another table is not counted",
    verdict(`await db.from("course_attempts_archive").insert({ id });\nawait db.from("xp_events").insert({ id });`), []);

  eq("a REST POST without context_kind is flagged",
    verdict("await rest(`/course_attempts`, { method: \"POST\", body: JSON.stringify({ user_id: uid, status: \"completed\" }) });", "tests/mobile/planted.mjs"),
    [{ kind: "rest", ok: false }]);
  eq("a REST POST naming context_kind passes",
    verdict("await rest(`/course_attempts`, { method: \"POST\", body: JSON.stringify({ user_id: uid, context_kind: \"individual\" }) });", "tests/mobile/planted.mjs"),
    [{ kind: "rest", ok: true }]);
  eq("a REST GET (no method) and a PATCH are not inserts",
    verdict("await rest(`/course_attempts?user_id=eq.${uid}&select=id`);\nawait rest(`/course_attempts?id=eq.${id}`, { method: \"PATCH\", body: \"{}\" });", "tests/mobile/planted.mjs"),
    []);
  eq("a fetch POST to /rest/v1/course_attempts without context_kind is flagged",
    verdict("await fetch(`${SUPA}/rest/v1/course_attempts`, { method: \"POST\", headers, body: JSON.stringify([{ user_id: uid }]) });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: false }]);
  eq("a fetch POST naming context_kind passes; a fetch GET is not an insert",
    verdict("await fetch(`${SUPA}/rest/v1/course_attempts?on_conflict=id`, { method: \"post\", body: JSON.stringify([{ user_id: uid, context_kind: \"individual\" }]) });\nawait fetch(`${SUPA}/rest/v1/course_attempts?select=id`, { headers });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: true }]);
  eq("a REST call whose method is not a literal is flagged",
    verdict("await rest(`/course_attempts`, { method: m, body });", "scripts/planted.mjs"), [{ kind: "rest", ok: false }]);

  eq("a batch call whose pushed rows name no context_kind is flagged",
    verdict(`const attempts = [];\nattempts.push({ user_id: a, status: "passed" });\nawait batch("course_attempts", attempts);`, "scripts/planted.mjs"),
    [{ kind: "batch", ok: false }]);
  eq("a batch call where one pushed row of two names none is flagged",
    verdict(`const attempts = [];\nattempts.push({ user_id: a, context_kind: "individual" });\nattempts.push({ user_id: b });\nawait batch("course_attempts", attempts);`, "scripts/planted.mjs"),
    [{ kind: "batch", ok: false }]);
  eq("a batch call whose every pushed row names context_kind passes",
    verdict(`const attempts = [];\nattempts.push({ user_id: a, context_kind: "individual" });\nattempts.push({ user_id: b, context_kind: "individual" });\nawait batch("course_attempts", attempts);`, "scripts/planted.mjs"),
    [{ kind: "batch", ok: true }]);
  eq("a batch call on a variable with no rows anywhere is flagged",
    verdict(`await batch("course_attempts", loaded);`, "scripts/planted.mjs"), [{ kind: "batch", ok: false }]);

  eq("rule 2: a journey insert without journey_day_id is flagged",
    problemsOf(`await db.from("course_attempts").insert({ context_kind: "journey", journey_enrollment_id: e, journey_day: 3 });`),
    ["a journey insert names no journey_day_id"]);
  eq("rule 2: with journey_day_id it passes",
    problemsOf(`await db.from("course_attempts").insert({ context_kind: "journey", journey_enrollment_id: e, journey_day: 3, journey_day_id: d });`), []);
  eq("rule 3: a preview insert without preview_kind, with a path tag, is flagged twice",
    problemsOf(`await db.from("course_attempts").insert({ context_kind: "preview", is_preview: true, learning_path_id: p });`),
    ["a preview insert names no preview_kind", "a preview insert names an official tag (learning_path_id)"]);
  eq("rule 3: a preview with preview_kind and null tags passes",
    problemsOf(`await db.from("course_attempts").insert({ context_kind: "preview", is_preview: true, preview_kind: "course", journey_day: null });`), []);

  // Rule 4: a journey insert in app/ and lib/ names journey_version_id (steps 13 and 23).
  const LIB = "lib/attempts/planted.ts";
  const NO_VERSION = "a journey insert in app/ or lib/ names no journey_version_id (steps 13 and 23)";
  eq("rule 4: a journey insert in lib/ without journey_version_id is flagged",
    problemsOf(`await svc.from("course_attempts").insert({ context_kind: "journey", journey_enrollment_id: e, journey_day: 1, journey_day_id: d });`, LIB),
    [NO_VERSION]);
  eq("rule 4: with journey_version_id it passes",
    problemsOf(`await svc.from("course_attempts").insert({ context_kind: "journey", journey_enrollment_id: e, journey_day: 1, journey_day_id: d, journey_version_id: v });`, LIB), []);
  eq("rule 4: a computed kind with an enrolment tag and a literal null journey_version_id, in app/, is flagged",
    problemsOf(`await svc.from("course_attempts").insert({ context_kind: kind, journey_enrollment_id: enr ?? null, journey_day: day, journey_day_id: dayId, journey_version_id: null });`, "app/planted/page.tsx"),
    [NO_VERSION]);
  eq("rule 4: a fixture's journey insert may leave journey_version_id null (tests/ and scripts/)",
    problemsOf(`await svc().from("course_attempts").insert({ context_kind: "journey", journey_enrollment_id: e, journey_day: 1, journey_day_id: d });`), []);
  eq("rule 4: a journey test run's preview in lib/ (a day id, no enrolment) is not a journey insert",
    problemsOf(`await svc.from("course_attempts").insert({ context_kind: "preview", is_preview: true, preview_kind: "journey_run", preview_run_id: r, journey_day_id: d });`, LIB), []);

  // Calls that write rows without .from(...).insert, a method or a name like batch.
  eq("a call of any name with the table and rows (spec 64's ins helper form) is counted and flagged",
    verdict(`const ins = async (table: string, rows: Record<string, unknown>) => svc().from(table).insert(rows);\nawait ins("course_attempts", { user_id: "x" });`),
    [{ kind: "batch", ok: false }]);
  eq("the same call naming context_kind passes",
    verdict(`await ins("course_attempts", { user_id: "x", context_kind: "individual" });`), [{ kind: "batch", ok: true }]);
  eq("a batch called on an object (helpers.batch) is counted and flagged",
    verdict(`await helpers.batch("course_attempts", [{ user_id: "x" }]);`, "scripts/planted.mjs"), [{ kind: "batch", ok: false }]);
  eq("a call with the table name alone is not an insert",
    verdict(`const n = await count("course_attempts");`), []);
  eq("a Playwright post to /rest/v1/course_attempts is a POST, its rows read from data, and is flagged",
    verdict("await req.post(`${SUPA}/rest/v1/course_attempts`, { data: { user_id: \"x\" } });"), [{ kind: "rest", ok: false }]);
  eq("the same post naming context_kind passes",
    verdict("await req.post(`${SUPA}/rest/v1/course_attempts`, { headers, data: [{ user_id: \"x\", context_kind: \"individual\" }] });"), [{ kind: "rest", ok: true }]);
  eq("a post with no rows is flagged",
    verdict("await req.post(`${SUPA}/rest/v1/course_attempts`);"), [{ kind: "rest", ok: false }]);
  eq("a post whose second argument is the rows (no data or body) reads them",
    verdict("await http.post(`${SUPA}/rest/v1/course_attempts`, [{ user_id: \"x\", context_kind: \"individual\" }]);"), [{ kind: "rest", ok: true }]);
  eq("a shorthand data option is followed to its rows",
    verdict("const data = { user_id: \"x\", context_kind: \"individual\" };\nawait req.post(`${SUPA}/rest/v1/course_attempts`, { headers, data });"), [{ kind: "rest", ok: true }]);
  eq("a Playwright get and patch are not inserts",
    verdict("await req.get(`${SUPA}/rest/v1/course_attempts?select=id`, { headers });\nawait req.patch(`${SUPA}/rest/v1/course_attempts?id=eq.${id}`, { data: { status: \"abandoned\" } });"), []);

  // Rows that spread the helper name no context column beside it.
  const IMPORT = `import { fixtureAttemptContext } from "./p0-helpers";\n`;
  eq("a path tag beside the helper is flagged (the helper, given no flags, answers individual)",
    problemsOf(`${IMPORT}await db.from("course_attempts").insert({ user_id: u, learning_path_id: p, ...fixtureAttemptContext() });`),
    [`names learning_path_id beside ${HELPER}; pass the flags to the helper`]);
  eq("context columns written after the helper are flagged",
    problemsOf(`${IMPORT}await db.from("course_attempts").insert({ user_id: "x", ...fixtureAttemptContext(), context_kind: "journey", journey_enrollment_id: "e" });`),
    [`names context_kind, journey_enrollment_id beside ${HELPER}; pass the flags to the helper`]);
  eq("a literal is_preview: true beside the helper is flagged",
    problemsOf(`${IMPORT}await db.from("course_attempts").insert({ user_id: "x", is_preview: true, ...fixtureAttemptContext() });`),
    [`names is_preview: true beside ${HELPER}; pass the flags to the helper`]);
  eq("a computed is_preview beside the helper, given the same flags, passes (spec 65)",
    verdict(`${IMPORT}await db.from("course_attempts").insert({ is_revision: flags.is_revision ?? false, is_preview: flags.is_preview ?? false, ...fixtureAttemptContext(flags) });`),
    [{ kind: "chain", ok: true }]);
  eq("a spread after the helper is flagged (it could override the context)",
    problemsOf(`${IMPORT}await db.from("course_attempts").insert({ ...fixtureAttemptContext(row), ...row });`),
    [`spreads another object after ${HELPER}; spread the helper last`]);
  eq("the helper in lib/ is flagged (a fixture helper; rule 4 binds lib/)",
    problemsOf(`import { fixtureAttemptContext } from "../../tests/e2e/helpers/supabase";\nawait svc.from("course_attempts").insert({ ...fixtureAttemptContext(flags) });`, LIB),
    [`${HELPER} is a fixture helper (tests/ and scripts/ only)`]);

  // A method the scan cannot read is never taken for a GET.
  eq("a POST whose method is a shorthand property is flagged",
    verdict("const method = \"POST\";\nawait fetch(`${SUPA}/rest/v1/course_attempts`, { method, body: JSON.stringify({ user_id: \"x\", context_kind: \"individual\" }) });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: false }]);
  eq("a POST whose options spread another object is flagged",
    verdict("const POST = { method: \"POST\" };\nawait fetch(`${SUPA}/rest/v1/course_attempts`, { ...POST, body: JSON.stringify({ user_id: \"x\", context_kind: \"individual\" }) });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: false }]);
  eq("a literal method written after a spread is read (a GET is not an insert)",
    verdict("await fetch(`${SUPA}/rest/v1/course_attempts?select=id`, { ...init, method: \"GET\" });", "scripts/planted.mjs"), []);

  // Names are read in scope; a null kind is no kind.
  eq("rows that are a parameter are flagged, though another function's rows of that name name the context",
    problemsOf(`function a() { const rows = [{ user_id: "y", context_kind: "individual" }]; return rows; }\nasync function b(rows: unknown[]) { await svc().from("course_attempts").insert(rows); }`),
    ["the rows in `rows` are a parameter, which the scan cannot follow"]);
  eq("rows are read from the declaration in scope, not another function's of the same name",
    verdict(`function a() { const rows = [{ user_id: "y" }]; return rows; }\nasync function b() { const rows = [{ user_id: "z", context_kind: "individual" }]; await svc().from("course_attempts").insert(rows); }`),
    [{ kind: "chain", ok: true }]);
  eq("pushes are read on the variable in scope only",
    verdict(`function a() { const rows = []; rows.push({ user_id: "y", context_kind: "individual" }); return rows; }\nasync function b() { const rows = []; rows.push({ user_id: "z" }); await svc().from("course_attempts").insert(rows); }`),
    [{ kind: "chain", ok: false }]);
  eq("rows bound by a loop are flagged",
    problemsOf(`for (const r of batches) await db.from("course_attempts").insert(r);`),
    ["the rows in `r` are not a variable declared in scope that the scan can follow"]);
  eq("rows assigned to an uninitialised let are followed",
    verdict(`let rows;\nrows = [{ user_id: "z", context_kind: "individual" }];\nawait db.from("course_attempts").insert(rows);`), [{ kind: "chain", ok: true }]);
  eq("context_kind: null is no context",
    problemsOf(`await db.from("course_attempts").insert({ user_id: "x", context_kind: null });`), ["names no context_kind"]);
  eq("context_kind: undefined is no context",
    problemsOf(`await db.from("course_attempts").insert({ user_id: "x", context_kind: undefined });`), ["names no context_kind"]);
  eq("a shorthand context_kind passes",
    verdict(`await db.from("course_attempts").insert({ user_id: "x", context_kind });`), [{ kind: "chain", ok: true }]);
  eq("rule 2: a literal null journey_day_id on a journey row is flagged",
    problemsOf(`await db.from("course_attempts").insert({ context_kind: "journey", journey_enrollment_id: e, journey_day: 3, journey_day_id: null });`),
    ["a journey insert names no journey_day_id"]);

  // Forms followed since the review (each a known gap before it).
  eq("a table name held in a constant is followed in .from()",
    verdict(`const T = "course_attempts";\nawait svc().from(T).insert({ user_id: "x" });`), [{ kind: "chain", ok: false }]);
  eq("a builder returned by an arrow function is followed",
    verdict(`const attempts = () => svc().from("course_attempts");\nawait attempts().insert({ user_id: "x" });`), [{ kind: "chain", ok: false }]);
  eq("an element-access insert is counted",
    verdict(`await svc().from("course_attempts")["insert"]({ user_id: "x" });`), [{ kind: "chain", ok: false }]);
  eq("a builder held by an assignment is followed",
    verdict(`let q: any;\nq = svc().from("course_attempts");\nawait q.insert({ user_id: "x" });`), [{ kind: "chain", ok: false }]);
  eq("a URL held in a variable is followed",
    verdict("const url = `${SUPA}/rest/v1/course_attempts`;\nawait fetch(url, { method: \"POST\", body: JSON.stringify({ user_id: \"x\" }) });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: false }]);
  eq("a URL built with new URL() is read",
    verdict("await fetch(new URL(\"/rest/v1/course_attempts\", SUPA), { method: \"POST\", body: JSON.stringify({ user_id: \"x\" }) });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: false }]);
  eq("a REST helper of another name called with the /course_attempts path is counted",
    verdict("const post = (p, b) => api(`/rest/v1${p}`, { method: \"POST\", body: JSON.stringify(b) });\nawait post(\"/course_attempts\", { user_id: \"x\" });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: false }]);
  eq("a PUT is an insert (PostgREST upserts on PUT)",
    verdict("await fetch(`${SUPA}/rest/v1/course_attempts?id=eq.${id}`, { method: \"PUT\", body: JSON.stringify({ id, user_id: \"x\" }) });", "scripts/planted.mjs"),
    [{ kind: "rest", ok: false }]);

  const PAGE = "app/planted/launch/page.tsx";
  eq("a pending file whose inserts all name the context is stale (the test fails until it leaves the list)",
    stalePending(scanSource(PAGE, `await svcAttempt.from("course_attempts").insert({ user_id: user.id, context_kind: kind });`), [PAGE]), [PAGE]);
  eq("a pending file that still has an open insert stays",
    stalePending(scanSource(PAGE, `await svcAttempt.from("course_attempts").insert({ user_id: user.id });`), [PAGE]), []);
}

// ---------------------------------------------------------------------------
// (c) The helper against 0107's shape check.
// ---------------------------------------------------------------------------
console.log("\n(c) fixtureAttemptContext against course_attempts_context_shape_chk (0107)");
{
  const raw = fs.readFileSync(path.join(root, "supabase/migrations/0107_learning_contexts.sql"), "utf8");
  const sql = raw.replace(/\s+/g, " ");
  /** SQL with its line comments dropped and its white space collapsed. */
  const flat = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  // The whole check, as 0107 writes it (comments dropped). shapeOk below is
  // its transcription; any change to the check in 0107 fails here first.
  const SHAPE_CHECK = `(
    (case context_kind
       when 'individual' then
         learning_path_id is null and journey_enrollment_id is null and journey_day is null
         and journey_day_id is null and not is_preview
       when 'path' then
         learning_path_id is not null and journey_enrollment_id is null and journey_day is null
         and journey_day_id is null and not is_preview
       when 'journey' then
         journey_enrollment_id is not null and journey_day is not null and journey_day_id is not null
         and learning_path_id is null and not is_preview
       when 'preview' then
         is_preview and preview_kind is not null and (
           (preview_kind in ('course', 'path_run', 'journey_run')
              and learning_path_id is null and journey_enrollment_id is null and journey_day is null
              and (preview_run_id is not null) = (preview_kind in ('path_run', 'journey_run'))
              and (journey_day_id is not null) = (preview_kind = 'journey_run'))
           or (preview_kind = 'legacy_role' and preview_run_id is null and journey_day_id is null))
       else false
     end)
    and (context_kind = 'preview' or (preview_kind is null and preview_run_id is null))
    and (context_kind = 'journey' or journey_version_id is null)
    and ((preview_kind is not null) = (context_kind = 'preview'))
  )`;
  /** The parenthesised body of `add constraint <name> check (...)` in 0107, comments dropped; null when absent. */
  const checkBody = (name: string): string | null => {
    const text = flat(raw);
    const anchor = `add constraint ${name} check (`;
    const at = text.indexOf(anchor);
    if (at < 0 || text.indexOf(anchor, at + 1) >= 0) return null;
    const start = at + anchor.length - 1;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  };
  eq("0107's course_attempts_context_shape_chk, added once, is the whole check transcribed here",
    checkBody("course_attempts_context_shape_chk"), flat(SHAPE_CHECK));
  eq("0107: context_key is generated (an insert may not name it)",
    /add column if not exists context_key text generated always as \(/.test(sql), true);
  eq("0107: day_ids_source admits 'editor'",
    sql.includes("check (day_ids_source in ('slot_backfill', 'editor'))"), true);

  type Row = Record<string, unknown>;
  const nul = (r: Row, k: string) => r[k] === undefined || r[k] === null;
  /** course_attempts_context_shape_chk, transcribed (legacy_role is the only preview kind a fixture writes). */
  const shapeOk = (r: Row): boolean => {
    const isPreview = r.is_preview === true;
    const arm = (() => {
      switch (r.context_kind) {
        case "individual": return nul(r, "learning_path_id") && nul(r, "journey_enrollment_id") && nul(r, "journey_day") && nul(r, "journey_day_id") && !isPreview;
        case "path": return !nul(r, "learning_path_id") && nul(r, "journey_enrollment_id") && nul(r, "journey_day") && nul(r, "journey_day_id") && !isPreview;
        case "journey": return !nul(r, "journey_enrollment_id") && !nul(r, "journey_day") && !nul(r, "journey_day_id") && nul(r, "learning_path_id") && !isPreview;
        case "preview": return isPreview && r.preview_kind === "legacy_role" && nul(r, "preview_run_id") && nul(r, "journey_day_id");
        default: return false;
      }
    })();
    return arm &&
      (r.context_kind === "preview" || (nul(r, "preview_kind") && nul(r, "preview_run_id"))) &&
      (r.context_kind === "journey" || nul(r, "journey_version_id")) &&
      (!nul(r, "preview_kind")) === (r.context_kind === "preview");
  };
  const BASE = { course_version_id: "v", user_id: "u", organization_id: "o", status: "in_progress" };
  const row = (flags: Row): Row => ({ ...BASE, ...flags, ...fixtureAttemptContext({ ...BASE, ...flags }) });
  const thrown = (flags: Row): boolean => { try { fixtureAttemptContext(flags); return false; } catch { return true; } };

  const cases: Array<[string, Row, string]> = [
    ["no flags", {}, "individual"],
    ["is_preview false", { is_preview: false, is_revision: true }, "individual"],
    ["a path tag", { learning_path_id: "p" }, "path"],
    ["a journey tag with its day and day id", { journey_enrollment_id: "e", journey_day: 3, journey_day_id: "d" }, "journey"],
    ["is_preview true", { is_preview: true }, "preview"],
    ["null tags read as absent", { learning_path_id: null, journey_enrollment_id: null, journey_day: null }, "individual"],
    ["is_preview true with null tags", { is_preview: true, learning_path_id: null, journey_day: null }, "preview"],
  ];
  for (const [name, flags, kind] of cases) {
    const r = row(flags);
    eq(`${name}: context_kind ${kind}, and the merged row passes the shape check`, [r.context_kind, shapeOk(r)], [kind, true]);
  }
  eq("is_preview true: preview_kind legacy_role, and nothing else",
    fixtureAttemptContext({ is_preview: true }), { context_kind: "preview", is_preview: true, preview_kind: "legacy_role" });
  eq("the check admits a legacy_role preview with an old path tag; the helper refuses it (step 6: a new preview carries no official tag)",
    [shapeOk({ context_kind: "preview", is_preview: true, preview_kind: "legacy_role", learning_path_id: "p" }), thrown({ is_preview: true, learning_path_id: "p" })],
    [true, true]);
  eq("a journey row carries its three journey columns",
    fixtureAttemptContext({ journey_enrollment_id: "e", journey_day: 3, journey_day_id: "d" }),
    { context_kind: "journey", journey_enrollment_id: "e", journey_day: 3, journey_day_id: "d" });
  eq("never context_key or journey_version_id",
    cases.some(([, flags]) => { const c = fixtureAttemptContext(flags) as Row; return "context_key" in c || "journey_version_id" in c; }), false);
  const refusals: Array<[string, Row]> = [
    ["a path tag with a journey tag", { learning_path_id: "p", journey_enrollment_id: "e", journey_day: 3, journey_day_id: "d" }],
    ["a journey tag without journey_day_id", { journey_enrollment_id: "e", journey_day: 3 }],
    ["journey_day_id without the enrolment", { journey_day: 3, journey_day_id: "d" }],
    ["a preview with journey_day_id", { is_preview: true, journey_enrollment_id: "e", journey_day: 1, journey_day_id: "d" }],
    ["a preview with a path tag", { is_preview: true, learning_path_id: "p" }],
    ["a preview with a journey tag and no day id", { is_preview: true, journey_enrollment_id: "e", journey_day: 2 }],
    ["a preview with a journey day number alone", { is_preview: true, journey_day: 2 }],
    ["a row that names context_kind", { context_kind: "individual" }],
    ["a row that names context_key", { context_key: "individual" }],
    ["a row that names preview_kind", { is_preview: true, preview_kind: "course" }],
  ];
  for (const [name, flags] of refusals) eq(`refused before the database: ${name}`, thrown(flags), true);
  // The first four are pairings the check itself refuses; the next three are
  // previews with an official tag, which step 6 forbids though the check's
  // legacy_role arm admits them; the last three name columns the helper
  // derives, or that no insert may name.
  eq("the check refuses a path tag with a journey tag", shapeOk({ context_kind: "path", learning_path_id: "p", journey_enrollment_id: "e", journey_day: 3, journey_day_id: "d" }), false);
  eq("the check refuses a journey row without journey_day_id", shapeOk({ context_kind: "journey", journey_enrollment_id: "e", journey_day: 3 }), false);
  eq("the check refuses an individual row with journey_day_id alone", shapeOk({ context_kind: "individual", journey_day: 3, journey_day_id: "d" }), false);
  eq("the check refuses a legacy_role preview with journey_day_id", shapeOk({ context_kind: "preview", is_preview: true, preview_kind: "legacy_role", journey_day_id: "d" }), false);
}

// ---------------------------------------------------------------------------
// (d) Journey version fixtures write day_ids (P2-N9).
// ---------------------------------------------------------------------------
console.log("\n(d) every journey_versions fixture insert in tests/ and scripts/ writes day_ids, day_ids_source 'editor' (P2-N9)");
{
  const versionInserts: Array<{ file: string; line: number; ok: boolean }> = [];
  for (const [file, text] of sources) {
    if (!/^(tests|scripts)\//.test(file) || !text.includes("journey_versions")) continue;
    const sf = parse(file, text);
    const visit = (n: ts.Node) => {
      const callee = ts.isCallExpression(n) ? unwrap(n.expression) : null;
      if (ts.isCallExpression(n) && callee && ts.isPropertyAccessExpression(callee) && ["insert", "upsert"].includes(callee.name.text)) {
        let cur: ts.Expression = unwrap(callee.expression);
        let table: string | null = null;
        while (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) {
          if (ts.isCallExpression(cur) && calleeName(cur) === "from") { table = literalText(cur.arguments[0]); break; }
          cur = unwrap(cur.expression);
        }
        if (table === "journey_versions") {
          const arg = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
          const props = arg && ts.isObjectLiteralExpression(arg)
            ? new Map(arg.properties.filter(ts.isPropertyAssignment).map((p) => [propName(p.name), p.initializer] as const))
            : new Map<string | null, ts.Expression>();
          const dayIds = props.get("day_ids");
          const ok = !!dayIds && ts.isObjectLiteralExpression(unwrap(dayIds)) &&
            (unwrap(dayIds) as ts.ObjectLiteralExpression).properties.length > 0 &&
            literalText(props.get("day_ids_source")) === "editor";
          versionInserts.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, ok });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  atLeast("journey_versions fixture inserts found (specs 46 and 55)", versionInserts.length, 2);
  eq("each names a non-empty day_ids map and day_ids_source 'editor'",
    versionInserts.filter((v) => !v.ok).map((v) => `${v.file}:${v.line}`), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
