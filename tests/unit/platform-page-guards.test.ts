/**
 * The platform page rule: a platform page is never protected by its layout
 * alone. Every page under app/(super-owner)/ awaits the platform-owner page
 * guard itself, requirePlatformOwner() from lib/auth/require-platform-owner.ts
 * (the function the platform layout calls), as its first statement, before
 * any read. A navigation inside the console renders the new page without
 * re-running the layout, and a layout and its page render side by side, so a
 * request that skips or races the layout must still get nothing.
 *
 * What counts as a platform file: every page, layout, template and default
 * file Next serves (.tsx, .ts, .jsx and .js, Next's default extensions) that
 * sits under app/(super-owner)/, or whose URL path, with route groups `(x)`
 * and parallel slots `@x` dropped as Next drops them, is /super or lies under
 * it, or that intercepts a /super path (`(.)super`, `(..)super`...).
 *
 * The rule on each such file:
 *   - its default export is an async function whose first statement is
 *     `await requirePlatformOwner()` (or `const x = await
 *     requirePlatformOwner()`), the guard imported by name from
 *     @/lib/auth/require-platform-owner and declared nowhere in the file; its
 *     parameters carry no default values (they would run first);
 *   - an exported generateMetadata or generateViewport starts the same way:
 *     metadata never reads data before the guard. A static `metadata` object
 *     reads nothing and passes;
 *   - no top-level await (module code runs outside any request's guard), and
 *     nothing is exported through an export list or a re-export, which the
 *     scan could not read;
 *   - every "use server" action reachable from it starts with the same
 *     guard: file-level ("use server" at the top: every exported function)
 *     or inline (a function whose body begins with "use server"), in the
 *     file itself or in any project module it imports, statically or with
 *     import(), followed transitively through `@/` and relative paths.
 *
 * Four parts:
 *   1. The scan on the real tree (TypeScript's parser, no type checker).
 *   2. Planted cases: each rule fires, and the right shapes pass.
 *   3. A planted tree (outside the repository): the walk finds a page in the
 *      group outside /super, a /super page outside the group, nested groups,
 *      a slot, .js and .jsx pages, a layout, a template, a default and an
 *      intercepting route, and no other file; the import walk finds a
 *      "use server" module through `@/`, a relative path and import().
 *   4. Every platform page and layout, called as Next calls it, under a
 *      stubbed Auth and PostgREST and a stubbed next/headers cookie jar:
 *      each refused caller is redirected before the file sends a single
 *      request of its own and nothing is written; an admitted owner gets the
 *      page, which then reads its data.
 *
 * The guard's last_mfa_check_at write: the guard is wrapped in React's
 * cache(), so within one server render the layout and the page share one run
 * and the write happens once per request. React keeps that cache only inside
 * a server render, so this script (plain Node, no render) sees each call run
 * in full: part 4 checks one write per admitted call, and part 1 checks the
 * wrapping in the source.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/platform-page-guards.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");

/* ---------------- 1. the scan ---------------- */

const GUARD = "requirePlatformOwner";
const GUARD_MODULE = "@/lib/auth/require-platform-owner";
const GROUP_DIR = "app/(super-owner)/";
/** Exports that Next calls per request beside the default export. */
const PER_REQUEST_EXPORTS = new Set(["generateMetadata", "generateViewport"]);

const skip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};
const kindOf = (file: string) =>
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
function walk(n: ts.Node, f: (n: ts.Node) => void) { f(n); ts.forEachChild(n, (c) => walk(c, f)); }
const hasModifier = (n: ts.Node, k: ts.SyntaxKind) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === k);

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const isFn = (e: ts.Node | undefined): e is Fn => !!e && (ts.isFunctionDeclaration(e) || ts.isFunctionExpression(e) || ts.isArrowFunction(e));

/** Top-level functions by name: `function f` and `const f = async () => …` / `= function …`. */
function localFns(sf: ts.SourceFile): Map<string, Fn> {
  const out = new Map<string, Fn>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      const init = d.initializer ? skip(d.initializer) : undefined;
      if (ts.isIdentifier(d.name) && isFn(init)) out.set(d.name.text, init);
    }
  }
  return out;
}

/** The string directives that open a block ("use server", "use strict"…). */
function directivesOf(statements: readonly ts.Statement[]): { names: string[]; rest: readonly ts.Statement[] } {
  let i = 0;
  const names: string[] = [];
  while (i < statements.length) {
    const st = statements[i];
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    names.push(st.expression.text);
    i++;
  }
  return { names, rest: statements.slice(i) };
}

/** `await requirePlatformOwner()` with no arguments. */
function isGuardAwait(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  const aw = skip(e);
  if (!ts.isAwaitExpression(aw)) return false;
  const call = skip(aw.expression);
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === GUARD && call.arguments.length === 0;
}
/** `await requirePlatformOwner();` or `const <binding> = await requirePlatformOwner();`. */
function isGuardStatement(st: ts.Statement | undefined): boolean {
  if (!st) return false;
  if (ts.isExpressionStatement(st)) return isGuardAwait(st.expression);
  if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) return isGuardAwait(st.declarationList.declarations[0].initializer);
  return false;
}

/** Every problem with one function that must start with the guard ("<label>: <what>"). */
function checkGuarded(label: string, fn: Fn): string[] {
  const out: string[] = [];
  if (!hasModifier(fn, ts.SyntaxKind.AsyncKeyword)) out.push(`${label}: is not an async function`);
  let defaults = false;
  for (const p of fn.parameters) walk(p, (n) => { if ((ts.isParameter(n) || ts.isBindingElement(n)) && n.initializer) defaults = true; });
  if (defaults) out.push(`${label}: its parameters carry default values (they run before the guard)`);
  const body = fn.body && ts.isBlock(fn.body) ? fn.body : null;
  if (!body || !isGuardStatement(directivesOf(body.statements).rest[0])) out.push(`${label}: the first statement is not \`await ${GUARD}()\``);
  return out;
}

