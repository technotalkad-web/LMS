/**
 * ALDS golden fixtures (ADR 0005 step 9): statements, sessions and
 * mini-packages with expected pass/fail, run against lib/alds/rules.
 *
 *   (i)   every case in tests/unit/alds-fixtures/*.cases.json plus the base
 *         anchors (every base document passes in its full context);
 *   (ii)  coverage: every rule id is exercised positively (evaluated, no
 *         finding) and negatively (a finding) by at least one case;
 *   (iii) every (rule, code) the rules source can emit has a negative case,
 *         so a new code cannot ship without a golden fixture.
 *
 * tests/unit/alds-bundle.test.ts runs the same cases against the built IIFE.
 *
 * Run:  npx tsx tests/unit/alds-golden.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import * as rules from "../../lib/alds/rules";
import { loadGolden, verify, type RulesApi } from "./alds-fixtures/harness";

let pass = 0, fail = 0;
const ok = (n: string, problems: string[]) => {
  if (problems.length === 0) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}\n      ${problems.join("\n      ")}`); }
};

const api = rules as unknown as RulesApi;
const { cases } = loadGolden();
const results = cases.map((c) => ({ c, res: c.run(api) }));

for (const kind of ["statement", "session", "package"] as const) {
  console.log(`\n(i) ${kind} cases`);
  for (const { c, res } of results.filter((x) => x.c.kind === kind)) ok(c.name, verify(c, res));
}

console.log("\n(ii) every rule is covered positively and negatively");
for (const rule of rules.RULE_IDS) {
  const positive = results.filter(({ res }) => res.checked.includes(rule) && !res.findings.some((f) => f.rule === rule)).length;
  const negative = results.filter(({ res }) => res.findings.some((f) => f.rule === rule)).length;
  ok(`${rule}: ${positive} passing, ${negative} failing case(s)`, positive > 0 && negative > 0 ? [] : ["needs at least one of each"]);
}

console.log("\n(iii) every emitted (rule, code) has a golden case");
{
  const dir = path.resolve(__dirname, "..", "..", "lib", "alds", "rules");
  const emitted = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/\.add\(\s*"([A-Z0-9]+)",\s*([^,]+?),/g)) {
      for (const c of m[2].matchAll(/"([a-z0-9_]+)"/g)) emitted.add(`${m[1]} ${c[1]}`);
    }
  }
  const seen = new Set(results.flatMap(({ res }) => res.findings.map((f) => `${f.rule} ${f.code}`)));
  const missing = Array.from(emitted).filter((k) => !seen.has(k)).sort();
  ok(`${emitted.size} (rule, code) pairs in the source, all produced by some case`, missing.map((k) => `no case produces ${k}`));
  const unknown = Array.from(seen).filter((k) => !emitted.has(k)).sort();
  ok("every code a case produced is visible to the source scan", unknown.map((k) => `scan missed ${k}`));
}

const byKind = (k: string) => cases.filter((c) => c.kind === k).length;
console.log(`\n${byKind("statement")} statement, ${byKind("session")} session and ${byKind("package")} package cases`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
