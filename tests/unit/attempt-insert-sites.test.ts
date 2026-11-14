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
 *     `.upsert(`, followed across lines and through a variable that holds
 *     the `.from(...)` chain;
 *   - a REST POST: `rest("/course_attempts...", { method: "POST", body })`
 *     or any call whose URL holds `/rest/v1/course_attempts` with
 *     `method: "POST"` (fetch and the like); a call without a method is a
 *     GET and not an insert;
 *   - a batch call: `batch("course_attempts", rows)` (any call named like
 *     batch, insert or upsert whose first argument is the table name).
 *
 * The inserted rows (the insert's argument, the body inside JSON.stringify,
 * the batch's rows; an identifier is followed to its initializer and to
 * every `.push(...)` on it) are object literals, and each must:
 *
 *   (1) name `context_kind`, or spread `fixtureAttemptContext(...)`, the
 *       helper of both harnesses (tests/e2e/helpers/supabase.ts, re-exported
 *       by tests/bot/lifecycle/p0-helpers.ts), imported from one of them;
 *   (2) when it names a journey tag or the literal kind 'journey', name
 *       `journey_day_id` (step 62);
 *   (3) when it is a preview (the literal kind 'preview' or is_preview:
 *       true), name `preview_kind` and no official tag (learning_path_id,
 *       journey_enrollment_id, journey_day) (steps 6 and 62).
 *
 * A helper-routed row is held to 0107's shape check by the helper itself,
 * proven by section (c) against a transcription of the check: a journey row
 * gets journey_day_id or throws (rule 2); a preview row is the by-role kind,
 * legacy_role, which the check lets keep old tags (step 6), so rule (3)'s
 * "no official tag" binds the literal rows, where a new preview kind is
 * written. A row whose kind is computed (not a string literal) is held to
 * (1) only by this scan; P2-6 states how the launch page's computed kinds
 * are read.
 *
 * Exceptions, each listed with its date and reason:
 *   - PENDING: the launch page, until P2-6 names the context on both of its
 *     inserts. The test fails when a pending file no longer needs the entry.
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

/** A URL argument's text, with `${}` for each substitution. */
function urlText(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  const lit = literalText(u);
  if (lit !== null) return lit;
  if (ts.isTemplateExpression(u)) return u.head.text + u.templateSpans.map((s) => "${}" + s.literal.text).join("");
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (urlText(u.left) ?? "${}") + (urlText(u.right) ?? "${}");
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
  return null;
}

type FileIndex = { decls: Map<string, ts.Expression[]>; pushes: Map<string, ts.Expression[]>; helperImported: boolean };

function indexFile(file: string, sf: ts.SourceFile): FileIndex {
  const decls = new Map<string, ts.Expression[]>();
  const pushes = new Map<string, ts.Expression[]>();
  let helperImported = HELPER_MODULES.includes(file);
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      decls.set(n.name.text, [...(decls.get(n.name.text) ?? []), n.initializer]);
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push" && ts.isIdentifier(unwrap(callee.expression))) {
        const name = (unwrap(callee.expression) as ts.Identifier).text;
        pushes.set(name, [...(pushes.get(name) ?? []), ...n.arguments]);
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
  return { decls, pushes, helperImported };
}

/** The `.from("course_attempts")` call a write is made on, if any (through a variable once). */
function fromCallIn(e: ts.Expression, idx: FileIndex, seen = new Set<string>()): ts.CallExpression | null {
  let cur: ts.Expression = e;
  for (;;) {
    cur = unwrap(cur);
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "from" && literalText(cur.arguments[0]) === TABLE) return cur;
      cur = callee;
    } else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
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

