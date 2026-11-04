/**
 * Unit tests for ADR 0014 step 11 (grants after a pass, Q2):
 * the pure twins in lib/attempts/request-decision.ts that the learner course
 * page, POST /api/attempt-requests, PATCH /api/attempt-requests/{id} and the
 * bulk route share (each route authenticates through the cookie-bound server
 * client, so its own wiring is a source check, added with the routes), the
 * message texts verbatim, and the roles the routes gate on (ADMIN_ROLES).
 *
 * Added under the route-test reading:
 *   - source checks of POST /api/attempt-requests, PATCH
 *     /api/attempt-requests/{id} and POST /api/attempt-requests/bulk (each
 *     on the cookie-bound server client, which has no unit rig), of the
 *     Attempt Requests page and of its queue;
 *   - grantExtraAttempts (lib/attempts/grant.ts, the ticket grant) run
 *     under tsx against a by-table fake: its reads fail closed.
 *
 * Run:  npx tsx tests/unit/attempt-requests.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeScoring, DEFAULT_POLICY, type ScorableAttempt } from "../../lib/scoring/policy";
import { grantExtraAttempts } from "../../lib/attempts/grant";
import {
  approvalDecision,
  bulkEligibility,
  learnerWarningLead,
  OVERRIDE_NOTE_MAX,
  OVERRIDE_NOTE_MIN,
  REQUEST_MESSAGES,
  requestDecision,
  resultStands,
} from "../../lib/attempts/request-decision";
import { ADMIN_ROLES } from "../../lib/attempts/requests";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const done = (id: string, day: number, ss: "passed" | "failed" | "unknown", score: number | null = ss === "passed" ? 0.85 : 0.4): ScorableAttempt => ({
  id,
  score,
  started_at: `2026-10-${String(day).padStart(2, "0")}T09:00:00Z`,
  completed_at: `2026-10-${String(day).padStart(2, "0")}T09:30:00Z`,
  completion_status: "completed",
  success_status: ss,
  status: ss === "unknown" ? "completed" : ss,
  is_revision: false,
});
const open = (id: string, day: number): ScorableAttempt => ({
  id,
  score: null,
  started_at: `2026-10-${String(day).padStart(2, "0")}T09:00:00Z`,
  completed_at: null,
  completion_status: "in_progress",
  success_status: "unknown",
  status: "in_progress",
  is_revision: false,
});
const scored = (attempts: ScorableAttempt[], retakes: string[] = []) => ({ scoring: computeScoring(attempts, DEFAULT_POLICY, new Set(retakes)), attempts });

// The learner states the tables are written over.
const S = {
  noAttempt: scored([]),
  firstInProgress: scored([open("a1", 1)]),
  passed: scored([done("a1", 1, "passed")]),
  failed: scored([done("a1", 1, "failed")]),
  completed: scored([done("a1", 1, "unknown", 0.7)]),
  liveOverPass: scored([done("a1", 1, "passed"), open("r1", 5)], ["r1"]),
  liveOverFail: scored([done("a1", 1, "failed"), open("r1", 5)], ["r1"]),
  resetRetake: scored([done("a1", 1, "failed"), { ...open("r1", 5), status: "abandoned" }], ["r1"]),
  retakeFailedAfterPass: scored([done("a1", 1, "passed"), done("r1", 5, "failed")], ["r1"]),
  revisionOnly: scored([done("a1", 1, "passed"), { ...open("v1", 6), is_revision: true }]),
};

console.log("\nrequestDecision: the page's rule and POST's, one function (ADR 0014 step 11 (1)-(2))");
{
  eq("no attempt → no_official_result", requestDecision(S.noAttempt), "no_official_result");
  eq("the official attempt still in progress → no_official_result", requestDecision(S.firstInProgress), "no_official_result");
  eq("failed → ok", requestDecision(S.failed), "ok");
  eq("passed → ok (a pass is never a refusal)", requestDecision(S.passed), "ok");
  eq("completed on a module without a pass mark → ok", requestDecision(S.completed), "ok");
  eq("a granted retake live over a pass → retake_live", requestDecision(S.liveOverPass), "retake_live");
  eq("…over a fail → retake_live", requestDecision(S.liveOverFail), "retake_live");
  eq("a reset (abandoned) retake is not live → ok", requestDecision(S.resetRetake), "ok");
  eq("an open revision visit's row is not a retake → ok", requestDecision(S.revisionOnly), "ok");
  eq("a live retake whose id the (failed, empty) read did not return → ok for that render (the page hides the button on a failed read)",
    requestDecision(scored([done("a1", 1, "passed"), open("r1", 5)])), "ok");
}

console.log("\nresultStands: officialDone and not failed (ADR 0014 step 11 (3))");
{
  eq("passed, pass required → stands", resultStands(S.passed.scoring, true), true);
  eq("passed, no pass mark → stands", resultStands(S.passed.scoring, false), true);
  eq("completed on a module without a pass mark → stands", resultStands(S.completed.scoring, false), true);
  eq("completed on a pass-required module → does not stand (officialDone false)", resultStands(S.completed.scoring, true), false);
  eq("failed on a pass-required module → does not stand", resultStands(S.failed.scoring, true), false);
  eq("failed on a module without a pass mark → does not stand (never needs the override)", resultStands(S.failed.scoring, false), false);
  eq("no official attempt → does not stand", resultStands(S.firstInProgress.scoring, false), false);
  eq("a live retake over a pass: the standing pass still stands", resultStands(S.liveOverPass.scoring, true), true);
  eq("a failed retake after a pass: the retake is official, it does not stand", resultStands(S.retakeFailedAfterPass.scoring, true), false);
}

console.log("\napprovalDecision: the PATCH approve rule (ADR 0014 step 11 (3))");
{
  const note = (n: number) => "x".repeat(n);
  const ap = (s: ReturnType<typeof scored>, passRequired: boolean, overridePassed: boolean | undefined, n: string | null) =>
    approvalDecision({ ...s, passRequired, overridePassed, note: n });
  eq("a result that does not stand → a plain approve (no override needed, note optional)", [ap(S.failed, true, undefined, null), ap(S.failed, false, false, "")], ["approve", "approve"]);
  eq("passed without override_passed → needs_override", ap(S.passed, true, undefined, note(40)), "needs_override");
  eq("passed, override_passed false → needs_override", ap(S.passed, true, false, note(40)), "needs_override");
  eq("passed, override, no note → needs_override", ap(S.passed, true, true, null), "needs_override");
  eq("note of 2 (trimmed) → needs_override", ap(S.passed, true, true, `  ${note(2)}  `), "needs_override");
  eq("note of 3 → approve_with_override", ap(S.passed, true, true, note(3)), "approve_with_override");
  eq("note of 2000 → approve_with_override", ap(S.passed, true, true, note(2000)), "approve_with_override");
  eq("whitespace does not count: 3 spaces + 2 characters → needs_override", ap(S.passed, true, true, `   ${note(2)}`), "needs_override");
  eq("a trimmed note of 2001 is the route's 400 before this is called (the override path only); here it would read needs_override",
    ap(S.passed, true, true, note(2001)), "needs_override");
  eq("the bounds are the ADR's 3-2000", [OVERRIDE_NOTE_MIN, OVERRIDE_NOTE_MAX], [3, 2000]);
  eq("completed on a module without a pass mark → needs the override too", [ap(S.completed, false, undefined, null), ap(S.completed, false, true, note(10))], ["needs_override", "approve_with_override"]);
  eq("a live retake at approval time → retake_live (before the override rule)", ap(S.liveOverPass, true, true, note(10)), "retake_live");
  eq("no official result at approval time → no_official_result", ap(S.firstInProgress, true, true, note(10)), "no_official_result");
}

console.log("\nbulkEligibility: not passed, plus the live-retake skip (ADR 0014 step 11 (5))");
{
  const be = (s: ReturnType<typeof scored>, passRequired: boolean) => bulkEligibility({ ...s, passRequired });
  eq("failed → grant", be(S.failed, false), "grant");
  eq("passed → not_failed", be(S.passed, true), "not_failed");
  eq("completed, no pass mark → not_failed", be(S.completed, false), "not_failed");
  eq("completed on a pass-required module (short of a pass) → grant", be(S.completed, true), "grant");
  eq("no official result → no_official", [be(S.noAttempt, false), be(S.firstInProgress, true)], ["no_official", "no_official"]);
  eq("failed with a live granted retake → retake_live (skipped)", be(S.liveOverFail, false), "retake_live");
  eq("passed with a live granted retake → not_failed (the standing pass)", be(S.liveOverPass, true), "not_failed");
  eq("a failed retake after a pass → grant (the retake is official)", be(S.retakeFailedAfterPass, true), "grant");
}

console.log("\nthe texts of ADR 0014 step 11, verbatim");
{
  eq("(2) no official result", REQUEST_MESSAGES.no_official_result, "You still have an official attempt available.");
  eq("(2) a live granted retake", REQUEST_MESSAGES.retake_live, "A granted retake is still in progress.");
  eq("(3) needs the override, passed", REQUEST_MESSAGES.needs_override_passed, "This learner passed. Confirm the override and give a reason.");
  eq("(3) needs the override, completed", REQUEST_MESSAGES.needs_override_completed, "This learner has completed this module. Confirm the override and give a reason.");
  eq("(1) the learner's warning, straight quotes around 'in progress'", REQUEST_MESSAGES.learner_warning,
    "If another attempt is granted, the result of that attempt becomes your official result even if it is lower, and the course shows 'in progress' until you finish it. Your current result stays in your history.");
  eq("(1) its lead: passed with a score, completed", [learnerWarningLead({ kind: "passed", scorePct: 85 }), learnerWarningLead({ kind: "completed", scorePct: 70 })],
    ["You passed this course (85 %).", "You have completed this course."]);
  eq("…passed with no score: no figure is guessed", learnerWarningLead({ kind: "passed", scorePct: null }), "You passed this course.");
}

console.log("\nthe roles the request routes gate on (ADMIN_ROLES; ADR 0014 step 11 (3), step 17's permissions case)");
{
  const roles: readonly string[] = ADMIN_ROLES;
  eq("super_owner, the legacy org-owner role owner, and admin decide", ["super_owner", "owner", "admin"].map((r) => roles.includes(r)), [true, true, true]);
  eq("data_analyst and user never decide (403)", ["data_analyst", "user"].map((r) => roles.includes(r)), [false, false]);
}

/* ---------------- the routes, the page and the queue: source checks ---------------- */

