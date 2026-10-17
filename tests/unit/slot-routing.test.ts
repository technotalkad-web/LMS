/**
 * Unit test for the launch-time other-slot rules (ADR 0004 step 9).
 *
 * Run:  npx tsx tests/unit/slot-routing.test.ts
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import { decideSlotRouting, type SlotAttempt, type SlotRoutingInput } from "../../lib/courses/slot-routing";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// Course with three slots: en (active), hi (active), gu (deactivated).
const packageOfVersion = new Map([
  ["en-v1", "en"], ["en-v2", "en"],
  ["hi-v1", "hi"],
  ["gu-v1", "gu"],
]);
const base: Omit<SlotRoutingInput, "source" | "chosenPackageId" | "inProgress"> = {
  packageOfVersion,
  activePackageIds: new Set(["en", "hi"]),
  retakeIds: new Set(),
};
const att = (id: string, version: string, activity: string): SlotAttempt => ({
  id, course_version_id: version, started_at: "2026-10-01T09:00Z", last_activity_at: activity,
});

console.log("\n(0) own-slot resume wins");
eq("own in-progress on a retired version of the chosen package → own-slot, nothing abandoned",
  decideSlotRouting({ ...base, source: "explicit", chosenPackageId: "en", inProgress: [att("a", "en-v1", "2026-10-02"), att("b", "hi-v1", "2026-10-05"), att("c", "gu-v1", "2026-10-03")] }),
  { kind: "own-slot", abandon: [] });

console.log("\n(1) explicit ?lang= with live progress on another active slot");
eq("explicit → confirm-switch, nothing abandoned",
  decideSlotRouting({ ...base, source: "explicit", chosenPackageId: "en", inProgress: [att("b", "hi-v1", "2026-10-05")] }),
  { kind: "confirm-switch", abandon: [], otherAttemptId: "b" });
eq("explicit + a deactivated-slot attempt too → still confirm, nothing abandoned on a redirect",
  decideSlotRouting({ ...base, source: "explicit", chosenPackageId: "en", inProgress: [att("b", "hi-v1", "2026-10-05"), att("c", "gu-v1", "2026-10-03")] }),
  { kind: "confirm-switch", abandon: [], otherAttemptId: "b" });

console.log("\n(2) preference / single rule → cross-slot grandfather");
eq("preference → launch the other slot's attempt version",
  decideSlotRouting({ ...base, source: "preference", chosenPackageId: "en", inProgress: [att("b", "hi-v1", "2026-10-05")] }),
  { kind: "cross-slot", versionId: "hi-v1", packageId: "hi", attemptId: "b", abandon: [] });
eq("two other active-slot attempts → the most recently active one",
  decideSlotRouting({
    ...base,
    activePackageIds: new Set(["en", "hi", "gu"]),
    source: "preference",
    chosenPackageId: "en",
    inProgress: [att("b", "hi-v1", "2026-10-05"), att("c", "gu-v1", "2026-10-07")],
  }),
  { kind: "cross-slot", versionId: "gu-v1", packageId: "gu", attemptId: "c", abandon: [] });
eq("cross-slot also closes a deactivated-slot attempt (3)",
  decideSlotRouting({ ...base, source: "preference", chosenPackageId: "en", inProgress: [att("b", "hi-v1", "2026-10-05"), att("c", "gu-v1", "2026-10-03")] }),
  { kind: "cross-slot", versionId: "hi-v1", packageId: "hi", attemptId: "b", abandon: ["c"] });

console.log("\n(3) deactivated slot → abandoned, launch continues");
eq("single-active rule, attempt on the deactivated slot → continue + abandon it",
  decideSlotRouting({ ...base, activePackageIds: new Set(["en"]), source: "single", chosenPackageId: "en", inProgress: [att("c", "gu-v1", "2026-10-03")] }),
  { kind: "continue", abandon: ["c"] });
eq("explicit choice, only a deactivated-slot attempt → continue + abandon it",
  decideSlotRouting({ ...base, source: "explicit", chosenPackageId: "en", inProgress: [att("c", "gu-v1", "2026-10-03")] }),
  { kind: "continue", abandon: ["c"] });
eq("no in-progress attempts → continue, nothing abandoned",
  decideSlotRouting({ ...base, source: "preference", chosenPackageId: "en", inProgress: [] }),
  { kind: "continue", abandon: [] });

console.log("\n(4) grant retakes are never abandoned or rerouted");
eq("retake on a deactivated slot → not abandoned",
  decideSlotRouting({ ...base, retakeIds: new Set(["c"]), source: "single", chosenPackageId: "en", inProgress: [att("c", "gu-v1", "2026-10-03")] }),
  { kind: "continue", abandon: [] });
eq("retake on another active slot → no redirect (explicit)",
  decideSlotRouting({ ...base, retakeIds: new Set(["b"]), source: "explicit", chosenPackageId: "en", inProgress: [att("b", "hi-v1", "2026-10-05")] }),
  { kind: "continue", abandon: [] });
eq("retake on another active slot → no cross-slot launch (preference)",
  decideSlotRouting({ ...base, retakeIds: new Set(["b"]), source: "preference", chosenPackageId: "en", inProgress: [att("b", "hi-v1", "2026-10-05")] }),
  { kind: "continue", abandon: [] });
eq("a retake on the chosen slot is an own-slot resume",
  decideSlotRouting({ ...base, retakeIds: new Set(["a"]), source: "preference", chosenPackageId: "en", inProgress: [att("a", "en-v2", "2026-10-05"), att("c", "gu-v1", "2026-10-03")] }),
  { kind: "own-slot", abandon: [] });

console.log("\nunknown versions are ignored");
eq("attempt on a version outside the course map → ignored",
  decideSlotRouting({ ...base, source: "preference", chosenPackageId: "en", inProgress: [att("x", "other-v1", "2026-10-05")] }),
  { kind: "continue", abandon: [] });

console.log(`\n==== slot routing: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
