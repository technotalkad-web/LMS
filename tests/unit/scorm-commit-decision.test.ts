/**
 * Unit tests for lib/scorm/commit-decision.ts (ADR 0014 step 4 and ADR 0017 step 9):
 * R-5 on a revision visit's row, the completed_at cases and the freeze. The
 * source checks below pin that the route applies this decision; the route's own
 * wiring runs in scorm-commit-route.test.ts, and its lifecycle cases are spec 59
 * and spec 62.
 *
 * Run:  npx tsx tests/unit/scorm-commit-decision.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { appliedCommitRecord, commitDecision, frozenCommit } from "../../lib/scorm/commit-decision";
import { deriveScore, deriveSuccessStatus } from "../../lib/scorm/types";
import { outcomeFinalVerdict } from "../../lib/courses/engine-version";
import { ignoredPassCount, type IgnoredRecord } from "../../lib/xapi/ignored-pass";

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

console.log("\nADR 0017 step 9: the freeze is a third outcome of the twin");
const failedAxes = { completion_status: "completed", success_status: "failed" };
const FROZEN = { revisionOnly: false, frozen: true, stampCompletedAt: false, completedAt: null };
eq("(a) final on a failed row + a passing commit → frozen",
  commitDecision({ current: failedAxes, derived: passed, finished: true, isRevision: false, alreadyCompletedAt: NOW, now: NOW, outcomeFinal: true }), FROZEN);
eq("(d) final on a failed row + an incomplete beacon → frozen",
  commitDecision({ current: failedAxes, derived: failedAxes, finished: false, isRevision: undefined, alreadyCompletedAt: NOW, now: NOW, outcomeFinal: true }), FROZEN);
eq("(g) is_revision takes precedence over the freeze",
  commitDecision({ current: failedAxes, derived: passed, finished: true, isRevision: true, alreadyCompletedAt: NOW, now: NOW, outcomeFinal: true }),
  { revisionOnly: true, stampCompletedAt: false, completedAt: null });
eq("(b) older on a failed row: not frozen, and the key is not there",
  commitDecision({ current: failedAxes, derived: passed, finished: true, isRevision: false, alreadyCompletedAt: NOW, now: NOW, outcomeFinal: false }),
  { revisionOnly: false, stampCompletedAt: false, completedAt: null });
eq("final on a row that is not failed: never frozen",
  ["unknown", "passed", null, undefined].map((s) =>
    "frozen" in commitDecision({ current: { completion_status: "completed", success_status: s }, derived: passed, finished: true, isRevision: false, alreadyCompletedAt: NOW, now: NOW, outcomeFinal: true })),
  [false, false, false, false]);

console.log("\nfrozenCommit: the candidate, the entry, the merge, the update and the echo");
const VERSION_ID = "v1";
const STAMP = "2026.10.28";
const FAILED_AT = "2026-11-05T10:00:00.000Z";
const row = (extra: Record<string, unknown> = {}) => ({
  completion_status: "completed", success_status: "failed", status: "failed", score: 0.5, completed_at: FAILED_AT, ...extra,
});
const commit = (cmi: Record<string, string>, finished: boolean, r: Record<string, unknown>, now = NOW) =>
  frozenCommit({
    derivedSuccess: deriveSuccessStatus(cmi, finished, 0.8),
    lessonStatus: cmi["cmi.core.lesson_status"],
    score: deriveScore(cmi),
    row: r,
    courseVersionId: VERSION_ID,
    engineVersion: STAMP,
    now,
  });
const PASSING = { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "100", "cmi.suspend_data": "tab-b" };
const ECHO = { completion_status: "completed", success_status: "failed", status: "failed", score: 0.5 };
{
  const f = commit(PASSING, true, row());
  eq("(a) a candidate", f.candidate, true);
  eq("(a) the update is last_activity_at and ignored_pass only", Object.keys(f.update).sort(), ["ignored_pass", "last_activity_at"]);
  eq("(a) no cmi_data, status, completion, success, score, progress or completed_at",
    ["cmi_data", "status", "completion_status", "success_status", "score", "progress_pct", "completed_at"].filter((k) => k in f.update), []);
  eq("(i) the echo is the row's values, in the response's shape", f.echo, ECHO);
  const rec = f.update.ignored_pass as IgnoredRecord;
  eq("(a) the record's frame", [rec.v, rec.runtime, rec.course_version_id, rec.engine_version, rec.floor], [1, "scorm12", VERSION_ID, STAMP, "2026.10.28"]);
  eq("(a) failed: the row's time and score, no ids on SCORM", rec.failed, { at: FAILED_AT, score: 0.5 });
  eq("(a) one entry: passed, the pair, same_session null", rec.entries.map((e) => [e.verb, e.lesson_status, e.score, e.same_session, "statement_id" in e]), [["passed", "passed", 1, null, false]]);
  eq("(a) count 1, first_at and last_at the commit's", [rec.count, rec.first_at, rec.last_at], [1, NOW, NOW]);
  eq("(a) pass_ignored", f.event, { event: "pass_ignored" });

  const later = "2026-11-05T10:30:00.000Z";
  const again = commit(PASSING, true, row({ ignored_pass: rec }), later);
  const rec2 = again.update.ignored_pass as IgnoredRecord;
  eq("(a') the same dictionary again: repeats 2, count 1, one entry", [rec2.entries[0].repeats, rec2.count, rec2.entries.length], [2, 1, 1]);
  eq("(a') last_at does not move", rec2.last_at, NOW);
  const third = commit(PASSING, false, row({ ignored_pass: rec2 }), later);
  eq("the beacon too: repeats 3, count 1", [(third.update.ignored_pass as IgnoredRecord).entries[0].repeats, (third.update.ignored_pass as IgnoredRecord).count], [3, 1]);
}
{
  const f = commit({ "cmi.core.lesson_status": "incomplete" }, false, row());
  eq("(d) an incomplete beacon with no score: not a candidate", f.candidate, false);
  eq("(d) last_activity_at only, no record", Object.keys(f.update), ["last_activity_at"]);
  eq("(d) nothing to log", f.event, null);
  eq("(d) the echo is the row's", f.echo, ECHO);
}
{
  const f = commit({ "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "50" }, true, row());
  eq("a trailing commit with the same status and score: not a candidate", [f.candidate, Object.keys(f.update)], [false, ["last_activity_at"]]);
}
{
  const f = commit({ "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "70" }, true, row());
  const rec = f.update.ignored_pass as IgnoredRecord;
  eq("(e) a later failed with another score: a failed entry, count 0", [rec.entries[0].verb, rec.entries[0].score, rec.count, ignoredPassCount(rec)], ["failed", 0.7, 0, 0]);
  eq("(e) score and cmi_data unchanged", ["score", "cmi_data"].filter((k) => k in f.update), []);
  eq("(e) result_ignored with the verb", f.event, { event: "result_ignored", verb: "failed" });
}
{
  const f = commit({ "cmi.core.lesson_status": "incomplete", "cmi.core.score.raw": "70" }, false, row());
  const rec = f.update.ignored_pass as IgnoredRecord;
  eq("an incomplete commit with another score: the entry reads the lesson_status", [rec.entries[0].verb, rec.entries[0].lesson_status, rec.count], ["incomplete", "incomplete", 0]);
  eq("…result_ignored names it", f.event, { event: "result_ignored", verb: "incomplete" });
}
{
  const f = commit({ "cmi.core.score.raw": "70" }, false, row());
  const rec = f.update.ignored_pass as IgnoredRecord;
  eq("a commit with no lesson_status and another score: verb unknown, no pair key", [rec.entries[0].verb, "lesson_status" in rec.entries[0]], ["unknown", false]);
}
{
  const f = commit({ "cmi.core.score.raw": "90" }, true, row());
  eq("a pass by the mastery score, not the lesson_status: a candidate, verb passed", [(f.update.ignored_pass as IgnoredRecord).entries[0].verb, f.event], ["passed", { event: "pass_ignored" }]);
}
{
  const f = commit({ "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "50" }, true, row({ score: null }));
  eq("a row with no score: a scored commit is a candidate", [f.candidate, f.echo.score, "score" in f.update], [true, null, false]);
}
{
  const f = commit({ "cmi.core.lesson_status": "PASSED", "cmi.core.score.raw": "100" }, true, row());
  eq("the pair key's lesson_status is lower case", (f.update.ignored_pass as IgnoredRecord).entries[0].lesson_status, "passed");
}
{
  const full: IgnoredRecord = {
    v: 1, runtime: "scorm12", course_version_id: VERSION_ID, engine_version: STAMP, floor: "2026.10.28", failed: { at: FAILED_AT, score: 0.5 },
    count: 20, first_at: "t0", last_at: "t19",
    entries: Array.from({ length: 20 }, (_, n) => ({ verb: "passed", received_at: `t${n}`, score: n / 100, lesson_status: "passed" })),
  };
  const f = commit(PASSING, true, row({ ignored_pass: full }));
  eq("at the cap: no ignored_pass in the update, pass_ignored with the flag", ["ignored_pass" in f.update, f.event], [false, { event: "pass_ignored", capped: true }]);
  const scored = commit({ "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "70" }, true, row({ ignored_pass: full }));
  eq("…a later score too: result_ignored with the flag", ["ignored_pass" in scored.update, scored.event], [false, { event: "result_ignored", verb: "failed", capped: true }]);
  const repeat = commit({ "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "19" }, true, row({ ignored_pass: full }));
  eq("…a repeat of the last entry: its repeats rise, with no flag", [(repeat.update.ignored_pass as IgnoredRecord).entries[19].repeats, repeat.event], [2, { event: "pass_ignored" }]);
  const trailing = commit({ "cmi.core.lesson_status": "incomplete" }, false, row({ ignored_pass: full }));
  eq("…a trailing commit is not a candidate: nothing to log", [trailing.candidate, trailing.event], [false, null]);
}

// (f) runs through the route in scorm-commit-route.test.ts, and so does (j), with its
// read on ensureEngineVersion in engine-version.test.ts.
console.log("\nthe verdict decides the path: (b), (c), (c')");
eq("(b) older → not final", outcomeFinalVerdict({ stamp: "2026.10.20" }) === "final", false);
eq("(c) cached unknown → not final, unknown", outcomeFinalVerdict({ stamp: "unknown" }), "unknown");
eq("(c') cached null → not final, non_kivo", outcomeFinalVerdict({ stamp: null }), "non_kivo");
{
  const rec = appliedCommitRecord({ lessonStatus: "passed", score: 1, row: row(), courseVersionId: VERSION_ID, engineVersion: "unknown", reason: "unknown", now: NOW });
  eq("(c) the applied record: one entry, never counted", [rec.count, rec.entries.map((e) => [e.verb, e.applied, e.reason, e.lesson_status, e.same_session, e.score])], [0, [["passed", true, "unknown", "passed", null, 1]]]);
  eq("(c) the record's failed is the row's", rec.failed, { at: FAILED_AT, score: 0.5 });
  eq("(c) no error key when none was read", "error" in rec.entries[0], false);
  const un = appliedCommitRecord({ lessonStatus: undefined, score: null, row: row(), courseVersionId: VERSION_ID, engineVersion: null, reason: "unreadable", error: "no_object", now: NOW });
  eq("unreadable carries the read error, no pair key", [un.entries[0].reason, un.entries[0].error, "lesson_status" in un.entries[0], un.engine_version], ["unreadable", "no_object", false, null]);
}

console.log("\nthe route applies ADR 0017 (source); its wiring runs in scorm-commit-route.test.ts");
{
  const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/scorm/[attemptId]/commit/route.ts"), "utf8");
  const at = (s: string) => src.indexOf(s);
  eq("the embed carries what the lazy read needs",
    /"\*, course_versions\(id, manifest_data, manifest_type, launch_url, storage_prefix, storage_driver\)"/.test(src), true);
  eq("the service client is built once, after the refusal and before the verdict", [
    (src.match(/createServiceClient\(/g) ?? []).length,
    at("runtimeRefusalResponse(refusal);") < at("const svc = createServiceClient("),
    at("const svc = createServiceClient(") < at("await ensureEngineVersion(svc"),
  ], [1, true, true]);
  eq("the verdict comes before the twin", at("await ensureEngineVersion(svc") < at("commitDecision({"), true);
  eq("the verdict is read only on a failed row that is not a revision visit",
    /if \(currentSuccess === "failed" && a\.is_revision !== true\) \{\s*engineRead = await ensureEngineVersion\(svc, a\.course_versions\);/.test(src), true);
  eq("the twin is told", /outcomeFinal: verdict === "final",/.test(src), true);
  eq("the frozen update is the pure function's", /const update: Record<string, unknown> = frozen\s*\? frozen\.update/.test(src), true);
  eq("the frozen values reach the echo and justPassed",
    /\(\{ completion_status, success_status, status, score \} = frozen\.echo\);/.test(src), true);
  eq("the score, progress and completed_at block is skipped when frozen", /if \(!decision\.revisionOnly && !frozen\) \{\s*if \(score !== null\) update\.score = score;/.test(src), true);
  eq("the held values are assigned before the write", at("= frozen.echo);") < at("updateAttemptFailSoft(svc"), true);
  eq("pass_upgraded only on a real upgrade, never when frozen",
    /if \(verdict && !frozen && currentSuccess === "failed" && success_status === "passed"\)/.test(src), true);
  eq("the applied entry only on unknown or unreadable", /if \(verdict === "unknown" \|\| verdict === "unreadable"\) \{\s*update\.ignored_pass = appliedCommitRecord\(/.test(src), true);
  eq("the revision branch was not widened to a frozen commit",
    /if \(decision\.revisionOnly\) \{\s*return NextResponse\.json/.test(src) && !/if \(decision\.revisionOnly \|\| /.test(src), true);
  eq("the response keeps its shape", /return NextResponse\.json\(\{\s*ok: true,\s*completion_status,\s*success_status,\s*status,\s*score,\s*\}\);/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
