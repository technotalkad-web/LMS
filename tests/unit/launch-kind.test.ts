/**
 * Unit tests for lib/attempts/launch-kind.ts (ADR 0014 step 3):
 * every branch of every helper the launch page decides
 * with. The page itself cannot run in a unit test; its wiring of these
 * helpers is checked by the source scans in tests/unit/alds-launch.test.ts.
 *
 * Run:  npx tsx tests/unit/launch-kind.test.ts   (or npm run test:unit)
 */
import {
  afterConsumeGrant,
  candidateKind,
  insertIsRevision,
  revisionInsertRefused,
  rowAction,
  seedPlan,
  shouldRecordVisit,
  tokenExpiryTargets,
  type RowAction,
} from "../../lib/attempts/launch-kind";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\ncandidateKind (ADR 0014 step 3, the launch kind)");
{
  const base = { limitReached: true, unusedGrantId: "g1", consumeGrants: true, liveRetakeOnAnyVersion: false };
  eq("a free slot → first, whatever the grants", candidateKind({ ...base, limitReached: false }), "first");
  eq("window used + unused grant + may consume + no live retake → grant", candidateKind(base), "grant");
  eq("…no unused grant → at_row", candidateKind({ ...base, unusedGrantId: null }), "at_row");
  eq("…the re-run after used/stale/retake_live/stands (consumeGrants false) → at_row", candidateKind({ ...base, consumeGrants: false }), "at_row");
  eq("…a live granted retake on any version blocks the grant → at_row", candidateKind({ ...base, liveRetakeOnAnyVersion: true }), "at_row");
}

console.log("\nrowAction: the kind rule and the cutover rule at the row");
{
  const retakes = new Set(["rt"]);
  const run = (candidate: "first" | "grant" | "at_row", limitReached: boolean, row: { id: string; is_revision?: boolean | null } | null) =>
    rowAction({ candidate, limitReached, row, retakeIds: retakes }).action;
  eq("first, no row → insert_first", run("first", false, null), "insert_first");
  eq("first, an unflagged row → resume_first", run("first", false, { id: "a", is_revision: false }), "resume_first");
  eq("first, a pre-0103 row (flag undefined) → resume_first", run("first", false, { id: "a" }), "resume_first");
  eq("first, a flagged row → refuse (never resumes a revision row as official)", run("first", false, { id: "a", is_revision: true }), "refuse");
  eq("first, a grant retake row → resume_retake", run("first", false, { id: "rt" }), "resume_retake");
  eq("at_row, no row → insert_revision", run("at_row", true, null), "insert_revision");
  eq("at_row, a grant retake row → resume_retake (kind retake)", run("at_row", true, { id: "rt", is_revision: false }), "resume_retake");
  eq("at_row, a flagged grant retake row → refuse", run("at_row", true, { id: "rt", is_revision: true }), "refuse");
  eq("at_row, a flagged row → resume_revision", run("at_row", true, { id: "a", is_revision: true }), "resume_revision");
  eq("at_row, an unflagged row → flag_then_resume (the cutover rule)", run("at_row", true, { id: "a", is_revision: false }), "flag_then_resume");
  eq("at_row, a pre-0103 row (flag undefined) → flag_then_resume", run("at_row", true, { id: "a" }), "flag_then_resume");
  eq("grant never reaches the row → refuse", run("grant", true, null), "refuse");
  eq("an inconsistent first + limitReached → refuse", run("first", true, null), "refuse");
  eq("an inconsistent at_row + free slot → refuse", run("at_row", false, null), "refuse");
  eq("a refusal carries its reason", rowAction({ candidate: "first", limitReached: false, row: { id: "a", is_revision: true }, retakeIds: retakes }).reason, "first_on_flagged_row");
}

console.log("\nafterConsumeGrant (consume_grant's outcomes)");
{
  eq("opened → proceed", afterConsumeGrant("opened"), "proceed");
  for (const o of ["used", "stale", "retake_live", "stands"]) eq(`${o} → rerun`, afterConsumeGrant(o), "rerun");
  for (const o of ["unavailable", "expired", "weird", null, undefined, 1]) eq(`${String(o)} → refuse`, afterConsumeGrant(o), "refuse");
}

