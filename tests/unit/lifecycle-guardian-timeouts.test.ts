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
 *         under app/ and lib/ that call runPackageGuardian() are exactly the
 *         four route files and lib/courses/direct-upload.ts, which the
 *         finalize route calls; a new caller fails here until its route is
 *         added to GUARDIAN_ROUTES;
 *   (ii)  GUARDIAN_ROUTE_TIMEOUT_MS (tests/bot/lifecycle/helpers.ts) is at
 *         least GUARDIAN_DEADLINE_MS + 60 s;
 *   (iii) every `.post(` / `.fetch(` call under tests/bot and tests/e2e whose
 *         URL is one of those routes passes an options object literal with
 *         `timeout: GUARDIAN_ROUTE_TIMEOUT_MS` or a longer number literal (the
 *         KIVO Release A uploads keep their 180 s);
 *   (iv)  the scan finds the calls it should (a floor on the count) and flags
 *         a planted call without the timeout.
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
  const callers: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes("runPackageGuardian")) continue;
    if (rel(f) === "lib/alds/guardian.ts") continue; // the definition
    let calls = false;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "runPackageGuardian") calls = true;
      ts.forEachChild(n, visit);
    };
    visit(parse(f, src));
    if (calls) callers.push(rel(f));
  }
  eq("the files that call runPackageGuardian() (a new caller: add its route to GUARDIAN_ROUTES)", callers.sort(), CALLERS);
  const fin = fs.readFileSync(path.join(root, "app/api/courses/upload/finalize/route.ts"), "utf8");
  eq("the finalize route calls finalizeDirectUpload (lib/courses/direct-upload.ts)", /finalizeDirectUpload\s*\(/.test(fin), true);
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

/** The URL argument's shape, or null when it is not a literal or template. */
function urlShape(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.head.text + arg.templateSpans.map((s) => "{}" + s.literal.text).join("");
  return null;
}
const ROUTE_RE = new RegExp(
  "^(?:\\{\\}|https?://[^/]+)?(?:" + GUARDIAN_ROUTES.map((r) => r.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\}/g, "\\{\\}")).join("|") + ")$"
);
type Site = { file: string; line: number; ok: boolean };
function scan(file: string, src: string): Site[] {
  const sf = parse(file, src);
  const out: Site[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["post", "fetch"].includes(n.expression.name.text)) {
      const shape = urlShape(n.arguments[0]);
      if (shape !== null && ROUTE_RE.test(shape.split("?")[0])) {
        const opts = n.arguments[1];
        if (n.expression.name.text === "fetch" && !(opts && ts.isObjectLiteralExpression(opts) && /method\s*:\s*["'`]POST/i.test(opts.getText()))) {
          // a GET through fetch() runs no Guardian
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
  return out;
}

console.log("\n(iii) every bot request to those routes carries the timeout");
{
  const files: string[] = [];
  for (const d of ["tests/bot", "tests/e2e"]) walk(path.join(root, d), files);
  const sites = files.flatMap((f) => scan(rel(f), fs.readFileSync(f, "utf8")));
  const missing = sites.filter((s) => !s.ok).map((s) => `${s.file}:${s.line}`);
  eq("calls without `timeout: GUARDIAN_ROUTE_TIMEOUT_MS` (or a longer literal)", missing, []);
  console.log(`    (${sites.length} calls found in ${new Set(sites.map((s) => s.file)).size} files)`);
  eq("the scan finds at least 25 calls (a floor: a broken matcher finds none)", sites.length >= 25, true);
}

console.log("\n(iv) the scan flags what it should");
{
  const planted = [
    'await req.post("/api/courses/upload", { multipart: {} });',
    "await ctx.request.post(`/api/courses/${id}/packages/${p}/versions/${v}/certify`, { data: {} });",
    'await req.post("/api/courses/upload/finalize", { data: {}, timeout: 30_000 });',
    "await req.post(`${base}/api/courses/${c}/packages`, { multipart: {} });",
    'await req.fetch("/api/courses/upload", { method: "POST", multipart: {} });',
  ].join("\n");
  eq("five planted calls without the shared timeout (one with a shorter literal) are all flagged", scan("planted.ts", planted).map((s) => s.ok), [false, false, false, false, false]);
  const fine = [
    'await req.post("/api/courses/upload", { multipart: {}, timeout: GUARDIAN_ROUTE_TIMEOUT_MS });',
    'await req.post("/api/courses/upload", { multipart: {}, timeout: 180_000 });',
    'await req.post("/api/courses/upload/init", { data: {} });',
    'await req.post("/api/courses/upload/abort", { data: {} });',
    'await req.post("/api/courses/validate-package", { multipart: {} });',
    "await req.get(`/api/courses/${c}/packages`);",
    'await req.fetch("/api/courses/upload", { method: "GET" });',
  ].join("\n");
  eq("the shared timeout and a longer literal pass; init, abort, validate and reads are not Guardian routes", scan("fine.ts", fine).map((s) => s.ok), [true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
