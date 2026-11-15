/**
 * Unit test for the per-version restart rules (ADR 0008 decision A, steps
 * 1–4): the reason bound, the 409 refusals, grant-retake exclusion and the
 * two classes of the dry run's by_role. Since ADR 0024 step 23 (P2-5 item 4)
 * a row is "staff" when it is a Preview (`context_kind = 'preview'`, read by
 * the route through the context filter) and "learner" otherwise, a staff
 * member's real attempt included; the member's role no longer decides. The
 * route's read itself is pinned at the end by a source scan.
 *
 * Run:  npx tsx tests/unit/version-restart.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import fs from "node:fs";
import path from "node:path";
import {
  RESTART_REASON_MAX,
  byRoleAnswer,
  byRoleClass,
  parseDryRun,
  parseRestartReason,
  planRestart,
  previewIdsOf,
  restartRefusal,
} from "../../lib/attempts/restart";
import * as restart from "../../lib/attempts/restart";

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

console.log("\nclasses by context (step 4; ADR 0024 step 23)");
// The route keeps the selected ids its context-filtered read answers (the
// rows whose context_kind is not 'preview'); every other selected id is a Preview.
eq("ids the filtered read did not keep are Previews", [...previewIdsOf(["a1", "a2", "a3"], ["a1", "a3"])], ["a2"]);
eq("a database without 0107 keeps every id: no preview split", [...previewIdsOf(["a1", "a2"], ["a1", "a2"])], []);
eq("an id kept but not selected adds nothing", [...previewIdsOf(["a1"], ["a1", "zz"])], []);
eq("nothing selected → no Preview", [...previewIdsOf([], ["a1"])], []);
eq("the role helpers are gone: no export decides by the member's role",
  ["STAFF_ROLES", "isStaffRole", "memberKey"].filter((n) => n in restart), []);

console.log("\nselection (step 3)");
const O = "org-1";
const att = (id: string, user: string, org = O) => ({ id, user_id: user, organization_id: org });
// a2 is the admin's Preview; a5 is the same admin's real attempt (a Start).
const previews = new Set(["a2"]);
{
  const p = planRestart(
    [att("a3", "u-learner3"), att("a1", "u-learner1"), att("a2", "u-admin"), att("a4", "u-retake"), att("a1", "u-learner1")],
    new Set(["a4"]),
    previews
  );
  eq("grant retake excluded, others selected, sorted, de-duplicated", p.attemptIds, ["a1", "a2", "a3"]);
  eq("excluded grant retake ids", p.excludedGrantRetakeIds, ["a4"]);
  eq("by role: the Preview is staff, the rest learners", p.byRole, { learner: 2, staff: 1 });
  eq("selected rows carry user + org", p.selected.map((a) => a.user_id), ["u-learner1", "u-admin", "u-learner3"]);
}
{
  const p = planRestart([att("a2", "u-admin"), att("a5", "u-admin")], new Set(), previews);
  eq("a staff member's real attempt is a learner's; only their Preview is staff", p.byRole, { learner: 1, staff: 1 });
}
{
  const p = planRestart([att("a2", "u-admin"), att("a5", "u-admin")], new Set(), previewIdsOf(["a2", "a5"], ["a2", "a5"]));
  eq("without 0107 (every id kept) the admin's rows are both learners'", p.byRole, { learner: 2, staff: 0 });
}
{
  const p = planRestart([], new Set(["zzz"]), previews);
  eq("nothing in progress → empty plan", [p.attemptIds, p.excludedGrantRetakeIds, p.byRole], [[], [], { learner: 0, staff: 0 }]);
}
{
  const p = planRestart([att("a1", "u1")], new Set(["a1"]), previews);
  eq("only a grant retake → nothing selected", [p.attemptIds, p.excludedGrantRetakeIds], [[], ["a1"]]);
}
eq("a Preview is told by its id, whatever its organisation or user",
  byRoleClass([att("a2", "u-learner", "org-2"), att("a9", "u-admin")], previews), { learner: 1, staff: 1 });

// The answer's by_role (P2-5 review, reads F2): without 0107 no row can be
// told a Preview, so staff is null ("previews not counted"), never a 0 that
// reads as "no previews"; the keys keep their names (A23).
eq("with 0107 (the filter applied): the counts as they are", byRoleAnswer({ learner: 2, staff: 1 }, true), { learner: 2, staff: 1 });
eq("no read was needed (nothing selected): the counts as they are", byRoleAnswer({ learner: 0, staff: 0 }, null), { learner: 0, staff: 0 });
eq("without 0107: staff null, learner every row", byRoleAnswer({ learner: 3, staff: 0 }, false), { learner: 3, staff: null });
eq("…the same keys, nothing else", Object.keys(byRoleAnswer({ learner: 3, staff: 0 }, false)), ["learner", "staff"]);

console.log("\nthe route's read (source scan)");
{
  const ROUTE = "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart/route.ts";
  const src = fs.readFileSync(path.join(__dirname, "../..", ROUTE), "utf8");
  eq("no membership read and no role test", [src.includes('from("organization_members")'), /isStaffRole|memberKey|\.role\b/.test(src)], [false, false]);
  eq("one decision for every chunk, declared once, fresh", (src.match(/const previews: ContextFilterState = \{ applies: null \};/g) ?? []).length, 1);
  eq("the Preview read: the selected ids, through readWithContextFilter over withoutPreviews",
    /readWithContextFilter\(previews, \(apply\) =>\s*withoutPreviews\(svc\.from\("course_attempts"\)\.select\("id"\)\.in\("id", ids\.slice\(i, i \+ 150\)\), apply\)\s*\)/.test(src), true);
  eq("a failed read answers 503 and restarts nothing (it comes before the dry run's answer and every write)",
    /if \(keptErr\) \{[\s\S]*?status: 503[\s\S]*?\}/.test(src) && src.indexOf("if (keptErr)") < src.indexOf("if (dryRun)") && src.indexOf("if (keptErr)") < src.indexOf('.update({ status: "abandoned" })'), true);
  eq("the plan and the real run's by_role both use the Preview ids",
    [/planRestart\(inProgress, grantRetakeIds, previewIds\)/.test(src), /byRoleClass\(plan\.selected\.filter\(\(a\) => restartedSet\.has\(a\.id\)\), previewIds\)/.test(src)], [true, true]);
  eq("both answers' by_role go through byRoleAnswer with the request's filter decision (null staff without 0107)",
    [/by_role: byRoleAnswer\(plan\.byRole, previews\.applies\),/.test(src),
      /by_role: byRoleAnswer\(byRoleClass\(plan\.selected\.filter\(\(a\) => restartedSet\.has\(a\.id\)\), previewIds\), previews\.applies\),/.test(src),
      /by_role: (plan\.byRole|byRoleClass\()/.test(src)],
    [true, true, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
