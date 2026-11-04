/**
 * The one-version check of Text A and Text B in docs/CRM_INTEGRATION.md
 * (ADR 0014 step 13 (j); ADR 0015 step 8). This file is the only check of the two texts.
 *
 *   - Before any comparison, every run of whitespace in the guide, newlines
 *     included, collapses to one space (the guide is hard-wrapped).
 *   - Each text's first eight words are searched for anywhere in the
 *     normalised guide. Every occurrence must begin the full text,
 *     byte-identical after the same normalisation.
 *   - At PR 1b each text occurs exactly once (PR 1b's attempt paragraphs).
 *     ADR 0015's pull request changes only EXPECTED_COUNT, to the number it
 *     produces (its Step 5 adds one paragraph per text), and makes no other
 *     edit here.
 *
 * TEXT_A and TEXT_B are ADR 0015 step 8's strings, verbatim.
 *
 * Run:  npx tsx tests/unit/crm-guide-texts.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/** Text A: the second `course_completed` message (ADR 0015 step 8). */
const TEXT_A =
  "At most two `course_completed` messages are sent per official attempt: the first when it completes (cmi5/xAPI: with its result, or, when the course sent its completion without a result, after that session ends or 15 minutes later; SCORM 1.2: at the completing commit, with whatever is known then), and a second, always `passed: true` with the same `attempt_number`, only if the attempt becomes passed afterwards (a fail then a pass in the same sitting, or a pass that arrives after a message sent without a result), which replaces the first.";
/** Text B: a granted extra official attempt (ADR 0015 step 8; ADR 0014 step 7). */
const TEXT_B =
  "A `course_completed` with a higher `attempt_number` for the same learner and course is a granted extra official attempt, whose result replaces the earlier one whether it is higher or lower, so a `passed: false` can follow a `passed: true` (`attempt_number` and `official: true` on both).";

/** The occurrences of each text in the guide at this pull request. */
const EXPECTED_COUNT = 1;

const normalise = (s: string) => s.replace(/\s+/g, " ");
const guide = normalise(fs.readFileSync(path.resolve(__dirname, "../../docs/CRM_INTEGRATION.md"), "utf8"));

for (const [name, raw] of [["Text A", TEXT_A], ["Text B", TEXT_B]] as const) {
  const text = normalise(raw);
  const opening = text.split(" ").slice(0, 8).join(" ");
  const at: number[] = [];
  for (let i = guide.indexOf(opening); i !== -1; i = guide.indexOf(opening, i + 1)) at.push(i);
  console.log(`\n${name}: "${opening} …"`);
  eq(`${name}: the constant carries no newline (normalisation leaves it unchanged)`, text, raw);
  eq(`${name}: occurs exactly ${EXPECTED_COUNT} time(s) in docs/CRM_INTEGRATION.md`, at.length, EXPECTED_COUNT);
  eq(`${name}: every occurrence of its first eight words begins the full text, byte-identical`,
    at.map((i) => guide.slice(i, i + text.length) === text), at.map(() => true));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