/** The guard must be the shared one: a named import from its module, declared nowhere in the file. */
function guardImportProblems(file: string, sf: ts.SourceFile): string[] {
  let imported = false, declared = false;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) {
      if (el.name.text !== GUARD) continue;
      if (st.moduleSpecifier.text === GUARD_MODULE && (el.propertyName ?? el.name).text === GUARD && !st.importClause?.isTypeOnly && !el.isTypeOnly) imported = true;
      else declared = true;
    }
    if (st.importClause?.name?.text === GUARD || (nb && ts.isNamespaceImport(nb) && nb.name.text === GUARD)) declared = true;
  }
  walk(sf, (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === GUARD) declared = true;
  });
  const out: string[] = [];
  if (declared) out.push(`${file}: ${GUARD} is not the one from ${GUARD_MODULE}`);
  else if (!imported) out.push(`${file}: ${GUARD} is not imported from ${GUARD_MODULE}`);
  return out;
}

/** Every "use server" action in a file: file-level (each exported function) and inline. */
function serverActionProblems(file: string, sf: ts.SourceFile): { problems: string[]; actions: number } {
  const out: string[] = [];
  let actions = 0;
  const fileLevel = directivesOf(sf.statements).names.includes("use server");
  if (fileLevel) {
    const local = localFns(sf);
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) && !st.isTypeOnly) out.push(`${file}: a "use server" file exports through an export list or re-export (write actions as \`export async function name\`)`);
      if (ts.isExportAssignment(st)) {
        const e = skip(st.expression);
        const fn = isFn(e) ? e : ts.isIdentifier(e) ? local.get(e.text) : undefined;
        actions++;
        if (fn) out.push(...checkGuarded(`${file} default action`, fn));
        else out.push(`${file}: a "use server" file has a default export the scan cannot read`);
      }
      if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isFunctionDeclaration(st)) { actions++; out.push(...checkGuarded(`${file} ${st.name?.text ?? "default"} action`, st)); }
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
        const init = d.initializer ? skip(d.initializer) : undefined;
        const name = ts.isIdentifier(d.name) ? d.name.text : "?";
        actions++;
        if (isFn(init)) out.push(...checkGuarded(`${file} ${name} action`, init));
        else if (init && ts.isIdentifier(init) && local.has(init.text)) out.push(...checkGuarded(`${file} ${name} action`, local.get(init.text)!));
        else out.push(`${file} ${name} action: not a function the scan can read`);
      }
    }
  }
  walk(sf, (n) => {
    if (!isFn(n) && !ts.isMethodDeclaration(n)) return;
    const body = n.body && ts.isBlock(n.body) ? n.body : null;
    if (!body || !directivesOf(body.statements).names.includes("use server")) return;
    actions++;
    const name = (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) ? n.name.text
      : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : "inline";
    if (ts.isMethodDeclaration(n)) { out.push(`${file} ${name} action: an inline action must be a function the scan can read`); return; }
    out.push(...checkGuarded(`${file} ${name} action`, n));
  });
  return { problems: out, actions };
}

/** Is there an `await` at module level (outside every function)? */
function hasTopLevelAwait(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** Every problem the rule finds in one platform page, layout, template or default file. */
function scanSegment(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  const local = localFns(sf);
  if (directivesOf(sf.statements).names.includes("use client")) out.push(`${file}: is a client component (a platform page or layout is a server component that checks the caller)`);
  if (hasTopLevelAwait(sf)) out.push(`${file}: awaits at module level (module code runs outside any request's guard)`);
  // The two export forms the scan reads; anything else could hide a page or
  // a per-request export from it.
  let def: Fn | null = null, defForms = 0;
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) out.push(`${file}: exports through an export list or re-export (write \`export default async function\` and \`export async function generateMetadata\`)`);
    if (ts.isFunctionDeclaration(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword) && hasModifier(st, ts.SyntaxKind.DefaultKeyword)) { def = st; defForms++; }
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const e = skip(st.expression);
      const fn = isFn(e) ? e : ts.isIdentifier(e) ? local.get(e.text) ?? null : null;
      defForms++;
      if (fn) def = fn;
      else out.push(`${file}: has a default export the scan cannot read (write \`export default async function\`)`);
    }
  }
  if (defForms === 0) out.push(`${file}: has no default export`);
  if (def) out.push(...checkGuarded(`${file} default export`, def));
  for (const st of sf.statements) {
    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(st) && st.name && PER_REQUEST_EXPORTS.has(st.name.text)) out.push(...checkGuarded(`${file} ${st.name.text}`, st));
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !PER_REQUEST_EXPORTS.has(d.name.text)) continue;
      const init = d.initializer ? skip(d.initializer) : undefined;
      const fn = isFn(init) ? init : init && ts.isIdentifier(init) ? local.get(init.text) : undefined;
      if (fn) out.push(...checkGuarded(`${file} ${d.name.text}`, fn));
      else out.push(`${file} ${d.name.text}: not a function the scan can read`);
    }
  }
  out.push(...guardImportProblems(file, sf));
  out.push(...serverActionProblems(file, sf).problems);
  return out;
}

/** Every problem in a module reachable from a platform file: its "use server" actions. */
function scanReachable(file: string, src: string): { problems: string[]; actions: number } {
  const sf = parse(file, src);
  const r = serverActionProblems(file, sf);
  return { problems: r.actions > 0 ? [...r.problems, ...guardImportProblems(file, sf)] : r.problems, actions: r.actions };
}

