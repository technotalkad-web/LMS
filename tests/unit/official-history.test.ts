/**
 * Unit tests for lib/scoring/official-history.ts (ADR 0014 steps 6 and 7,
 * "The chain, stated once"): the chain cases,
 * reissued_from followed transitively, the request-time result and the
 * running retake as the open end. No PR 1a surface renders it; it is the
 * TypeScript twin of consume_grant's chain rule (0103).
 *
 * Run:  npx tsx tests/unit/official-history.test.ts   (or npm run test:unit)
 */
import {
  currentOfficial,
  officialHistory,
  officialResultAt,
  officialRetakeState,
  type HistoryAttempt,
  type HistoryGrant,
} from "../../lib/scoring/official-history";
import { computeScoring, DEFAULT_POLICY } from "../../lib/scoring/policy";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const att = (id: string, day: number, ss: "passed" | "failed" | "unknown", extra: Partial<HistoryAttempt> = {}): HistoryAttempt => ({
  id,
  started_at: `2026-10-${String(day).padStart(2, "0")}T09:00:00Z`,
  completed_at: `2026-10-${String(day).padStart(2, "0")}T09:30:00Z`,
  completion_status: "completed",
  success_status: ss,
  score: ss === "passed" ? 0.9 : 0.4,
  status: ss === "unknown" ? "completed" : ss,
  is_revision: false,
  ...extra,
});
const grant = (id: string, usedAttemptId: string | null, decidedDay: number, extra: Partial<HistoryGrant> = {}): HistoryGrant => ({
  id,
  used_attempt_id: usedAttemptId,
  created_at: `2026-10-${String(decidedDay).padStart(2, "0")}T08:00:00Z`,
  decided_by: `admin-${id}`,
  decided_at: `2026-10-${String(decidedDay).padStart(2, "0")}T08:30:00Z`,
  decision_note: `note ${id}`,
  reason: `reason ${id}`,
  ...extra,
});

console.log("\nthe chain (official #1, then each completed granted retake)");
{
  const a1 = att("a1", 1, "failed");
  const r1 = att("r1", 5, "passed");
  const h = officialHistory([r1, a1], [grant("g1", "r1", 3)]);
  eq("official #1 then the retake, oldest first", h.entries.map((e) => [e.attemptId, e.kind]), [["a1", "first"], ["r1", "retake"]]);
  eq("the current official result is the retake", currentOfficial(h)?.attemptId, "r1");
  eq("each entry but the last is superseded by the next", h.entries.map((e) => e.supersededBy), ["r1", null]);
  eq("the retake carries who, when and why", h.entries[1].grant, {
    grantId: "g1", originalGrantId: "g1", decidedBy: "admin-g1", decidedAt: "2026-10-03T08:30:00Z", decisionNote: "note g1", reason: "reason g1", reissuedAt: null,
  });
  eq("status and score per entry", h.entries.map((e) => [e.status, e.score]), [["failed", 0.4], ["passed", 0.9]]);
  eq("no running retake", h.running, null);
  const s = computeScoring([a1, r1], DEFAULT_POLICY, new Set(["r1"]));
  eq("agrees with computeScoring's official attempt", s.officialAttempt?.id, currentOfficial(h)?.attemptId);
}
{
  const h = officialHistory([att("a1", 1, "passed"), att("p2", 2, "failed"), att("p3", 3, "passed")], []);
  eq("legacy completed revision runs (no grant) are not in the chain", h.entries.map((e) => e.attemptId), ["a1"]);
}
{
  const rows = [
    att("ab", 1, "passed", { status: "abandoned" }), // abandoned-but-completed: never official
    att("rv", 2, "passed", { is_revision: true }), // a revision visit's row: never
    att("a1", 3, "failed"),
  ];
  eq("abandoned and revision rows never enter the chain", officialHistory(rows, []).entries.map((e) => e.attemptId), ["a1"]);
}
{
  const h = officialHistory([att("r1", 5, "passed"), att("a1", 1, "failed"), att("r2", 8, "failed")], [grant("g1", "r1", 3), grant("g2", "r2", 6)]);
  eq("two retakes in completion order; a later failed retake replaces a pass", h.entries.map((e) => e.attemptId), ["a1", "r1", "r2"]);
  eq("…the current official result is the failed retake", [currentOfficial(h)?.attemptId, currentOfficial(h)?.status], ["r2", "failed"]);
}
{
  const h = officialHistory([att("a1", 1, "failed"), att("r1", 5, "passed")], [grant("g1", "r1", 3, { status: "rejected" })]);
  eq("only an APPROVED grant links a retake (a declined row's attempt is not one)", h.entries.map((e) => e.attemptId), ["a1"]);
}
{
  eq("no attempt → no entry, no current result", [officialHistory([], []).entries, currentOfficial(officialHistory([], []))], [[], null]);
  const ip = { ...att("a1", 1, "unknown"), completed_at: null, completion_status: "in_progress", success_status: "unknown", status: "in_progress" };
  eq("an official attempt still in progress → no entry yet", officialHistory([ip], []).entries.length, 0);
}

