/**
 * The platform route rule: every handler under app/api/super/ requires what
 * the platform pages require, through one guard,
 * requirePlatformOwnerApi(level) in lib/auth/require-platform-owner.ts.
 *
 *   - "full": signed in, a platform_owners row, not in the
 *     must-change-password state, and a session at AAL2 whenever the row's
 *     mfa_required is not false (the pages' rule), whether or not a factor
 *     is enrolled;
 *   - "end": signed in and a platform_owners row. Only ending an
 *     impersonation uses it: the exit is never refused for the second factor;
 *   - the impersonation status read has no guard: it answers only the
 *     caller's own session and writes nothing.
 *
 * Three parts:
 *   1. The scan (TypeScript's parser, no type checker). It walks all of app/
 *      and reads every route file Next serves (route.ts, .tsx, .js and .jsx,
 *      Next's default extensions) whose URL path, with route groups `(x)` and
 *      parallel slots `@x` dropped as Next drops them, is /api/super or
 *      /super or lies under either: a platform handler, wherever its folder
 *      sits. The table below names every exported handler of every such file
 *      with its level, and names no handler that does not exist. A handler at
 *      "full" or "end" starts with `const guard = await requirePlatformOwnerApi(
 *      "<level>")`, imported from lib/auth/require-platform-owner, followed
 *      directly by `if ("error" in guard) return ...`. No platform route file
 *      keeps its own caller check (no `platform_owners` in its code, no
 *      assertPlatformOwner). Planted cases prove each rule fires, and a
 *      planted tree proves the walk finds a grouped path, a slot, a .js and
 *      a .jsx handler and a route beside the platform pages.
 *   2. The guard's answers, on the real code under a stubbed Auth and
 *      PostgREST and a stubbed next/headers cookie jar.
 *   3. Every handler at "full", called as the route: an owner at AAL1 whose
 *      row requires the second factor gets 403 and nothing is written; the
 *      exit still ends the impersonation for that owner.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/platform-route-guards.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");

/* ---------------- 1. the scan ---------------- */

type Level = "full" | "end" | "none";
/** Every exported handler served under /api/super/ or /super/, with its level. A new handler is "full" unless a later decision names it here. */
const TABLE: Record<string, Level> = {
  "app/api/super/broadcasts/route.ts GET": "full",
  "app/api/super/broadcasts/route.ts POST": "full",
  "app/api/super/broadcasts/route.ts PATCH": "full",
  "app/api/super/broadcasts/route.ts DELETE": "full",
  "app/api/super/plans/route.ts GET": "full",
  "app/api/super/plans/route.ts POST": "full",
  "app/api/super/plans/route.ts PATCH": "full",
  "app/api/super/plans/route.ts DELETE": "full",
  "app/api/super/tenants/route.ts POST": "full",
  "app/api/super/tenants/[id]/route.ts PATCH": "full",
  "app/api/super/tenants/[id]/route.ts DELETE": "full",
  "app/api/super/tenants/[id]/admins/route.ts GET": "full",
  "app/api/super/tenants/[id]/admins/route.ts POST": "full",
  "app/api/super/tenants/[id]/admins/route.ts PATCH": "full",
  "app/api/super/tenants/[id]/admins/route.ts DELETE": "full",
  "app/api/super/impersonate/route.ts POST": "full",
  "app/api/super/impersonate/route.ts DELETE": "end",
  "app/api/super/impersonate/route.ts GET": "none",
};
/** The only handler at "end": ending an impersonation. */
const EXIT = "app/api/super/impersonate/route.ts DELETE";
/** The only handler with no guard: the impersonation status read. */
const STATUS = "app/api/super/impersonate/route.ts GET";
const GUARD = "requirePlatformOwnerApi";
const GUARD_MODULE = "@/lib/auth/require-platform-owner";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const WRITES = new Set(["insert", "update", "upsert", "delete", "rpc"]);
const WRITE_HELPERS = new Set(["auditLog", "startImpersonation", "endImpersonation", "endImpersonationForSessionChange"]);

const skip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};
const kindOf = (file: string) =>
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
const codeOf = (sf: ts.SourceFile) => ts.createPrinter({ removeComments: true }).printFile(sf);

