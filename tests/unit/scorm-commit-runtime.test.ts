/**
 * Unit test for the SCORM commit route's runtime rule (ADR 0010 steps 3 and
 * 5): only a `scorm12` attempt is written; a known non-SCORM type is a 409
 * with the type echoed; a type that could not be established is a 503.
 *
 * Run:  npx tsx tests/unit/scorm-commit-runtime.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import { commitRuntimeRefusal, isScormRuntime } from "../../lib/scorm/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\nisScormRuntime (step 3)");
eq('"scorm12" → true', isScormRuntime("scorm12"), true);
for (const t of ["cmi5", "xapi", null, undefined, "", "SCORM12"] as const) {
  eq(`${JSON.stringify(t) ?? "undefined"} → false`, isScormRuntime(t), false);
}

console.log("\ncommitRuntimeRefusal: scorm12 is written (step 3)");
eq('"scorm12" → null (derive and write)', commitRuntimeRefusal("scorm12"), null);

console.log("\ncommitRuntimeRefusal: a known non-SCORM type → 409 wrong_runtime, type echoed");
for (const t of ["cmi5", "xapi", "SCORM12"]) {
  const r = commitRuntimeRefusal(t);
  eq(`${JSON.stringify(t)} → 409`, r?.status, 409);
  eq(`${JSON.stringify(t)} → wrong_runtime`, r?.error, "wrong_runtime");
  eq(`${JSON.stringify(t)} → manifest_type echoed`, r && "manifest_type" in r ? r.manifest_type : undefined, t);
  eq(`${JSON.stringify(t)} → a message`, typeof r?.message === "string" && r.message.length > 0, true);
  eq(`${JSON.stringify(t)} → exactly these keys`, r ? Object.keys(r).sort() : [], ["error", "manifest_type", "message", "status"]);
}

console.log("\ncommitRuntimeRefusal: the type could not be established → 503 attempt_unreadable");
for (const t of [null, undefined, ""] as const) {
  const name = JSON.stringify(t) ?? "undefined";
  const r = commitRuntimeRefusal(t);
  eq(`${name} → 503`, r?.status, 503);
  eq(`${name} → attempt_unreadable`, r?.error, "attempt_unreadable");
  eq(`${name} → a message`, typeof r?.message === "string" && r.message.length > 0, true);
  eq(`${name} → no manifest_type`, r ? Object.keys(r).sort() : [], ["error", "message", "status"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