console.log("\nthe running retake is the chain's open end");
{
  const live = { ...att("r2", 9, "unknown"), completed_at: null, completion_status: "in_progress", success_status: "unknown", status: "in_progress" };
  const h = officialHistory([att("a1", 1, "passed"), live], [grant("g2", "r2", 8)]);
  eq("running = the live granted retake", h.running?.attemptId, "r2");
  eq("…the current official result stays attempt #1 until it finishes", currentOfficial(h)?.attemptId, "a1");
  const reset = { ...live, status: "abandoned" };
  eq("a retake reset by a forced restart is not running", officialHistory([att("a1", 1, "passed"), reset], [grant("g2", "r2", 8)]).running, null);
}

console.log("\nreissued_from is followed transitively to the original grant");
{
  const rows = [att("a1", 1, "failed"), att("r3", 12, "passed")];
  const g1 = grant("g1", "r1", 3); // original approval; its retake r1 was reset
  const g2 = grant("g2", "r2", 6, { reissued_from: "g1", decision_note: "re-issued by forced restart of version 2" });
  const g3 = grant("g3", "r3", 10, { reissued_from: "g2", decision_note: "re-issued by forced restart of version 3" });
  const h = officialHistory(rows, [g1, g2, g3]);
  const info = h.entries[1].grant;
  eq("the retake opened through two re-issues names the original grant", info?.originalGrantId, "g1");
  eq("…who, when and why come from the original", [info?.decidedBy, info?.decidedAt, info?.decisionNote, info?.reason], ["admin-g1", "2026-10-03T08:30:00Z", "note g1", "reason g1"]);
  eq("…and the re-issue date is the re-issued grant's", info?.reissuedAt, "2026-10-10T08:30:00Z");
  const cyclic = officialHistory(rows, [grant("g3", "r3", 10, { reissued_from: "g4" }), grant("g4", null, 9, { reissued_from: "g3" })]);
  eq("a link cycle stops instead of looping", cyclic.entries[1].grant?.originalGrantId, "g4");
  eq("a link to an unknown grant stops at the last known one", officialHistory(rows, [grant("g3", "r3", 10, { reissued_from: "gone" })]).entries[1].grant?.originalGrantId, "g3");
  eq("a grant without reissued_from (pre-0103 read) follows no link", officialHistory(rows, [grant("g3", "r3", 10)]).entries[1].grant?.reissuedAt, null);
}

console.log("\nthe request-time result (a decided request: the chain before its created_at)");
{
  const h = officialHistory([att("a1", 1, "failed"), att("r1", 5, "passed")], [grant("g1", "r1", 3)]);
  eq("before any official attempt → null", officialResultAt(h, "2026-09-30T00:00:00Z"), null);
  eq("between #1 and the retake → #1 (failed)", [officialResultAt(h, "2026-10-03T00:00:00Z")?.attemptId, officialResultAt(h, "2026-10-03T00:00:00Z")?.status], ["a1", "failed"]);
  eq("after the retake → the retake (passed)", officialResultAt(h, "2026-10-20T00:00:00Z")?.attemptId, "r1");
  eq("exactly at a completion → the previous entry (completed BEFORE T)", officialResultAt(h, "2026-10-05T09:30:00Z")?.attemptId, "a1");
}

console.log("\nofficialRetakeState: the one reader of the retake state and the previous result");
{
  const none = officialRetakeState(officialHistory([att("a1", 1, "passed")], []));
  eq("none: no retake → state none, the current result, no previous, no grant",
    [none.state, none.current?.attemptId, none.previous, none.grant], ["none", "a1", null, null]);
  eq("…and before any official attempt", officialRetakeState(officialHistory([], [])), { state: "none", current: null, previous: null, grant: null });

  const live = { ...att("r2", 9, "unknown"), completed_at: null, completion_status: "in_progress", success_status: "unknown", status: "in_progress" };
  const running = officialRetakeState(officialHistory([att("a1", 1, "passed"), live], [grant("g2", "r2", 8)]));
  eq("running: state in_progress; current = the standing result; no previous; the running retake's grant",
    [running.state, running.current?.attemptId, running.previous, running.grant?.grantId], ["in_progress", "a1", null, "g2"]);

  const done = officialRetakeState(officialHistory([att("a1", 1, "passed"), att("r1", 5, "failed")], [grant("g1", "r1", 3)]));
  eq("completed: state completed; current = the retake; previous = the entry it superseded",
    [done.state, done.current?.attemptId, done.current?.status, done.previous?.attemptId, done.previous?.status, done.previous?.score],
    ["completed", "r1", "failed", "a1", "passed", 0.9]);
  eq("…its grant", done.grant?.grantId, "g1");
  const two = officialRetakeState(
    officialHistory([att("a1", 1, "failed"), att("r1", 5, "passed"), att("r2", 8, "failed")], [grant("g1", "r1", 3), grant("g2", "r2", 6)])
  );
  eq("two retakes: previous is the entry the current superseded (the first retake), not official #1", [two.current?.attemptId, two.previous?.attemptId], ["r2", "r1"]);

  const g1 = grant("g1", "r1", 3);
  const g2 = grant("g2", "r2", 6, { reissued_from: "g1", decision_note: "re-issued by forced restart of version 2" });
  const resetRow = { ...att("r1", 4, "unknown"), status: "abandoned", completed_at: null, completion_status: "in_progress" };
  const reissued = officialRetakeState(officialHistory([att("a1", 1, "failed"), resetRow, att("r2", 7, "passed")], [g1, g2]));
  eq("a re-issued grant's retake: the grant info is the original's through reissued_from",
    [reissued.state, reissued.grant?.grantId, reissued.grant?.originalGrantId, reissued.grant?.decisionNote, reissued.grant?.reissuedAt],
    ["completed", "g2", "g1", "note g1", "2026-10-06T08:30:00Z"]);
}