console.log("\ninsertIsRevision (the insert invariant)");
eq("window used, no grant consumed → revision", insertIsRevision(true, null), true);
eq("window used, a grant consumed → official", insertIsRevision(true, "g1"), false);
eq("a free slot → official", [insertIsRevision(false, null), insertIsRevision(false, "g1")], [false, false]);

console.log("\nrevisionInsertRefused (I-4)");
{
  const missing = { code: "PGRST204", message: "Could not find the 'is_revision' column of 'course_attempts' in the schema cache" };
  eq("named is_revision, no P4 columns, schema missing → refuse", revisionInsertRefused(missing, true, false), true);
  eq("…the 42703 spelling too", revisionInsertRefused({ code: "42703", message: "column is_revision does not exist" }, true, false), true);
  eq("named P4 columns too → not yet (the P4 retry comes first)", revisionInsertRefused(missing, true, true), false);
  eq("is_revision not named → never", revisionInsertRefused(missing, false, false), false);
  eq("a 23505 → not this rule (the raced-row fallback)", revisionInsertRefused({ code: "23505", message: "duplicate key" }, true, false), false);
  eq("no error → false", revisionInsertRefused(null, true, false), false);
}

console.log("\ntokenExpiryTargets (after opened)");
{
  const attempts = [
    { id: "a1", is_revision: false }, // completed official attempt #1 (any status)
    { id: "rv", is_revision: true }, // a revision row
    { id: "new" }, // the retake consume_grant just opened
    { id: "old" }, // pre-0103 row
  ];
  const t = tokenExpiryTargets({ attempts, abandonedIds: ["ab1", "old", "ab1"], newAttemptId: "new" });
  eq("the abandoned ids once, then every non-revision attempt but the new one", t, ["ab1", "old", "a1"]);
  eq("a completed attempt #1 is in the set", t.includes("a1"), true);
  eq("the new retake is not", t.includes("new"), false);
  eq("a flagged row is not (unless consume_grant abandoned it)", t.includes("rv"), false);
  eq("a flagged row consume_grant abandoned is", tokenExpiryTargets({ attempts, abandonedIds: ["rv"], newAttemptId: "new" }).includes("rv"), true);
  eq("nothing → empty", tokenExpiryTargets({ attempts: [], abandonedIds: [], newAttemptId: "new" }), []);
}

console.log("\nseedPlan (the seed on every revision launch, never on first, grant or retake)");
{
  const actions: RowAction[] = ["insert_first", "resume_first", "resume_retake", "resume_revision", "flag_then_resume", "insert_revision", "refuse"];
  const seeded = actions.filter((a) => seedPlan({ action: a, flagResult: 1, manifestType: "cmi5" }).seed);
  eq("seed only on the three revision actions", seeded, ["resume_revision", "flag_then_resume", "insert_revision"]);
  eq("flag_then_resume with flagResult 0 → no seed", seedPlan({ action: "flag_then_resume", flagResult: 0, manifestType: "cmi5" }).seed, false);
  eq("flag_then_resume without a flag call → no seed", seedPlan({ action: "flag_then_resume", flagResult: null, manifestType: "cmi5" }).seed, false);
  eq("SCORM → the rebuilt cmi only", seedPlan({ action: "resume_revision", flagResult: null, manifestType: "scorm12" }), { seed: true, scorm: true, state: false, officialResult: false });
  eq("cmi5 → State and LMS.OfficialResult", seedPlan({ action: "resume_revision", flagResult: null, manifestType: "cmi5" }), { seed: true, scorm: false, state: true, officialResult: true });
  eq("xAPI → State and LMS.OfficialResult", seedPlan({ action: "insert_revision", flagResult: null, manifestType: "xapi" }), { seed: true, scorm: false, state: true, officialResult: true });
  eq("a first launch on SCORM → nothing", seedPlan({ action: "insert_first", flagResult: null, manifestType: "scorm12" }), { seed: false, scorm: false, state: false, officialResult: false });
}

console.log("\nshouldRecordVisit (the visit record)");
eq("a learner on a flagged row → record", shouldRecordVisit({ isPreview: false, rowIsRevision: true }), true);
eq("a preview → never, whatever the row", [shouldRecordVisit({ isPreview: true, rowIsRevision: true }), shouldRecordVisit({ isPreview: true, rowIsRevision: false })], [false, false]);
eq("an unflagged row → never", shouldRecordVisit({ isPreview: false, rowIsRevision: false }), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
