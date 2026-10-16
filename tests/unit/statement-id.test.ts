/**
 * Unit test for the deterministic statement id (ADR 0003 step 6) and the
 * write-once retry comparison (ADR 0003 step 5).
 *
 * Fixed vectors were cross-checked with Python's uuid.uuid5 (an independent
 * RFC 4122 implementation), so a change to the name layout or the namespace
 * fails here.
 *
 * Run:  npx tsx tests/unit/statement-id.test.ts   (or npm run test:unit)
 */
import { uuid5 } from "../../lib/lrs/uuid5";
import {
  ALDS_NS,
  ALDS_QUESTION_TRY_EXT,
  deterministicStatementId,
  statementIdName,
} from "../../lib/lrs/statement-id";
import { canonicalJson, isSameStatementAsReceived } from "../../lib/xapi/statement-equality";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const answered = {
  actor: { objectType: "Agent", name: "learner@example.test" },
  verb: { id: "http://adlnet.gov/expapi/verbs/answered" },
  object: { id: "urn:elearning-engine:demo/3" },
  timestamp: "2026-10-05T09:00:00.000Z",
  result: { success: true, response: "option_1" },
  context: { extensions: { [ALDS_QUESTION_TRY_EXT]: 2 } },
};

console.log("\nuuid5 (RFC 4122 v5)");
eq("RFC vector: DNS namespace + python.org", uuid5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
eq("ALDS namespace constant", ALDS_NS, "6b2c1f6e-9c2e-5c3a-8f0b-3c1a6d1e2a10");
eq("try extension IRI", ALDS_QUESTION_TRY_EXT, "https://ambak.com/xapi/ext/question/try");

console.log("\nname layout (BLUEPRINT §5.3)");
eq(
  "attempt|verb|object|timestamp|result|try",
  statementIdName(ATTEMPT, answered),
  `${ATTEMPT}|http://adlnet.gov/expapi/verbs/answered|urn:elearning-engine:demo/3|2026-10-05T09:00:00.000Z|{"success":true,"response":"option_1"}|2`
);
eq(
  "missing timestamp, result and try → empty string and null",
  statementIdName(ATTEMPT, { verb: { id: "http://adlnet.gov/expapi/verbs/initialized" }, object: { id: "https://qa.bot/cmi5/au1" } }),
  `${ATTEMPT}|http://adlnet.gov/expapi/verbs/initialized|https://qa.bot/cmi5/au1||null|null`
);

console.log("\nfixed vectors (cross-checked with Python uuid.uuid5)");
eq("answered statement", deterministicStatementId(ATTEMPT, answered), "0e9f6733-7831-5291-9bf1-92a7a25e4714");
eq(
  "id-less initialized without timestamp",
  deterministicStatementId(ATTEMPT, { verb: { id: "http://adlnet.gov/expapi/verbs/initialized" }, object: { id: "https://qa.bot/cmi5/au1" } }),
  "969b628d-79d8-5d7b-b304-d90dab8ee126"
);

console.log("\nproperties");
eq("an exact retry collapses (same object → same id)", deterministicStatementId(ATTEMPT, { ...answered }), deterministicStatementId(ATTEMPT, answered));
eq(
  "separate launches never collapse (different content timestamp)",
  deterministicStatementId(ATTEMPT, { ...answered, timestamp: "2026-10-05T09:00:01.000Z" }) === deterministicStatementId(ATTEMPT, answered),
  false
);
eq(
  "a second try differs",
  deterministicStatementId(ATTEMPT, { ...answered, context: { extensions: { [ALDS_QUESTION_TRY_EXT]: 3 } } }) === deterministicStatementId(ATTEMPT, answered),
  false
);
eq(
  "another attempt differs",
  deterministicStatementId("99999999-2222-4333-8444-555555555555", answered) === deterministicStatementId(ATTEMPT, answered),
  false
);
eq("not the LMS-derived namespace", deterministicStatementId(ATTEMPT, answered) === uuid5(statementIdName(ATTEMPT, answered)), false);
eq("output is a v5 uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deterministicStatementId(ATTEMPT, answered)), true);

console.log("\nwrite-once comparison (ADR 0003 step 5)");
eq("canonical JSON sorts keys at every level", canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }), '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
{
  // Stored copy as jsonb hands it back: other key order + LMS-filled id/timestamp.
  const received = { verb: { id: "v" }, object: { id: "o" }, result: { score: { scaled: 0.5 } } };
  const stored = { timestamp: "2026-10-16T00:00:00.000Z", id: "lms-id", result: { score: { scaled: 0.5 } }, object: { id: "o" }, verb: { id: "v" } };
  eq("exact retry of an id-less, timestamp-less statement", isSameStatementAsReceived(stored, received), true);
  eq("different result under the same id → conflict", isSameStatementAsReceived(stored, { ...received, result: { score: { scaled: 0.9 } } }), false);
}
{
  const received = { id: "abc", timestamp: "2026-10-05T09:00:00.000Z", verb: { id: "v" }, object: { id: "o" } };
  eq("content-set id and timestamp are compared", isSameStatementAsReceived({ ...received }, received), true);
  eq("a different content timestamp is a conflict", isSameStatementAsReceived({ ...received, timestamp: "2026-10-05T09:00:05.000Z" }, received), false);
}
eq("no stored copy → not the same", isSameStatementAsReceived(null, { verb: { id: "v" } }), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