console.log("\nreset: a granted retake abandoned by a forced restart (ADR 0014:185)");
{
  const reset = { ...att("r1", 4, "unknown"), status: "abandoned", completed_at: null, completion_status: "in_progress", success_status: "unknown" };
  const g1 = grant("g1", "r1", 3);
  const h = officialHistory([att("a1", 1, "passed"), reset], [g1]);
  eq("an abandoned grant-linked row is in reset, with the superseded grant's who, when and why", h.reset, [
    {
      attemptId: "r1",
      startedAt: "2026-10-04T09:00:00Z",
      grant: { grantId: "g1", originalGrantId: "g1", decidedBy: "admin-g1", decidedAt: "2026-10-03T08:30:00Z", decisionNote: "note g1", reason: "reason g1", reissuedAt: null },
    },
  ]);
  eq("…and in neither entries nor running", [h.entries.map((e) => e.attemptId), h.running], [["a1"], null]);
  eq("…the retake state stays none (no live or completed retake)", officialRetakeState(h).state, "none");
  eq("an abandoned row no grant links appears nowhere", officialHistory([att("a1", 1, "passed"), { ...reset, id: "x1" }], [g1]).reset, []);
  eq("an abandoned revision row appears nowhere", officialHistory([att("a1", 1, "passed"), { ...reset, is_revision: true }], [g1]).reset, []);
  eq("a declined grant links nothing", officialHistory([att("a1", 1, "passed"), reset], [grant("g1", "r1", 3, { status: "rejected" })]).reset, []);

  // A reset, then the re-issued grant and its completed retake.
  const g2 = grant("g2", "r2", 6, { reissued_from: "g1", decision_note: "re-issued by forced restart of version 2" });
  const h2 = officialHistory([att("a1", 1, "passed"), reset, att("r2", 8, "failed")], [g1, g2]);
  eq("a reset followed by a re-issued grant and a completed retake → one reset, one retake entry",
    [h2.reset.map((r) => r.attemptId), h2.entries.filter((e) => e.kind === "retake").map((e) => e.attemptId)], [["r1"], ["r2"]]);
  eq("…the two are joined by originalGrantId", [h2.reset[0]?.grant.originalGrantId, h2.entries[1]?.grant?.originalGrantId], ["g1", "g1"]);
  eq("…the retake state is completed, the pass is the previous result", [officialRetakeState(h2).state, officialRetakeState(h2).previous?.attemptId], ["completed", "a1"]);
  const order = officialHistory([att("a1", 1, "passed"), { ...reset, id: "r3", started_at: "2026-10-09T09:00:00Z" }, reset], [g1, grant("g3", "r3", 8)]);
  eq("several resets are listed in the ordering key's order", order.reset.map((r) => r.attemptId), ["r1", "r3"]);
}

// ADR 0024 step 49: from 0107 the course learners table and its CSV read the
// Individual context's attempts only, while their grant read still returns
// every grant of the (learner, course). A grant consumed before 0107 can name
// a retake that old consume_grant tagged with a path or journey (note N9), so
// the retake is not among the rows. It belongs to its own context's chain;
// the Individual chain leaves it out without an error.
console.log("\na used grant whose retake row is not among the rows (another context's, ADR 0024 step 49)");
{
  const a1 = att("a1", 1, "failed");
  const g1 = grant("g1", "p1", 3);
  const h = officialHistory([a1], [g1]);
  eq("the chain is the rows' own: official #1 only, no retake entry, nothing running or reset",
    [h.entries.map((e) => [e.attemptId, e.kind]), h.running, h.reset], [[["a1", "first"]], null, []]);
  eq("…the retake state is none and the current result is the Individual one",
    [officialRetakeState(h).state, officialRetakeState(h).current?.attemptId, officialRetakeState(h).current?.status], ["none", "a1", "failed"]);
  const s = computeScoring([a1], DEFAULT_POLICY, new Set(["p1"]));
  eq("computeScoring with that retake id: the official attempt is a1, failed (an id not among the rows changes nothing)",
    [s.officialAttempt?.id, s.officialStatus, s.scoredAttempts], ["a1", "failed", 1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