type Handler = { method: string; body: ts.Block | null };
/** The exported handlers: `export async function GET`, `export const GET = fn` or `= otherFn`. */
function handlersOf(sf: ts.SourceFile): Handler[] {
  const local = new Map<string, ts.FunctionLikeDeclaration>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) local.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) local.set(d.name.text, d.initializer);
    }
  }
  const bodyOf = (fn: ts.FunctionLikeDeclaration | undefined) => (fn?.body && ts.isBlock(fn.body) ? fn.body : null);
  const out: Handler[] = [];
  for (const st of sf.statements) {
    const exported = (ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name && METHODS.has(st.name.text)) out.push({ method: st.name.text, body: bodyOf(st) });
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !METHODS.has(d.name.text) || !d.initializer) continue;
      const init = skip(d.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.push({ method: d.name.text, body: bodyOf(init) });
      else if (ts.isIdentifier(init)) out.push({ method: d.name.text, body: bodyOf(local.get(init.text)) });
      else out.push({ method: d.name.text, body: null });
    }
  }
  return out;
}

/** `const <v> = await requirePlatformOwnerApi("<level>")`: the variable name, or null. */
function guardDecl(st: ts.Statement | undefined, level: string): string | null {
  if (!st || !ts.isVariableStatement(st) || st.declarationList.declarations.length !== 1) return null;
  if (!(st.declarationList.flags & ts.NodeFlags.Const)) return null;
  const d = st.declarationList.declarations[0];
  if (!ts.isIdentifier(d.name) || !d.initializer) return null;
  const aw = skip(d.initializer);
  if (!ts.isAwaitExpression(aw)) return null;
  const call = skip(aw.expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== GUARD) return null;
  if (call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== level) return null;
  return d.name.text;
}
/** `if ("error" in <v>) return ...;` with no else. */
function isExit(st: ts.Statement | undefined, v: string): boolean {
  if (!st || !ts.isIfStatement(st) || st.elseStatement) return false;
  const c = skip(st.expression);
  if (!ts.isBinaryExpression(c) || c.operatorToken.kind !== ts.SyntaxKind.InKeyword) return false;
  const l = skip(c.left), r = skip(c.right);
  if (!ts.isStringLiteral(l) || l.text !== "error" || !ts.isIdentifier(r) || r.text !== v) return false;
  const t = st.thenStatement;
  return ts.isReturnStatement(t) || (ts.isBlock(t) && t.statements.length > 0 && ts.isReturnStatement(t.statements[0]));
}
function walk(n: ts.Node, f: (n: ts.Node) => void) { f(n); ts.forEachChild(n, (c) => walk(c, f)); }

/** Every problem the rule finds in one route file, as "<file> <METHOD>: <what>" or "<file>: <what>". */
function scanFile(file: string, src: string, table: Record<string, Level>): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  // The guard must be the shared one: imported from its module, never declared here.
  let imported = false, declared = false;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) {
        if (el.name.text === GUARD) {
          if (st.moduleSpecifier.text === GUARD_MODULE && (el.propertyName ?? el.name).text === GUARD) imported = true;
          else declared = true;
        }
      }
    }
  }
  walk(sf, (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === GUARD) declared = true;
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === "assertPlatformOwner") out.push(`${file}: declares its own caller check (assertPlatformOwner)`);
  });
  if (declared) out.push(`${file}: ${GUARD} is not the one from ${GUARD_MODULE}`);
  // Only the two export shapes the scan reads may carry a handler: an
  // export list, a re-export or a default export could hide one from it.
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) out.push(`${file}: exports through an export list or re-export (write handlers as \`export async function METHOD\` or \`export const METHOD =\`)`);
    if (ts.isExportAssignment(st)) out.push(`${file}: has a default export (write handlers as \`export async function METHOD\` or \`export const METHOD =\`)`);
  }
  if (/platform_owners/.test(codeOf(sf))) out.push(`${file}: names platform_owners in its code (the caller's check is the guard)`);

  for (const h of handlersOf(sf)) {
    const key = `${file} ${h.method}`;
    const level = table[key];
    if (!level) { out.push(`${key}: not in the level table`); continue; }
    if (!h.body) { out.push(`${key}: handler body not found`); continue; }
    if (level === "none") {
      walk(h.body, (n) => {
        if (ts.isCallExpression(n)) {
          const c = skip(n.expression);
          if (ts.isIdentifier(c) && c.text === GUARD) out.push(`${key}: the status read calls the guard`);
          if (ts.isIdentifier(c) && WRITE_HELPERS.has(c.text)) out.push(`${key}: the status read writes (${c.text})`);
          if (ts.isPropertyAccessExpression(c) && WRITES.has(c.name.text)) out.push(`${key}: the status read writes (.${c.name.text})`);
          if (/\.auth\.admin\./.test(c.getText())) out.push(`${key}: the status read calls the auth admin API`);
        }
        if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "status" && ts.isNumericLiteral(n.initializer) && Number(n.initializer.text) >= 400) {
          out.push(`${key}: the status read refuses (status ${n.initializer.text})`);
        }
      });
      continue;
    }
    if (!imported) out.push(`${key}: ${GUARD} is not imported from ${GUARD_MODULE}`);
    const v = guardDecl(h.body.statements[0], level);
    if (!v) out.push(`${key}: the first statement is not \`const guard = await ${GUARD}("${level}")\``);
    else if (!isExit(h.body.statements[1], v)) out.push(`${key}: the second statement is not \`if ("error" in ${v}) return ...\``);
    // The table holds "end" for the exit alone (checked on the real table);
    // a handler the table puts at "full" never asks for "end".
    if (level !== "end") walk(h.body, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(skip(n.expression)) && (skip(n.expression) as ts.Identifier).text === GUARD && n.arguments.some((a) => ts.isStringLiteral(a) && a.text === "end")) {
        out.push(`${key}: level "end" is for ending an impersonation only`);
      }
    });
  }
  return out;
}