/** A segment file under Next's default page extensions (next.config sets none of its own; checked below). */
const SEGMENT_FILE = /^(page|layout|template|default)\.(tsx|ts|jsx|js)$/;
/** An intercepting segment that shows a /super page: `(.)super`, `(..)super`, `(...)super`, `(..)(..)super`. */
const INTERCEPTS_SUPER = /^(\(\.{1,3}\))+super$/;
const toPosix = (p: string) => p.split(path.sep).join("/");

/** Every segment file under <base>/app, as "app/..." with forward slashes. */
function segmentFiles(base: string, dir = path.join(base, "app"), out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) segmentFiles(base, p, out);
    else if (SEGMENT_FILE.test(e.name)) out.push(toPosix(path.relative(base, p)));
  }
  return out.sort();
}
/** The URL path a segment file is served at: route groups `(x)` and parallel slots `@x` are dropped, as Next drops them. */
function urlPathOf(file: string): string {
  const segments = file.split("/").slice(1, -1);
  return "/" + segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@")).join("/");
}
const isPlatformSegment = (f: string) => {
  const u = urlPathOf(f);
  return f.startsWith(GROUP_DIR) || u === "/super" || u.startsWith("/super/") || f.split("/").some((s) => INTERCEPTS_SUPER.test(s));
};
const platformSegmentFiles = (base: string) => segmentFiles(base).filter(isPlatformSegment);

const SOURCE = /\.(tsx|ts|jsx|js|mts|mjs|cts|cjs)$/;
/** A project import (`@/…` or relative) resolved to a source file under <base>, or null for a package. */
function resolveImport(base: string, from: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = path.join(base, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) p = path.resolve(path.dirname(path.join(base, from)), spec);
  else return null;
  const tries = [p, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"].map((e) => p + e), ...["ts", "tsx", "js", "jsx"].map((e) => path.join(p, `index.${e}`))];
  for (const c of tries) if (SOURCE.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) return toPosix(path.relative(base, c));
  return null;
}
/** The project modules a file loads at run time: imports, re-exports and import() with a literal path (type-only imports skipped). */
function importsOf(base: string, file: string, src: string): string[] {
  const sf = parse(file, src);
  const specs: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && !st.importClause?.isTypeOnly) specs.push(st.moduleSpecifier.text);
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) specs.push(st.moduleSpecifier.text);
  }
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) specs.push(n.arguments[0].text);
  });
  return specs.map((s) => resolveImport(base, file, s)).filter((f): f is string => f !== null);
}
/** Every project module reachable from the roots, the roots included. */
function reachable(base: string, roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const g of importsOf(base, f, fs.readFileSync(path.join(base, f), "utf8"))) if (!seen.has(g)) queue.push(g);
  }
  return [...seen].sort();
}
/** Every source file under app/(super-owner)/ (client components included): roots of the import walk beside the segment files. */
function groupSources(base: string): string[] {
  const out: string[] = [];
  const dir = path.join(base, ...GROUP_DIR.split("/").filter(Boolean));
  if (!fs.existsSync(dir)) return out;
  const go = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (SOURCE.test(e.name)) out.push(toPosix(path.relative(base, p)));
    }
  };
  go(dir);
  return out.sort();
}

/** The whole rule on a tree: problems in segment files and in every module reachable from the platform files. */
function scanTree(base: string) {
  const segments = platformSegmentFiles(base);
  const roots = [...new Set([...segments, ...groupSources(base)])].sort();
  const modules = reachable(base, roots);
  const problems: string[] = [];
  let actions = 0;
  for (const f of modules) {
    const src = fs.readFileSync(path.join(base, f), "utf8");
    if (segments.includes(f)) { problems.push(...scanSegment(f, src)); actions += serverActionProblems(f, parse(f, src)).actions; }
    else { const r = scanReachable(f, src); problems.push(...r.problems); actions += r.actions; }
  }
  return { segments, modules, problems, actions };
}

console.log("\nthe scan: every platform page and layout awaits the guard first");
{
  const all = segmentFiles(root);
  const t = scanTree(root);
  const pages = t.segments.filter((f) => /\/page\.\w+$/.test(f));
  eq(`non-vacuous: the walk covers all of app/ (${all.length} segment files, ${t.segments.length} platform)`, all.length > t.segments.length && all.some((f) => f.startsWith("app/[org]/")), true);
  eq("next.config sets no pageExtensions of its own (the walk reads Next's default extensions)", /pageExtensions/.test(fs.readFileSync(path.join(root, "next.config.ts"), "utf8")), false);
  eq("the platform layout is read", t.segments.includes("app/(super-owner)/layout.tsx"), true);
  for (const p of ["super/page.tsx", "super/admins/page.tsx", "super/audit/page.tsx", "super/broadcasts/page.tsx", "super/organizations/page.tsx", "super/organizations/new/page.tsx", "super/organizations/[id]/page.tsx", "super/plans/page.tsx"]) {
    eq(`non-vacuous: ${GROUP_DIR}${p} is read`, pages.includes(`${GROUP_DIR}${p}`), true);
  }
  eq("the multi-factor pages are not platform pages (they must open before the second factor)", t.segments.filter((f) => f.startsWith("app/super-mfa/")), []);
  eq(`non-vacuous: the import walk reads the client components and their modules (${t.modules.length} files)`, t.modules.includes("app/(super-owner)/super/plans/plans-editor.tsx") && t.modules.includes("lib/auth/require-platform-owner.ts"), true);
  eq("no rule is broken in any platform file or any module they reach", t.problems, []);
  console.log(`    (${t.actions} "use server" action(s) reachable from the platform files)`);

  // The guard writes last_mfa_check_at; React's cache() makes it one run per server render.
  const g = parse("lib/auth/require-platform-owner.ts", fs.readFileSync(path.join(root, "lib/auth/require-platform-owner.ts"), "utf8"));
  let cacheFromReact = false, wrapped = false;
  for (const st of g.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "react") {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) cacheFromReact ||= nb.elements.some((el) => el.name.text === "cache" && (el.propertyName ?? el.name).text === "cache");
    }
    if (ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword) && st.declarationList.flags & ts.NodeFlags.Const) for (const d of st.declarationList.declarations) {
      const init = d.initializer ? skip(d.initializer) : undefined;
      if (ts.isIdentifier(d.name) && d.name.text === GUARD && init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "cache" && init.arguments.length === 1 && isFn(skip(init.arguments[0]))) wrapped = true;
    }
  }
  eq("the guard is `export const requirePlatformOwner = cache(async () => …)` with cache from react: one run, one write, per server render", [cacheFromReact, wrapped], [true, true]);
}

