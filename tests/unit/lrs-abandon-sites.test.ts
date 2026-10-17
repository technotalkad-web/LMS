/**
 * Guard for gap 4 (tenant LRS "abandoned"): every abandon site queues the
 * statement through the one shared helper, right after it expires the
 * attempts' launch tokens. A lifecycle check would need LRS forwarding
 * switched on for an organisation, which the project rules forbid, so this
 * reads the sources instead: removing a call makes it fail.
 *
 * Run:  npx tsx tests/unit/lrs-abandon-sites.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const SITES: Array<{ file: string; calls: number; what: string }> = [
  { file: "app/api/courses/[courseId]/language-preference/route.ts", calls: 1, what: "language switch" },
  { file: "app/api/courses/[courseId]/packages/[packageId]/versions/route.ts", calls: 1, what: "force-restart replace (multipart)" },
  { file: "lib/courses/direct-upload.ts", calls: 1, what: "force-restart replace (direct upload)" },
  { file: "app/[org]/(learner)/courses/[courseId]/launch/page.tsx", calls: 2, what: "grant-retake and deactivated-slot closes" },
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