const root = path.resolve(__dirname, "../..");
const raw = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
/** The source with line and block comments blanked (strings kept), so a comment naming a call is not a call. */
const code = (rel: string) =>
  raw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
/** Each needle's first index, in order; true when every one is found and they appear in that order. */
const inOrder = (src: string, needles: string[]) => {
  let at = -1;
  for (const n of needles) {
    const i = src.indexOf(n, at + 1);
    if (i < 0 || i <= at) return false;
    at = i;
  }
  return true;
};

const POST = "app/api/attempt-requests/route.ts";
const PATCH = "app/api/attempt-requests/[id]/route.ts";
const BULK = "app/api/attempt-requests/bulk/route.ts";
const ARP = "app/[org]/(admin)/attempt-requests/page.tsx";
const ARQ = "app/[org]/(admin)/attempt-requests/attempt-requests-queue.tsx";

console.log("\nPOST /api/attempt-requests: the page's rule, strict reads, before the insert (ADR 0014 step 11 (2))");
{
  const src = code(POST);
  eq("authenticates through the cookie-bound server client (why this is a source check)", /from "@\/lib\/supabase\/server"/.test(src), true);
  eq("the attempts columns name status", /const ATTEMPT_COLUMNS = "[^"]*\bstatus\b[^"]*";/.test(src), true);
  eq("the attempts read adds is_revision through the narrower-select fallback",
    /readWithOptionalColumn<ScorableAttempt\[\]>\(\s*"is_revision",[\s\S]*?\.from\("course_attempts"\)[\s\S]*?ATTEMPT_COLUMNS\s*\)/.test(src), true);
  eq("versions, attempts and grants are error-checked inside one try: grantSnapshotFor, then computeScoring",
    inOrder(src, ["try {", 'from("course_versions")', "if (verErr || !verRows) throw", "if (attErr || !attRows) throw", "grantSnapshotFor(s, user.id, course.id)", "computeScoring(attempts, policy, snapshot.retakeIds)", "} catch (e) {", '{ error: "records_unreadable" }, { status: 503 }']), true);
  eq("requestDecision( and both 409s come before the insert",
    inOrder(src, ["requestDecision({ scoring, attempts })", "REQUEST_MESSAGES.no_official_result }, { status: 409 }", "REQUEST_MESSAGES.retake_live }, { status: 409 }", ".insert({"]), true);
  eq("the fail-soft grantRetakeIdsFor is gone, and one attempts read remains (attempts_used reuses the scoring)",
    [/grantRetakeIdsFor\(/.test(src), (src.match(/\.from\("course_attempts"\)/g) ?? []).length, /attempts_used: scoring\.scoredAttempts/.test(src)], [false, 1, true]);
  eq("the one-open index keeps its 409", /"23505"[\s\S]*?You already have an open attempt request for this course\.[\s\S]*?status: 409/.test(src), true);
  eq("a pass is not a refusal: no resultStands or officialStatus test in POST", [/resultStands\(/.test(src), /officialStatus/.test(src)], [false, false]);
}

console.log("\nPATCH /api/attempt-requests/{id}: the approval rule, the override marker (ADR 0014 step 11 (3))");
{
  const src = code(PATCH);
  eq("authenticates through the cookie-bound server client", /from "@\/lib\/supabase\/server"/.test(src), true);
  eq("the body names override_passed", /override_passed\?: boolean;/.test(src) && /overridePassed: body\.override_passed === true/.test(src), true);
  eq("the non-override note keeps today's cut to 2000; the untruncated trimmed note is kept beside it",
    /const noteFull = \(body\.note \?\? ""\)\.trim\(\);\s*const note = noteFull\.slice\(0, 2000\) \|\| null;/.test(src), true);
  eq("the strict reads run for approve only, after the pending check, in one try answering 503",
    inOrder(src, ['reqRow.status !== "pending"', 'if (body.action === "approve") {', "try {", 'from("course_versions")', "grantSnapshotFor(s, reqRow.user_id, reqRow.course_id)", 'select("pass_required")', "computeScoring(attempts, policy, snapshot.retakeIds)", "} catch (e) {", '{ error: "records_unreadable" }, { status: 503 }']), true);
  eq("the pass mark read is error-checked: a missing column reads false, any other error throws",
    /if \(courseErr && !isMissingColumn\(courseErr, "pass_required"\)\) throw/.test(src), true);
  eq("source order: resultStands( → the 2000-character 400 (override path only) → approvalDecision(",
    inOrder(src, ["const stands = resultStands(scoring, passRequired);", "if (stands && noteFull.length > OVERRIDE_NOTE_MAX)", '{ error: "note must be at most 2000 characters" }, { status: 400 }', "approvalDecision({"]), true);
  eq("approvalDecision gets the untruncated note", /approvalDecision\(\{[\s\S]*?note: noteFull,[\s\S]*?\}\)/.test(src), true);
  eq("the refusals: no official result, a live retake, and the two needs-override texts, all 409",
    inOrder(src, ['decision === "no_official_result"', "REQUEST_MESSAGES.no_official_result }, { status: 409 }", 'decision === "retake_live"', "REQUEST_MESSAGES.retake_live }, { status: 409 }", 'decision === "needs_override"', 'scoring.officialStatus === "completed" ? REQUEST_MESSAGES.needs_override_completed : REQUEST_MESSAGES.needs_override_passed', "{ error: text }, { status: 409 }"]), true);
  eq("override_confirmed: true is written only on the override branch, in the one update statement",
    [/override = decision === "approve_with_override";/.test(src), /\.\.\.\(override \? \{ override_confirmed: true \} : \{\}\),/.test(src), (src.match(/override_confirmed: true/g) ?? []).length], [true, true, 1]);
  eq("the override stores the note whole; reject and a plain approve store the cut note", /const decisionNote = override \? noteFull : note;/.test(src) && /decision_note: decisionNote,/.test(src), true);
  eq("a missing override_confirmed column answers 503 schema_missing, logged, nothing approved",
    inOrder(src, ["if (override && isMissingColumn(error, \"override_confirmed\"))", '"schema_missing"', '{ error: "schema_missing" }, { status: 503 }']), true);
  eq("every check precedes the update", src.indexOf("approvalDecision({") < src.indexOf(".update({"), true);
  eq("roles unchanged: ADMIN_ROLES gates the caller", /if \(!ADMIN_ROLES\.includes\(normalizeRole\(caller\?\.role as string\)/.test(src), true);
}

console.log("\nPOST /api/attempt-requests/bulk: fail closed, skip a live retake (ADR 0014 step 11 (5))");
{
  const src = code(BULK);
  eq("authenticates through the cookie-bound server client", /from "@\/lib\/supabase\/server"/.test(src), true);
  eq("the attempts columns name status, and the read adds is_revision through readPagedWithOptionalColumn (the first page decides)",
    /const ATTEMPT_COLUMNS = "[^"]*\bstatus\b[^"]*";/.test(src) &&
      /readPagedWithOptionalColumn<Att>\(\s*"is_revision",\s*\(cols, from, to\) =>\s*s\s*\.from\("course_attempts"\)\s*\.select\(cols\)[\s\S]*?\.order\("id"\)\s*\.range\(from, to\)[^,]*,\s*ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\);\s*if \(attemptsRead\.error\) return unreadable\("attempts"\);/.test(src), true);
  eq("…a failed page or an empty answer still answers 503 (nullIsError), and no local copy of the first-page closure remains",
    [/\{ nullIsError: true \}/.test(src), /= used;|readWithOptionalColumn\b/.test(src)], [true, false]);
  eq("eligibility is bulkEligibility(…) === \"grant\"; a live retake is counted in skipped_live_retake",
    /const verdict = bulkEligibility\(\{ scoring: sc, attempts: list, passRequired \}\);\s*if \(verdict === "retake_live"\) skippedLiveRetake\+\+;\s*if \(verdict !== "grant"\) continue;/.test(src), true);
  eq("the strict bulk snapshot replaces the fail-soft read", [/grantSnapshotForUsers\(s, org\.id, \[course\.id\], userIds\)/.test(src), /fetchGrantRetakeIdsForUsers/.test(src)], [true, false]);
  eq("the versions, attempts, grants and open-requests reads each answer 503 (unreadable) before the insert",
    inOrder(src, ['return unreadable("versions")', 'return unreadable("attempts")', 'return unreadable("grants")', 'return unreadable("open requests")', ".insert(rows)"]), true);
  eq("unreadable answers 503 records_unreadable", /const unreadable = \(read: string\) => \{[\s\S]*?\{ error: "records_unreadable" \}, \{ status: 503 \}/.test(src), true);
  eq("no .insert( before the last 503", src.indexOf(".insert(") > src.lastIndexOf('return unreadable("'), true);
  eq("the answer carries skipped_live_retake", /skipped_live_retake: skippedLiveRetake,\s*failed_total: failedUserIds\.length,\s*\}\);\s*\}\s*$/.test(src), true);
}

console.log("\nThe Attempt Requests page: the strict chain read, the request-time result (ADR 0014 steps 7, 11)");
{
  const src = code(ARP);
  eq("admin-gated (canManage): not an analyst-visible page; every read is on the service client", /if \(!canManage\(role\)\)/.test(src) && /createServiceClient\(/.test(src), true);
  eq("the attempts select names status and adds is_revision through readPagedWithOptionalColumn (the first page decides)",
    /const ATTEMPT_COLUMNS = "[^"]*\bstatus\b[^"]*";/.test(src) &&
      /readPagedWithOptionalColumn<Row>\(\s*"is_revision",\s*\(cols, from, to\) =>\s*svc\s*\.from\("course_attempts"\)\s*\.select\(cols\)[\s\S]*?\.order\("id"\)\s*\.range\(from, to\)[^,]*,\s*ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\);/.test(src) &&
      !/= usedColumns;|readWithOptionalColumn\b/.test(src), true);
  eq("…an attempts page with neither rows nor an error is an error, so it too sets historyUnavailable (nullIsError)",
    /ATTEMPT_COLUMNS,\s*\{ nullIsError: true \}\s*\);\s*if \(attemptsRead\.error\) \{\s*historyUnavailable = true;/.test(src), true);
  eq("a failed or empty course_versions read sets historyUnavailable, logged, before the attempts read",
    /const \{ data: verRows, error: verErr \} = await svc\s*\.from\("course_versions"\)\s*\.select\("id, course_id"\)\s*\.in\("course_id", courseIds\);\s*if \(verErr \|\| !verRows\) \{\s*historyUnavailable = true;\s*console\.warn\(\s*JSON\.stringify\(\{ event: "attempt_requests_versions_unreadable", org_id: org\.id, code: verErr\?\.code \?\? "error" \}\)\s*\);\s*\}/.test(src) &&
      src.indexOf('event: "attempt_requests_versions_unreadable"') < src.indexOf("readPagedWithOptionalColumn<Row>("), true);
  eq("a failed attempts page sets historyUnavailable, logged, before any row is scored",
    /if \(attemptsRead\.error\) \{\s*historyUnavailable = true;\s*console\.warn\(\s*JSON\.stringify\(\{ event: "attempt_requests_attempts_unreadable", org_id: org\.id, code: attemptsRead\.error\.code \?\? "error" \}\)\s*\);\s*\}/.test(src) &&
      src.indexOf("if (attemptsRead.error) {") < src.indexOf("computeScoring("), true);
  eq("…the rows read so far are still grouped (the live figures), the old silent break is gone", [/for \(const a of attemptsRead\.data\) \{/.test(src), /if \(res\.error\) break;/.test(src)], [true, false]);
  eq("the grant links: grantSnapshotForUsers in a try whose catch sets historyUnavailable; the fail-soft read is gone",
    [/try \{\s*snapshots = await grantSnapshotForUsers\(svc, org\.id, courseIds, userIds\);\s*\} catch \(e\) \{\s*historyUnavailable = true;/.test(src), /fetchGrantRetakeIdsForUsers/.test(src)], [true, false]);
  eq("the chain per (learner, course): officialHistory over the snapshot's rows; none while unavailable",
    /history: historyUnavailable \? null : officialHistory\(list, snap\?\.rows \?\? \[\]\),/.test(src), true);
  eq("a decided row's result is the chain at the request's created_at", /r\.status !== "pending" && cur\.history \? officialResultAt\(cur\.history, r\.created_at\) : null/.test(src), true);
  eq("result_stands: resultStands over pass_required, pending rows only, false while unavailable",
    /stands: !historyUnavailable && resultStands\(sc, passRequired\.has\(r\.course_id\)\),/.test(src) && /result_stands: r\.status === "pending" && cur\.stands,/.test(src), true);
  eq("the row carries request_time_result, history_unavailable and opened_retake (used grants only)",
    [/request_time_result: atRequest \?/.test(src), /history_unavailable: historyUnavailable,/.test(src), /opened_retake: r\.status === "approved" && r\.used_attempt_id \? openedRetake\(found, r\.used_attempt_id\) : null,/.test(src)], [true, true, true]);
  eq("the source type admits restart", /source: "request" \| "bulk" \| "manager" \| "ticket" \| "restart";/.test(src), true);
}

console.log("\nThe queue: CurrentScore, the confirmation box, the source label (ADR 0014 step 11 (4))");
{
  const src = code(ARQ);
  const rawSrc = raw(ARQ);
  const currentScore = src.slice(src.indexOf("function CurrentScore("), src.indexOf("function ordinal("));
  eq("CurrentScore branches on r.status === \"pending\": live value there, request_time_result otherwise",
    inOrder(currentScore, ['if (r.status === "pending") {', "score = r.current_score;", "} else {", "r.history_unavailable", "History unavailable. Please reload.", "score = r.request_time_result?.score ?? null;"]), true);
  eq("…and it is rendered on every card", /<CurrentScore row=\{r\} \/>/.test(src), true);
  eq("AttemptContext reads the request-time result on a decided row", /const status = r\.status === "pending" \? r\.current_status : r\.request_time_result\?\.status \?\? null;/.test(src), true);
  eq("Approve is disabled while the history is unavailable, or a standing result lacks the tick or a 3-character reason",
    /const approveBlocked =\s*r\.history_unavailable \|\| \(r\.result_stands && \(!confirmed \|\| note\.trim\(\)\.length < 3\)\);/.test(src) && /disabled=\{busy \|\| approveBlocked\}/.test(src), true);
  eq("the pending card reads history_unavailable first, then result_stands",
    inOrder(src, ["{r.history_unavailable ? (", "History unavailable. Please reload.", ") : r.result_stands ? ("]), true);
  eq("the two sentences of ADR 0014 step 11 (4), verbatim",
    ["`This learner passed (${r.current_score} %).`", '"This learner has completed this module."', "\"A granted retake replaces that result even if it is lower, and shows 'in progress' until finished.\""].map((s) => rawSrc.includes(s)), [true, true, true]);
  eq("the checkbox text, verbatim", rawSrc.includes("I confirm: grant another official attempt to a learner whose result stands"), true);
  eq("the placeholder on a standing result, in place of the optional note", /placeholder=\{r\.result_stands \? "Reason \(required for a learner who passed\)" : "Optional note to the learner…"\}/.test(src), true);
  eq("the textarea stops at 2000 (maxLength={2000})", /<textarea[\s\S]*?maxLength=\{2000\}[\s\S]*?\/>/.test(src), true);
  eq("decide() sends override_passed: true only on an approve with the box ticked",
    /\.\.\.\(action === "approve" && overridePassed \? \{ override_passed: true \} : \{\}\),/.test(src) && /onDecide\(r\.id, "approve", note, expiry, r\.result_stands && confirmed\)/.test(src), true);
  eq("the source label names restart before the Bulk grant fallback",
    inOrder(src, ['r.source === "restart"', '"Re-issued after a module update"', '"Bulk grant"']), true);
  eq("a used grant links its opened retake", /Opened retake/.test(src) && /href=\{`\/\$\{orgSlug\}\/courses\/\$\{r\.course_id\}\/attempts\/\$\{opened\.attempt_id\}`\}/.test(src), true);
  eq("the bulk panel's copy: the window wording retired, the live-retake skip stated",
    [rawSrc.includes("every learner who has an official result on a module and didn&apos;t pass"), rawSrc.includes("Learners with a granted retake in progress are skipped."), rawSrc.includes("used up their window")], [true, true, false]);
}

/* ---------------- grantExtraAttempts (the ticket grant) under tsx ---------------- */

type FRow = Record<string, unknown>;
type FOp = { op: string; args: unknown[] };
type FQ = { table: string; ops: FOp[] };
/** A fault that answers neither rows nor an error ({ data: null, error: null }). */
const NULL_ANSWER = { code: "null_answer", message: "neither rows nor an error" } as const;
type Fault = (q: FQ) => { code: string; message: string } | null;
/**
 * A by-table fake (the lrs-revision-markers shape): honours .eq / .in / .is
 * on top-level columns a row carries, strips is_revision from rows whose
 * select does not name it, records inserts and updates; `fault` may answer
 * any query with an error, or with NULL_ANSWER for an answer with neither
 * rows nor an error; rpc answers no policy rows (DEFAULT_POLICY).
 */
function fakeDb(tables: Record<string, FRow[]>, fault: Fault = () => null) {
  const queries: FQ[] = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const keep = (o: FOp, r: FRow) => {
    const [col, v] = o.args as [unknown, unknown];
    if (typeof col !== "string" || col.includes(".") || !(col in r)) return true;
    if (o.op === "eq") return r[col] === v;
    if (o.op === "in") return (v as unknown[]).includes(r[col]);
    if (o.op === "is") return r[col] === v;
    return true;
  };
  const from = (table: string) => {
    const q: FQ = { table, ops: [] };
    queries.push(q);
    let single = false;
    let written: unknown = null;
    const answer = () => {
      const err = fault(q);
      if (err === NULL_ANSWER) return { data: null, error: null };
      if (err) return { data: null, error: err };
      if (written) return written;
      const sel = String(q.ops.find((o) => o.op === "select")?.args[0] ?? "*");
      let rows = (tables[table] ?? []).filter((r) => q.ops.every((o) => keep(o, r)));
      if (!sel.includes("is_revision")) rows = rows.map(({ is_revision: _drop, ...r }) => (void _drop, r));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = answer();
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej);
          }
          if (prop === "maybeSingle" || prop === "single") return () => ((single = true), proxy);
          if (prop === "insert" || prop === "update") {
            return (payload: unknown) => {
              q.ops.push({ op: String(prop), args: [payload] });
              (prop === "insert" ? inserts : updates).push({ table, payload: JSON.parse(JSON.stringify(payload)) });
              written = { data: null, error: null };
              return proxy;
            };
          }
          return (...args: unknown[]) => {
            q.ops.push({ op: String(prop), args });
            return proxy;
          };
        },
      }
    );
    return proxy;
  };
  const db = { from, rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;
  return { db, queries, inserts, updates };
}

const ORG = "org-1";
const COURSE = "course-1";
const VERSION = "ver-1";
const day = (d: number, h = 9) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
const attemptRow = (id: string, userId: string, d: number, ss: "passed" | "failed" | null, over: FRow = {}): FRow => ({
  id,
  user_id: userId,
  organization_id: ORG,
  course_version_id: VERSION,
  score: ss === "passed" ? 0.85 : ss === "failed" ? 0.4 : null,
  started_at: day(d),
  completed_at: ss ? day(d, 10) : null,
  completion_status: ss ? "completed" : "in_progress",
  success_status: ss ?? "unknown",
  status: ss ? "completed" : "in_progress",
  is_revision: false,
  ...over,
});
const grantRow = (id: string, userId: string, usedAttemptId: string | null): FRow => ({
  id,
  organization_id: ORG,
  course_id: COURSE,
  user_id: userId,
  status: "approved",
  used_attempt_id: usedAttemptId,
  used_at: usedAttemptId ? day(9) : null,
  expires_at: null,
  created_at: day(8),
  decided_by: "admin-1",
  decided_at: day(8),
  decision_note: null,
  reason: null,
  reissued_from: null,
});
// u1 failed (eligible), u2 failed with a granted retake in progress, u3 passed.
const TABLES = (): Record<string, FRow[]> => ({
  courses: [{ id: COURSE, title: "Course One", is_active: true, organization_id: ORG, pass_required: false }],
  course_versions: [{ id: VERSION, course_id: COURSE }],
  course_attempts: [
    attemptRow("a1", "u1", 1, "failed"),
    attemptRow("a2", "u2", 1, "failed"),
    attemptRow("r2", "u2", 5, null),
    attemptRow("a3", "u3", 1, "passed"),
  ],
  attempt_requests: [grantRow("g2", "u2", "r2")],
  profiles: [],
});
const ticket = (db: SupabaseClient) =>
  grantExtraAttempts(db, {
    orgId: ORG,
    orgName: "Org",
    orgSlug: "org",
    origin: "",
    decidedBy: "admin-1",
    source: "ticket",
    courseId: COURSE,
    userIds: ["u1", "u2", "u3"],
    expiresInDays: 30,
  });
type TicketOut = { results: Array<{ userId: string; status: string; reason?: string }>; courseTitle: string };
const byUid = (out: unknown) => Object.fromEntries((out as TicketOut).results.map((r) => [r.userId, `${r.status}${r.reason ? `: ${r.reason}` : ""}`]));
const FAILED_ALL = {
  u1: "failed: could not read the learner's records",
  u2: "failed: could not read the learner's records",
  u3: "failed: could not read the learner's records",
};
const BOOM = { code: "XX000", message: "boom" };
const isAttempts = (q: FQ) => q.table === "course_attempts";
const isGrantRead = (q: FQ) => q.table === "attempt_requests" && q.ops.some((o) => o.op === "eq" && o.args[0] === "status" && o.args[1] === "approved") && q.ops.some((o) => o.op === "select");
const isOpenRows = (q: FQ) => q.table === "attempt_requests" && q.ops.some((o) => o.op === "select" && o.args[0] === "user_id, status, used_at");

async function ticketCases() {
  console.log("\ngrantExtraAttempts: the ticket grant's reads fail closed (ADR 0014 step 11 (5))");
  {
    const f = fakeDb(TABLES());
    const out = await ticket(f.db);
    eq("healthy reads: the failed learner is granted, the live retake and the pass are skipped as today", byUid(out), {
      u1: "granted",
      u2: "skipped: a granted retake is still in progress",
      u3: "skipped: has not failed this module",
    });
    eq("…one insert, for u1, source ticket", f.inserts.map((i) => [(i.payload as FRow).user_id, (i.payload as FRow).source]), [["u1", "ticket"]]);
    const att = f.queries.find(isAttempts);
    eq("the attempts read names status and is_revision", /\bstatus\b/.test(String(att?.ops.find((o) => o.op === "select")?.args[0])) && /is_revision/.test(String(att?.ops.find((o) => o.op === "select")?.args[0])), true);
    const g = f.queries.find(isGrantRead);
    eq("the strict bulk snapshot: org, approved, the named users, this course", [
      g?.ops.some((o) => o.op === "eq" && o.args[0] === "organization_id" && o.args[1] === ORG),
      JSON.stringify(g?.ops.find((o) => o.op === "in" && o.args[0] === "user_id")?.args[1]),
      JSON.stringify(g?.ops.find((o) => o.op === "in" && o.args[0] === "course_id")?.args[1]),
    ], [true, JSON.stringify(["u1", "u2", "u3"]), JSON.stringify([COURSE])]);
  }
  for (const [what, fault] of [
    ["a failing versions read", (q: FQ) => (q.table === "course_versions" ? BOOM : null)],
    ["a failing attempts read", (q: FQ) => (isAttempts(q) ? BOOM : null)],
    ["a failing grants read (GrantReadError)", (q: FQ) => (isGrantRead(q) ? BOOM : null)],
    ["a failing open-requests read", (q: FQ) => (isOpenRows(q) ? BOOM : null)],
  ] as Array<[string, Fault]>) {
    const f = fakeDb(TABLES(), fault);
    const out = await ticket(f.db);
    eq(`${what} → every named learner failed with the text`, byUid(out), FAILED_ALL);
    eq(`${what} → nothing inserted`, f.inserts.length, 0);
  }
  {
    // A page with neither rows nor an error ({ nullIsError: true }
    // at the site) fails closed like an error, never as "no attempts".
    const f = fakeDb(TABLES(), (q) => (isAttempts(q) ? NULL_ANSWER : null));
    const out = await ticket(f.db);
    eq("an attempts page with neither rows nor an error → every named learner failed with the text", byUid(out), FAILED_ALL);
    eq("…nothing inserted, after one attempts read (no narrower re-read: it was not a missing-column error)", [f.inserts.length, f.queries.filter(isAttempts).length], [0, 1]);
  }
  {
    const f = fakeDb(TABLES(), (q) => (q.table === "course_versions" ? BOOM : null));
    await ticket(f.db);
    eq("a failing versions read reads no attempts", f.queries.filter(isAttempts).length, 0);
    eq("…and it is a result list, not an ActionError", "error" in ((await ticket(f.db)) as object), false);
  }
  {
    // A database without 0103: the first attempts select (naming is_revision) answers 42703.
    let firstAttempts = true;
    const f = fakeDb(TABLES(), (q) => {
      if (isAttempts(q) && firstAttempts && String(q.ops.find((o) => o.op === "select")?.args[0]).includes("is_revision")) {
        firstAttempts = false;
        return { code: "42703", message: "column course_attempts.is_revision does not exist" };
      }
      return null;
    });
    const out = await ticket(f.db);
    eq("a missing is_revision column re-reads without it (the narrower-select fallback), as today", byUid(out), {
      u1: "granted",
      u2: "skipped: a granted retake is still in progress",
      u3: "skipped: has not failed this module",
    });
  }
  {
    // A database without attempt_requests (pre-0083): no grants, not a failure.
    const f = fakeDb(TABLES(), (q) => (isGrantRead(q) ? { code: "42P01", message: 'relation "public.attempt_requests" does not exist' } : null));
    const out = await ticket(f.db);
    eq("a missing attempt_requests relation reads as no grants: the in-progress row is then not a retake, so u2 has no live retake", byUid(out).u2, "granted");
  }
  {
    const f = fakeDb(TABLES(), (q) => (q.table === "attempt_requests" && q.ops.some((o) => o.op === "update") ? BOOM : null));
    const out = await ticket(f.db);
    eq("the expiry sweep stays fail-soft: a failing sweep still grants u1", byUid(out).u1, "granted");
  }
}

ticketCases()
  .catch((e) => {
    fail++;
    console.log("  ✗ grantExtraAttempts cases threw:", e);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
