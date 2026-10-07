/**
 * Unit test for the role helpers in lib/auth/permissions.ts — in particular
 * where "Switch to Admin View" lands per role (a Data Analyst must never be
 * sent to a canManage-only page, which bounces them to the learner dashboard).
 *
 * Run:  npx tsx tests/unit/permissions.test.ts
 */
import { adminHome, canManage, canViewReports, roleLabel } from "../../lib/auth/permissions";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\nrole helpers");
eq("canManage: super_owner + admin only", ["super_owner", "admin", "data_analyst", "user"].map((r) => canManage(r as never)), [true, true, false, false]);
eq("canViewReports: super_owner + admin + data_analyst", ["super_owner", "admin", "data_analyst", "user"].map((r) => canViewReports(r as never)), [true, true, true, false]);
eq("labels", ["super_owner", "admin", "data_analyst", "user"].map((r) => roleLabel(r as never)), ["Super Owner", "Administrator", "Data Analyst", "User"]);

console.log("\nadminHome: where the profile menu's admin link lands");
eq("admin → Attention Center, 'Switch to Admin View'", adminHome("admin"), { path: "attention", label: "Switch to Admin View", hint: "Manage workspace" });
eq("super_owner → Attention Center", adminHome("super_owner")?.path, "attention");
eq("data_analyst → Learner Analytics (never a canManage-only page), 'Switch to Insights'", adminHome("data_analyst"), { path: "analytics", label: "Switch to Insights", hint: "Analytics and reports" });
eq("user → no admin link", adminHome("user"), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
