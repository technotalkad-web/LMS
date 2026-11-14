/**
 * Guard: every bot request to a route that runs the Package Guardian carries
 * the shared request timeout.
 *
 * Why: a request made through a browser context's `request` inherits the
 * context's default timeout, which the Playwright config sets to its
 * `actionTimeout` (20 s in playwright.lifecycle.config.ts). The Guardian's
 * own static check may run for GUARDIAN_DEADLINE_MS (20 s) after the upload's
 * storage writes, so on a slow runner the test gave up first: the request
 * threw "Timeout 20000ms exceeded", the serial spec skipped the rest, the
 * nightly stopped the app and the run row stayed `pending` (spec 66 on
 * 13 and 14 Nov 2026; reproduced locally with a delay on every staging call).
 *
 * Checks, reading sources only (no browser, no database):
 *   (i)   the routes that run the Guardian are the five listed below: the files
 *         under app/ and lib/ that name runPackageGuardian are exactly the
 *         four route files and lib/courses/direct-upload.ts, each calls it
 *         (through its import's local name), guardian.ts does not call it
 *         (no wrapper), no file imports the guardian module whole, and only
 *         the finalize route names finalizeDirectUpload; a new caller fails
 *         here until its route is added to GUARDIAN_ROUTES;
 *   (ii)  GUARDIAN_ROUTE_TIMEOUT_MS (tests/bot/lifecycle/helpers.ts) is at
 *         least GUARDIAN_DEADLINE_MS + 60 s;
 *   (iii) every `.post(` call, and every `.fetch(` call whose method is not a
 *         literal GET or HEAD, under tests/bot and tests/e2e whose URL is one
 *         of those routes (a literal, a template or a `+` chain of strings,
 *         with an optional query suffix) passes an options object literal
 *         with `timeout: GUARDIAN_ROUTE_TIMEOUT_MS` or a longer number literal
 *         (the KIVO Release A uploads keep their 180 s); and no route-shaped
 *         text appears anywhere else in those folders (a URL held in a
 *         variable or built in a helper would escape the check), except as
 *         the URL of a GET, PUT, PATCH, DELETE or HEAD call;
 *   (iv)  the scan finds the calls it should (a floor on the count) and flags
 *         planted calls without the timeout and planted route text outside a
 *         call.
 *
 * Run:  npx tsx tests/unit/lifecycle-guardian-timeouts.test.ts   (or npm run test:unit)
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
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
}
const parse = (name: string, src: string) =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(name) ? ts.ScriptKind.TSX : /\.[mc]?js$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

/** The route shapes, with each `${...}` (or `:param`) written as `{}`. */
const GUARDIAN_ROUTES = [
  "/api/courses/upload", //                                       multipart new course
  "/api/courses/upload/finalize", //                              browser-direct finalize (lib/courses/direct-upload.ts)
  "/api/courses/{}/packages", //                                  multipart new language package
  "/api/courses/{}/packages/{}/versions", //                      multipart new version
  "/api/courses/{}/packages/{}/versions/{}/certify", //           the super_owner's re-run
];
const CALLERS = [
  "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/certify/route.ts",
  "app/api/courses/[courseId]/packages/[packageId]/versions/route.ts",
  "app/api/courses/[courseId]/packages/route.ts",
  "app/api/courses/upload/route.ts",
  "lib/courses/direct-upload.ts",
];