/** A route handler file under Next's default page extensions (next.config sets none of its own; checked below). */
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;
/** Every route handler file under <base>/app, as "app/..." with forward slashes. */
function routeFiles(base: string, dir = path.join(base, "app"), out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) routeFiles(base, p, out);
    else if (ROUTE_FILE.test(e.name)) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}
/** The URL path a route file is served at: route groups `(x)` and parallel slots `@x` are dropped, as Next drops them. */
function urlPathOf(file: string): string {
  const segments = file.split("/").slice(1, -1);
  return "/" + segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@")).join("/");
}
/** The platform paths: /api/super and /super, and everything under either. */
const PLATFORM_PATHS = ["/api/super", "/super"];
const isPlatformPath = (u: string) => PLATFORM_PATHS.some((p) => u === p || u.startsWith(`${p}/`));
/** Every route file under <base>/app that Next serves at a platform path. */
const platformRouteFiles = (base: string) => routeFiles(base).filter((f) => isPlatformPath(urlPathOf(f)));

console.log("\nthe scan: every handler served under /api/super/ or /super/ passes the guard at its level");
{
  const all = routeFiles(root);
  const files = platformRouteFiles(root);
  eq(`non-vacuous: the walk covers all of app/ (${all.length} route files, ${files.length} at a platform path)`, all.length > files.length && all.some((f) => /\/\(.+\)\//.test(f)), true);
  eq("next.config sets no pageExtensions of its own (the walk reads Next's default route extensions)", /pageExtensions/.test(fs.readFileSync(path.join(root, "next.config.ts"), "utf8")), false);
  const found: string[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const h of handlersOf(parse(f, src))) found.push(`${f} ${h.method}`);
    problems.push(...scanFile(f, src, TABLE));
  }
  eq(`non-vacuous: route files found (${files.length})`, files.length >= 6, true);
  eq("every exported handler is in the level table", found.filter((k) => !(k in TABLE)), []);
  eq("the table names no handler that does not exist", Object.keys(TABLE).filter((k) => !found.includes(k)), []);
  eq("no rule is broken in any route file", problems, []);
  eq('only ending an impersonation is at level "end"', Object.entries(TABLE).filter(([, l]) => l === "end").map(([k]) => k), [EXIT]);
  eq("only the impersonation status read has no guard", Object.entries(TABLE).filter(([, l]) => l === "none").map(([k]) => k), [STATUS]);
  const fullCount = Object.values(TABLE).filter((l) => l === "full").length;
  eq(`non-vacuous: ${fullCount} handlers at "full"`, fullCount >= 15, true);
}

console.log("\nthe scan: planted cases");
{
  const F = "app/api/super/__planted__/route.ts";
  const T: Record<string, Level> = { [`${F} POST`]: "full", [`${F} DELETE`]: "end", [`${F} GET`]: "none" };
  const HEAD = `import { NextResponse } from "next/server";\nimport { createClient as createServiceClient } from "@supabase/supabase-js";\nimport { requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";\n`;
  const EXIT_LINE = `if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });`;
  const POST = (body: string) => `export async function POST(request: Request) {\n${body}\n  return NextResponse.json({ ok: true });\n}\n`;
  const scan = (src: string, table = T) => scanFile(F, src, table);
  const good = POST(`  const guard = await requirePlatformOwnerApi("full");\n  ${EXIT_LINE}\n  await svc().from("x").insert({});`);
  eq("the right shape passes", scan(HEAD + good), []);
  eq("…and as `export const POST = async (…) => {…}`", scan(HEAD + `export const POST = async () => {\n  const guard = await requirePlatformOwnerApi("full");\n  ${EXIT_LINE}\n  return NextResponse.json({});\n};\n`), []);
  eq("…and with the exit's return inside braces", scan(HEAD + POST(`  const guard = await requirePlatformOwnerApi("full");\n  if ("error" in guard) { return NextResponse.json({ error: guard.error }, { status: guard.status }); }`)), []);
  eq("a handler with no guard fails", scan(HEAD + POST(`  await svc().from("x").insert({});`)), [`${F} POST: the first statement is not \`const guard = await ${GUARD}("full")\``]);
  eq("a guard that is not the first statement fails", scan(HEAD + POST(`  const body = await request.json();\n  const guard = await requirePlatformOwnerApi("full");\n  ${EXIT_LINE}`)), [`${F} POST: the first statement is not \`const guard = await ${GUARD}("full")\``]);
  eq("a guard that is not awaited fails", scan(HEAD + POST(`  const guard = requirePlatformOwnerApi("full");\n  ${EXIT_LINE}`)), [`${F} POST: the first statement is not \`const guard = await ${GUARD}("full")\``]);
  eq('a "full" handler at level "end" fails', scan(HEAD + POST(`  const guard = await requirePlatformOwnerApi("end");\n  ${EXIT_LINE}`)), [`${F} POST: the first statement is not \`const guard = await ${GUARD}("full")\``, `${F} POST: level "end" is for ending an impersonation only`]);
  eq("a guard whose answer is not acted on fails", scan(HEAD + POST(`  const guard = await requirePlatformOwnerApi("full");\n  await svc().from("x").insert({});`)), [`${F} POST: the second statement is not \`if ("error" in guard) return ...\``]);
  eq("an inverted exit fails", scan(HEAD + POST(`  const guard = await requirePlatformOwnerApi("full");\n  if (!("error" in guard)) return NextResponse.json({});`)), [`${F} POST: the second statement is not \`if ("error" in guard) return ...\``]);
  eq("an exit on another value fails", scan(HEAD + POST(`  const guard = await requirePlatformOwnerApi("full");\n  const other = {};\n  if ("error" in other) return NextResponse.json({});`)), [`${F} POST: the second statement is not \`if ("error" in guard) return ...\``]);
  eq("an exit that falls through to an else fails", scan(HEAD + POST(`  const guard = await requirePlatformOwnerApi("full");\n  if ("error" in guard) return NextResponse.json({}); else console.log("x");`)), [`${F} POST: the second statement is not \`if ("error" in guard) return ...\``]);
  eq("a guard of the same name declared in the file fails", scan(HEAD.replace(`import { requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";\n`, "") + `async function requirePlatformOwnerApi(_l: string) { return { userId: "x" }; }\n` + good), [`${F}: ${GUARD} is not the one from ${GUARD_MODULE}`, `${F} POST: ${GUARD} is not imported from ${GUARD_MODULE}`]);
  eq("a guard of the same name imported from elsewhere fails", scan(HEAD.replace(GUARD_MODULE, "@/lib/auth/elsewhere") + good), [`${F}: ${GUARD} is not the one from ${GUARD_MODULE}`, `${F} POST: ${GUARD} is not imported from ${GUARD_MODULE}`]);
  const LIST_MSG = `${F}: exports through an export list or re-export (write handlers as \`export async function METHOD\` or \`export const METHOD =\`)`;
  eq("a handler exported through an export list fails", scan(HEAD + `async function handle() { return NextResponse.json({}); }
export { handle as POST };
`), [LIST_MSG]);
  eq("a handler re-exported from another module fails", scan(HEAD + `export { POST } from "../elsewhere/route";
`), [LIST_MSG]);
  eq("a default export fails", scan(HEAD + good + `export default POST;
`), [`${F}: has a default export (write handlers as \`export async function METHOD\` or \`export const METHOD =\`)`]);
  eq("a handler missing from the table fails", scan(HEAD + good + `export async function PATCH() {\n  const guard = await requirePlatformOwnerApi("full");\n  ${EXIT_LINE}\n  return NextResponse.json({});\n}\n`), [`${F} PATCH: not in the level table`]);
  eq("the exit at level end passes", scan(HEAD + `export async function DELETE() {\n  const guard = await requirePlatformOwnerApi("end");\n  ${EXIT_LINE}\n  return NextResponse.json({ ok: true });\n}\n`), []);
  eq("…the exit with no guard fails", scan(HEAD + `export async function DELETE() {\n  return NextResponse.json({ ok: true });\n}\n`), [`${F} DELETE: the first statement is not \`const guard = await ${GUARD}("end")\``]);
  eq("a file's own platform_owners read fails", scan(HEAD + good + `async function own() { return svc().from("platform_owners").select("user_id"); }\n`), [`${F}: names platform_owners in its code (the caller's check is the guard)`]);
  eq("…platform_owners named only in a comment passes", scan(HEAD + `// the caller's platform_owners row is read by the guard\n` + good), []);
  eq("a file's own assertPlatformOwner fails", scan(HEAD + good + `async function assertPlatformOwner() { return null; }\n`), [`${F}: declares its own caller check (assertPlatformOwner)`]);
  const GET = (body: string) => `export async function GET() {\n${body}\n}\n`;
  eq("the status read that only answers passes", scan(HEAD + good + GET(`  const session = null;\n  return NextResponse.json({ session });`)), []);
  eq("…the status read that writes fails", scan(HEAD + good + GET(`  await svc().from("platform_impersonation_sessions").update({ ended_at: "now" }).eq("id", "1");\n  return NextResponse.json({ session: null });`)), [`${F} GET: the status read writes (.update)`]);
  eq("…the status read that refuses fails", scan(HEAD + good + GET(`  return NextResponse.json({ error: "Forbidden" }, { status: 403 });`)), [`${F} GET: the status read refuses (status 403)`]);
  eq("…the status read that calls the guard fails", scan(HEAD + good + GET(`  const guard = await requirePlatformOwnerApi("end");\n  return NextResponse.json({ session: null, guard });`)), [`${F} GET: the status read calls the guard`]);
}

console.log("\nthe walk: a planted tree (outside the repository)");
{
  // Each planted route file has one handler with no guard. Every one Next
  // serves at a platform path must be read and fail; no other file is read.
  const SERVED: Array<[string, string, string]> = [
    ["a plain path", "app/api/super/plain/route.ts", "/api/super/plain"],
    ["a route group", "app/(super-owner)/api/super/grouped/route.ts", "/api/super/grouped"],
    ["nested route groups", "app/(a)/(b)/api/super/nested/route.tsx", "/api/super/nested"],
    ["a parallel slot", "app/@panel/api/super/slot/route.ts", "/api/super/slot"],
    ["a .js handler", "app/api/super/script/route.js", "/api/super/script"],
    ["a .jsx handler", "app/api/super/markup/route.jsx", "/api/super/markup"],
    ["a route beside the platform pages", "app/(super-owner)/super/export/route.ts", "/super/export"],
    ["a route at /super itself", "app/(super-owner)/super/route.ts", "/super"],
  ];
  const ELSEWHERE: Array<[string, string]> = [
    ["app/api/superb/route.ts", "/api/superb"],
    ["app/api/org/super/route.ts", "/api/org/super"],
    ["app/[org]/(admin)/api/super-tools/route.ts", "/[org]/api/super-tools"],
    ["app/(super-owner)/superstar/route.ts", "/superstar"],
  ];
  const NOT_ROUTES = ["app/api/super/plain/page.tsx", "app/api/super/plain/helpers.ts", "app/api/super/plain/route.test.ts"];
  const TS_SRC = `import { NextResponse } from "next/server";\nexport async function POST(request: Request) {\n  return NextResponse.json({ ok: true, url: request.url });\n}\n`;
  const JS_SRC = `import { NextResponse } from "next/server";\nexport async function POST(request) {\n  return NextResponse.json({ ok: true, url: request.url });\n}\n`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "platform-route-walk-"));
  try {
    const plant = (file: string) => {
      const p = path.join(base, ...file.split("/"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, /\.jsx?$/.test(file) ? JS_SRC : TS_SRC);
    };
    for (const [, f] of SERVED) plant(f);
    for (const [f] of ELSEWHERE) plant(f);
    for (const f of NOT_ROUTES) plant(f);
    const walked = routeFiles(base);
    const picked = platformRouteFiles(base);
    eq("the walk finds every planted route file and no other file", walked, [...SERVED.map(([, f]) => f), ...ELSEWHERE.map(([f]) => f)].sort());
    for (const [label, f, url] of SERVED) {
      const got = { url: urlPathOf(f), problems: picked.includes(f) ? scanFile(f, fs.readFileSync(path.join(base, f), "utf8"), {}) : "not read" };
      eq(`${label} (${f} at ${url}) is read, and its unguarded handler fails`, got, { url, problems: [`${f} POST: not in the level table`] });
    }
    eq("…named in the table at full, each one fails for the missing guard", SERVED.flatMap(([, f]) => scanFile(f, fs.readFileSync(path.join(base, f), "utf8"), { [`${f} POST`]: "full" })), SERVED.flatMap(([, f]) => [`${f} POST: ${GUARD} is not imported from ${GUARD_MODULE}`, `${f} POST: the first statement is not \`const guard = await ${GUARD}("full")\``]));
    eq("a path that is not a platform path is not read", ELSEWHERE.map(([f]) => [urlPathOf(f), picked.includes(f)]), ELSEWHERE.map(([, url]) => [url, false]));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/* ---------------- 2 and 3: behaviour under a stub ---------------- */

type Row = Record<string, unknown>;
type Req = { method: string; path: string; query: URLSearchParams; body: string };
type User = { id: string; aud: string; role: string; email: string };

const SUPABASE = "http://stub.supabase.test";
const AUTH_COOKIE = "sb-stub-auth-token";
const IMP_COOKIE = "lms_impersonation";
const OWNER: User = { id: "6c1e0a6e-0000-4000-8000-00000000d001", aud: "authenticated", role: "authenticated", email: "owner@example.test" };
const MEMBER: User = { id: "6c1e0a6e-0000-4000-8000-00000000d002", aud: "authenticated", role: "authenticated", email: "member@example.test" };
const ORG_ID = "org-1";

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
/** Sign in with a token; `factors` are the verified factors the session's user carries. */
const signIn = (token: string | null, factors: Array<{ id: string; status: string; factor_type: string }> = []) => {
  browser.delete(AUTH_COOKIE);
  if (!token) return;
  const u = TOKENS.get(token)!;
  browser.set(AUTH_COOKIE, JSON.stringify({ access_token: token, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: { ...u, factors } }));
};
const VERIFIED_TOTP = [{ id: "f-1", status: "verified", factor_type: "totp" }];

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") return { cookies: async () => jar, headers: async () => new Headers({ host: "lms.test" }) };
  return load.call(this, request, ...rest);
};

// ---- the server side ----
const owners = new Map<string, Row>();
const mustChange = new Set<string>();
let ownerReadFails = false;
const sessions = new Map<string, Row>();
let requests: Req[] = [];
let nextId = 1;
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
  if (p === "/rest/v1/platform_owners" && method === "GET") {
    if (ownerReadFails) return json({ message: "stub failure", code: "XX000" }, 500);
    const r = owners.get(eqParam(q, "user_id") ?? "");
    return json(object ? r ?? null : r ? [r] : []);
  }
  if (p === "/rest/v1/profiles" && method === "GET") {
    const id = eqParam(q, "id") ?? "";
    const r = { must_change_password: mustChange.has(id) };
    return json(object ? r : [r]);
  }
  if (p === "/rest/v1/platform_impersonation_sessions") {
    if (method === "POST") {
      const ins = JSON.parse(body) as Row;
      const id = `0f8fad5b-d9cb-469f-a165-7086772895${String(nextId++).padStart(2, "0")}`;
      const row = { id, ...ins, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), ended_at: null, revoked_at: null };
      sessions.set(id, row);
      return json(object ? row : [row], 201);
    }
    if (method === "GET") {
      const found = [...sessions.values()].filter((r) => r.id === eqParam(q, "id") && r.actor_user_id === eqParam(q, "actor_user_id"));
      return json(object ? found[0] ?? null : found);
    }
    if (method === "PATCH") {
      const r = sessions.get(eqParam(q, "id") ?? "");
      if (r) Object.assign(r, JSON.parse(body) as Row);
      return new Response(null, { status: 204 });
    }
  }
  if (method === "GET" || method === "HEAD") return json(object ? null : []);
  return json([], 201);
};

