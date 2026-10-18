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
 *   (vii) both finalize paths call the gate once, after publishVersion(),
 *         inside try/catch (an upload never fails for it); the direct path
 *         calls it last, after the forced restart and the update notice.
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

console.log("\n(vii) both finalize paths run the gate once, after publishVersion(), inside try/catch");
{
  for (const [file, listed] of [["lib/courses/upload.ts", false], ["lib/courses/direct-upload.ts", true]] as const) {
    const c = code(file);
    const calls = [...c.matchAll(/runPackageGuardian\(/g)].map((m) => m.index ?? 0);
    eq(`${file}: one call`, calls.length, 1);
    const at = calls[0] ?? 0;
    const before = c.slice(0, at);
    eq(`${file}: after publishVersion(`, before.lastIndexOf("await publishVersion(") > before.lastIndexOf("export async function"), true);
    const tryAt = before.lastIndexOf("try {");
    eq(`${file}: inside a try block that catches`, tryAt > before.lastIndexOf("await publishVersion(") && /^[^]*?\}\s*catch\s*\(/.test(c.slice(at)), true);
    eq(`${file}: listedKeys ${listed ? "reused" : "not passed"}`, /listedKeys:\s*keys/.test(statementFrom(c, at + "runPackageGuardian(".length)), listed);
    eq(`${file}: the result is not used`, /=\s*await\s+runPackageGuardian\(/.test(c), false);
    if (listed) {
      // Note (e) addition of 2026-10-19: in finalizeDirectUpload the gate is
      // last, so it can never delay or cost the ADR 0011 restart or the notice.
      const pub = before.lastIndexOf("await publishVersion(");
      eq(`${file}: after the forced restart and the update notification`,
        before.lastIndexOf("forceRestartOlderVersions(") > pub && before.lastIndexOf("notifyCourseUpdate(") > pub, true);
      eq(`${file}: nothing but the return after it`, /^[^]*?\}\s*catch\s*\([^)]*\)\s*\{[^{}]*\}\s*return\s*\{/.test(c.slice(at)), true);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
