/**
 * The launch pair's parity, the TypeScript side (ADR 0024 step 62's row
 * "launch-context-facts.test.ts"; build notes N15 and N16; twins contract 5.3
 * and 6): every case of
 * scripts/migration-rehearsal/fixtures/parity-launch.cases.json, read through
 * the one loader both sides import, fed to resolveLaunchContext() as the
 * facts launch_context returns: the resolver given `expect.facts` decides
 * `expect.decision`. The rehearsal asserts launch_context(call) =
 * expect.facts on the same world (assert-0107-parity.sql (P4)), so the facts
 * the resolver is tested on are the ones the database answers.
 *
 *   (a) each case: the decision, compared field by field;
 *   (b) the file: a case the SQL side does not run is only the conflict row
 *       (no call is made for it), and every case the SQL side runs carries
 *       facts.
 *
 * Run:  npx tsx tests/unit/launch-context-facts.test.ts   (or npm run test:unit)
 */
import { loadCases } from "../../scripts/migration-rehearsal/parity-cases.mjs";
import { resolveLaunchContext, type LaunchContextFacts, type LaunchParams } from "../../lib/attempts/launch-context";
import type { OrgRole } from "../../lib/auth/require-org-access";

let pass = 0, fail = 0;
const ok = (n: string, problems: string[]) => {
  if (problems.length === 0) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}\n      ${problems.join("\n      ")}`); }
};

type LaunchCase = {
  name: string;
  sides: Array<"ts" | "sql">;
  call: { course_id: string; role: OrgRole; params: LaunchParams };
  expect: { facts: LaunchContextFacts | null; decision: Record<string, unknown> };
};
const doc = loadCases("fixtures/parity-launch.cases.json") as unknown as { pair: string; now: string; cases: LaunchCase[] };

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
function diff(p: string, want: unknown, got: unknown, out: string[] = []): string[] {
  if (isObj(want) && isObj(got)) {
    for (const k of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
      if (!(k in want)) out.push(`${p}.${k}: not in expect (got ${JSON.stringify(got[k])})`);
      else if (!(k in got)) out.push(`${p}.${k}: expected ${JSON.stringify(want[k])}, not produced`);
      else diff(`${p}.${k}`, want[k], got[k], out);
    }
  } else if (JSON.stringify(want) !== JSON.stringify(got)) {
    out.push(`${p}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return out;
}

console.log(`\n(a) resolveLaunchContext() fed the recorded facts (${doc.cases.length} cases, now ${doc.now})`);
for (const c of doc.cases) {
  const problems: string[] = [];
  try {
    const got = resolveLaunchContext({
      courseId: c.call.course_id,
      role: c.call.role,
      params: c.call.params,
      facts: c.expect.facts,
      now: doc.now,
    });
    diff("expect.decision", c.expect.decision, got, problems);
  } catch (e) {
    problems.push(`threw ${String(e)}`);
  }
  ok(c.name, problems);
}

console.log("\n(b) the file");
ok("the pair is launch", doc.pair === "launch" ? [] : [`pair ${doc.pair}`]);
ok("a case only TypeScript runs is the conflict row, made with no call", doc.cases
  .filter((c) => !c.sides.includes("sql"))
  .flatMap((c) => (c.expect.facts === null && c.expect.decision.reason === "context_conflict" ? [] : [`${c.name}: not the conflict row`])));
ok("every case the SQL side runs carries facts", doc.cases
  .filter((c) => c.sides.includes("sql"))
  .flatMap((c) => (c.expect.facts !== null ? [] : [`${c.name}: no facts`])));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
