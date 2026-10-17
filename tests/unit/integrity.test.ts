/**
 * Unit test for the content-integrity rules (ADR 0004 steps 2–7): identity
 * extraction and normalisation, the collision rule (id or title of ANOTHER
 * course; the untitled KIVO id never collides on the id), the verdict order
 * when the findings are merged into a report ('unplayable' wins over
 * 'blocked', which wins over fail/warning), and the two gate predicates
 * (an unresolved block; a validation bound to another upload target).
 *
 * Run:  npx tsx tests/unit/integrity.test.ts   (or npm run test:unit)
 * (No DB: checkIntegrity's database reads are covered by lifecycle spec 52.)
 */
import {
  UNTITLED_KIVO_ID,
  applyIntegrity,
  integrityChecks,
  isUnresolvedBlock,
  kivoIdFromLaunchHtml,
  matchedOn,
  normalizeIdentityId,
  normalizeTitle,
  packageIdentity,
  storedIdentity,
  validatedForOtherCourse,
  type IntegrityFindings,
} from "../../lib/courses/validation/integrity";
import type { ValidationCheck } from "../../lib/courses/validation/validate-package";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const findings = (over: Partial<IntegrityFindings> = {}): IntegrityFindings => ({
  version: 1,
  stage: "validate",
  identity: { kivoCourseId: "urn:elearning-engine:x", title: "X" },
  context: { courseId: null, packageId: null },
  collisions: [],
  sameSlot: null,
  untitledId: false,
  blocked: false,
  checkedAt: "2026-10-17T00:00:00.000Z",
  ...over,
});
const report = (verdict: string, checks: ValidationCheck[] = []): { verdict: string; checks: ValidationCheck[]; integrity?: IntegrityFindings | null } => ({ verdict, checks });
const check = (id: string, status: ValidationCheck["status"]): ValidationCheck => ({ id, label: id, status, detail: "" });

console.log("\nnormalisation");
eq("id: trimmed, trailing slashes dropped, lower-cased", normalizeIdentityId("  URN:Elearning-Engine:Demo// "), "urn:elearning-engine:demo");
eq("id: empty → null", [normalizeIdentityId(""), normalizeIdentityId("   "), normalizeIdentityId(null)], [null, null, null]);
eq("title: NFKC, trimmed, whitespace collapsed, case-insensitive", normalizeTitle("  Ｔｕｒｎｉｎｇ   Escalations\n Into  EXCELLENCE "), "turning escalations into excellence");
eq("title: empty → null", normalizeTitle("  "), null);

console.log("\nidentity extraction");
eq("KIVO COURSE_CONFIG xapiActivityId", kivoIdFromLaunchHtml(`<script>var COURSE_CONFIG = { settings: { xapiActivityId: "urn:elearning-engine:demo" } };</script>`), "urn:elearning-engine:demo");
eq("quoted key form", kivoIdFromLaunchHtml(`COURSE_CONFIG={"settings":{"xapiActivityId":'urn:elearning-engine:q'}}`), "urn:elearning-engine:q");
eq("no COURSE_CONFIG → null", kivoIdFromLaunchHtml(`<script>var x = { xapiActivityId: "urn:a" };</script>`), null);
eq("no html → null", kivoIdFromLaunchHtml(null), null);
eq("cmi5: the course id wins over the launch file", packageIdentity({ type: "cmi5", title: "T", raw: { courseId: "urn:cmi5" } }, `COURSE_CONFIG={settings:{xapiActivityId:"urn:kivo"}}`), { kivoCourseId: "urn:cmi5", title: "T" });
eq("xapi: activityId, else courseId", [packageIdentity({ type: "xapi", raw: { activityId: "urn:act", courseId: "urn:c" } }).kivoCourseId, packageIdentity({ type: "xapi", raw: { courseId: "urn:c" } }).kivoCourseId], ["urn:act", "urn:c"]);
eq("scorm: only the launch file's KIVO id", packageIdentity({ type: "scorm12", title: " S ", raw: { courseId: "ignored" } }, `COURSE_CONFIG={settings:{xapiActivityId:"urn:kivo"}}`), { kivoCourseId: "urn:kivo", title: "S" });
eq("scorm without a KIVO launch file → title only", packageIdentity({ type: "scorm12", title: "S" }, "<html></html>"), { kivoCourseId: null, title: "S" });
eq("stored: manifest_data.identity wins", storedIdentity({ identity: { kivoCourseId: "urn:new", title: "New" }, title: "Old", rawCourseId: "urn:old" }), { kivoCourseId: "urn:new", title: "New" });
eq("stored: legacy rows read raw.courseId + title", storedIdentity({ identity: null, title: "Old", rawCourseId: "urn:old" }), { kivoCourseId: "urn:old", title: "Old" });

