/**
 * ADR 0014 PR 1b: source
 * checks of the UI copy and of two in-progress state tests. The files are
 * .tsx pages and client components (next/* imports, a cookie client), so
 * nothing here renders them; two predicates are evaluated from the source
 * text itself against row fixtures.
 *
 *   - the three Report Card reassurances beyond the four empty states
 *     (L1 "Where the team struggles", L2 "Common struggles across teams",
 *     L3 "Teams needing support") are withheld while any learner in scope
 *     has historyUnavailable, with the same sentence and count source;
 *   - the request button and the Attempt Requests queue show
 *     records_unreadable and schema_missing as plain sentences, and the bulk
 *     panel prints skipped_live_retake and never says "nothing to grant"
 *     when a learner was skipped for a live retake;
 *   - an open revision visit's row never marks a learning-path
 *     step "in progress" (the learner path page) nor starts a path (the
 *     dashboard path tile), through isRevisionAttempt;
 *   - the scoring-rules card's copy names no rule precedence,
 *     inheritance or override, and keeps ADR 0014 step 9's words.
 *
 * Run:  npx tsx tests/unit/revision-ui-copy.test.ts   (or npm run test:unit)
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import fs from "node:fs";
import path from "node:path";
import { isRevisionAttempt } from "../../lib/scoring/policy";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const raw = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
/** Source with line and block comments blanked (strings kept), so a comment is never read as code. */
const code = (rel: string) =>
  raw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const count = (src: string, needle: string) => src.split(needle).length - 1;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TP = "app/[org]/(learner)/team-performance/_components";
const L1 = `${TP}/l1-view.tsx`, L2 = `${TP}/l2-view.tsx`, L3 = `${TP}/l3-view.tsx`;
const BUTTON = "app/[org]/(learner)/courses/[courseId]/request-attempt-button.tsx";
const QUEUE = "app/[org]/(admin)/attempt-requests/attempt-requests-queue.tsx";
const CARD = "components/scoring/scoring-rules-card.tsx";
const PATH_PAGE = "app/[org]/(learner)/paths/[pathId]/page.tsx";
const DASHBOARD = "app/[org]/(learner)/dashboard/page.tsx";

/** The sentence, as the four gated empty states print it. */
const UNAVAILABLE_P =
  '<p className="text-sm text-muted">History unavailable for {unreadableN} {unreadableN === 1 ? "learner" : "learners"}. Please reload.</p>';

console.log("\nthe three more reassurances are gated like the four empty states (ADR 0014:188)");
{
  /**
   * `{<list>.length === 0 ? ( learners.some((l) => l.historyUnavailable) ? ( <the sentence> ) : ( <reassurance> ) ) : (`:
   * the reassurance is the else of the historyUnavailable test, inside the list's empty branch.
   */
  const gated = (src: string, list: string, reassurance: string) =>
    new RegExp(
      `\\{${esc(list)}\\.length === 0 \\? \\(\\s*learners\\.some\\(\\(l\\) => l\\.historyUnavailable\\) \\? \\(\\s*${esc(UNAVAILABLE_P)}\\s*\\) : \\(\\s*` +
        `<p className="text-sm text-muted">${esc(reassurance)}</p>\\s*\\)\\s*\\) : \\(`
    ).test(src);
  const cases: Array<[string, string, string]> = [
    [L1, "struggles", "No course or journey day is holding the team back right now."],
    [L2, "common", "No module or journey day is holding several teams back."],
    [L3, "weak", "Every scored team is in the green."],
  ];
  for (const [f, list, reassurance] of cases) {
    const src = code(f);
    eq(`${f}: "${reassurance}" shows only when no learner in scope is degraded, else the history-unavailable sentence`, gated(src, list, reassurance), true);
    eq(`${f}: the reassurance occurs once (no ungated copy left)`, count(src, reassurance), 1);
  }
  eq("each view now prints the sentence twice (the empty state's gate and this one)", [count(code(L1), UNAVAILABLE_P), count(code(L2), UNAVAILABLE_P), count(code(L3), UNAVAILABLE_P)], [2, 2, 2]);
  eq("the same degraded-learners count source: one unreadableN per view", [
    count(code(L1), "const unreadableN ="), /const readable = learners\.filter\(\(l\) => !l\.historyUnavailable\);\s*const unreadableN = learners\.length - readable\.length;/.test(code(L1)),
    count(code(L2), "const unreadableN ="), /const unreadableN = learners\.filter\(\(l\) => l\.historyUnavailable\)\.length;/.test(code(L2)),
    count(code(L3), "const unreadableN ="), /const unreadableN = learners\.filter\(\(l\) => l\.historyUnavailable\)\.length;/.test(code(L3)),
  ], [1, true, 1, true, 1, true]);
  eq("non-vacuous: the four gated reassurances are still there, beside the new ones", [
    code(L1).includes("Nothing needs attention right now — everyone is on track."),
    code(L2).includes("Every team is on track."),
    code(L3).includes("No module or journey day is holding the organisation back right now."),
  ], [true, true, true]);
}

