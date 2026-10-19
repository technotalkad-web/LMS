/**
 * Guard for ADR 0005 D1 and steps 2 and 10 as built in P4 (notes (c), (e),
 * (g), (i) and (j) of 2026-10-19). Reads the sources under app/, lib/ and
 * components/ (comments stripped with the TypeScript printer, so a comment
 * that names a column is not a read), no database:
 *
 *   (i)   the tier columns (analytics_tier*, certified_at, certification_id)
 *         appear only in the listed P4 files, and never under the grading,
 *         completion, Report Card, CRM, journey, xAPI or LRS code;
 *   (ii)  is_preview / launch_mode appear only in the launch contract's files;
 *   (iii) the alds_set_version_tier RPC is called only from tier-writer.ts;
 *   (iv)  package_certifications is written only by guardian.ts (one insert,
 *         one update, both org-scoped; never deleted);
 *   (v)   no other course_versions write names a tier column;
 *   (vi)  the grading code imports none of the tier modules, no client
 *         component imports the server flag or the gate, and the frozen rules
 *         tree imports none of the P4 modules;
 *   (vii) every finalize path calls the gate once, inside try/catch (an
 *         upload never fails for it), as its last step: finalizeDirectUpload
 *         and the three multipart routes that call uploadCoursePackage()
 *         (the helper itself no longer does), after publication, the forced
 *         restart and the update notice (note (e), additions of 2026-10-19);
 *   (viii) the course page offers "Re-run check" through the certify route's
 *         own predicate (canRerunCertification) on the same raw membership
 *         role (note (f)).
 * The allowlists say where a name MAY appear; a listed file that does not
 * exist yet (another builder's) is not an error.
 *
 * Run:  npx tsx tests/unit/alds-tier-read-sites.test.ts   (or npm run test:unit)
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

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
}
const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(root, d), files);
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
const raw = new Map<string, string>(files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));

/** The file's code without comments (strings and identifiers kept). */
const printed = new Map<string, string>();
function code(file: string): string {
  let out = printed.get(file);
  if (out === undefined) {
    const src = raw.get(file) ?? "";
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(m?js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
    out = ts.createPrinter({ removeComments: true }).printFile(sf);
    printed.set(file, out);
  }
  return out;
}
/** Files whose code (comments stripped) matches `re`; the raw text pre-filters. */
function filesMatching(re: RegExp): string[] {
  const out: string[] = [];
  for (const [file, src] of raw) {
    if (!re.test(src)) continue;
    if (re.test(code(file))) out.push(file);
  }
  return out.sort();
}

/** The statement that starts at `start`: up to a `;` or an unmatched closer at depth 0, skipping strings. */
function statementFrom(src: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (ch === ";" && depth === 0) break;
  }
  return src.slice(start, i);
}

