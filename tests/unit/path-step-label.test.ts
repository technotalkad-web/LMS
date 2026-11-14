/**
 * Unit tests for pathStepLabel() and PATH_STEP_LABEL_TEXT (lib/paths/progress.ts;
 * the owner's O4 answer of 2026-11-14, option (ii); the ADR 0024 note of
 * 2026-11-14, O4-a to O4-c):
 *
 *   (a) the two strings, exactly as the owner wrote them;
 *   (b) the four rows of O4-a through pathProgress(): done by its fact
 *       without a pass; an earlier pass with a failed retake (D14); no pass
 *       required, the standing result failed, never passed; a standing pass;
 *       and the rows around them: not done, the D14 case with no pass
 *       required (the case passed_in_window exists for, O4-b), a fact then a
 *       failed granted retake;
 *   (c) the rule on rows shaped like v_path_step_status (its column names);
 *   (d) a source scan: under app/, lib/ and components/ each string is in
 *       exactly one file, lib/paths/progress.ts, so no page writes the words
 *       itself.
 *
 * Built in phase 1 although O4-c places it with the path page of phase 2;
 * no page calls it yet.
 *
 * Run:  npx tsx tests/unit/path-step-label.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import {
  PATH_STEP_LABEL_TEXT,
  pathProgress,
  pathStepLabel,
  type PathAttempt,
  type PathGrant,
  type PathProgressInput,
  type PathStepFact,
  type PathStepInput,
} from "../../lib/paths/progress";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const uid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
const A = (n: number) => uid("a", n);
const G = (n: number) => uid("c", n);
const PATH = uid("b", 1);
const C1 = uid("cc", 1);
const C2 = uid("cc", 2);
const P = `path:${PATH}`;

type Outcome = "passed" | "failed" | "completed";
function row(n: number, course: string, outcome: Outcome, day: number): PathAttempt {
  const d = String(day).padStart(2, "0");
  return {
    id: A(n),
    course_id: course,
    course_version_id: `${course.slice(0, -4)}ffff`,
    context_kind: "path",
    context_key: P,
    status: outcome,
    completion_status: "completed",
    success_status: outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "unknown",
    score: outcome === "passed" ? 0.9 : outcome === "failed" ? 0.4 : 0.7,
    started_at: `2026-02-${d}T09:00:00Z`,
    completed_at: `2026-02-${d}T09:30:00Z`,
    is_revision: false,
    learning_path_id: PATH,
    journey_enrollment_id: null,
    journey_day: null,
    journey_day_id: null,
    journey_version_id: null,
  };
}
const grant = (n: number, course: string, used: string, day: number): PathGrant => ({
  id: G(n),
  course_id: course,
  context_key: P,
  used_attempt_id: used,
  used_at: `2026-02-${String(day).padStart(2, "0")}T10:00:00Z`,
  expires_at: null,
  created_at: `2026-02-${String(day).padStart(2, "0")}T08:00:00Z`,
});
const fact = (course: string, rulePassRequired = false): PathStepFact => ({
  path_id: PATH,
  course_id: course,
  done_at: "2026-03-01T00:00:00Z",
  rule_pass_required: rulePassRequired,
});
const step = (course: string, n: number, passRequired: boolean): PathStepInput => ({
  course_id: course,
  step_number: n,
  release_at: null,
  pass_required: passRequired,
});
const first = (i: Partial<PathProgressInput> & { steps: PathStepInput[] }) => {
  const p = pathProgress({
    pathId: PATH,
    attempts: [],
    grants: [],
    facts: [],
    completion: null,
    terms: { due_at: null, enrolled_at: "2026-01-01T00:00:00Z" },
    now: "2026-06-01T00:00:00Z",
    ...i,
  });
  return p.steps[0];
};
const view = (s: ReturnType<typeof first>) => ({
  passed_ever: s.passed_ever, passed_by_rule: s.passed_by_rule, passed_in_window: s.passed_in_window,
  latest_result: s.latest_result, label: pathStepLabel(s),
});

console.log("(a) the two strings");
eq("PATH_STEP_LABEL_TEXT, exactly as the owner wrote them", PATH_STEP_LABEL_TEXT, {
  passed_earlier: "Passed Earlier",
  completed_under_earlier_rule: "Completed Under the Earlier Rule",
});

console.log("\n(b) the four rows of O4-a, through pathProgress()");
{
  const TWO_REQUIRED = [step(C1, 1, true), step(C2, 2, true)];
  eq("1. done by its fact without a pass (completed under no required pass, then tightened): Completed Under the Earlier Rule",
    view(first({ steps: TWO_REQUIRED, attempts: [row(1, C1, "completed", 1)], facts: [fact(C1)] })),
    { passed_ever: true, passed_by_rule: false, passed_in_window: false, latest_result: "completed", label: "completed_under_earlier_rule" });
  eq("2. an earlier pass with a failed retake (D14): Passed Earlier",
    view(first({ steps: TWO_REQUIRED, attempts: [row(1, C1, "passed", 1), row(2, C1, "failed", 3)], grants: [grant(1, C1, A(2), 2)] })),
    { passed_ever: true, passed_by_rule: true, passed_in_window: true, latest_result: "failed", label: "passed_earlier" });
  eq("3. no pass required, the standing result failed, never passed: done, no label (never Passed Earlier)",
    view(first({ steps: [step(C1, 1, false)], attempts: [row(1, C1, "failed", 1)] })),
    { passed_ever: true, passed_by_rule: true, passed_in_window: false, latest_result: "failed", label: null });
  eq("4. a standing pass: done, no label",
    view(first({ steps: TWO_REQUIRED, attempts: [row(1, C1, "passed", 1)] })),
    { passed_ever: true, passed_by_rule: true, passed_in_window: true, latest_result: "passed", label: null });

  eq("not done (a pass required, failed, no fact): no label",
    view(first({ steps: TWO_REQUIRED, attempts: [row(1, C1, "failed", 1)] })),
    { passed_ever: false, passed_by_rule: false, passed_in_window: false, latest_result: "failed", label: null });
  eq("not done (no row at all): no label",
    view(first({ steps: TWO_REQUIRED })),
    { passed_ever: false, passed_by_rule: false, passed_in_window: false, latest_result: null, label: null });
  eq("D14 with no pass required: passed_by_rule says only that the window is not empty, passed_in_window tells the pass (O4-b): Passed Earlier",
    view(first({ steps: [step(C1, 1, false)], attempts: [row(1, C1, "passed", 1), row(2, C1, "failed", 3)], grants: [grant(1, C1, A(2), 2)] })),
    { passed_ever: true, passed_by_rule: true, passed_in_window: true, latest_result: "failed", label: "passed_earlier" });
  eq("a fact, then a granted retake that failed (O1-g (11)), never passed: Completed Under the Earlier Rule",
    view(first({ steps: TWO_REQUIRED, attempts: [row(1, C1, "completed", 1), row(2, C1, "failed", 5)], grants: [grant(1, C1, A(2), 4)], facts: [fact(C1)] })),
    { passed_ever: true, passed_by_rule: false, passed_in_window: false, latest_result: "failed", label: "completed_under_earlier_rule" });
  eq("a fact, then a pass under the rule as it stands: done by the rule, no label",
    view(first({ steps: TWO_REQUIRED, attempts: [row(1, C1, "completed", 1), row(2, C1, "passed", 5)], grants: [grant(1, C1, A(2), 4)], facts: [fact(C1)] })),
    { passed_ever: true, passed_by_rule: true, passed_in_window: true, latest_result: "passed", label: null });
}

console.log("\n(c) rows shaped like v_path_step_status");
{
  const r = (passed_ever: boolean, passed_by_rule: boolean, passed_in_window: boolean, latest_result: "passed" | "failed" | "completed" | null) =>
    pathStepLabel({ passed_ever, passed_by_rule, passed_in_window, latest_result });
  eq("not done reads no label, whatever the other columns", [r(false, false, false, null), r(false, false, false, "failed")], [null, null]);
  eq("done by the fact alone", r(true, false, false, "completed"), "completed_under_earlier_rule");
  eq("done by the fact alone with no standing result", r(true, false, false, null), "completed_under_earlier_rule");
  eq("a window pass, the standing result failed", r(true, true, true, "failed"), "passed_earlier");
  eq("a window pass, the standing result completed", r(true, true, true, "completed"), "passed_earlier");
  eq("a window pass, no standing result (latest_result null)", r(true, true, true, null), "passed_earlier");
  eq("a standing pass", r(true, true, true, "passed"), null);
  eq("no pass required, never passed, the standing result failed", r(true, true, false, "failed"), null);
  eq("the shown words of each key", [PATH_STEP_LABEL_TEXT[r(true, false, false, "completed")!], PATH_STEP_LABEL_TEXT[r(true, true, true, "failed")!]],
    ["Completed Under the Earlier Rule", "Passed Earlier"]);
}

console.log("\n(d) the words live in one file");
{
  const root = path.resolve(__dirname, "../..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ["app", "lib", "components"]) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  eq("the scan reads files under app/, lib/ and components/ (control)", files.length > 50, true);
  for (const text of Object.values(PATH_STEP_LABEL_TEXT)) {
    const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes(text)).map((f) => path.relative(root, f).split(path.sep).join("/"));
    eq(`"${text}" is written in exactly one file, lib/paths/progress.ts`, hits, ["lib/paths/progress.ts"]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