function checkObject(obj: ts.ObjectLiteralExpression): Verdict {
  const props = new Map<string, ts.Expression | null>();
  let helper = false;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const name = propName(p.name);
      if (name) props.set(name, p.initializer);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      props.set(p.name.text, null);
    } else if (ts.isSpreadAssignment(p)) {
      const s = unwrap(p.expression);
      if (ts.isCallExpression(s) && ts.isIdentifier(unwrap(s.expression)) && (unwrap(s.expression) as ts.Identifier).text === HELPER) helper = true;
    }
  }
  const problems: string[] = [];
  if (!helper && !props.has("context_kind")) problems.push("names no context_kind");
  if (!helper) {
    const kind = literalText(props.get("context_kind") ?? undefined);
    const isTrue = (e: ts.Expression | null | undefined) => !!e && unwrap(e).kind === ts.SyntaxKind.TrueKeyword;
    const isNull = (e: ts.Expression | null | undefined) => !!e && unwrap(e).kind === ts.SyntaxKind.NullKeyword;
    if ((kind === "journey" || props.has("journey_enrollment_id")) && !props.has("journey_day_id")) {
      problems.push("a journey insert names no journey_day_id");
    }
    if (kind === "preview" || isTrue(props.get("is_preview"))) {
      if (!props.has("preview_kind")) problems.push("a preview insert names no preview_kind");
      const tags = OFFICIAL_TAGS.filter((t) => props.has(t) && !isNull(props.get(t)));
      if (tags.length) problems.push(`a preview insert names an official tag (${tags.join(", ")})`);
    }
  }
  return { problems, rows: 1, helper };
}