console.log("\ncollision rule (ADR 0004 steps 3 and 5)");
const X = { kivoCourseId: "urn:elearning-engine:x", title: "Module X" };
eq("same id → id", matchedOn(X, { kivoCourseId: "URN:elearning-engine:x/", title: "Other" }), ["id"]);
eq("same title → title", matchedOn(X, { kivoCourseId: "urn:elearning-engine:y", title: "  module   x " }), ["title"]);
eq("both", matchedOn(X, X), ["id", "title"]);
eq("neither", matchedOn(X, { kivoCourseId: "urn:elearning-engine:y", title: "Y" }), []);
eq("stored SCORM row (no id) matches on title only", matchedOn(X, { kivoCourseId: null, title: "Module X" }), ["title"]);
const U1 = { kivoCourseId: UNTITLED_KIVO_ID, title: "Untitled One" };
eq("two untitled exports never collide on the id", matchedOn(U1, { kivoCourseId: UNTITLED_KIVO_ID, title: "Untitled Two" }), []);
eq("an untitled stored row never collides on the id", matchedOn(X, { kivoCourseId: UNTITLED_KIVO_ID, title: "Other" }), []);
eq("the title rule still applies to an untitled export", matchedOn(U1, { kivoCourseId: UNTITLED_KIVO_ID, title: "untitled one" }), ["title"]);
eq("no identity at all → no match", matchedOn({ kivoCourseId: null, title: null }, { kivoCourseId: null, title: null }), []);

console.log("\nverdict order when findings are merged (applyIntegrity)");
const blocked = findings({ blocked: true, collisions: [{ courseId: "c-1", courseTitle: "Course One", versionId: "v-1", matchedOn: ["id"] }] });
eq("collision → blocked", applyIntegrity(report("pass"), blocked).verdict, "blocked");
eq("collision on a warning/fail report → blocked", [applyIntegrity(report("warning"), blocked).verdict, applyIntegrity(report("fail"), blocked).verdict], ["blocked", "blocked"]);
eq("'unplayable' wins over 'blocked'", applyIntegrity(report("unplayable"), blocked).verdict, "unplayable");
eq("no collision, clean report → pass", applyIntegrity(report("pass", [check("x", "pass")]), findings()).verdict, "pass");
eq("no collision keeps a fail", applyIntegrity(report("fail", [check("x", "fail")]), findings()).verdict, "fail");
const slot = findings({ sameSlot: { versionId: "v-0", versionNumber: 1, previous: { kivoCourseId: "urn:elearning-engine:x", title: "Old" }, idChanged: false, titleChanged: true } });
eq("same-slot retitle → warning (needs the admin's confirm)", applyIntegrity(report("pass"), slot).verdict, "warning");
eq("untitled id → warning only", applyIntegrity(report("pass"), findings({ untitledId: true })).verdict, "warning");
{
  const once = applyIntegrity(report("pass"), blocked);
  const twice = applyIntegrity(once, findings());
  eq("re-applying replaces the integrity lines (never duplicates them)", twice.checks.filter((c) => c.id.startsWith("integrity")).map((c) => [c.id, c.status]), [["integrity", "pass"]]);
  eq("…and the verdict follows the new findings", twice.verdict, "pass");
  eq("the findings ride along as report.integrity", once.integrity?.blocked, true);
}
eq("the block line names the colliding course and what matched", /"Course One" \(matched on id\)/.test(integrityChecks(blocked)[0].detail), true);

console.log("\ngate predicates");
eq("blocked, not overridden → unresolved", isUnresolvedBlock({ verdict: "blocked" }), true);
eq("blocked, overridden → resolved", isUnresolvedBlock({ verdict: "blocked", overridden_at: "2026-10-17T00:00:00Z" }), false);
eq("other verdicts are never an unresolved block", ["pass", "warning", "fail", "unplayable"].map((v) => isUnresolvedBlock({ verdict: v })), [false, false, false, false]);
const boundTo = (courseId: string | null) => ({ verdict: "pass", report: { integrity: { context: { courseId } } } });
eq("bound to X, uploading into X → fine", validatedForOtherCourse(boundTo("X"), "X"), false);
eq("bound to X, uploading into Y → refused", validatedForOtherCourse(boundTo("X"), "Y"), true);
eq("bound to X, uploading a new course → refused", validatedForOtherCourse(boundTo("X"), null), true);
eq("unbound (the strictest lookup) → any target", [validatedForOtherCourse(boundTo(null), "Y"), validatedForOtherCourse(boundTo(null), null)], [false, false]);
eq("no recorded integrity → binds to nothing", validatedForOtherCourse({ verdict: "pass", report: {} }, "Y"), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
