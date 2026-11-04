/**
 * Unit tests for the language switch (PUT /api/courses/{courseId}/
 * language-preference), ADR 0014 step 3 (the is_revision filter) and step 18
 * (requires_finish), with step 17's cases:
 *
 *   1. lib/courses/slot-routing.ts languageSwitchDecision() and its two
 *      helpers: a flagged revision row on the other language is neither
 *      counted nor abandoned; a stored `failed`, and separately a stored
 *      `passed`, run summary on an in-progress cmi5 attempt → requires_finish
 *      on both values of restart_if_in_progress (nothing abandoned, no
 *      preference written); none → today's confirm, then the abandon; a
 *      consumed grant retake stays exempt; a SCORM-only row and a plain-xAPI
 *      row with a run summary → today's confirm.
 *   2. The route, by source: it authenticates through the cookie-bound
 *      server client (`@/lib/supabase/server`), which has no unit rig, so
 *      its wiring is checked on the text (the route-test departure of ADR
 *      0014 step 17, as for the launch page and the SCORM commit route):
 *      the narrower select on a missing column, the 503s, the order of the
 *      check, the full verb IRIs, the 409 body.
 *   3. The launch picker, by source (no React rig): the !restart 409 branch
 *      reads the body once and shows `message`, never "HTTP 409".
 *
 * Run:  npx tsx tests/unit/language-preference.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import {
  finishCheckAttemptIds,
  languageSwitchDecision,
  REQUIRES_FINISH_MESSAGE,
  resettableSwitchRows,
  type SwitchRow,
} from "../../lib/courses/slot-routing";
import { isMissingColumn } from "../../lib/scoring/attempt-kind";
import { VERBS } from "../../lib/xapi/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const types = new Map<string, string | null>([["cmi5-v", "cmi5"], ["scorm-v", "scorm12"], ["xapi-v", "xapi"]]);
const row = (id: string, version: string, extra: Partial<SwitchRow> = {}): SwitchRow => ({ id, course_version_id: version, ...extra });
const none = new Set<string>();

/** The route's flow, on its pure parts: which ids the statements read checks, then the decision. */
function decide(rows: SwitchRow[], retakeIds: Set<string>, storedOutcomeIds: Set<string>, restart: boolean) {
  const checked = finishCheckAttemptIds(resettableSwitchRows(rows, retakeIds), types);
  const assessed = new Set(checked.filter((id) => storedOutcomeIds.has(id)));
  return { checked, decision: languageSwitchDecision({ rows, retakeIds, assessedAttemptIds: assessed, restartIfInProgress: restart }) };
}

console.log("\nstep 3: a revision visit's row is neither counted nor abandoned");
{
  const flagged = [row("rev", "cmi5-v", { is_revision: true })];
  eq("a flagged row on the other language → no confirm (not counted)", decide(flagged, none, none, false).decision, { kind: "proceed", resettableIds: [], keptRetakes: 0 });
  eq("…and a confirmed switch abandons nothing", decide(flagged, none, none, true).decision, { kind: "proceed", resettableIds: [], keptRetakes: 0 });
  eq("…even with a stored outcome on it (never checked)", decide(flagged, none, new Set(["rev"]), false).checked, []);
  eq("beside an official row: only the official one counts",
    decide([...flagged, row("off", "scorm-v")], none, none, false).decision, { kind: "requires_confirm", inProgressAttempts: 1 });
  eq("a pre-0103 row (is_revision undefined) counts as today", resettableSwitchRows([row("p", "cmi5-v")], none).length, 1);
  eq("the narrower select's trigger: a 42703 naming is_revision", isMissingColumn({ code: "42703", message: "column course_attempts.is_revision does not exist" }, "is_revision"), true);
  eq("…never another error", isMissingColumn({ code: "57014", message: "canceling statement due to statement timeout" }, "is_revision"), false);
}

console.log("\nstep 18: requires_finish for an official cmi5 attempt that has taken an assessment");
{
  const ip = [row("a1", "cmi5-v")];
  for (const restart of [false, true]) {
    const failed = decide(ip, none, new Set(["a1"]), restart);
    eq(`a stored failed run summary, restart_if_in_progress ${restart} → requires_finish`, failed.decision.kind, "requires_finish");
    eq(`…nothing to abandon, the preference not written (restart ${restart})`, failed.decision.kind === "proceed", false);
  }
  eq("a stored passed run summary → requires_finish too", decide(ip, none, new Set(["a1"]), false).decision.kind, "requires_finish");
  eq("the message names Finish now and is the ADR's text", REQUIRES_FINISH_MESSAGE,
    "You have already taken an assessment in this course attempt. Continue it in its language, or end it with Finish now, before switching language.");
  eq("…carried by the decision", (decide(ip, none, new Set(["a1"]), true).decision as { message?: string }).message, REQUIRES_FINISH_MESSAGE);
  eq("no stored outcome → today's confirm", decide(ip, none, none, false).decision, { kind: "requires_confirm", inProgressAttempts: 1 });
  eq("…and the confirmed switch abandons it as today", decide(ip, none, none, true).decision, { kind: "proceed", resettableIds: ["a1"], keptRetakes: 0 });
  eq("a consumed grant retake is exempt (never checked, never counted, kept)",
    decide([row("rt", "cmi5-v")], new Set(["rt"]), new Set(["rt"]), false), { checked: [], decision: { kind: "proceed", resettableIds: [], keptRetakes: 1 } });
  eq("a SCORM-only in-progress row → today's confirm (no statements read)",
    decide([row("s1", "scorm-v")], none, new Set(["s1"]), false), { checked: [], decision: { kind: "requires_confirm", inProgressAttempts: 1 } });
  eq("a plain-xAPI row with a stored run summary → today's confirm",
    decide([row("x1", "xapi-v")], none, new Set(["x1"]), false), { checked: [], decision: { kind: "requires_confirm", inProgressAttempts: 1 } });
  eq("only the cmi5 rows are checked", decide([row("s1", "scorm-v"), row("a1", "cmi5-v"), row("x1", "xapi-v")], none, none, false).checked, ["a1"]);
  eq("one assessed cmi5 row blocks the whole switch",
    decide([row("s1", "scorm-v"), row("a1", "cmi5-v")], none, new Set(["a1"]), true).decision.kind, "requires_finish");
  eq("a version of unknown type is never checked", finishCheckAttemptIds([row("u", "gone-v")], types), []);
  eq("no in-progress row → proceed, nothing reset", decide([], none, none, false).decision, { kind: "proceed", resettableIds: [], keptRetakes: 0 });
}

