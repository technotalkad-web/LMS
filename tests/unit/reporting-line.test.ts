/**
 * Unit test for the explicit reporting line (Phase 0b, product decisions
 * 2/3/7/9): scope = exactly the people who list the viewer as L1/L2/L3;
 * level = the highest level anyone assigns; integrity (block vs warn);
 * backfill suggestions from the L1 chain; save-time validation.
 *
 * Run:  npx tsx tests/unit/reporting-line.test.ts
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import {
  checkIntegrity,
  resolveManagerScope,
  suggestBackfill,
  validateManagerAssignment,
  upsertSnapshot,
  type HierarchyMember,
} from "../../lib/org/reporting-line";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const m = (
  id: string,
  l1: string | null = null,
  l2: string | null = null,
  l3: string | null = null,
  status = "active"
): HierarchyMember => ({ user_id: id, status, line_manager_id: l1, indirect_manager_id: l2, l3_manager_id: l3 });
const sorted = (s: Set<string>) => [...s].sort();

// ceo ← vp ← mgr ← {e1, e2}; e3 reports to mgr2 (who reports to vp).
const org = [
  m("ceo"),
  m("vp", "ceo"),
  m("mgr", "vp", "ceo"),
  m("mgr2", "vp", "ceo"),
  m("e1", "mgr", "vp", "ceo"),
  m("e2", "mgr", "vp", "ceo"),
  m("e3", "mgr2", "vp", "ceo"),
  m("gone", "mgr", "vp", "ceo", "inactive"),
];

console.log("\nscope (decision 3: only the people who list you)");
{
  const s = resolveManagerScope(org, "mgr");
  eq("L1 sees the direct team only", [s.level, sorted(s.all)], [1, ["e1", "e2"]]);
  eq("inactive reports are out of scope", s.all.has("gone"), false);
}
{
  const s = resolveManagerScope(org, "vp");
  eq("L2 sees L1s + their teams", [s.level, sorted(s.all)], [2, ["e1", "e2", "e3", "mgr", "mgr2"]]);
  eq("L2 grouping by L1", [...s.teamsByL1.entries()].map(([k, v]) => [k, sorted(v)]).sort(), [
    ["mgr", ["e1", "e2"]],
    ["mgr2", ["e3"]],
    ["vp", ["mgr", "mgr2"]],
  ]);
}
{
  const s = resolveManagerScope(org, "ceo");
  eq("L3 sees L2s, L1s and teams", [s.level, sorted(s.all)], [3, ["e1", "e2", "e3", "mgr", "mgr2", "vp"]]);
  eq("L3 grouping: L2 → L1s", [...s.l1sByL2.entries()].map(([k, v]) => [k, sorted(v)]).sort(), [
    ["ceo", ["vp"]],
    ["vp", ["mgr", "mgr2"]],
  ]);
}
{
  eq("non-manager has level 0 and sees nobody", resolveManagerScope(org, "e1").level, 0);
  eq("viewer never sees themselves", resolveManagerScope([m("x", "x")], "x").all.size, 0);
  eq("no inference: blank L2 → not visible at L2", resolveManagerScope([m("boss"), m("a", "boss"), m("b", "a")], "boss").all.has("b"), false);
}
{
  // Grouping never names anyone outside the scope: e1's L1 "outsider" does
  // not list vp, so e1 is ungrouped rather than keyed under outsider; an
  // inactive L1 likewise.
  const s = resolveManagerScope([m("vp"), m("outsider"), m("e1", "outsider", "vp"), m("gone", "vp", null, null, "inactive"), m("e2", "gone", "vp")], "vp");
  eq("out-of-scope / inactive L1 → ungrouped, not a key", [sorted(s.all), [...s.teamsByL1.keys()], [...s.l1sByL2.keys()], sorted(s.ungrouped)], [["e1", "e2"], [], [], ["e1", "e2"]]);
  const keysOk = (sc: ReturnType<typeof resolveManagerScope>) =>
    [...sc.teamsByL1.keys(), ...sc.l1sByL2.keys(), ...[...sc.l1sByL2.values()].flatMap((v) => [...v])].every((id) => sc.all.has(id) || id === sc.viewerId);
  eq("every grouping key/value is in scope ∪ viewer (ceo view)", keysOk(resolveManagerScope(org, "ceo")), true);
}

console.log("\nintegrity (decision 9: block serious, warn minor)");
{
  const issues = checkIntegrity(org);
  eq("clean org has no blocking issues", issues.filter((i) => i.severity === "block").length, 0);
  eq("ceo/vp/mgr gaps are warnings only", issues.every((i) => i.severity === "warn" && i.code.startsWith("missing_")), true);
}
{
  const bad = [m("a", "a"), m("b", "c"), m("c", "b"), m("d", "z"), m("e", "gone"), m("gone", null, null, null, "inactive")];
  const codes = checkIntegrity(bad).filter((i) => i.severity === "block").map((i) => `${i.user_id}:${i.code}`).sort();
  eq("self-reference, cycle, missing + inactive manager all block", codes, [
    "a:self_reference", "b:cycle", "c:cycle", "d:manager_missing", "e:manager_inactive",
  ]);
}
{
  // Cycles through L2/L3 edges are cycles too (decision 3: every edge is a
  // visibility edge): mgr ← e1 (L1) while mgr.L3 = e1; a pure L2 loop; a
  // three-hop mixed loop.
  const viaL3 = [m("mgr", null, null, "e1"), m("e1", "mgr")];
  eq("L3 → direct report closes a cycle (both flagged, via the closing level)",
    checkIntegrity(viaL3).filter((i) => i.code === "cycle").map((i) => `${i.user_id}:L${i.level}`).sort(), ["e1:L1", "mgr:L3"]);
  const l2Loop = [m("a", null, "b"), m("b", null, "a")];
  eq("pure L2 loop is a cycle", checkIntegrity(l2Loop).filter((i) => i.code === "cycle").map((i) => i.user_id).sort(), ["a", "b"]);
  const mixed = [m("a", "b"), m("b", null, "c"), m("c", null, null, "a"), m("d", "a")];
  eq("mixed-edge 3-hop loop flags exactly its members", checkIntegrity(mixed).filter((i) => i.code === "cycle").map((i) => i.user_id).sort(), ["a", "b", "c"]);
  eq("a self-reference is not double-reported as a cycle", checkIntegrity([m("x", "x")]).filter((i) => i.code === "cycle").length, 0);
}
{
  const mismatch = [m("ceo"), m("vp", "ceo"), m("other"), m("mgr", "vp", "other"), m("e", "mgr", "vp", "other")];
  const codes = checkIntegrity(mismatch).filter((i) => i.code.startsWith("chain_")).map((i) => `${i.user_id}:${i.code}:${i.severity}`).sort();
  eq("chain mismatch warns (L2 ≠ L1's L1; L3 ≠ L2's L1)", codes, ["e:chain_mismatch_l3:warn", "mgr:chain_mismatch_l2:warn"]);
}

console.log("\nbackfill (decision 7: suggest from the chain, admin confirms)");
{
  const gaps = [m("ceo"), m("vp", "ceo"), m("mgr", "vp"), m("e", "mgr")];
  const s = suggestBackfill(gaps).map((x) => `${x.user_id}:L${x.level}=${x.suggested}`).sort();
  eq("L2 = L1's L1, L3 = (suggested) L2's L1", s, ["e:L2=vp", "e:L3=ceo", "mgr:L2=ceo"]);
}
{
  const s = suggestBackfill([m("ceo"), m("vp", "ceo", null, null, "inactive"), m("mgr", "vp"), m("e", "mgr")]);
  eq("inactive link breaks the suggestion chain", s.length, 0);
}
{
  const s = suggestBackfill([m("a", "b"), m("b", "a")]);
  eq("never suggests the person themselves", s.length, 0);
}

console.log("\nsave-time validation (every write path)");
{
  const v = validateManagerAssignment(org, "e1", { line_manager_id: "e1" });
  eq("self-reference blocks", v.errors.map((e) => e.level), [1]);
}
{
  const v = validateManagerAssignment(org, "vp", { line_manager_id: "e1" });
  eq("cycle blocks (e1 reports up to vp)", v.errors.length === 1 && /cycle/.test(v.errors[0].message), true);
  const v3 = validateManagerAssignment(org, "mgr", { l3_manager_id: "e1" });
  eq("L3 = own direct report blocks (cycle through L3)", v3.errors.map((e) => e.level), [3]);
  const v2 = validateManagerAssignment([m("a"), m("b", null, "a")], "a", { indirect_manager_id: "b" });
  eq("L2 loop blocks", v2.errors.map((e) => e.level), [2]);
  const top = validateManagerAssignment([m("ceo"), m("e", "ceo")], "ceo", { l3_manager_id: "e" });
  eq("top-level manager (blank L1) still gets the block", top.errors.map((e) => e.level), [3]);
  eq("untouched fields are not re-walked", validateManagerAssignment([m("a", "b"), m("b", "a")], "a", { l3_manager_id: "" }).errors.length, 0);
}
{
  const v = validateManagerAssignment(org, "e1", { indirect_manager_id: "gone", l3_manager_id: "nobody" });
  eq("inactive + non-member block, per level", v.errors.map((e) => e.level), [2, 3]);
}
{
  const v = validateManagerAssignment(org, "e1", { indirect_manager_id: "mgr2" });
  // mgr2's L1 is vp (≠ e1's stored L3 "ceo"? no — vp), so L3 mismatches too.
  eq("chain mismatch only warns (L2 vs L1's L1, L3 vs new L2's L1)", [v.errors.length, v.warnings.map((w) => w.level)], [0, [2, 3]]);
}
{
  const v = validateManagerAssignment(org, null, { line_manager_id: "mgr", indirect_manager_id: "vp", l3_manager_id: "ceo" });
  eq("new account with a clean chain passes", [v.errors.length, v.warnings.length], [0, 0]);
  eq("undefined fields are not checked; empty string clears", validateManagerAssignment(org, "e1", { l3_manager_id: "" }).errors.length, 0);
}
{
  const snap = [m("a")];
  upsertSnapshot(snap, m("b", "a"));
  upsertSnapshot(snap, m("a", null, null, null, "inactive"));
  eq("snapshot upsert replaces in place", snap.map((x) => `${x.user_id}:${x.status}`), ["a:inactive", "b:active"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
