/**
 * Unit test for the per-version restart rules (ADR 0008 decision A, steps
 * 1–4): the reason bound, the 409 refusals, grant-retake exclusion and the
 * learner/staff role classes.
 *
 * Run:  npx tsx tests/unit/version-restart.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import {
  RESTART_REASON_MAX,
  byRoleClass,
  isStaffRole,
  memberKey,
  parseDryRun,
  parseRestartReason,
  planRestart,
  restartRefusal,
} from "../../lib/attempts/restart";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("\ndry_run (step 1)");
eq("absent → real run", parseDryRun(undefined), { ok: true, dryRun: false });
eq("true → dry run", parseDryRun(true), { ok: true, dryRun: true });
eq("false → real run", parseDryRun(false), { ok: true, dryRun: false });
for (const bad of ["true", "false", 1, 0, null, {}, []]) {
  eq(`${JSON.stringify(bad)} → refused, never a real run`, parseDryRun(bad).ok, false);
}

console.log("\nreason (step 1)");
eq("missing → refused", parseRestartReason(undefined).ok, false);
eq("empty → refused", parseRestartReason("").ok, false);
eq("blank → refused", parseRestartReason("   \n ").ok, false);
eq("not a string → refused", parseRestartReason(42).ok, false);
eq("trimmed", parseRestartReason("  wrong module on v1  "), { ok: true, reason: "wrong module on v1" });
eq("500 chars → ok", parseRestartReason("x".repeat(RESTART_REASON_MAX)).ok, true);
eq("501 chars → refused", parseRestartReason("x".repeat(RESTART_REASON_MAX + 1)).ok, false);
eq("500 chars after trim → ok", parseRestartReason(`  ${"x".repeat(RESTART_REASON_MAX)}  `).ok, true);

console.log("\nrefusals (step 2)");
const V = "v1";
eq("non-current ready version of an active package → allowed",
  restartRefusal({ versionId: V, uploadStatus: "ready", packageCurrentVersionId: "v2", packageActive: true }), null);
eq("pre-0077 (no upload_status) → allowed",
  restartRefusal({ versionId: V, uploadStatus: undefined, packageCurrentVersionId: "v2", packageActive: true }), null);
eq("current version of an active package → 409 version_is_current",
  restartRefusal({ versionId: V, uploadStatus: "ready", packageCurrentVersionId: V, packageActive: true })?.error, "version_is_current");
eq("current version of an inactive package → allowed (D5b case)",
  restartRefusal({ versionId: V, uploadStatus: "ready", packageCurrentVersionId: V, packageActive: false }), null);
eq("uploading → 409 version_not_ready",
  restartRefusal({ versionId: V, uploadStatus: "uploading", packageCurrentVersionId: "v2", packageActive: true })?.error, "version_not_ready");
eq("failed → 409 version_not_ready (even on an inactive package)",
  restartRefusal({ versionId: V, uploadStatus: "failed", packageCurrentVersionId: V, packageActive: false })?.error, "version_not_ready");
eq("refusals are 409",
  restartRefusal({ versionId: V, uploadStatus: "ready", packageCurrentVersionId: V, packageActive: true })?.status, 409);

console.log("\nrole classes (step 4; ADR 0003 step 10)");
eq("super_owner is staff", isStaffRole("super_owner"), true);
eq("admin is staff", isStaffRole("admin"), true);
eq("data_analyst is staff", isStaffRole("data_analyst"), true);
eq("user is a learner", isStaffRole("user"), false);
eq("member (legacy) is a learner", isStaffRole("member"), false);
eq("owner (legacy) is a learner, as in the 0098 guard", isStaffRole("owner"), false);
eq("no membership is a learner", isStaffRole(null), false);

console.log("\nselection (step 3)");
const O = "org-1";
const att = (id: string, user: string, org = O) => ({ id, user_id: user, organization_id: org });
const staff = new Set([memberKey(O, "u-admin")]);
{
  const p = planRestart(
    [att("a3", "u-learner3"), att("a1", "u-learner1"), att("a2", "u-admin"), att("a4", "u-retake"), att("a1", "u-learner1")],
    new Set(["a4"]),
    staff
  );
  eq("grant retake excluded, others selected, sorted, de-duplicated", p.attemptIds, ["a1", "a2", "a3"]);
  eq("excluded grant retake ids", p.excludedGrantRetakeIds, ["a4"]);
  eq("by role", p.byRole, { learner: 2, staff: 1 });
  eq("selected rows carry user + org", p.selected.map((a) => a.user_id), ["u-learner1", "u-admin", "u-learner3"]);
}
{
  const p = planRestart([], new Set(["zzz"]), staff);
  eq("nothing in progress → empty plan", [p.attemptIds, p.excludedGrantRetakeIds, p.byRole], [[], [], { learner: 0, staff: 0 }]);
}
{
  const p = planRestart([att("a1", "u1")], new Set(["a1"]), staff);
  eq("only a grant retake → nothing selected", [p.attemptIds, p.excludedGrantRetakeIds], [[], ["a1"]]);
}
eq("staff judged in the attempt's organisation",
  byRoleClass([att("a1", "u-admin", "org-2")], staff), { learner: 1, staff: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