type Write = { file: string; method: string; stmt: string };
function writesOn(fromArg: RegExp): Write[] {
  const out: Write[] = [];
  for (const [file, src] of raw) {
    if (!fromArg.test(src)) continue;
    const c = code(file);
    const re = new RegExp(`\\.from\\(\\s*${fromArg.source}\\s*\\)`, "g");
    for (const m of c.matchAll(re)) {
      const stmt = statementFrom(c, (m.index ?? 0) + m[0].length);
      const w = /\.(insert|update|upsert|delete)\(/.exec(stmt);
      if (w) out.push({ file, method: w[1], stmt });
    }
  }
  return out;
}

const LAUNCH_PAGE = "app/[org]/(learner)/courses/[courseId]/launch/page.tsx";
const CERTIFY_ROUTE = "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/certify/route.ts";
const TIER_READERS = [
  "components/alds/tier-badge.tsx",
  "app/[org]/(admin)/library/page.tsx",
  "app/[org]/(admin)/library/library-browser.tsx",
  "app/[org]/(admin)/library/[courseId]/page.tsx",
  "app/[org]/(admin)/library/[courseId]/version-actions.tsx",
  "app/[org]/(admin)/reports/page.tsx",
  "app/api/integrations/catalog/route.ts",
  CERTIFY_ROUTE,
];
/** D1: grading, completion, scores, official status, Report Card, CRM progress, journeys, XP, statements. */
const FORBIDDEN_PREFIXES = [
  "lib/scoring/",
  "lib/manager/",
  "lib/integrations/",
  "lib/journey/",
  "lib/xapi/",
  "lib/attention/",
  "lib/lrs/",
  "lib/attempts/",
  "lib/gamification/",
  "lib/learner/",
  "lib/courses/progress.ts",
  "app/api/scorm/",
  "app/api/xapi/",
  "app/api/integrations/progress",
  "app/api/integrations/learner-summary",
  "app/api/journey/",
  "app/api/manager/",
  "app/api/gamification/",
  "app/api/cron/",
];
const isForbidden = (f: string) => FORBIDDEN_PREFIXES.some((p) => f.startsWith(p));
const inAlds = (f: string) => f.startsWith("lib/alds/");

console.log("\n(i) the tier columns are read only by the listed P4 files, never by grading (D1)");
{
  const TIER_COLS = /\b(analytics_tier\w*|certified_at|certification_id)\b/;
  const hits = filesMatching(TIER_COLS);
  const unlisted = hits.filter((f) => !inAlds(f) && !TIER_READERS.includes(f));
  eq("no file outside lib/alds/* and the listed surfaces names a tier column", unlisted, []);
  eq("no file under the grading prefixes names a tier column", hits.filter(isForbidden), []);
  eq("the catalog (under app/api/integrations) is the only integration file that names it",
    hits.filter((f) => f.startsWith("app/api/integrations/")), ["app/api/integrations/catalog/route.ts"]);
  eq("the frozen rules tree never names a tier column", hits.filter((f) => f.startsWith("lib/alds/rules/") || f === "lib/alds/types.ts"), []);
  eq("non-vacuous: the gate and the badge surfaces do name it", ["lib/alds/rpc.ts", "app/[org]/(admin)/library/page.tsx", "app/api/integrations/catalog/route.ts"].every((f) => hits.includes(f)), true);
}

console.log("\n(ii) is_preview / launch_mode are written only by the launch contract");
{
  const hits = filesMatching(/\b(is_preview|launch_mode)\b/);
  const allowed = ["lib/alds/launch.ts", LAUNCH_PAGE, "lib/alds/rpc.ts"];
  eq("only lib/alds/launch.ts, the launch page and lib/alds/rpc.ts name them", hits.filter((f) => !allowed.includes(f)), []);
  eq("never under the grading prefixes", hits.filter(isForbidden), []);
}

console.log("\n(iii) alds_set_version_tier is called only from lib/alds/tier-writer.ts");
{
  const calls = filesMatching(/\.rpc\(\s*(["'`]alds_set_version_tier["'`]|ALDS_RPC\.)/);
  eq("the RPC call sites", calls, ["lib/alds/tier-writer.ts"]);
  eq("ALDS_RPC.setVersionTier is used only in tier-writer.ts", filesMatching(/ALDS_RPC\.setVersionTier/), ["lib/alds/tier-writer.ts"]);
  eq("the function name is spelled only in rpc.ts", filesMatching(/["'`]alds_set_version_tier["'`]/), ["lib/alds/rpc.ts"]);
  eq("setVersionTier( is called only by the gate", filesMatching(/(?<!function\s)\bsetVersionTier\(/).filter((f) => f !== "lib/alds/tier-writer.ts"), ["lib/alds/guardian.ts"]);
}

console.log("\n(iv) package_certifications is written only by lib/alds/guardian.ts");
{
  const writes = writesOn(/(?:["'`]package_certifications["'`]|PACKAGE_CERTIFICATIONS_TABLE)/);
  eq("write sites (file: method), in file order", writes.map((w) => `${w.file}: ${w.method}`), ["lib/alds/guardian.ts: insert", "lib/alds/guardian.ts: update"]);
  eq("the insert names organization_id", writes.filter((w) => w.method === "insert").every((w) => /\borganization_id:/.test(w.stmt)), true);
  eq("the update is by id and organization_id", writes.filter((w) => w.method === "update").every((w) => /\.eq\("id",/.test(w.stmt) && /\.eq\("organization_id",/.test(w.stmt)), true);
  eq("never deleted, never upserted", writes.filter((w) => w.method === "delete" || w.method === "upsert").length, 0);
}

console.log("\n(v) no course_versions write outside tier-writer.ts names a tier column");
{
  const writes = writesOn(/["'`]course_versions["'`]/);
  const offending = writes
    .filter((w) => w.file !== "lib/alds/tier-writer.ts" && /\b(analytics_tier|analytics_tier_reason|certified_at|certification_id)\b/.test(w.stmt))
    .map((w) => `${w.file}: ${w.method}`);
  eq("offending writes", offending, []);
  eq("non-vacuous: course_versions writes were found", writes.length > 0, true);
}

console.log("\n(vi) imports: grading never imports the tier modules; the flag stays server-side; the rules tree stays pure");
{
  const TIER_MODULES = /from\s+["'](?:@\/lib\/alds\/|(?:\.\.?\/)+(?:lib\/alds\/)?)(tier|tier-writer|guardian)["']/;
  eq("no grading file imports lib/alds/tier, tier-writer or guardian", filesMatching(TIER_MODULES).filter(isForbidden), []);
  const clientFiles = [...raw.keys()].filter((f) => /^\s*["']use client["']/.test(code(f)) || /^["']use client["']/.test((raw.get(f) ?? "").trimStart()));
  const SERVER_ONLY = /from\s+["'](?:@\/lib\/alds\/|\.\.?\/)(flag|guardian|tier-writer)["']/;
  eq("no client component imports the flag, the gate or the tier writer", clientFiles.filter((f) => SERVER_ONLY.test(code(f))), []);
  eq("components/alds/tier-badge.tsx imports only lib/alds/tier", (code("components/alds/tier-badge.tsx").match(/from\s+["'][^"']+["']/g) ?? []), ['from "@/lib/alds/tier"']);
  const rules = [...raw.keys()].filter((f) => f.startsWith("lib/alds/rules/") || f === "lib/alds/types.ts");
  const P4 = /from\s+["'](?:\.\.?\/)+(flag|tier|rpc|guardian|tier-writer|launch|engine-allowlist(?:\.json)?)["']/;
  eq("lib/alds/rules/* and types.ts import none of the P4 modules", rules.filter((f) => P4.test(code(f))), []);
  eq("non-vacuous: the rules tree was scanned", rules.length > 5, true);
}

console.log("\n(vii) every finalize path runs the gate once, as its last step before the return, inside try/catch");
{
  // Note (e), additions of 2026-10-19: the gate runs at the end of each
  // finalize path, after publication, the forced restart and the update
  // notification, so it can never delay or cost the ADR 0011 restart or the
  // notice. The multipart helper does not run it; each route that calls
  // uploadCoursePackage() does, exactly as finalizeDirectUpload does.
  eq("lib/courses/upload.ts (the multipart helper) does not call it", /runPackageGuardian\(/.test(code("lib/courses/upload.ts")), false);
  eq("lib/courses/upload.ts does not import it", /@\/lib\/alds\/guardian/.test(code("lib/courses/upload.ts")), false);
  const UPLOAD_ROUTE = "app/api/courses/upload/route.ts";
  const PACKAGES_ROUTE = "app/api/courses/[courseId]/packages/route.ts";
  const VERSIONS_ROUTE = "app/api/courses/[courseId]/packages/[packageId]/versions/route.ts";
  eq("the files that call uploadCoursePackage( are exactly the three multipart routes",
    filesMatching(/\buploadCoursePackage\(/).filter((f) => f !== "lib/courses/upload.ts"), [UPLOAD_ROUTE, PACKAGES_ROUTE, VERSIONS_ROUTE].sort());

  /** published: the call after which the version is public; after: the calls the gate must follow. */
  const SITES: Array<{ file: string; published: string; after: string[]; listed: boolean }> = [
    { file: "lib/courses/direct-upload.ts", published: "publishVersion", after: ["forceRestartOlderVersions", "notifyCourseUpdate"], listed: true },
    { file: UPLOAD_ROUTE, published: "linkValidationToVersion", after: ["notifyCourseUpdate"], listed: false },
    { file: PACKAGES_ROUTE, published: "linkValidationToVersion", after: [], listed: false },
    { file: VERSIONS_ROUTE, published: "linkValidationToVersion", after: ["forceRestartOlderVersions"], listed: false },
  ];
  for (const site of SITES) {
    const { file } = site;
    const sf = ts.createSourceFile(file, raw.get(file) ?? "", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const callsOf = (name: string, under: ts.Node = sf): ts.CallExpression[] => {
      const out: ts.CallExpression[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n);
        ts.forEachChild(n, visit);
      };
      visit(under);
      return out;
    };
    const gates = callsOf("runPackageGuardian");
    eq(`${file}: one call`, gates.length, 1);
    const call = gates[0];
    if (!call) continue;
    // `await runPackageGuardian(…)` is the only statement of a try block whose
    // catch only warns; that try is a top-level statement of the function
    // (never inside a branch), followed only by the function's return.
    const stmt = call.parent?.parent;
    const tryBlock = stmt?.parent;
    const tryStmt = tryBlock?.parent;
    const fnBody = tryStmt?.parent;
    const fn = fnBody?.parent;
    const shaped = !!stmt && ts.isAwaitExpression(call.parent) && ts.isExpressionStatement(stmt) &&
      !!tryBlock && ts.isBlock(tryBlock) && tryBlock.statements.length === 1 &&
      !!tryStmt && ts.isTryStatement(tryStmt) && tryStmt.tryBlock === tryBlock && !tryStmt.finallyBlock;
    eq(`${file}: \`await runPackageGuardian(…)\` alone in a try block (the result is not used)`, shaped, true);
    const catchBody = shaped ? (tryStmt as ts.TryStatement).catchClause?.block : undefined;
    eq(`${file}: the catch only warns`, !!catchBody && catchBody.statements.length === 1 &&
      /^console\.warn\("\[alds\] guardian failed",/.test(catchBody.statements[0].getText(sf)), true);
    const isFn = !!fn && !!fnBody && ts.isBlock(fnBody) &&
      (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && fn.body === fnBody;
    eq(`${file}: the try is a top-level statement of the function, never inside a branch`, isFn, true);
    if (!isFn || !shaped) continue;
    const body = fnBody as ts.Block;
    const tryAt = (tryStmt as ts.TryStatement).getStart(sf);
    const last = body.statements[body.statements.length - 1];
    eq(`${file}: followed only by the function's return`,
      body.statements.indexOf(tryStmt as ts.TryStatement) === body.statements.length - 2 && ts.isReturnStatement(last), true);
    const pubCalls = callsOf(site.published, body);
    eq(`${file}: after ${site.published}()`, pubCalls.length === 1 && pubCalls[0].getStart(sf) < tryAt, true);
    for (const a of site.after) {
      const xs = callsOf(a, body);
      eq(`${file}: after ${a}()`, xs.length >= 1 && xs.every((x) => x.getStart(sf) < tryAt), true);
    }
    // Every way out after publication passes the gate: the only return
    // after it is the last statement (nested functions do not count).
    const returns: ts.ReturnStatement[] = [];
    const visitReturns = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
      if (ts.isReturnStatement(n)) returns.push(n);
      ts.forEachChild(n, visitReturns);
    };
    body.statements.forEach(visitReturns);
    const pubAt = pubCalls[0]?.getStart(sf) ?? Infinity;
    eq(`${file}: one exit after publication, after the gate`,
      returns.filter((r) => r.getStart(sf) > pubAt).map((r) => r === last), [true]);
    eq(`${file}: listedKeys ${site.listed ? "reused" : "not passed"}`, /listedKeys:\s*keys/.test(call.getText(sf)), site.listed);
    eq(`${file}: trigger "upload"`, /trigger:\s*"upload"/.test(call.getText(sf)), true);
  }
}

console.log("\n(viii) \"Re-run check\" shows for exactly the roles the certify route accepts");
{
  const COURSE_PAGE = "app/[org]/(admin)/library/[courseId]/page.tsx";
  const route = code(CERTIFY_ROUTE);
  const page = code(COURSE_PAGE);
  eq("canRerunCertification is defined only in lib/alds/guardian.ts", filesMatching(/function canRerunCertification\(/), ["lib/alds/guardian.ts"]);
  eq("…and called only by the certify route and the course page",
    filesMatching(/(?<!function\s)\bcanRerunCertification\(/), [COURSE_PAGE, CERTIFY_ROUTE].sort());
  eq("the route answers 403 unless canRerunCertification(role), role from requireOrgAdminApi (the raw membership role)",
    /if\s*\(!canRerunCertification\(role\)\)\s*\{\s*return NextResponse\.json\(\{\s*error:\s*"super_owner_required"\s*\},\s*\{\s*status:\s*403\s*\}\);/.test(route) &&
      /const\s*\{[^}]*\brole\b[^}]*\}\s*=\s*auth;/.test(route) && /=\s*await requireOrgAdminApi\(/.test(route), true);
  eq("the route compares no role literal itself", /\brole\s*[!=]==?\s*"/.test(route), false);
  eq("the page feeds it the RAW organization_members.role of the signed-in user, read as requireOrgAdminApi reads it",
    /\.from\("organization_members"\)\s*\.select\("role"\)\s*\.eq\("organization_id",\s*org\.id\)\s*\.eq\("user_id",\s*user\.id\)\s*\.maybeSingle\(\)/.test(page) &&
      /rerunAllowed\s*=\s*canRerunCertification\(\(membership as [^)]*\)\?\.role\);/.test(page), true);
  eq("the page reads it only with the flag on: if (showTiers) { … }", /if\s*\(showTiers\)\s*\{\s*const\s*\{\s*data:\s*membership\s*\}/.test(page), true);
  eq("the button's predicate starts from it, never from the normalised role",
    /const canRerun\s*=\s*rerunAllowed\s*&&/.test(page) && !/\brole\s*===?\s*"super_owner"/.test(page), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