console.log("\n(i) the routes that run the Guardian");
{
  const files: string[] = [];
  for (const d of ["app", "lib"]) walk(path.join(root, d), files);
  /** The local names a file binds to `name` through its named imports (an alias included). */
  const localNames = (sf: ts.SourceFile, name: string): string[] => {
    const out: string[] = [];
    for (const st of sf.statements) {
      const nb = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) if ((el.propertyName ?? el.name).text === name) out.push(el.name.text);
      }
    }
    return out;
  };
  const callsTo = (sf: ts.SourceFile, names: string[]): number => {
    let n = 0;
    const visit = (x: ts.Node) => {
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && names.includes(x.expression.text)) n++;
      ts.forEachChild(x, visit);
    };
    visit(sf);
    return n;
  };
  const naming: string[] = [];
  const callingByImport: string[] = [];
  const wholeImports: string[] = [];
  const finalizeNamers: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const r = rel(f);
    const sf = parse(f, src);
    // a namespace import, a default import or a dynamic import() of the guardian module
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /(^|\/)alds\/guardian$|^\.\/guardian$/.test(st.moduleSpecifier.text)) {
        const c = st.importClause;
        if (c && (c.name || (c.namedBindings && ts.isNamespaceImport(c.namedBindings)))) wholeImports.push(r);
      }
    }
    if (/import\(\s*["'`][^"'`]*alds\/guardian["'`]\s*\)/.test(src)) wholeImports.push(r);
    if (r !== "lib/courses/direct-upload.ts" && src.includes("finalizeDirectUpload")) {
      // an identifier in code (an import or a call), not a comment
      let named = false;
      const visit = (x: ts.Node) => {
        if (ts.isIdentifier(x) && x.text === "finalizeDirectUpload") named = true;
        ts.forEachChild(x, visit);
      };
      visit(sf);
      if (named) finalizeNamers.push(r);
    }
    if (!src.includes("runPackageGuardian")) continue;
    if (r === "lib/alds/guardian.ts") {
      eq("guardian.ts does not call runPackageGuardian itself (no wrapper)", callsTo(sf, ["runPackageGuardian"]), 0);
      continue;
    }
    naming.push(r);
    if (callsTo(sf, localNames(sf, "runPackageGuardian")) > 0) callingByImport.push(r);
  }
  eq("the files that name runPackageGuardian (a new caller: add its route to GUARDIAN_ROUTES)", naming.sort(), CALLERS);
  eq("each of them calls it through its import (an alias included)", callingByImport.sort(), CALLERS);
  eq("no file imports the guardian module whole (namespace, default or dynamic)", wholeImports, []);
  eq("only the finalize route names finalizeDirectUpload (lib/courses/direct-upload.ts)", finalizeNamers.sort(), ["app/api/courses/upload/finalize/route.ts"]);
  const fin = fs.readFileSync(path.join(root, "app/api/courses/upload/finalize/route.ts"), "utf8");
  eq("the finalize route calls finalizeDirectUpload", /finalizeDirectUpload\s*\(/.test(fin), true);
}

console.log("\n(ii) the shared timeout");
const constOf = (file: string, name: string): number | null => {
  const sf = parse(file, fs.readFileSync(path.join(root, file), "utf8"));
  let v: number | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isNumericLiteral(n.initializer)) {
      v = Number(n.initializer.text.replace(/_/g, ""));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return v;
};
const deadline = constOf("lib/alds/guardian.ts", "GUARDIAN_DEADLINE_MS");
const timeout = constOf("tests/bot/lifecycle/helpers.ts", "GUARDIAN_ROUTE_TIMEOUT_MS");
eq("GUARDIAN_DEADLINE_MS is a number literal", typeof deadline, "number");
eq("GUARDIAN_ROUTE_TIMEOUT_MS is a number literal", typeof timeout, "number");
eq("GUARDIAN_ROUTE_TIMEOUT_MS >= GUARDIAN_DEADLINE_MS + 60 s", (timeout ?? 0) >= (deadline ?? Infinity) + 60_000, true);

/**
 * A string expression's shape: a literal's text, a template with each `${...}`
 * as `{}`, or a `+` chain of those with any other operand as `{}`; null for
 * anything else (and for a `+` chain with no string part).
 */
function urlShape(arg: ts.Node | undefined): string | null {
  if (!arg) return null;
  if (ts.isParenthesizedExpression(arg)) return urlShape(arg.expression);
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.head.text + arg.templateSpans.map((s) => "{}" + s.literal.text).join("");
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = urlShape(arg.left), r = urlShape(arg.right);
    if (l === null && r === null) return null;
    return (l ?? "{}") + (r ?? "{}");
  }
  return null;
}
const esc = (r: string) => r.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
/** A route, after an optional `{}` or origin, before an optional `{}` or query string. */
const ROUTE_RE = new RegExp("^(?:" + esc("{}") + "|https?://[^/]+)?(?:" + GUARDIAN_ROUTES.map(esc).join("|") + ")(?:" + esc("{}") + "|\\?.*)?$");
const OTHER_METHODS = ["get", "put", "patch", "delete", "head"];
type Site = { file: string; line: number; ok: boolean };
function scan(file: string, src: string): { sites: Site[]; orphans: string[] } {
  const sf = parse(file, src);
  const out: Site[] = [];
  const orphans: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  /** Route text that is a call's URL argument (checked or a non-POST method) is not an orphan. */
  const isUrlArg = (n: ts.Node) => {
    let x: ts.Node = n;
    while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
    const p = x.parent;
    return (
      !!p &&
      ts.isCallExpression(p) &&
      p.arguments[0] === x &&
      ts.isPropertyAccessExpression(p.expression) &&
      ["post", "fetch", ...OTHER_METHODS].includes(p.expression.name.text)
    );
  };
  const visit = (n: ts.Node) => {
    // route text outside a call's URL argument: the outermost string expression only
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) ||
        (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
      !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) &&
      !ts.isTemplateSpan(n.parent) &&
      !ts.isImportDeclaration(n.parent)
    ) {
      const shape = urlShape(n);
      if (shape !== null && ROUTE_RE.test(shape) && !isUrlArg(n)) orphans.push(at(n));
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["post", "fetch"].includes(n.expression.name.text)) {
      const shape = urlShape(n.arguments[0]);
      if (shape !== null && ROUTE_RE.test(shape)) {
        const opts = n.arguments[1];
        const method =
          opts && ts.isObjectLiteralExpression(opts)
            ? opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "method")
            : undefined;
        const literalRead =
          !!method &&
          (ts.isStringLiteral(method.initializer) || ts.isNoSubstitutionTemplateLiteral(method.initializer)) &&
          /^(GET|HEAD)$/i.test(method.initializer.text);
        if (n.expression.name.text === "fetch" && (literalRead || !opts)) {
          // fetch() with a literal GET or HEAD, or with no options (a GET): no Guardian
        } else {
          const ok =
            !!opts &&
            ts.isObjectLiteralExpression(opts) &&
            opts.properties.some(
              (p) =>
                ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.name) &&
                p.name.text === "timeout" &&
                ((ts.isIdentifier(p.initializer) && p.initializer.text === "GUARDIAN_ROUTE_TIMEOUT_MS") ||
                  (ts.isNumericLiteral(p.initializer) && Number(p.initializer.text.replace(/_/g, "")) >= (timeout ?? Infinity)))
            );
          out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, ok });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sites: out, orphans };
}

console.log("\n(iii) every bot request to those routes carries the timeout");
{
  const files: string[] = [];
  for (const d of ["tests/bot", "tests/e2e"]) walk(path.join(root, d), files);
  const scans = files.map((f) => scan(rel(f), fs.readFileSync(f, "utf8")));
  const sites = scans.flatMap((s) => s.sites);
  const missing = sites.filter((s) => !s.ok).map((s) => `${s.file}:${s.line}`);
  eq("calls without `timeout: GUARDIAN_ROUTE_TIMEOUT_MS` (or a longer literal)", missing, []);
  eq("route text outside a call's URL argument (inline the URL in the .post call)", scans.flatMap((s) => s.orphans), []);
  console.log(`    (${sites.length} calls found in ${new Set(sites.map((s) => s.file)).size} files)`);
  eq("the scan finds at least 35 calls (a floor: today's count; a broken matcher finds fewer)", sites.length >= 35, true);
}

console.log("\n(iv) the scan flags what it should");
{
  const planted = [
    'await req.post("/api/courses/upload", { multipart: {} });',
    "await ctx.request.post(`/api/courses/${id}/packages/${p}/versions/${v}/certify`, { data: {} });",
    'await req.post("/api/courses/upload/finalize", { data: {}, timeout: 30_000 });',
    "await req.post(`${base}/api/courses/${c}/packages`, { multipart: {} });",
    'await req.fetch("/api/courses/upload", { method: "POST", multipart: {} });',
    'await req.post("/api/courses/" + id + "/packages", { multipart: {} });',
    "await req.post(`/api/courses/upload${qs}`, { multipart: {} });",
    'await req.fetch("/api/courses/upload", { method: m, multipart: {} });',
  ].join("\n");
  eq(
    "eight planted calls without the shared timeout (a shorter literal, a + chain, a query suffix, a fetch with a non-literal method) are all flagged",
    scan("planted.ts", planted).sites.map((s) => s.ok),
    [false, false, false, false, false, false, false, false]
  );
  const orphaned = [
    'const URL_UPLOAD = "/api/courses/upload";',
    "const certify = (c: string, p: string, v: string) => `/api/courses/${c}/packages/${p}/versions/${v}/certify`;",
    'const u = "/api/courses/" + id + "/packages";',
    "await req.post(URL_UPLOAD, { multipart: {} });",
  ].join("\n");
  eq("route text outside a call (a constant, a helper, a + chain) is flagged", scan("orphans.ts", orphaned).orphans, ["orphans.ts:1", "orphans.ts:2", "orphans.ts:3"]);
  const fine = [
    'await req.post("/api/courses/upload", { multipart: {}, timeout: GUARDIAN_ROUTE_TIMEOUT_MS });',
    'await req.post("/api/courses/upload", { multipart: {}, timeout: 180_000 });',
    'await req.post("/api/courses/upload/init", { data: {} });',
    'await req.post("/api/courses/upload/abort", { data: {} });',
    'await req.post("/api/courses/validate-package", { multipart: {} });',
    "await req.get(`/api/courses/${c}/packages`);",
    'await req.fetch("/api/courses/upload", { method: "GET" });',
    'await req.fetch("/api/courses/upload");',
    '// a comment naming /api/courses/upload is not code',
  ].join("\n");
  const f = scan("fine.ts", fine);
  eq("the shared timeout and a longer literal pass; init, abort, validate and reads are not Guardian routes", f.sites.map((s) => s.ok), [true, true]);
  eq("no orphans in the fine cases", f.orphans, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
