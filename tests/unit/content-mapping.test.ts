/**
 * Unit test for Phase 4b rules (0096): department ⊂ vertical, content scope
 * validation, "does the mapping cover this target" (decision 20), and the
 * system scope-group keys (decision 18). No DB.
 *
 * Run:  npx tsx tests/unit/content-mapping.test.ts
 */
import { checkDepartmentInVertical, checkGovernedField, type OrgGovernance } from "../../lib/org/field-options";
import { checkScopes, describeScopes, scopeLabel, scopesCover, COMMON_VERTICAL } from "../../lib/content/scopes";
import { checkScopeTarget, scopeGroupKey, scopeGroupName } from "../../lib/org/scope-groups";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const gov = (verticals: string[], depts: Record<string, string[]>): OrgGovernance => {
  const options = new Map<OrgGovernance["options"] extends Map<infer K, unknown> ? K : never, Map<string, string>>();
  for (const f of ["designation", "node_id", "job_role", "city", "state", "business_vertical", "branch", "department"] as const) options.set(f, new Map());
  for (const v of verticals) options.get("business_vertical")!.set(v.toLowerCase(), v);
  const departmentsByVertical = new Map<string, Map<string, string>>();
  for (const [v, ds] of Object.entries(depts)) {
    departmentsByVertical.set(v.toLowerCase(), new Map(ds.map((d) => [d.toLowerCase(), d])));
    for (const d of ds) options.get("department")!.set(d.toLowerCase(), d);
  }
  return { options, requireManagers: false, departmentsByVertical };
};
const G = gov(["Retail", "Institutional", "Fulfillment"], { Retail: ["Home Loan Sales", "Collections"], Institutional: ["Home Loan Sales"] });

console.log("\ndepartment ⊂ vertical (decision 17)");
{
  eq("no department passes", checkDepartmentInVertical(G, "", "Retail"), { ok: true, canonical: null });
  eq("department under its vertical → canonical spelling", checkDepartmentInVertical(G, "home loan sales", "retail"), { ok: true, canonical: "Home Loan Sales" });
  eq("department under another vertical → refused", (checkDepartmentInVertical(G, "Collections", "Institutional") as { ok: boolean }).ok, false);
  eq("department without a vertical → refused", (checkDepartmentInVertical(G, "Collections", null) as { ok: boolean }).ok, false);
  eq("no department master values → free text passes", checkDepartmentInVertical(gov(["Retail"], {}), "Anything", "Retail"), { ok: true, canonical: "Anything" });
  eq("department is optional in the governed check", checkGovernedField(G, "department", ""), { ok: true, canonical: null });
  eq("unknown department fails the governed check", (checkGovernedField(G, "department", "Nope") as { ok: boolean }).ok, false);
}

console.log("\ncontent scopes (decision 16)");
{
  const ok = checkScopes(G, { common: true, pairs: [{ vertical: "retail", department: "home loan sales" }, { vertical: "Institutional" }, { vertical: "Retail", department: "Home Loan Sales" }] });
  eq("pairs canonicalised, deduped, common kept", ok, { ok: true, scopes: { common: true, pairs: [{ vertical: "Retail", department: "Home Loan Sales" }, { vertical: "Institutional", department: null }] } });
  eq("unknown vertical → error", (checkScopes(G, { pairs: [{ vertical: "Wholesale" }] }) as { ok: boolean }).ok, false);
  eq("department outside its vertical → error", (checkScopes(G, { pairs: [{ vertical: "Fulfillment", department: "Collections" }] }) as { ok: boolean }).ok, false);
  eq("'*' is not a vertical (use common)", (checkScopes(G, { pairs: [{ vertical: COMMON_VERTICAL }] }) as { ok: boolean }).ok, false);
  eq("empty mapping is valid (unmapped)", checkScopes(G, {}), { ok: true, scopes: { common: false, pairs: [] } });
  eq("labels", [scopeLabel({ vertical: "Retail", department: "Collections" }), scopeLabel({ vertical: "Retail", department: null }), describeScopes({ common: true, pairs: [] }), describeScopes({ common: false, pairs: [] })], ["Retail · Collections", "Retail (all)", "Common to all verticals", "Unmapped"]);
}

console.log("\nwarn, never block (decision 20)");
{
  const m = { common: false, pairs: [{ vertical: "Retail", department: "Home Loan Sales" }, { vertical: "Fulfillment", department: null }] };
  eq("exact pair covered", scopesCover(m, { vertical: "Retail", department: "Home Loan Sales" }), true);
  eq("other department of a mapped vertical → not covered", scopesCover(m, { vertical: "Retail", department: "Collections" }), false);
  eq("a whole-vertical target when only one department is mapped → covered (the vertical overlaps)", scopesCover(m, { vertical: "Retail", department: null }), true);
  eq("whole-vertical mapping covers any department", scopesCover(m, { vertical: "Fulfillment", department: "Ops" }), true);
  eq("unmapped vertical → not covered", scopesCover(m, { vertical: "Institutional", department: null }), false);
  eq("unmapped content never warns", scopesCover({ common: false, pairs: [] }, { vertical: "Institutional", department: null }), true);
  eq("common content never warns", scopesCover({ common: true, pairs: [] }, { vertical: "Institutional", department: "X" }), true);
}

console.log("\nsystem scope groups (decision 18)");
{
  eq("key + name for a vertical / department", [scopeGroupKey({ vertical: "Retail", department: "Home Loan Sales" }), scopeGroupName({ vertical: "Retail", department: "Home Loan Sales" })], ["scope:Retail|Home Loan Sales", "Retail · Home Loan Sales (everyone)"]);
  eq("key + name for a whole vertical", [scopeGroupKey({ vertical: "Retail", department: null }), scopeGroupName({ vertical: "Retail", department: null })], ["scope:Retail|", "Retail (everyone)"]);
  eq("target validated against master data (canonical)", checkScopeTarget(G, { vertical: "RETAIL", department: "collections" }), { ok: true, pair: { vertical: "Retail", department: "Collections" } });
  eq("target with a foreign department → error", (checkScopeTarget(G, { vertical: "Fulfillment", department: "Collections" }) as { ok: boolean }).ok, false);
  eq("target without a vertical → error", (checkScopeTarget(G, { department: "Collections" }) as { ok: boolean }).ok, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
