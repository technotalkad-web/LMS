/**
 * Unit tests for lib/scorm/commit-decision.ts (ADR 0014 step 4):
 * R-5 on a revision visit's row and the completed_at cases. The
 * route itself authenticates through the cookie-bound server client and has
 * no unit rig; its route-level case is the SCORM lifecycle spec, and the
 * source checks below pin that the route applies this decision.
 *
 * Run:  npx tsx tests/unit/scorm-commit-decision.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { commitDecision } from "../../lib/scorm/commit-decision";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const NOW = "2026-10-29T10:00:00.000Z";
const incomplete = { completion_status: "in_progress", success_status: "unknown" };
const completed = { completion_status: "completed", success_status: "unknown" };
const passed = { completion_status: "completed", success_status: "passed" };

console.log("\nR-5: a revision visit's row");
eq("a flagged row → revisionOnly, never a stamp",
  commitDecision({ current: incomplete, derived: passed, finished: true, isRevision: true, alreadyCompletedAt: null, now: NOW }),
  { revisionOnly: true, stampCompletedAt: false, completedAt: null });
eq("is_revision false → not revisionOnly",
  commitDecision({ current: incomplete, derived: incomplete, finished: false, isRevision: false, alreadyCompletedAt: null, now: NOW }).revisionOnly, false);
eq("is_revision undefined (a database without 0103) → not revisionOnly",
  commitDecision({ current: incomplete, derived: incomplete, finished: false, isRevision: undefined, alreadyCompletedAt: null, now: NOW }).revisionOnly, false);

console.log("\ncompleted_at: stamped at the change to complete and only then");
eq("a mid-way LMSFinish (finished, lesson_status incomplete) → no stamp",
  commitDecision({ current: incomplete, derived: incomplete, finished: true, isRevision: false, alreadyCompletedAt: null, now: NOW }),
  { revisionOnly: false, stampCompletedAt: false, completedAt: null });
eq("the completing commit → stamp once, now",
  commitDecision({ current: incomplete, derived: completed, finished: false, isRevision: false, alreadyCompletedAt: null, now: NOW }),
  { revisionOnly: false, stampCompletedAt: true, completedAt: NOW });
eq("a pass completes too (success_status passed)",
  commitDecision({ current: incomplete, derived: { completion_status: "in_progress", success_status: "passed" }, finished: true, isRevision: false, alreadyCompletedAt: null, now: NOW }).stampCompletedAt, true);
eq("the completing session's final LMSFinish (already complete, stamped) → no stamp",
  commitDecision({ current: completed, derived: passed, finished: true, isRevision: false, alreadyCompletedAt: "2026-10-29T09:59:00.000Z", now: NOW }).stampCompletedAt, false);
eq("a row stamped before this release keeps its date (complete, stamped)",
  commitDecision({ current: passed, derived: passed, finished: false, isRevision: false, alreadyCompletedAt: "2026-09-01T00:00:00.000Z", now: NOW }).completedAt, null);
eq("…and an incomplete row stamped by an old mid-way LMSFinish keeps its date too (no backfill)",
  commitDecision({ current: incomplete, derived: incomplete, finished: true, isRevision: false, alreadyCompletedAt: "2026-09-01T00:00:00.000Z", now: NOW }).stampCompletedAt, false);
eq("…but stamps the real completion over it (the change to complete)",
  commitDecision({ current: incomplete, derived: completed, finished: true, isRevision: false, alreadyCompletedAt: "2026-09-01T00:00:00.000Z", now: NOW }).stampCompletedAt, true);
eq("a complete row that was never stamped → stamped now",
  commitDecision({ current: completed, derived: completed, finished: false, isRevision: false, alreadyCompletedAt: null, now: NOW }).stampCompletedAt, true);

console.log("\nthe route applies the decision (source)");
{
  const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/scorm/[attemptId]/commit/route.ts"), "utf8");
  eq("imports commitDecision", /import \{ commitDecision \} from "@\/lib\/scorm\/commit-decision";/.test(src), true);
  eq("passes the row's own flag", /isRevision: a\.is_revision,/.test(src), true);
  eq("a revision row writes cmi_data and last_activity_at only",
    /decision\.revisionOnly\s*\?\s*\{ cmi_data: cmi, last_activity_at: nowIso \}/.test(src), true);
  eq("completed_at comes from the decision only", [
    /if \(decision\.stampCompletedAt\) update\.completed_at = decision\.completedAt;/.test(src),
    /finished \|\| derivedCompletion === "completed"/.test(src),
  ], [true, false]);
  eq("one write: updateAttemptFailSoft(svc, attemptId, update, { userId: user.id })",
    (src.match(/updateAttemptFailSoft\(/g) ?? []).length, 1);
  const ret = src.indexOf("if (decision.revisionOnly) {");
  eq("the revision commit returns after the write, before classification, RPCs and the webhook",
    ret > src.indexOf("updateAttemptFailSoft(svc") && ret < src.indexOf("classifyAttempt(svc") &&
      ret < src.indexOf('svc.rpc("gamification_record_activity"') && ret < src.indexOf("fireCompletionWebhook("), true);
  eq("officialRun carries the flag gate too",
    /const officialRun = a\.is_revision !== true && \(!nowComplete \|\| !kind \|\| kind\.official\);/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