console.log("\nthe scan: planted cases");
{
  const F = "app/(super-owner)/super/__planted__/page.tsx";
  const HEAD = `import { createClient as createServiceClient } from "@supabase/supabase-js";\nimport { requirePlatformOwner } from "@/lib/auth/require-platform-owner";\nconst svc = () => createServiceClient("u", "k");\n`;
  const PAGE = (body: string) => `export default async function PlantedPage() {\n${body}\n  return null;\n}\n`;
  const READ = `  const { data } = await svc().from("organizations").select("*");`;
  const good = PAGE(`  await requirePlatformOwner();\n${READ}`);
  const scan = (src: string, file = F) => scanSegment(file, src);
  const FIRST = `${F} default export: the first statement is not \`await ${GUARD}()\``;
  eq("the right shape passes", scan(HEAD + good), []);
  eq("…with the guard's answer kept (`const { user } = await requirePlatformOwner()`)", scan(HEAD + PAGE(`  const { user } = await requirePlatformOwner();\n${READ}\n  void user;`)), []);
  eq("…as `async function P` then `export default P`", scan(HEAD + `async function P() {\n  await requirePlatformOwner();\n${READ}\n  return null;\n}\nexport default P;\n`), []);
  eq("…as `const P = async () => {…}` then `export default P`", scan(HEAD + `const P = async ({ params }: { params: Promise<{ id: string }> }) => {\n  await requirePlatformOwner();\n  const { id } = await params;\n  return id;\n};\nexport default P;\n`), []);
  eq("…with a static metadata object and the dynamic flag", scan(HEAD + `export const dynamic = "force-dynamic";\nexport const metadata = { title: "Plans" };\n` + good), []);
  eq("a page with no guard fails", scan(HEAD + PAGE(READ)), [FIRST]);
  eq("a guard after a data read fails", scan(HEAD + PAGE(`${READ}\n  await requirePlatformOwner();`)), [FIRST]);
  eq("a guard after reading the route params fails (the guard comes first, before anything)", scan(HEAD + `export default async function P({ params }: { params: Promise<{ id: string }> }) {\n  const { id } = await params;\n  await requirePlatformOwner();\n  return id;\n}\n`), [FIRST]);
  eq("a guard that is not awaited fails (the read races it)", scan(HEAD + PAGE(`  requirePlatformOwner();\n${READ}`)), [FIRST]);
  eq("…nor one started and awaited later", scan(HEAD + PAGE(`  const gate = requirePlatformOwner();\n${READ}\n  await gate;`)), [FIRST]);
  eq("a guard inside a branch fails", scan(HEAD + PAGE(`  if (process.env.X) await requirePlatformOwner();\n${READ}`)), [FIRST]);
  eq("a guard inside a try fails", scan(HEAD + PAGE(`  try { await requirePlatformOwner(); } catch {}\n${READ}`)), [FIRST]);
  eq("a page that is not async fails", scan(HEAD + `export default function P() {\n  return null;\n}\n`), [`${F} default export: is not an async function`, FIRST]);
  eq("a parameter default that runs before the guard fails", scan(HEAD + `export default async function P(_p: unknown, rows = svc().from("organizations").select("*")) {\n  await requirePlatformOwner();\n  return rows;\n}\n`), [`${F} default export: its parameters carry default values (they run before the guard)`]);
  eq("…in a destructured parameter too", scan(HEAD + `export default async function P({ rows = svc().from("organizations").select("*") }: { rows?: unknown }) {\n  await requirePlatformOwner();\n  return rows;\n}\n`), [`${F} default export: its parameters carry default values (they run before the guard)`]);
  eq("a module-level read fails", scan(HEAD + `const { data: ROWS } = await svc().from("organizations").select("*");\n` + good), [`${F}: awaits at module level (module code runs outside any request's guard)`]);
  eq("a guard of the same name declared in the file fails", scan(HEAD.replace(`import { requirePlatformOwner } from "@/lib/auth/require-platform-owner";\n`, "") + `async function requirePlatformOwner() { return { user: null }; }\n` + good), [`${F}: ${GUARD} is not the one from ${GUARD_MODULE}`]);
  eq("a guard of the same name imported from elsewhere fails", scan(HEAD.replace(GUARD_MODULE, "@/lib/auth/elsewhere") + good), [`${F}: ${GUARD} is not the one from ${GUARD_MODULE}`]);
  eq("another function imported under the guard's name fails", scan(HEAD.replace(`{ requirePlatformOwner }`, `{ requirePlatformOwnerApi as requirePlatformOwner }`) + good), [`${F}: ${GUARD} is not the one from ${GUARD_MODULE}`]);
  eq("the guard under another name fails", scan(HEAD.replace(`{ requirePlatformOwner }`, `{ requirePlatformOwner as gate }`) + PAGE(`  await gate();\n${READ}`)), [FIRST, `${F}: ${GUARD} is not imported from ${GUARD_MODULE}`]);
  eq("the API guard in its place fails", scan(HEAD + `import { requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";\n` + PAGE(`  const guard = await requirePlatformOwnerApi("full");\n  if ("error" in guard) return null;\n${READ}`)), [FIRST]);
  eq("a default export through an export list fails", scan(HEAD + `async function P() {\n  await requirePlatformOwner();\n  return null;\n}\nexport { P as default };\n`), [`${F}: exports through an export list or re-export (write \`export default async function\` and \`export async function generateMetadata\`)`, `${F}: has no default export`]);
  eq("a page re-exported from another module fails", scan(HEAD + `export { default } from "../elsewhere/page";\n`), [`${F}: exports through an export list or re-export (write \`export default async function\` and \`export async function generateMetadata\`)`, `${F}: has no default export`]);
  eq("a default export the scan cannot read fails", scan(HEAD + `import { wrap } from "@/lib/wrap";\nexport default wrap(async () => null);\n`), [`${F}: has a default export the scan cannot read (write \`export default async function\`)`]);
  eq("a file with no default export fails", scan(HEAD + `export const dynamic = "force-dynamic";\n`), [`${F}: has no default export`]);
  eq("a client component as the page fails", scan(`"use client";\n` + HEAD + good), [`${F}: is a client component (a platform page or layout is a server component that checks the caller)`]);
  const META = (body: string) => `export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {\n${body}\n}\n`;
  eq("generateMetadata that awaits the guard first passes", scan(HEAD + good + META(`  await requirePlatformOwner();\n  const { id } = await params;\n  const { data } = await svc().from("organizations").select("name").eq("id", id).maybeSingle();\n  return { title: (data as { name?: string } | null)?.name ?? "Organization" };`)), []);
  eq("generateMetadata that reads data before the guard fails", scan(HEAD + good + META(`  const { id } = await params;\n  const { data } = await svc().from("organizations").select("name").eq("id", id).maybeSingle();\n  return { title: (data as { name?: string } | null)?.name ?? "Organization" };`)), [`${F} generateMetadata: the first statement is not \`await ${GUARD}()\``]);
  eq("…written as `export const generateMetadata = async () => …`", scan(HEAD + good + `export const generateMetadata = async () => {\n  const { data } = await svc().from("organizations").select("name").limit(1);\n  return { title: String(data) };\n};\n`), [`${F} generateMetadata: the first statement is not \`await ${GUARD}()\``]);
  eq("generateViewport is held to the same rule", scan(HEAD + good + `export async function generateViewport() {\n  return { themeColor: "#000" };\n}\n`), [`${F} generateViewport: the first statement is not \`await ${GUARD}()\``]);
  eq("an inline server action that awaits the guard first passes", scan(HEAD + `export default async function P() {\n  await requirePlatformOwner();\n  async function save(form: FormData) {\n    "use server";\n    await requirePlatformOwner();\n    await svc().from("organizations").update({ name: String(form.get("name")) }).eq("id", "x");\n  }\n  return save;\n}\n`), []);
  eq("an inline server action with no guard fails (the page's guard does not cover a later POST)", scan(HEAD + `export default async function P() {\n  await requirePlatformOwner();\n  async function save(form: FormData) {\n    "use server";\n    await svc().from("organizations").update({ name: String(form.get("name")) }).eq("id", "x");\n  }\n  return save;\n}\n`), [`${F} save action: the first statement is not \`await ${GUARD}()\``]);
  eq("…an inline arrow action too", scan(HEAD + `export default async function P() {\n  await requirePlatformOwner();\n  const drop = async () => {\n    "use server";\n    await svc().from("organizations").delete().eq("id", "x");\n  };\n  return drop;\n}\n`), [`${F} drop action: the first statement is not \`await ${GUARD}()\``]);
  const A = "lib/planted/actions.ts";
  const AHEAD = `"use server";\nimport { createClient as createServiceClient } from "@supabase/supabase-js";\nimport { requirePlatformOwner } from "@/lib/auth/require-platform-owner";\nconst svc = () => createServiceClient("u", "k");\n`;
  const ACT = (name: string, body: string) => `export async function ${name}(id: string) {\n${body}\n}\n`;
  const DEL = `  await svc().from("organizations").delete().eq("id", id);`;
  eq("a \"use server\" module whose actions await the guard first passes", scanReachable(A, AHEAD + ACT("removeOrg", `  await requirePlatformOwner();\n${DEL}`)).problems, []);
  eq("…an action with no guard fails", scanReachable(A, AHEAD + ACT("removeOrg", DEL)).problems, [`${A} removeOrg action: the first statement is not \`await ${GUARD}()\``]);
  eq("…an action written as `export const x = async () => …` with no guard fails", scanReachable(A, AHEAD + `export const removeOrg = async (id: string) => {\n${DEL}\n};\n`).problems, [`${A} removeOrg action: the first statement is not \`await ${GUARD}()\``]);
  eq("…actions exported through a list fail", scanReachable(A, AHEAD + `async function removeOrg(id: string) {\n  await requirePlatformOwner();\n${DEL}\n}\nexport { removeOrg };\n`).problems, [`${A}: a "use server" file exports through an export list or re-export (write actions as \`export async function name\`)`]);
  eq("…a guard of the same name from elsewhere fails", scanReachable(A, AHEAD.replace(GUARD_MODULE, "@/lib/auth/elsewhere") + ACT("removeOrg", `  await requirePlatformOwner();\n${DEL}`)).problems, [`${A}: ${GUARD} is not the one from ${GUARD_MODULE}`]);
  eq("a module with no actions is not held to the rule", scanReachable("lib/planted/plain.ts", `export async function readOrgs() { return []; }\n`), { problems: [], actions: 0 });
  eq("a layout is held to the same rule as a page", scan(HEAD + `export default async function L({ children }: { children: unknown }) {\n  const { data } = await svc().from("organizations").select("*");\n  return [children, data];\n}\n`, "app/(super-owner)/super/__planted__/layout.tsx"), [`app/(super-owner)/super/__planted__/layout.tsx default export: the first statement is not \`await ${GUARD}()\``]);
}

