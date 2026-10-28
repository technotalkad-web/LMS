/**
 * Unit tests for lib/attempts/revision-seed.ts (ADR 0014 step 3, the seed and
 * the SCORM runtime keys): the rebuilt SCORM cmi, the
 * LMS.OfficialResult document with its integer-percent score, and the
 * cross-language case (the official attempt on version A, the revision row
 * on version B).
 *
 * Run:  npx tsx tests/unit/revision-seed.test.ts   (or npm run test:unit)
 */
import { buildOfficialResult, buildRevisionCmi, REVISION_CMI_COPIED_KEYS } from "../../lib/attempts/revision-seed";
import { computeScoring, DEFAULT_POLICY } from "../../lib/scoring/policy";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\nbuildRevisionCmi (SCORM: rebuilt from the official attempt alone)");
{
  const official = {
    cmi_data: {
      "cmi.suspend_data": "slides=1,2,3",
      "cmi.core.lesson_location": "slide-3",
      "cmi.core.lesson_status": "passed",
      "cmi.core.score.raw": "93",
      "cmi.core.score.min": "0",
      "cmi.core.score.max": "100",
      "cmi.core.session_time": "00:10:00",
      "cmi.core.student_name": "someone",
      "cmi.interactions.0.id": "q1",
    },
  };
  const cmi = buildRevisionCmi(official);
  eq("the six copied keys, then entry, lesson_mode and credit", Object.keys(cmi), [...REVISION_CMI_COPIED_KEYS, "cmi.core.entry", "cmi.core.lesson_mode", "cmi.core.credit"]);
  eq("values copied verbatim", [cmi["cmi.suspend_data"], cmi["cmi.core.lesson_status"], cmi["cmi.core.score.raw"]], ["slides=1,2,3", "passed", "93"]);
  eq("review / no-credit / resume always", [cmi["cmi.core.lesson_mode"], cmi["cmi.core.credit"], cmi["cmi.core.entry"]], ["review", "no-credit", "resume"]);
  eq("nothing else of the official attempt (session time, name, interactions)", ["cmi.core.session_time", "cmi.core.student_name", "cmi.interactions.0.id"].map((k) => k in cmi), [false, false, false]);
  eq("an official attempt without cmi_data → the three fixed keys only", buildRevisionCmi({ cmi_data: null }), {
    "cmi.core.entry": "resume", "cmi.core.lesson_mode": "review", "cmi.core.credit": "no-credit",
  });
  eq("no official attempt → the three fixed keys only", Object.keys(buildRevisionCmi(null)), ["cmi.core.entry", "cmi.core.lesson_mode", "cmi.core.credit"]);
  eq("an empty value is not copied", "cmi.suspend_data" in buildRevisionCmi({ cmi_data: { "cmi.suspend_data": "" } }), false);
  const prevRevisit = { ...official.cmi_data, "cmi.core.lesson_mode": "normal", "cmi.core.credit": "credit", "cmi.core.entry": "ab-initio" };
  eq("the official attempt's own mode keys never leak through", [buildRevisionCmi({ cmi_data: prevRevisit })["cmi.core.lesson_mode"], buildRevisionCmi({ cmi_data: prevRevisit })["cmi.core.credit"]], ["review", "no-credit"]);
}

console.log("\nbuildOfficialResult (cmi5/xAPI: LMS.OfficialResult)");
{
  const scoring = {
    officialStatus: "passed" as const,
    officialScore: 0.93,
    officialAttempt: { id: "att-A", completed_at: "2026-10-01T09:30:00Z", course_version_id: "ver-A" },
  };
  const doc = buildOfficialResult({ scoring, writtenAt: "2026-10-29T10:00:00Z" });
  eq("the document", doc, {
    status: "passed", score: 93, completed_at: "2026-10-01T09:30:00Z", course_version_id: "ver-A", attempt_id: "att-A", written_at: "2026-10-29T10:00:00Z",
  });
  eq("score 0.93 → 93 (an integer percent, never 0.93)", doc.score, 93);
  eq("score 0.935 → 94 (Math.round, as learner-summary)", buildOfficialResult({ scoring: { ...scoring, officialScore: 0.935 }, writtenAt: "t" }).score, 94);
  eq("score null → null", buildOfficialResult({ scoring: { ...scoring, officialScore: null }, writtenAt: "t" }).score, null);
  eq("score 0 → 0", buildOfficialResult({ scoring: { ...scoring, officialScore: 0 }, writtenAt: "t" }).score, 0);
  eq("no official attempt → nulls", buildOfficialResult({ scoring: { officialStatus: null, officialScore: null, officialAttempt: null }, writtenAt: "t" }), {
    status: null, score: null, completed_at: null, course_version_id: null, attempt_id: null, written_at: "t",
  });
  eq("no name, email or actor anywhere", /@|"name"|actor|mbox/i.test(JSON.stringify(doc)), false);
}

console.log("\ncross-language: the official attempt on version A, the revision row on version B");
{
  // The learner's rows across both language slots: A's official attempt and
  // B's revision row. The seed source is scoring.officialAttempt, which
  // computeScoring takes over every version.
  const official = {
    id: "att-A", course_version_id: "ver-A", started_at: "2026-10-01T09:00Z", completed_at: "2026-10-01T09:30Z",
    completion_status: "completed", success_status: "failed", score: 0.4, status: "failed",
    cmi_data: { "cmi.suspend_data": "A-bookmark", "cmi.core.lesson_location": "a-7" },
  };
  const revisionOnB = {
    id: "rev-B", course_version_id: "ver-B", started_at: "2026-10-05T09:00Z", completed_at: null,
    completion_status: "in_progress", success_status: "unknown", score: null, status: "in_progress", is_revision: true,
    cmi_data: { "cmi.suspend_data": "B-revisit-state", "cmi.core.lesson_location": "b-2" },
  };
  const scoring = computeScoring([official, revisionOnB], DEFAULT_POLICY);
  const src = scoring.officialAttempt as typeof official | null;
  eq("the official attempt is A's, whatever version the row is on", src?.id, "att-A");
  const doc = buildOfficialResult({ scoring: { ...scoring, officialAttempt: src }, writtenAt: "t" });
  eq("LMS.OfficialResult names A's course_version_id and attempt id", [doc.course_version_id, doc.attempt_id], ["ver-A", "att-A"]);
  eq("…its result and score", [doc.status, doc.score], ["failed", 40]);
  const cmi = buildRevisionCmi(src);
  eq("buildRevisionCmi copies A's cmi_data, never B's", [cmi["cmi.suspend_data"], cmi["cmi.core.lesson_location"]], ["A-bookmark", "a-7"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