console.log("\nthe 503 codes are plain sentences; the bulk panel prints skipped_live_retake");
{
  const button = code(BUTTON);
  eq("the request button maps records_unreadable to its sentence",
    /const REQUEST_ERRORS: Record<string, string> = \{\s*records_unreadable: "Could not read your records\. Please try again\.",\s*\};/.test(button), true);
  eq("…and its one error site reads the map first (the 409 sentences fall through as sent)", [
    count(button, "setError((j.error && REQUEST_ERRORS[j.error]) ?? j.error ?? `HTTP ${res.status}`);"),
    /setError\(j\.error \?\?/.test(button),
  ], [1, false]);
  eq("…and names the code only as the map's key", count(button, "records_unreadable"), 1);

  const queue = code(QUEUE);
  eq("the queue maps PATCH's two codes (records_unreadable, schema_missing) to admin sentences", [
    /const DECIDE_ERRORS: Record<string, string> = \{\s*records_unreadable: "Could not read this learner's records\. Nothing was approved\. Please try again\.",\s*schema_missing: "Could not record the override on this database\. Nothing was approved\. Please try again later\.",\s*\};/.test(queue),
  ], [true]);
  eq("…and BULK's records_unreadable", /const BULK_ERRORS: Record<string, string> = \{\s*records_unreadable: "Could not read the learners' records\. Nothing was granted\. Please try again\.",\s*\};/.test(queue), true);
  eq("decide() and the bulk panel read their maps; no error site shows j.error raw", [
    count(queue, "setError((j.error && DECIDE_ERRORS[j.error]) ?? j.error ?? `HTTP ${res.status}`);"),
    count(queue, "setErr((j.error && BULK_ERRORS[j.error]) ?? j.error ?? `HTTP ${res.status}`);"),
    /set(?:Error|Err)\(j\.error \?\?/.test(queue),
  ], [1, 1, false]);
  eq("…and names each code only as a map key", [count(queue, "records_unreadable"), count(queue, "schema_missing")], [2, 1]);
  const sentences = [
    ...[...button.matchAll(/^\s*records_unreadable: "([^"]+)",/gm)].map((m) => m[1]),
    ...[...queue.matchAll(/^\s*(?:records_unreadable|schema_missing): "([^"]+)",/gm)].map((m) => m[1]),
  ];
  eq("every mapped sentence is plain text: no snake_case code in it, and it ends with 'try again'", [
    sentences.length, sentences.some((s) => /[a-z]+_[a-z]+/.test(s)), sentences.every((s) => /Please try again( later)?\.$/.test(s)),
  ], [4, false, true]);

  const grant = queue.slice(queue.indexOf("async function grant()"), queue.indexOf("return (", queue.indexOf("async function grant()")));
  eq("the bulk answer's type reads skipped_live_retake", /skipped\?: number;\s*skipped_live_retake\?: number;\s*failed_total\?: number;/.test(grant), true);
  eq("\"nothing to grant\" only when failed_total is 0 AND no learner was skipped for a live retake", [
    /const liveRetake = j\.skipped_live_retake \?\? 0;\s*if \(\(j\.failed_total \?\? 0\) === 0 && liveRetake === 0\) \{\s*setMsg\("No learners have failed this module's official attempt — nothing to grant\."\);\s*\} else \{/.test(grant),
    count(queue, "nothing to grant"),
  ], [true, 1]);
  eq("the result line prints the live-retake count beside the open-grant count", inOrderIn(grant, [
    "`Granted ${j.granted ?? 0} extra attempt${j.granted === 1 ? \"\" : \"s\"}`",
    "((j.skipped ?? 0) > 0 ? ` · ${j.skipped} already had an open grant` : \"\")",
    "(liveRetake > 0 ? ` · ${liveRetake} had a granted retake in progress` : \"\")",
  ]), true);
  eq("non-vacuous: the panel's description of the skip is unchanged", raw(QUEUE).includes("Learners with a granted retake in progress are skipped."), true);
}

function inOrderIn(src: string, parts: string[]) {
  let at = -1;
  for (const p of parts) {
    const i = src.indexOf(p, at + 1);
    if (i < 0) return false;
    at = i;
  }
  return true;
}

console.log("\nan open revision visit's row is never in progress (ADR 0014 steps 6 and 12)");
type Row = { learning_path_id: string | null; status: string; completion_status: string; is_revision?: boolean | null };
const openOfficial: Row = { learning_path_id: "p1", status: "in_progress", completion_status: "in_progress", is_revision: false };
const openRevision: Row = { learning_path_id: "p1", status: "in_progress", completion_status: "in_progress", is_revision: true };
const openPre0103: Row = { learning_path_id: "p1", status: "in_progress", completion_status: "in_progress" };
const abandoned: Row = { learning_path_id: "p1", status: "abandoned", completion_status: "in_progress", is_revision: false };
const otherPath: Row = { learning_path_id: "p2", status: "in_progress", completion_status: "in_progress", is_revision: false };
{
  const src = code(PATH_PAGE);
  eq("the learner path page imports isRevisionAttempt from the scoring policy", /import \{[^}]*\bisRevisionAttempt\b[^}]*\} from "@\/lib\/scoring\/policy";/.test(src), true);
  const m = src.match(/\} else if \(list\.some\((\(a\) => [^\n]*?)\)\) \{\s*inProgressCourseIds\.add\(cid\);/);
  eq("inProgressCourseIds: the step's predicate skips abandoned and revision rows", m?.[1] ?? null,
    '(a) => a.completion_status === "in_progress" && a.status !== "abandoned" && !isRevisionAttempt(a)');
  const pred = m ? (new Function("isRevisionAttempt", `return ${m[1]};`)(isRevisionAttempt) as (a: Row) => boolean) : () => true;
  eq("…evaluated from the source: an open official row, an open revision row, a pre-0103 open row, an abandoned row",
    [pred(openOfficial), pred(openRevision), pred(openPre0103), pred(abandoned)], [true, false, true, false]);
  eq("…a step whose only open row is a revision visit is not in progress", [openRevision].some(pred), false);
}
{
  const src = code(DASHBOARD);
  const m = src.match(/const started =\s*done > 0 \|\|\s*attempts\.some\(\s*(\(a\) =>\s*[^\n]*?)\s*\);/);
  eq("the dashboard path tile's started test skips abandoned and revision rows", m?.[1].replace(/\s+/g, " ") ?? null,
    '(a) => a.learning_path_id === p.id && a.completion_status !== "completed" && a.status !== "abandoned" && !isRevisionAttempt(a)');
  eq("…and the dashboard imports isRevisionAttempt", /\bisRevisionAttempt,\s/.test(src.slice(0, src.indexOf("export default"))), true);
  const pred = m ? (new Function("isRevisionAttempt", "p", `return ${m[1]};`)(isRevisionAttempt, { id: "p1" }) as (a: Row) => boolean) : () => true;
  eq("…evaluated from the source for path p1: open official, open revision, pre-0103 open, abandoned, another path's row",
    [pred(openOfficial), pred(openRevision), pred(openPre0103), pred(abandoned), pred(otherPath)], [true, false, true, false, false]);
  eq("…a path whose only open row is a revision visit is not started", [openRevision, abandoned].some(pred), false);
}

console.log("\nthe scoring-rules card's copy matches ADR 0014 step 9 (ADR 0014:193)");
{
  const src = code(CARD);
  const text = src.replace(/\s+/g, " ");
  eq("the retired editor's copy is gone: no precedence, inheritance or override wording", [
    "Rules set here", "override any learning-path or journey rule", "most restrictive rule wins", "has no rule of its own",
    "no module or learning-path rule of its own", "Inheriting:", "Custom rule", "(inherit)", "fall back to their own rule",
    "follow its learning path / journey rule", "only decide which attempts", "scopeCopy", "policySourceLabel",
  ].filter((s) => text.includes(s)), []);
  eq("the ADR's words stay: the header sentence and the read-only note", [
    text.includes("Attempt rules are the same for every module (ADR 0014)."),
    text.includes("One official attempt, then review-only revision visits; extra attempts by grant"),
  ], [true, true]);
  eq("the paragraph's second sentence says revisiting never changes the result (ADR 0014 step 7's notice)",
    text.includes("Attempt rules are the same for every module (ADR 0014). Learners can revisit a module any time to review; revisiting never changes their official result. </p>"), true);
  eq("a legacy row: the badge and the stored-rule sentence both say it is read as the default", [
    /\{hasRule \? "Legacy rule · read as default" : "Platform default"\}/.test(src),
    text.includes("A rule is stored on this {targetNoun[scope]} ({describePolicy(initialRule)}); it is read as the default."),
  ], [true, true]);
  eq("Remove rule (DELETE) is kept; its confirm says nothing changes for learners", [
    /method: "DELETE"/.test(src),
    src.includes("message: `Remove the rule stored on this ${targetNoun[scope]}? Nothing changes for learners: it is already read as the default.`,"),
    /<button[\s\S]*?onClick=\{reset\}[\s\S]*?>\s*Remove rule\s*<\/button>/.test(src),
  ], [true, true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
