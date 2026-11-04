/**
 * Unit tests for Rule R-3, the registration rule (ADR 0014 step 5; step 17's
 * seven cases): lib/xapi/registration.ts registrationVerdict(). The
 * statements-route case (a sibling registration answered 200 with nothing
 * stored, processed or mirrored; R-3 before R-5) runs the route for real
 * against a stubbed PostgREST fetch in tests/unit/revision-gate.test.ts.
 *
 * Run:  npx tsx tests/unit/xapi-registration.test.ts   (or npm run test:unit)
 */
import { isUuid, registrationVerdict } from "../../lib/xapi/registration";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const BOUND = "11111111-1111-4111-8111-111111111111";
// The learner's attempts on the bound attempt's course: #1 (it stores the
// statement id the engine re-sends) and an abandoned one (it does not).
const SIB_STORES = "22222222-2222-4222-8222-222222222222";
const SIB_PLAIN = "33333333-3333-4333-8333-333333333333";
const siblings = new Set([BOUND, SIB_STORES, SIB_PLAIN]);
const OTHER_USER = "44444444-4444-4444-8444-444444444444"; // another learner's attempt: never in the set
const OTHER_COURSE = "55555555-5555-4555-8555-555555555555"; // the same learner on another course: never in the set

const v = (registration: unknown) => registrationVerdict({ registration, attemptId: BOUND, siblingAttemptIds: siblings });

console.log("\nregistrationVerdict (R-3)");
eq("registration absent → absent (today's path)", [v(undefined), v(null), v("")], ["absent", "absent", "absent"]);
eq("a non-string → absent", v(42), "absent");
eq("non-UUID → not_uuid (third-party engines keep working)", v("my-own-registration-key"), "not_uuid");
eq("the same attempt → same", v(BOUND), "same");
eq("…case-insensitive", v(BOUND.toUpperCase()), "same");
eq("a sibling of the same user and course that stores the statement id → sibling", v(SIB_STORES), "sibling");
eq("a sibling that does not → sibling (whether or not it stores the id)", v(SIB_PLAIN), "sibling");
eq("…case-insensitive", v(SIB_PLAIN.toUpperCase()), "sibling");
eq("another user's attempt → unknown (stored as today)", v(OTHER_USER), "unknown");
eq("another course's attempt → unknown (stored as today)", v(OTHER_COURSE), "unknown");

console.log("\nisUuid");
eq("a v4 uuid", isUuid(BOUND), true);
eq("not a uuid", [isUuid("x"), isUuid(null), isUuid(`${BOUND}0`)], [false, false, false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