console.log("\nthe walk: a planted tree (outside the repository)");
{
  // Each planted segment file has a default export with no guard. Every one
  // that is a platform file must be read and fail; no other file is read.
  const SERVED: Array<[string, string]> = [
    ["a page at /super", "app/(super-owner)/super/page.tsx"],
    ["a nested page", "app/(super-owner)/super/a/b/page.tsx"],
    ["a page in the platform group outside /super", "app/(super-owner)/console/page.tsx"],
    ["a /super page outside the platform group (no platform layout at all)", "app/super/plain/page.tsx"],
    ["nested route groups", "app/(a)/(b)/super/nested/page.tsx"],
    ["a parallel slot", "app/@panel/super/slot/page.tsx"],
    ["a .js page", "app/super/script/page.js"],
    ["a .jsx page", "app/super/markup/page.jsx"],
    ["a .ts page", "app/super/typed/page.ts"],
    ["a nested layout", "app/(super-owner)/super/x/layout.tsx"],
    ["a template", "app/(super-owner)/super/x/template.tsx"],
    ["a slot's default", "app/@panel/super/default.tsx"],
    ["an intercepting route that shows a /super page", "app/[org]/(..)super/peek/page.tsx"],
  ];
  const ELSEWHERE: Array<[string, string]> = [
    ["app/super-mfa/challenge/page.tsx", "/super-mfa/challenge"],
    ["app/superb/page.tsx", "/superb"],
    ["app/[org]/super/page.tsx", "/[org]/super"],
    ["app/(learner)/supervisor/page.tsx", "/supervisor"],
  ];
  const NOT_SEGMENTS = ["app/(super-owner)/super/old/page.tsx.new", "app/super/plain/page.test.tsx", "app/super/plain/helpers.ts", "app/super/plain/loading.tsx"];
  const TS_SRC = `export default async function P() {\n  return null;\n}\n`;
  const JS_SRC = `export default async function P() {\n  return null;\n}\n`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "platform-page-walk-"));
  try {
    const plant = (file: string, src?: string) => {
      const p = path.join(base, ...file.split("/"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, src ?? (/\.jsx?$/.test(file) ? JS_SRC : TS_SRC));
    };
    for (const [, f] of SERVED) plant(f);
    for (const [f] of ELSEWHERE) plant(f);
    for (const f of NOT_SEGMENTS) plant(f);
    eq("the walk finds every planted segment file and no other file", segmentFiles(base), [...SERVED.map(([, f]) => f), ...ELSEWHERE.map(([f]) => f)].sort());
    const picked = platformSegmentFiles(base);
    for (const [label, f] of SERVED) {
      const got = picked.includes(f) ? scanSegment(f, fs.readFileSync(path.join(base, f), "utf8")) : "not read";
      eq(`${label} (${f}) is read, and its missing guard fails`, got, [`${f} default export: the first statement is not \`await ${GUARD}()\``, `${f}: ${GUARD} is not imported from ${GUARD_MODULE}`]);
    }
    eq("a path that is not a platform path is not read", ELSEWHERE.map(([f]) => [urlPathOf(f), picked.includes(f)]), ELSEWHERE.map(([, url]) => [url, false]));

    // The import walk: actions reached through `@/`, a relative path and import(), from a page and from a client component.
    const GOOD_PAGE = `import { requirePlatformOwner } from "@/lib/auth/require-platform-owner";\nimport { removeOrg } from "@/lib/planted/actions";\nimport { Editor } from "./editor";\nexport default async function P() {\n  await requirePlatformOwner();\n  return [removeOrg, Editor];\n}\n`;
    const EDITOR = `"use client";\nimport { renameOrg } from "../shared/rename";\nexport function Editor() {\n  void import("@/lib/planted/lazy");\n  return renameOrg;\n}\n`;
    const UNGUARDED = (name: string) => `"use server";\nexport async function ${name}(id: string) {\n  return id;\n}\n`;
    plant("app/(super-owner)/super/acts/page.tsx", GOOD_PAGE);
    plant("app/(super-owner)/super/acts/editor.tsx", EDITOR);
    plant("app/(super-owner)/super/shared/rename.ts", UNGUARDED("renameOrg"));
    plant("lib/planted/actions.ts", UNGUARDED("removeOrg"));
    plant("lib/planted/lazy.ts", UNGUARDED("lazyAction"));
    plant("lib/planted/unreached.ts", UNGUARDED("unreachedAction"));
    plant("lib/auth/require-platform-owner.ts", `export async function requirePlatformOwner() { return { user: null }; }\n`);
    const reached = reachable(base, ["app/(super-owner)/super/acts/page.tsx"]);
    eq("the import walk follows `@/`, relative paths and import(), through a client component", reached, ["app/(super-owner)/super/acts/editor.tsx", "app/(super-owner)/super/acts/page.tsx", "app/(super-owner)/super/shared/rename.ts", "lib/auth/require-platform-owner.ts", "lib/planted/actions.ts", "lib/planted/lazy.ts"]);
    const t = scanTree(base);
    const actionProblems = t.problems.filter((p) => p.includes(" action:") || p.includes("lib/planted/") || p.includes("/shared/rename.ts"));
    eq("each reachable unguarded action fails; an unreachable module is not read", actionProblems.sort(), [
      "app/(super-owner)/super/shared/rename.ts renameOrg action: the first statement is not `await requirePlatformOwner()`",
      "app/(super-owner)/super/shared/rename.ts: requirePlatformOwner is not imported from @/lib/auth/require-platform-owner",
      "lib/planted/actions.ts removeOrg action: the first statement is not `await requirePlatformOwner()`",
      "lib/planted/actions.ts: requirePlatformOwner is not imported from @/lib/auth/require-platform-owner",
      "lib/planted/lazy.ts lazyAction action: the first statement is not `await requirePlatformOwner()`",
      "lib/planted/lazy.ts: requirePlatformOwner is not imported from @/lib/auth/require-platform-owner",
    ]);
    eq("…and the guarded page itself passes", t.problems.filter((p) => p.startsWith("app/(super-owner)/super/acts/")), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/* ---------------- 4. every platform page and layout, called as Next calls it ---------------- */

type Row = Record<string, unknown>;
type Req = { method: string; path: string; query: URLSearchParams; body: string };
type User = { id: string; aud: string; role: string; email: string };

const SUPABASE = "http://stub.supabase.test";
const AUTH_COOKIE = "sb-stub-auth-token";
const OWNER: User = { id: "6c1e0a6e-0000-4000-8000-00000000e001", aud: "authenticated", role: "authenticated", email: "owner@example.test" };
const MEMBER: User = { id: "6c1e0a6e-0000-4000-8000-00000000e002", aud: "authenticated", role: "authenticated", email: "member@example.test" };
const ORG_ID = "6c1e0a6e-0000-4000-8000-00000000e0a1";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
/** An access token shaped like the auth server's, carrying the assurance level. The stub's /user answers by the whole token. */
const jwt = (u: User, aal: "aal1" | "aal2") => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: u.id, aud: "authenticated", role: "authenticated", aal, exp: 4102444800 })}.c2ln`;
const TOKENS = new Map<string, User>();
const tokenFor = (u: User, aal: "aal1" | "aal2") => { const t = jwt(u, aal); TOKENS.set(t, u); return t; };

// ---- the browser: one cookie jar ----
const browser = new Map<string, string>();
const jar = {
  get: (name: string) => (browser.has(name) ? { name, value: browser.get(name)! } : undefined),
  getAll: () => [...browser].map(([name, value]) => ({ name, value })),
  has: (name: string) => browser.has(name),
  set: (name: string, value: string, opts?: { maxAge?: number }) => { if (value === "" || opts?.maxAge === 0) browser.delete(name); else browser.set(name, value); },
  delete: (name: string) => { browser.delete(name); },
};
const signIn = (token: string | null, factors: Array<{ id: string; status: string; factor_type: string }> = []) => {
  browser.delete(AUTH_COOKIE);
  if (!token) return;
  const u = TOKENS.get(token)!;
  browser.set(AUTH_COOKIE, JSON.stringify({ access_token: token, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: { ...u, factors } }));
};
const VERIFIED_TOTP = [{ id: "f-1", status: "verified", factor_type: "totp" }];

// tsx compiles the pages' JSX to React.createElement.
(globalThis as { React?: unknown }).React = React;
// The pages' only cookie-bound import. Everything below it is the real code.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") return { cookies: async () => jar, headers: async () => new Headers({ host: "lms.test" }) };
  return load.call(this, request, ...rest);
};

// ---- the server side ----
const owners = new Map<string, Row>();
const mustChange = new Set<string>();
let requests: Req[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const eqParam = (q: URLSearchParams, k: string) => q.get(k)?.replace(/^eq\./, "") ?? null;
const bearer = (h: Headers) => (h.get("authorization") ?? "").replace(/^Bearer /, "");

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = typeof init?.body === "string" ? init.body : "";
  const p = url.pathname, q = url.searchParams;
  requests.push({ method, path: p, query: q, body });
  const object = (headers.get("accept") ?? "").includes("vnd.pgrst.object");

  if (p === "/auth/v1/user" && method === "GET") {
    const u = TOKENS.get(bearer(headers));
    return u ? json(u) : json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
  }
  if (p === "/rest/v1/platform_owners" && method === "GET" && q.has("user_id")) {
    const r = owners.get(eqParam(q, "user_id") ?? "");
    return json(object ? r ?? null : r ? [r] : []);
  }
  if (p === "/rest/v1/profiles" && method === "GET" && q.get("select") === "must_change_password") {
    const r = { must_change_password: mustChange.has(eqParam(q, "id") ?? "") };
    return json(object ? r : [r]);
  }
  if (method === "PATCH") return new Response(null, { status: 204 });
  if (p.startsWith("/rest/v1/rpc/")) return json(null);
  if (method === "GET" || method === "HEAD") return json(object ? null : []);
  return json([], 201);
};

/** The guard's own requests for the signed-in caller: everything else a visit sends is the file's own. */
function isGuardRequest(r: Req, callerId: string | null): boolean {
  if (r.path === "/auth/v1/user" && r.method === "GET") return true;
  if (!callerId) return false;
  if (r.path === "/rest/v1/profiles" && r.method === "GET") return r.query.get("select") === "must_change_password" && eqParam(r.query, "id") === callerId;
  if (r.path === "/rest/v1/platform_owners" && r.method === "GET") return r.query.get("select") === "user_id,mfa_required" && eqParam(r.query, "user_id") === callerId;
  if (r.path === "/rest/v1/platform_owners" && r.method === "PATCH") {
    let keys: string[] = [];
    try { keys = Object.keys(JSON.parse(r.body) as Row); } catch { keys = []; }
    return eqParam(r.query, "user_id") === callerId && JSON.stringify(keys) === JSON.stringify(["last_mfa_check_at"]);
  }
  return false;
}
const isWrite = (r: Req) => (r.path.startsWith("/rest/v1/") && r.method !== "GET" && r.method !== "HEAD" && !r.path.startsWith("/rest/v1/rpc/")) || r.path.startsWith("/auth/v1/admin") || r.path.startsWith("/functions/v1/");
const GUARD_REDIRECTS = ["/login", "/change-password", "/super-mfa/challenge", "/super-mfa/enroll"];

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn, realError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const files = platformSegmentFiles(root);
    type Visit = { outcome: string; own: string[]; guardWrites: number; otherWrites: string[] };
    const mods = new Map<string, (props: unknown) => unknown>();
    for (const f of files) mods.set(f, ((await import(`../../${f}`)) as { default: (props: unknown) => unknown }).default);
    const OWNER_AAL1 = tokenFor(OWNER, "aal1");
    const OWNER_AAL2 = tokenFor(OWNER, "aal2");
    const MEMBER_AAL2 = tokenFor(MEMBER, "aal2");
    const asOwner = (mfa: boolean | null) => owners.set(OWNER.id, { user_id: OWNER.id, mfa_required: mfa });

    /** One request for <file> as Next makes it: the file's default export with the route's props. */
    const visit = async (f: string, caller: User | null): Promise<Visit> => {
      requests = [];
      let outcome = "rendered";
      try {
        await mods.get(f)!({ children: null, params: Promise.resolve({ id: ORG_ID }), searchParams: Promise.resolve({}) });
      } catch (e) {
        const digest = (e as { digest?: unknown })?.digest;
        if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) outcome = `redirect ${digest.split(";").slice(2, -2).join(";")}`;
        else if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) outcome = `http ${digest.split(";")[1]}`;
        else outcome = `threw ${e instanceof Error ? e.message : String(e)}`;
      }
      const id = caller?.id ?? null;
      return {
        outcome,
        own: requests.filter((r) => !isGuardRequest(r, id)).map((r) => `${r.method} ${r.path}`),
        guardWrites: requests.filter((r) => isGuardRequest(r, id) && r.method === "PATCH").length,
        otherWrites: requests.filter((r) => isWrite(r) && !isGuardRequest(r, id)).map((r) => `${r.method} ${r.path}`),
      };
    };
    const refusedEverywhere = async (label: string, want: string, caller: User | null, arrange: () => void) => {
      const wrong: string[] = [];
      for (const f of files) {
        browser.clear(); owners.clear(); mustChange.clear();
        arrange();
        const v = await visit(f, caller);
        if (v.outcome !== `redirect ${want}` || v.own.length > 0 || v.guardWrites > 0 || v.otherWrites.length > 0) wrong.push(`${f}: ${JSON.stringify(v)}`);
      }
      eq(`${label}: every platform page and layout redirects to ${want} before sending a request of its own, and writes nothing (${files.length} files)`, wrong, []);
    };

    console.log("\nrefused callers, each page on its own (as when a navigation skips the layout)");
    await refusedEverywhere("signed out", "/login", null, () => { asOwner(true); signIn(null); });
    await refusedEverywhere("a signed-in user with no owner row, at AAL2", "/login", MEMBER, () => { asOwner(true); signIn(MEMBER_AAL2); });
    await refusedEverywhere("an owner who must change their password, at AAL2", "/change-password", OWNER, () => { asOwner(true); mustChange.add(OWNER.id); signIn(OWNER_AAL2, VERIFIED_TOTP); });
    await refusedEverywhere("an owner whose row requires the factor, at AAL1 with a factor enrolled", "/super-mfa/challenge", OWNER, () => { asOwner(true); signIn(OWNER_AAL1, VERIFIED_TOTP); });
    await refusedEverywhere("…at AAL1 with no factor enrolled", "/super-mfa/enroll", OWNER, () => { asOwner(true); signIn(OWNER_AAL1); });
    await refusedEverywhere("…a row that leaves mfa_required unset, at AAL1", "/super-mfa/enroll", OWNER, () => { asOwner(null); signIn(OWNER_AAL1); });

    console.log("\nan admitted owner");
    {
      const admitted = async (arrange: () => void) => {
        const out = new Map<string, Visit>();
        for (const f of files) { browser.clear(); owners.clear(); mustChange.clear(); arrange(); out.set(f, await visit(f, OWNER)); }
        return out;
      };
      const at2 = await admitted(() => { asOwner(true); signIn(OWNER_AAL2, VERIFIED_TOTP); });
      eq("at AAL2: no file is refused by the guard (and none throws)", [...at2].filter(([, v]) => GUARD_REDIRECTS.some((g) => v.outcome === `redirect ${g}`) || v.outcome.startsWith("threw")).map(([f, v]) => `${f}: ${v.outcome}`), []);
      eq("…each call records the check once (one last_mfa_check_at write per call; React's cache makes it one per server render)", [...at2].filter(([, v]) => v.guardWrites !== 1).map(([f, v]) => `${f}: ${v.guardWrites}`), []);
      eq("…and writes nothing else", [...at2].flatMap(([f, v]) => v.otherWrites.map((w) => `${f}: ${w}`)), []);
      const reading = [...at2].filter(([, v]) => v.own.length > 0).map(([f]) => f);
      eq(`non-vacuous: the admitted pages go on to read their data (${reading.length} of ${files.length} files)`, reading.length >= 6, true);
      eq("…the /super page sends the owner on to the organizations list", at2.get("app/(super-owner)/super/page.tsx")?.outcome, "redirect /super/organizations");
      const off = await admitted(() => { asOwner(false); signIn(OWNER_AAL1); });
      eq("an owner whose row sets mfa_required false, at AAL1: admitted, and nothing is written", [...off].filter(([, v]) => GUARD_REDIRECTS.some((g) => v.outcome === `redirect ${g}`) || v.outcome.startsWith("threw") || v.guardWrites !== 0 || v.otherWrites.length > 0).map(([f, v]) => `${f}: ${JSON.stringify(v)}`), []);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