function checkRows(e: ts.Expression | undefined, idx: FileIndex, depth = 0): Verdict {
  if (!e) return { problems: ["the insert has no rows argument"], rows: 0, helper: false };
  const u = unwrap(e);
  const merge = (vs: Verdict[]): Verdict => ({
    problems: vs.flatMap((v) => v.problems),
    rows: vs.reduce((n, v) => n + v.rows, 0),
    helper: vs.length > 0 && vs.every((v) => v.helper),
  });
  if (ts.isObjectLiteralExpression(u)) return checkObject(u);
  if (ts.isArrayLiteralExpression(u)) {
    return merge(u.elements.map((el) => checkRows(ts.isSpreadElement(el) ? el.expression : el, idx, depth + 1)));
  }
  if (ts.isCallExpression(u) && u.expression.getText() === "JSON.stringify") return checkRows(u.arguments[0], idx, depth + 1);
  if (ts.isIdentifier(u) && depth < 4) {
    const sources = [...(idx.decls.get(u.text) ?? []), ...(idx.pushes.get(u.text) ?? [])];
    const v = merge(sources.map((s) => checkRows(s, idx, depth + 1)));
    if (v.rows === 0) v.problems.push(`the rows in \`${u.text}\` cannot be found (no object literal assigned or pushed)`);
    return v;
  }
  return { problems: [`the rows (\`${u.getText().slice(0, 60)}\`) are not an object literal, an array of them or a variable the scan can follow`], rows: 0, helper: false };
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
      if (ts.isPropertyAccessExpression(callee) && (name === "insert" || name === "upsert")) {
        const from = fromCallIn(callee.expression, idx);
        if (from) {
          const on = unwrap(from.expression) as ts.PropertyAccessExpression;
          add(n, "chain", on.expression.getText(sf), checkRows(n.arguments[0], idx));
        }
      }
      // (2) REST POSTs.
      const url = urlText(n.arguments[0]);
      // A URL has no white space (a test's name that mentions the path is not one).
      const restPath = name === "rest" && url !== null && /^\/course_attempts(?![\w])\S*$/.test(url);
      const restV1 = url !== null && /^\S*\/rest\/v1\/course_attempts(?![\w])\S*$/.test(url);
      if (restPath || restV1) {
        const opts = n.arguments[1] ? unwrap(n.arguments[1]) : undefined;
        if (opts && !ts.isObjectLiteralExpression(opts)) {
          add(n, "rest", name ?? "?", { problems: [], rows: 0, helper: false }, ["the request options are not an object literal, so the method cannot be read"]);
        } else if (opts) {
          const prop = (k: string) => opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propName(p.name) === k);
          const method = prop("method");
          const m = method ? literalText(method.initializer) : "GET";
          if (m === null) add(n, "rest", name ?? "?", { problems: [], rows: 0, helper: false }, ["the method is not a string literal"]);
          else if (m.toUpperCase() === "POST") add(n, "rest", name ?? "?", checkRows(prop("body")?.initializer, idx));
        }
      }
      // (3) batch calls: batch("course_attempts", rows).
      if (ts.isIdentifier(callee) && /batch|insert|upsert/i.test(callee.text) && literalText(n.arguments[0]) === TABLE) {
        add(n, "batch", callee.text, checkRows(n.arguments[1], idx));
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
const PENDING = {
  since: "2026-11-14",
  until: "emptied by P2-6 (ADR 0024 step 23: both launch inserts name context_kind with the tags)",
  files: ["app/[org]/(learner)/courses/[courseId]/launch/page.tsx"],
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
  const pendingOpen = open.filter((s) => PENDING.files.includes(s.file));
  eq("no insert outside the pending list names no context (or breaks rule 2 or 3)",
    open.filter((s) => !PENDING.files.includes(s.file)).map(show), []);
  eq(`the pending list (since ${PENDING.since}, ${PENDING.until}) holds only files that still need it`,
    stalePending(sites.filter((s) => !refused(s)), PENDING.files), []);
  if (pendingOpen.length) console.log(`  note: pending since ${PENDING.since}: ${pendingOpen.map((s) => `${s.file}:${s.line}`).join(", ")}`);
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
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/0107_learning_contexts.sql"), "utf8").replace(/\s+/g, " ");
  // The arms transcribed below, as 0107 writes them (whitespace collapsed).
  const ARMS = [
    "when 'individual' then learning_path_id is null and journey_enrollment_id is null and journey_day is null and journey_day_id is null and not is_preview",
    "when 'path' then learning_path_id is not null and journey_enrollment_id is null and journey_day is null and journey_day_id is null and not is_preview",
    "when 'journey' then journey_enrollment_id is not null and journey_day is not null and journey_day_id is not null and learning_path_id is null and not is_preview",
    "when 'preview' then is_preview and preview_kind is not null and (",
    "or (preview_kind = 'legacy_role' and preview_run_id is null and journey_day_id is null))",
    "and (context_kind = 'preview' or (preview_kind is null and preview_run_id is null))",
    "and (context_kind = 'journey' or journey_version_id is null)",
    "and ((preview_kind is not null) = (context_kind = 'preview'))",
  ];
  eq("0107 holds the transcribed arms of the shape check", ARMS.filter((a) => !sql.includes(a)), []);
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
    ["a by-role preview with an old path tag (the legacy_role arm)", { is_preview: true, learning_path_id: "p" }, "preview"],
    ["a by-role preview with an old journey tag, no day id", { is_preview: true, journey_enrollment_id: "e", journey_day: 2 }, "preview"],
  ];
  for (const [name, flags, kind] of cases) {
    const r = row(flags);
    eq(`${name}: context_kind ${kind}, and the merged row passes the shape check`, [r.context_kind, shapeOk(r)], [kind, true]);
  }
  eq("is_preview true: preview_kind legacy_role",
    fixtureAttemptContext({ is_preview: true }), { context_kind: "preview", is_preview: true, preview_kind: "legacy_role" });
  eq("a by-role preview keeps the old tags it was given",
    fixtureAttemptContext({ is_preview: true, journey_enrollment_id: "e", journey_day: 2 }),
    { context_kind: "preview", is_preview: true, preview_kind: "legacy_role", journey_enrollment_id: "e", journey_day: 2 });
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
    ["a row that names context_kind", { context_kind: "individual" }],
    ["a row that names context_key", { context_key: "individual" }],
    ["a row that names preview_kind", { is_preview: true, preview_kind: "course" }],
  ];
  for (const [name, flags] of refusals) eq(`refused before the database: ${name}`, thrown(flags), true);
  // The first four are pairings the check itself refuses; the last three
  // name columns the helper derives, or that no insert may name.
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