console.log("\nthe route (source check; no unit rig for the cookie-bound client)");
{
  const src = fs.readFileSync(path.join(root, "app/api/courses/[courseId]/language-preference/route.ts"), "utf8");
  eq("the versions select names manifest_type and is error-checked (503)",
    /\.select\("id, package_id, manifest_type"\)/.test(src) && /if \(versionsErr\) return unreadable\("versions", versionsErr\.message\);/.test(src), true);
  eq("the in-progress select names course_version_id, filters is_revision = false",
    /\.select\("id, course_version_id"\)[\s\S]{0,200}if \(withFlagFilter\) q = q\.eq\("is_revision", false\);/.test(src), true);
  eq("…retries without the filter on a missing column only, then errors answer 503",
    /let \{ data: ipRows, error: ipErr \} = await readInProgress\(true\);\s*if \(ipErr && isMissingColumn\(ipErr, "is_revision"\)\) \(\{ data: ipRows, error: ipErr \} = await readInProgress\(false\)\);\s*if \(ipErr\) return unreadable\(/.test(src), true);
  eq("the statements read: the cmi5 resettable ids, verb passed or failed by the full IRI constants, error → 503",
    /\.from\("xapi_statements"\)\s*\.select\("attempt_id"\)\s*\.in\("attempt_id", finishCheckIds\)\s*\.in\("verb", \[VERBS\.passed, VERBS\.failed\]\);\s*if \(outcomeErr\) return unreadable\(/.test(src), true);
  eq("…VERBS.passed and VERBS.failed are the full IRIs the statements route stores",
    [VERBS.passed, VERBS.failed], ["http://adlnet.gov/expapi/verbs/passed", "http://adlnet.gov/expapi/verbs/failed"]);
  eq("…read only when there is a cmi5 attempt to check", /if \(finishCheckIds\.length > 0\) \{/.test(src), true);
  eq("unreadable answers 503 and writes nothing", /status: 503 \}\);/.test(src) && /const unreadable = \(what: string, message: string\) => \{/.test(src), true);
  const at = (s: string) => src.indexOf(s);
  eq("order: the grant read, then the statements read, then the decision, the finish 409, the confirm 409, the upsert, the abandon",
    [
      at('.from("attempt_requests")'),
      at('.from("xapi_statements")'),
      at("const decision = languageSwitchDecision("),
      at('if (decision.kind === "requires_finish")'),
      at('if (decision.kind === "requires_confirm")'),
      at('.from("course_language_preferences").upsert('),
      at('.update({ status: "abandoned" })'),
    ].every((v, i, arr) => v > 0 && (i === 0 || v > arr[i - 1])), true);
  eq("the decision gets restart_if_in_progress as given (both values reach the finish check)",
    /restartIfInProgress: Boolean\(body\.restart_if_in_progress\),/.test(src), true);
  eq("the requires_finish 409 body: { requires_finish, error, message }",
    /\{ requires_finish: true, error: decision\.message, message: decision\.message \},\s*\{ status: 409 \}/.test(src), true);
  eq("the abandon is the decision's resettable ids (grant retakes and revision rows excluded)", /const resettableIds = decision\.resettableIds;/.test(src), true);
}

console.log("\nthe launch picker (source check; no React rig)");
{
  const src = fs.readFileSync(path.join(root, "app/[org]/(learner)/courses/[courseId]/launch/launch-language-picker.tsx"), "utf8");
  const s = src.indexOf("if (res.status === 409 && !restart) {");
  const e = src.indexOf("if (!res.ok) {", s);
  const branch = s > 0 && e > s ? src.slice(s, e) : "";
  eq("the !restart 409 branch reads the body once", (branch.match(/res\.json\(/g) ?? []).length, 1);
  eq("…tests requires_finish after requires_confirm", branch.indexOf("if (j.requires_confirm)") > 0 && branch.indexOf("if (j.requires_finish)") > branch.indexOf("if (j.requires_confirm)"), true);
  eq("…shows message (or error) and stops, never falling through to the second res.json()",
    /if \(j\.requires_finish\) \{\s*setError\(j\.message \?\? j\.error \?\? ""\);\s*setPicking\(null\);\s*return;\s*\}/.test(branch), true);
  eq("…its parsed type names requires_finish and error", /requires_finish\?: boolean;/.test(branch) && /error\?: string;/.test(branch), true);
  eq("the restart path still reads the 409's error once (the route fills it with the same message)",
    /if \(!res\.ok\) \{\s*const j = \(await res\.json\(\)\.catch\(\(\) => \(\{\}\)\)\) as \{ error\?: string \};\s*setError\(j\.error \?\? `HTTP \$\{res\.status\}`\);/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
