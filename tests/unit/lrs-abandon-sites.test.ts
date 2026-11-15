/**
 * Guard for gap 4 (tenant LRS "abandoned"): every abandon site queues the
 * statement through the one shared helper, right after it expires the
 * attempts' launch tokens. A lifecycle check would need LRS forwarding
 * switched on for an organisation, which the project rules forbid, so this
 * reads the sources instead: removing a call makes it fail.
 *
 * Extended for ADR 0024 P2-3 (step 62's abandon scan, here and not copied
 * into preview-isolation-sites.test.ts): the listed sites are every caller,
 * and the helper's own attempts read drops `context_kind = 'preview'` rows
 * through the one fallback, so no caller can enqueue a preview's
 * "abandoned" statement (step 80).
 *
 * Extended for ADR 0024 P2-5 (note N4): the launch page's close of an open
 * legacy_role row before a course preview insert writes no "abandoned"
 * statement, by design: both rows are previews, and a preview never reaches a
 * tenant LRS (decision A35). The scan says so explicitly: of the launch
 * page's four `.update({ status: "abandoned" })` closes, the three closes of
 * a Start each queue the statement after their token expiry, and the N4
 * close (the one write that names preview_kind 'legacy_role') expires its
 * tokens and queues nothing anywhere in the preview branch. The helper would
 * drop those rows anyway (P2-3); not calling it keeps the branch from
 * reading attempts it has no use for.
 *
 * Run:  npx tsx tests/unit/lrs-abandon-sites.test.ts   (or npm run test:unit)
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
const SITES: Array<{ file: string; calls: number; what: string }> = [
  { file: "app/api/courses/[courseId]/language-preference/route.ts", calls: 1, what: "language switch" },
  // ADR 0011: both replace paths (multipart route, direct-upload finalize) call the one forced restart.
  { file: "lib/attempts/force-restart.ts", calls: 1, what: "force-restart replace (both paths)" },
  // ADR 0014 step 3: the deactivated-slot close, the stale-revision
  // close, the flagged-row close of a first launch, and the rows
  // consume_grant abandoned once it answered `opened`. ADR 0024 note N4:
  // the preview's legacy_role close is a fifth abandon and queues nothing
  // (checked below).
  { file: "app/[org]/(learner)/courses/[courseId]/launch/page.tsx", calls: 4, what: "deactivated-slot, stale-revision and flagged-row closes, consume_grant's abandoned rows" },
  { file: "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart/route.ts", calls: 1, what: "per-version restart" },
];

console.log("\nabandon sites queue the LRS statement through the shared helper");
for (const s of SITES) {
  const src = fs.readFileSync(path.join(root, s.file), "utf8");
  const calls = [...src.matchAll(/\benqueueAbandonedStatements\(/g)].map((m) => m.index ?? 0);
  eq(`${s.what}: ${s.calls} call(s)`, calls.length, s.calls);
  eq(`${s.what}: imported from lib/lrs/abandoned`, /from "@\/lib\/lrs\/abandoned"/.test(src), true);
  const expiries = [...src.matchAll(/\bexpireLaunchTokens\(/g)].map((m) => m.index ?? 0);
  eq(
    `${s.what}: each call follows a token expiry`,
    calls.every((c) => expiries.some((e) => e < c)),
    true
  );
}

console.log("\nADR 0024 P2-3: the listed sites are every caller, and the helper never enqueues a preview");
{
  const walk = (dir: string, out: string[]) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
    }
  };
  const files: string[] = [];
  for (const d of ["app", "lib", "components"]) walk(path.join(root, d), files);
  // Calls by name in the parsed code (comments do not count), the definition left out.
  const callers: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes("enqueueAbandonedStatements")) continue;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let n = 0;
    const visit = (x: ts.Node) => {
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "enqueueAbandonedStatements") n++;
      ts.forEachChild(x, visit);
    };
    visit(sf);
    if (n) callers.push(`${path.relative(root, f).split(path.sep).join("/")}: ${n}`);
  }
  eq("every caller of enqueueAbandonedStatements is a listed site, with its count", callers.sort(), SITES.map((s) => `${s.file}: ${s.calls}`).sort());

  const helper = fs.readFileSync(path.join(root, "lib/lrs/abandoned.ts"), "utf8").replace(/\r\n/g, "\n");
  eq("the helper's attempts read sits in readWithContextFilter(previews, (apply) => withoutPreviews(…, apply)), one decision for every slice",
    /const previews: ContextFilterState = \{ applies: null \};\s*for \(let i = 0; i < ids\.length; i \+= SLICE\) \{\s*const slice = ids\.slice\(i, i \+ SLICE\);\s*const \{ data, error \} = await readWithContextFilter\(previews, \(apply\) =>\s*withoutPreviews\(\s*svc\.from\("course_attempts"\)\.select\("id, organization_id, status, started_at, last_activity_at"\)\.in\("id", slice\),\s*apply\s*\)\s*\);/.test(helper), true);
  eq("…and the contexts are loaded with the same decision", /loadAttemptContexts\(svc, slice\.map\(\(r\) => r\.id\), groups, previews\)/.test(helper), true);
  eq("…and it reads course_attempts nowhere else", (helper.match(/\.from\("course_attempts"\)/g) ?? []).length, 1);
}

console.log("\nADR 0024 note N4: the launch page's legacy_role close queues no \"abandoned\" statement, by design");
{
  const file = "app/[org]/(learner)/courses/[courseId]/launch/page.tsx";
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callName = (c: ts.CallExpression) =>
    ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null;
  const callsIn = (n: ts.Node, name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = [];
    const visit = (x: ts.Node) => {
      if (ts.isCallExpression(x) && callName(x) === name) out.push(x);
      ts.forEachChild(x, visit);
    };
    visit(n);
    return out;
  };
  /** The whole method chain an update sits in (its outermost call). */
  const chainOf = (c: ts.Node): ts.Node => {
    let n: ts.Node = c;
    while (n.parent && (ts.isPropertyAccessExpression(n.parent) || (ts.isCallExpression(n.parent) && n.parent.expression === n))) n = n.parent;
    return n;
  };
  const blockOf = (n: ts.Node): ts.Block | null => {
    for (let p = n.parent; p; p = p.parent) if (ts.isBlock(p)) return p;
    return null;
  };
  const abandons = callsIn(sf, "update").filter((c) => {
    const a = c.arguments[0];
    return !!a && ts.isObjectLiteralExpression(a) && /^\{\s*status:\s*"abandoned"\s*\}$/.test(a.getText(sf));
  });
  const rows = abandons.map((u) => {
    const legacy = /\.eq\("preview_kind", "legacy_role"\)/.test(chainOf(u).getText(sf));
    const block = blockOf(u);
    const after = (name: string) => (block ? callsIn(block, name).filter((c) => c.getStart(sf) > u.getStart(sf)).length : 0);
    return { legacy, expires: after("expireLaunchTokens") > 0, enqueues: after("enqueueAbandonedStatements") > 0 };
  });
  eq("four abandon closes in file order: deactivated-slot, stale-revision, the N4 legacy_role close, flagged-row",
    rows.map((r) => r.legacy), [false, false, true, false]);
  eq("each close of a Start expires its tokens and then queues the statement",
    rows.filter((r) => !r.legacy).map((r) => r.expires && r.enqueues), [true, true, true]);
  eq("the N4 close expires its tokens and queues no statement", rows.filter((r) => r.legacy).map((r) => [r.expires, r.enqueues]), [[true, false]]);
  // The whole preview branch (`if (preview) { … }`, the one that holds the
  // N4 close) queues nothing: no later edit can add a queue beside the close.
  const legacyUpdate = abandons.find((u) => /\.eq\("preview_kind", "legacy_role"\)/.test(chainOf(u).getText(sf)));
  let branch: ts.Node | null = null;
  for (let p = legacyUpdate?.parent; p; p = p.parent) {
    if (ts.isIfStatement(p) && p.expression.getText(sf) === "preview") { branch = p.thenStatement; break; }
  }
  eq("…it sits in the `if (preview)` branch, which calls enqueueAbandonedStatements nowhere",
    branch !== null && callsIn(branch, "enqueueAbandonedStatements").length === 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