/** Requests that change something: any non-read on PostgREST, the auth admin API, functions. */
const writes = () => requests.filter((r) =>
  (r.path.startsWith("/rest/v1/") && r.method !== "GET" && r.method !== "HEAD") ||
  r.path.startsWith("/auth/v1/admin") || r.path.startsWith("/functions/v1/"));
const fresh = () => {
  browser.clear(); owners.clear(); mustChange.clear(); sessions.clear();
  ownerReadFails = false; requests = [];
};

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.IMPERSONATION_SECRET = "stub-impersonation-secret";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const { requirePlatformOwnerApi } = await import("../../lib/auth/require-platform-owner");
    const OWNER_AAL1 = tokenFor(OWNER, "aal1");
    const OWNER_AAL2 = tokenFor(OWNER, "aal2");
    const MEMBER_AAL1 = tokenFor(MEMBER, "aal1");
    const MEMBER_AAL2 = tokenFor(MEMBER, "aal2");
    const asOwner = (mfa: boolean | null) => owners.set(OWNER.id, { user_id: OWNER.id, mfa_required: mfa });

    console.log("\nthe guard at level full");
    {
      const at = async (token: string | null, arrange: () => void, factors: typeof VERIFIED_TOTP = []) => {
        fresh(); arrange(); signIn(token, factors);
        const g = await requirePlatformOwnerApi("full");
        return { g, wrote: writes().length };
      };
      eq("signed out: 401", (await at(null, () => asOwner(true))).g, { error: "Unauthorized", status: 401 });
      eq("signed in with no owner row: 403 Forbidden", (await at(MEMBER_AAL1, () => asOwner(true))).g, { error: "Forbidden", status: 403 });
      eq("…at AAL2 too", (await at(MEMBER_AAL2, () => asOwner(true))).g, { error: "Forbidden", status: 403 });
      eq("the owner read fails: 503, not admitted", (await at(OWNER_AAL2, () => { asOwner(true); ownerReadFails = true; })).g, { error: "try again", status: 503 });
      eq("an owner whose row requires the factor, at AAL1 with a factor enrolled: 403 mfa_required", (await at(OWNER_AAL1, () => asOwner(true), VERIFIED_TOTP)).g, { error: "mfa_required", status: 403 });
      eq("…at AAL1 with no factor enrolled: 403 mfa_required", (await at(OWNER_AAL1, () => asOwner(true))).g, { error: "mfa_required", status: 403 });
      eq("…a row that leaves mfa_required unset requires it too", (await at(OWNER_AAL1, () => asOwner(null))).g, { error: "mfa_required", status: 403 });
      eq("…at AAL2: admitted", (await at(OWNER_AAL2, () => asOwner(true), VERIFIED_TOTP)).g, { userId: OWNER.id });
      eq("an owner whose row sets mfa_required false, at AAL1: admitted", (await at(OWNER_AAL1, () => asOwner(false))).g, { userId: OWNER.id });
      eq("an owner who must change their password: 403 password_change_required, even at AAL2", (await at(OWNER_AAL2, () => { asOwner(true); mustChange.add(OWNER.id); })).g, { error: "password_change_required", status: 403 });
      const garbled = "not-a-jwt";
      TOKENS.set(garbled, OWNER);
      eq("an access token whose level cannot be read: refused, not thrown", (await at(garbled, () => asOwner(true))).g, { error: "mfa_required", status: 403 });
      eq("the guard writes nothing (admitted or refused)", (await at(OWNER_AAL2, () => asOwner(true))).wrote + (await at(OWNER_AAL1, () => asOwner(true))).wrote, 0);
    }

    console.log("\nthe guard at level end (ending an impersonation)");
    {
      const at = async (token: string | null, arrange: () => void) => { fresh(); arrange(); signIn(token); return requirePlatformOwnerApi("end"); };
      eq("an owner at AAL1 whose row requires the factor: admitted", await at(OWNER_AAL1, () => asOwner(true)), { userId: OWNER.id });
      eq("…who must change their password: admitted", await at(OWNER_AAL1, () => { asOwner(true); mustChange.add(OWNER.id); }), { userId: OWNER.id });
      eq("signed in with no owner row: 403 Forbidden", await at(MEMBER_AAL2, () => asOwner(true)), { error: "Forbidden", status: 403 });
      eq("signed out: 401", await at(null, () => asOwner(true)), { error: "Unauthorized", status: 401 });
      eq("the owner read fails: 503", await at(OWNER_AAL1, () => { asOwner(true); ownerReadFails = true; }), { error: "try again", status: 503 });
    }

    console.log("\nevery handler at full, called as the route: an owner at AAL1 whose row requires the factor");
    {
      type H = (...a: unknown[]) => Promise<Response>;
      const call = async (key: string) => {
        const [file, method] = key.split(" ");
        const mod = (await import(`../../${file}`)) as Record<string, H>;
        const urlPath = "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace("[id]", ORG_ID);
        const req = new Request(`http://lms.test${urlPath}?id=x`, method === "GET" || method === "DELETE" ? { method } : { method, body: JSON.stringify({ id: "x", org_id: ORG_ID, name: "N", slug: "n-slug", email: "a@example.test", role: "admin", action: "suspend", title: "T", body_md: "B" }) });
        return mod[method](req, { params: Promise.resolve({ id: ORG_ID }) });
      };
      const refused: string[] = [];
      const wrote: string[] = [];
      const full = Object.entries(TABLE).filter(([, l]) => l === "full").map(([k]) => k);
      for (const key of full) {
        fresh(); asOwner(true); signIn(OWNER_AAL1, VERIFIED_TOTP);
        const res = await call(key);
        const body = (await res.json()) as Row;
        if (!(res.status === 403 && body.error === "mfa_required")) refused.push(`${key}: ${res.status} ${JSON.stringify(body)}`);
        if (writes().length > 0) wrote.push(`${key}: ${writes().map((w) => `${w.method} ${w.path}`).join(", ")}`);
      }
      eq(`all ${full.length} handlers answer 403 mfa_required`, refused, []);
      eq("…and none of them wrote anything, called the auth admin API or sent anything", wrote, []);

      fresh(); asOwner(true); signIn(OWNER_AAL2, VERIFIED_TOTP);
      const admitted = await call("app/api/super/plans/route.ts GET");
      eq("the same owner at AAL2 is admitted (GET /api/super/plans: 200)", admitted.status, 200);
      fresh(); asOwner(true); signIn(MEMBER_AAL2);
      const member = await call("app/api/super/plans/route.ts GET");
      eq("a signed-in user with no owner row at AAL2: 403 Forbidden", [member.status, ((await member.json()) as Row).error], [403, "Forbidden"]);
    }

    console.log("\nending an impersonation is never refused for the second factor");
    {
      const imp = await import("../../lib/auth/impersonation");
      const route = (await import("../../app/api/super/impersonate/route")) as unknown as Record<string, (...a: unknown[]) => Promise<Response>>;
      fresh(); asOwner(true); signIn(OWNER_AAL1, VERIFIED_TOTP);
      const id = await imp.startImpersonation({ actorUserId: OWNER.id, targetOrgId: ORG_ID, reason: "unit test" });
      requests = [];
      const status = await route.GET();
      eq("the status read answers the owner's session at AAL1", [status.status, ((await status.json()) as { session: Row | null }).session?.id], [200, id]);
      const start = await route.POST(new Request("http://lms.test/api/super/impersonate", { method: "POST", body: JSON.stringify({ org_id: ORG_ID }) }));
      eq("starting another at AAL1: 403 mfa_required, no session row written", [start.status, ((await start.json()) as Row).error, sessions.size], [403, "mfa_required", 1]);
      requests = [];
      const end = await route.DELETE();
      eq("the exit at AAL1: 200", [end.status, ((await end.json()) as Row).ok], [200, true]);
      eq("…the session row is stamped ended and the cookie deleted", [typeof sessions.get(id)?.ended_at, browser.has(IMP_COOKIE)], ["string", false]);

      fresh(); asOwner(true); signIn(MEMBER_AAL2);
      const other = await route.DELETE();
      eq("the exit by a signed-in user with no owner row: 403 Forbidden", [other.status, ((await other.json()) as Row).error], [403, "Forbidden"]);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
