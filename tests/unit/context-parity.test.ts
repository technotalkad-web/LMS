/**
 * The twins' parity, the TypeScript side (ADR 0024 step 62's row
 * "context-parity.test.ts"; build notes N16 and N17; twins contract 2, 3, 4
 * and 6): the cases of scripts/migration-rehearsal/fixtures/parity-*.cases.json,
 * read through the one loader both sides import
 * (scripts/migration-rehearsal/parity-cases.mjs), run through the TypeScript
 * twins. The rehearsal runs the same cases through the SQL rules
 * (assert-0107-parity.sql), so each case's `expect` is what both sides answer.
 *
 *   (a) pair 1, the official rule: contextResult() on the learner's rows of
 *       the course, any context, and the approved grants of the (learner,
 *       course); every field of the projection (contract 2.4), and for a
 *       writer case the writer's `done` against contextResult's;
 *   (b) pair 2, the path rule: pathProgress() on the path's steps (each
 *       step's rule resolved as the view resolves it: the step's own, else
 *       the course's), the rows and approved grants on the steps' courses,
 *       the learner's step facts, the completion row and the terms; every
 *       column of both views (contract 3.4, build notes N10 to N12, O1-d),
 *       and for a writer case the writer's done, passed_ever and
 *       passed_by_rule against the step's (the writer reads them from
 *       v_path_step_status, O1-c and O1-k, never from contextResult);
 *   (c) pair 3, the journey credit rule: its TypeScript twin changes its
 *       signature for every caller in phase 2 (step 45), so its cases are on
 *       the dated pending list below, which must name exactly the file's
 *       cases; the phase 2 pull request runs them and empties it (N17,
 *       contract A14). The SQL side runs them now.
 *   (d) the files themselves: the four load, and the projection lists the
 *       loader enforces are the ones this test compares;
 *   (e) the loader refuses a file that could let a side pass by omission or
 *       disagree with the database's clock (a minimal file in a temporary
 *       folder, edited one rule at a time);
 *   (f) the key twin: contextKeyOf() built from each fixture row's kind and
 *       tags gives the context_key the row names, which the SQL side compares
 *       with the generated column (contract 1.1).
 *
 * The launch pair runs in launch-context-facts.test.ts, as the record names
 * it (step 62).
 *
 * Run:  npx tsx tests/unit/context-parity.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CASE_FILES, FIELDS, loadCases } from "../../scripts/migration-rehearsal/parity-cases.mjs";
import {
  ContextKeyError,
  contextKeyOf,
  contextResult,
  type ContextAttempt,
  type ContextGrant,
  type ContextRef,
} from "../../lib/scoring/context";
import { pathProgress, type PathAttempt, type PathGrant, type PathStepFact, type PathStepInput } from "../../lib/paths/progress";
import { DEFAULT_POLICY } from "../../lib/scoring/policy";

let pass = 0, fail = 0;
const ok = (n: string, problems: string[]) => {
  if (problems.length === 0) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}\n      ${problems.join("\n      ")}`); }
};

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type ParityCase = {
  name: string;
  sides: Array<"ts" | "sql">;
  writer: boolean;
  given: Tables;
  call: Record<string, unknown>;
  expect: Record<string, unknown>;
};
type ParityDoc = { pair: string; now: string; world: Tables; cases: ParityCase[] };

const load = (file: string) => loadCases(file) as unknown as ParityDoc;

// The comparator of contract 6.2 rule 5, as assert-0107-parity.sql's
// par_diff: objects key by key (a key on one side only is a mismatch), arrays
// in order, numbers at 4 decimals, an ISO time against an ISO time as an
// instant, anything else exactly.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
function diff(p: string, want: unknown, got: unknown, out: string[] = []): string[] {
  if (isObj(want) && isObj(got)) {
    for (const k of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
      if (!(k in want)) out.push(`${p}.${k}: not in expect (got ${JSON.stringify(got[k])})`);
      else if (!(k in got)) out.push(`${p}.${k}: expected ${JSON.stringify(want[k])}, not produced`);
      else diff(`${p}.${k}`, want[k], got[k], out);
    }
  } else if (Array.isArray(want) && Array.isArray(got)) {
    if (want.length !== got.length) out.push(`${p}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    else want.forEach((w, i) => diff(`${p}[${i}]`, w, got[i], out));
  } else if (typeof want === "number" && typeof got === "number") {
    if (Math.round(want * 1e4) !== Math.round(got * 1e4)) out.push(`${p}: expected ${want}, got ${got}`);
  } else if (typeof want === "string" && typeof got === "string" && ISO_TIME.test(want) && ISO_TIME.test(got)) {
    if (Date.parse(want) !== Date.parse(got)) out.push(`${p}: expected ${want}, got ${got}`);
  } else if (JSON.stringify(want) !== JSON.stringify(got)) {
    out.push(`${p}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return out;
}
const only = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));

// The rows a case sees: the pair's world and the case's own.
function tables(doc: ParityDoc, c: ParityCase) {
  return (t: string): Row[] => [...(doc.world[t] ?? []), ...(c.given[t] ?? [])];
}
const str = (x: unknown) => (typeof x === "string" ? x : null);
const num = (x: unknown) => (typeof x === "number" ? x : null);

// A course_attempts row as the twins read it; the loader makes every row name
// the columns whose table default the two sides could read differently.
function attemptOf(r: Row, courseOf: Map<string, string>): PathAttempt {
  return {
    id: String(r.id),
    course_version_id: String(r.course_version_id),
    course_id: courseOf.get(String(r.course_version_id)) ?? "",
    context_kind: r.context_kind as ContextAttempt["context_kind"],
    context_key: r.context_key as string,
    status: r.status as ContextAttempt["status"],
    completion_status: r.completion_status as ContextAttempt["completion_status"],
    success_status: r.success_status as ContextAttempt["success_status"],
    score: num(r.score),
    started_at: String(r.started_at),
    completed_at: str(r.completed_at),
    is_revision: r.is_revision === true,
    learning_path_id: str(r.learning_path_id),
    journey_enrollment_id: str(r.journey_enrollment_id),
    journey_day: num(r.journey_day),
    journey_day_id: str(r.journey_day_id),
    journey_version_id: str(r.journey_version_id),
  };
}
// An approved attempt_requests row; contextResult reads every grant it is
// given as approved, so the builder passes the approved ones only.
function grantsOf(rows: Row[], userId: string): PathGrant[] {
  return rows
    .filter((r) => r.user_id === userId && r.status === "approved")
    .map((r) => ({
      id: String(r.id),
      course_id: String(r.course_id),
      context_key: r.context_key as string,
      used_attempt_id: str(r.used_attempt_id),
      used_at: str(r.used_at),
      expires_at: str(r.expires_at),
      created_at: String(r.created_at),
      reissued_from: str(r.reissued_from),
    }));
}
function courseOfVersion(t: (n: string) => Row[]) {
  return new Map(t("course_versions").map((v) => [String(v.id), String(v.course_id)]));
}

// --- (a) the official rule -------------------------------------------------
function runOfficial(doc: ParityDoc, c: ParityCase): string[] {
  const t = tables(doc, c);
  const userId = String(c.call.user_id);
  const courseId = String(c.call.course_id);
  const courseOf = courseOfVersion(t);
  const attempts: ContextAttempt[] = t("course_attempts")
    .filter((r) => r.user_id === userId && courseOf.get(String(r.course_version_id)) === courseId)
    .map((r) => attemptOf(r, courseOf));
  const grants: ContextGrant[] = grantsOf(t("attempt_requests"), userId).filter((g) => g.course_id === courseId);
  const input = {
    key: String(c.call.context_key),
    attempts,
    grants,
    policy: DEFAULT_POLICY,
    passRequired: c.call.pass_required === true,
    now: doc.now,
  };
  if ("throws" in c.expect) {
    try {
      contextResult(input);
      return [`expected ${String(c.expect.throws)}, nothing was thrown`];
    } catch (e) {
      return e instanceof ContextKeyError && e.name === c.expect.throws ? [] : [`expected ${String(c.expect.throws)}, got ${String(e)}`];
    }
  }
  const r = contextResult(input);
  const s = r.scoring;
  const got = {
    official_attempt_id: s.officialAttempt?.id ?? null,
    official_status: s.officialStatus,
    official_score: s.officialScore,
    first_score: s.firstScore,
    best_score: s.bestScore,
    latest_score: s.latestScore,
    completed_attempts: s.completedAttempts,
    scored_attempts: s.scoredAttempts,
    practice_attempts: s.practiceAttempts,
    attempt_count: r.rows.filter((a) => !a.is_revision).length,
    live_attempt_count: r.officialRows.length,
    pass_required: input.passRequired,
    status: r.status,
    stored: r.stored,
    done: r.done,
    live_retake: r.liveRetake,
    unused_grant_id: r.unusedGrant?.id ?? null,
  };
  const out = diff("expect", only(c.expect, FIELDS.official.ts), got);
  // Contract 6.4: for an Individual row the writer's done is the official
  // attempt's done under the resolved rule, which is contextResult's.
  if (c.writer) diff("expect.writer.done", (c.expect.writer as Row).done, r.done, out);
  return out;
}

// --- (b) the path rule -----------------------------------------------------
function runPath(doc: ParityDoc, c: ParityCase): string[] {
  const t = tables(doc, c);
  const pathId = String(c.call.path_id);
  const userId = String(c.call.user_id);
  const courseOf = courseOfVersion(t);
  const coursePass = new Map(t("courses").map((x) => [String(x.id), x.pass_required === true]));
  const steps: PathStepInput[] = t("learning_path_courses")
    .filter((x) => x.path_id === pathId)
    .map((x) => ({
      course_id: String(x.course_id),
      step_number: Number(x.step_number),
      release_at: str(x.release_at),
      // the view's resolution by join: the step's own rule, else the course's
      pass_required: typeof x.pass_required === "boolean" ? x.pass_required : (coursePass.get(String(x.course_id)) ?? false),
    }));
  const stepCourses = new Set(steps.map((s) => s.course_id));
  // the reader passes rows on the current steps' courses only (contract 3.2)
  const attempts = t("course_attempts")
    .filter((r) => r.user_id === userId && stepCourses.has(courseOf.get(String(r.course_version_id)) ?? ""))
    .map((r) => attemptOf(r, courseOf));
  const grants = grantsOf(t("attempt_requests"), userId).filter((g) => stepCourses.has(g.course_id));
  const facts: PathStepFact[] = t("learning_path_step_completions")
    .filter((f) => f.path_id === pathId && f.user_id === userId)
    .map((f) => ({ path_id: String(f.path_id), course_id: String(f.course_id), done_at: String(f.done_at), rule_pass_required: f.rule_pass_required === true }));
  const done = t("learning_path_completions").find((x) => x.path_id === pathId && x.user_id === userId);
  const terms = c.expect.terms as { due_at: string | null; enrolled_at: string | null };
  const p = pathProgress({
    pathId,
    steps,
    attempts,
    grants,
    facts,
    completion: done ? { completed_at: String(done.completed_at), path_score: num(done.path_score) } : null,
    terms,
    now: doc.now,
  });
  const got = {
    steps: p.steps.map((s) => only(s, FIELDS.path.steps)),
    progress: only(p, FIELDS.path.progress),
    terms,
  };
  const out = diff("expect", only(c.expect, FIELDS.path.top), got);
  if (c.writer) {
    // The writer reads done, passed_ever and passed_by_rule for a path row
    // from v_path_step_status after its fact insert (O1-c); its twin is the
    // step's answer, never contextResult's done (O1-k).
    const w = c.expect.writer as Row;
    const row = t("course_attempts").find((r) => r.id === c.call.writer_attempt_id);
    const step = p.steps.find((s) => s.course_id === courseOf.get(String(row?.course_version_id)));
    if (!step) out.push("expect.writer: the writer's row is on no step of the path");
    else {
      diff("expect.writer.done", w.done, step.done, out);
      diff("expect.writer.passed_ever", w.passed_ever, step.passed_ever, out);
      diff("expect.writer.passed_by_rule", w.passed_by_rule, step.passed_by_rule, out);
    }
  }
  return out;
}

// --- (c) the journey credit rule: pending until phase 2 ----------------------
// Dated 2026-11-14 (ADR 0024 phase 1; build note N17, contract A14). The
// TypeScript twin (computeJourneyState on creditedDays, creditedDaysFor,
// resumableDayIdsFor) takes its new signature in phase 2 (step 45); the
// phase 2 pull request runs these cases on it and empties this list. Until
// then the SQL side runs them (assert-0107-parity.sql (P3)).
const JOURNEY_TS_PENDING = {
  since: "2026-11-14",
  until: "the phase 2 pull request (ADR 0024 step 45)",
  cases: [
    "journey/no re-pin: the credits read by day identity equal the old count",
    "journey/a course on two days: each day is its own required day",
    "journey/a legacy_cross_context credit counts like any other kind",
    "journey/a credit on a day now a rest day counts towards nothing",
    "journey/a credit above days_total counts towards nothing",
    "journey/a credit on a removed day counts towards nothing; an open attempt there is resumable",
    "journey/zero required days: never complete",
    "journey/a completed enrolment's credits are still read",
    "journey/resumable: open official journey rows only, in uuid order",
    "journey/repin-a: a day inserted at number 2",
    "journey/repin-b: days 2 and 3 swapped",
    "journey/repin-c: the course of day 4 swapped",
    "journey/repin-d: day 4 removed, every remaining day credited",
    "journey/repin-e: a shorter version, every remaining day credited",
    "journey/repin-f: a completed enrolment stays on its version",
    "journey/repin-g: kept on a slot_backfill version",
    "journey/repin-h: day 3 relaxed and credited by the rule change",
  ],
};

// --- run ----------------------------------------------------------------------
const docs = new Map<string, ParityDoc>();
console.log("\n(d) the four files load through the one loader");
for (const f of CASE_FILES) {
  try {
    const d = load(f);
    docs.set(d.pair, d);
    ok(`${f}: ${d.cases.length} cases`, []);
  } catch (e) {
    ok(f, [String(e)]);
  }
}
ok("the loader's projection lists are the ones compared here", [
  ...(FIELDS.official.sql.every((k: string) => FIELDS.official.ts.includes(k)) ? [] : ["an official SQL field the TypeScript side does not compare"]),
  ...(FIELDS.path.top.join() === "steps,progress,terms" ? [] : ["the path projection's parts changed"]),
]);

const official = docs.get("official");
if (official) {
  console.log("\n(a) the official rule: contextResult()");
  for (const c of official.cases.filter((x) => x.sides.includes("ts"))) ok(c.name, runOfficial(official, c));
}
const pathDoc = docs.get("path");
if (pathDoc) {
  console.log("\n(b) the path rule: pathProgress()");
  for (const c of pathDoc.cases.filter((x) => x.sides.includes("ts"))) ok(c.name, runPath(pathDoc, c));
}
const journey = docs.get("journey");
if (journey) {
  console.log(`\n(c) the journey credit rule: TypeScript side pending since ${JOURNEY_TS_PENDING.since}, until ${JOURNEY_TS_PENDING.until}`);
  const names = journey.cases.filter((x) => x.sides.includes("ts")).map((x) => x.name);
  const listed = JOURNEY_TS_PENDING.cases;
  ok(`the pending list names exactly the file's ${names.length} journey cases`, [
    ...names.filter((n) => !listed.includes(n)).map((n) => `not on the pending list: ${n}`),
    ...listed.filter((n) => !names.includes(n)).map((n) => `on the pending list, not in the file: ${n}`),
  ]);
  for (const n of names) console.log(`  … pending (phase 2): ${n}`);
}

// --- (f) the key twin: contextKeyOf() against the generated column -------------
// The SQL side compares every context_key a fixture row names with the value
// the database generates (assert-0107-parity.sql, par_put); here every such
// row of the four files is given to contextKeyOf() built from the row's kind
// and tags (twins contract 1.1), so the two keys are one string on both sides.
console.log("\n(f) contextKeyOf() gives every fixture row's generated key");
for (const d of docs.values()) {
  const rows: Array<[string, Row]> = [];
  for (const t of ["course_attempts", "attempt_requests"]) {
    for (const r of d.world[t] ?? []) rows.push([`world.${t}`, r]);
    for (const c of d.cases.filter((x) => x.sides.includes("sql"))) {
      for (const r of c.given[t] ?? []) rows.push([`${c.name}: ${t}`, r]);
    }
  }
  const problems: string[] = [];
  for (const [where, r] of rows) {
    const ref: ContextRef =
      r.context_kind === "path" ? { kind: "path", pathId: String(r.learning_path_id) }
      : r.context_kind === "journey" ? { kind: "journey", enrollmentId: String(r.journey_enrollment_id), dayId: String(r.journey_day_id) }
      : r.context_kind === "preview" ? { kind: "preview", runId: str(r.preview_run_id), dayId: str(r.journey_day_id) }
      : { kind: "individual" };
    let key: string;
    try {
      key = contextKeyOf(ref);
    } catch (e) {
      key = `threw ${String(e)}`;
    }
    if (key !== r.context_key) problems.push(`${where} ${String(r.id)}: contextKeyOf gives ${key}, the row says ${String(r.context_key)}`);
  }
  ok(`${d.pair}: ${rows.length} rows`, problems);
}

// --- (e) the loader refuses a file that could pass by omission ------------------
console.log("\n(e) the loader's refusals (a minimal official file, written to a temporary folder)");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-loader-"));
  const base = () => ({
    format: 1,
    pair: "official",
    now: "2026-06-01T00:00:00Z",
    ids: { "@L": "00000000-0000-0000-0107-010000000001", "@C": "00000000-0000-0000-0107-020000000001" },
    world: {},
    cases: [{
      name: "official/minimal",
      given: {},
      call: { user_id: "@L", course_id: "@C", context_key: "individual", pass_required: false },
      expect: Object.fromEntries(FIELDS.official.ts.map((k: string) => [k, k === "pass_required" ? false : null])) as Record<string, unknown>,
    }],
  });
  type Doc = ReturnType<typeof base>;
  const tryLoad = (name: string, edit: (d: Doc) => void): string | null => {
    const d = base();
    edit(d);
    const file = path.join(dir, `${name}.cases.json`);
    fs.writeFileSync(file, JSON.stringify(d));
    try {
      loadCases(file);
      return null;
    } catch (e) {
      return String(e);
    }
  };
  ok("the minimal file loads", tryLoad("ok", () => {}) === null ? [] : [String(tryLoad("ok", () => {}))]);
  const refusals: Array<[string, (d: Doc) => void, RegExp]> = [
    ["a projection field missing from expect", (d) => { delete d.cases[0].expect.unused_grant_id; }, /missing unused_grant_id/],
    ["a field outside the projection", (d) => { d.cases[0].expect.extra = 1; }, /not in the projection extra/],
    ["a time compared with now() inside the window", (d) => { d.world = { course_assignments: [{ release_at: "2026-01-01T00:00:00Z" }] }; }, /compared with now/],
    ["an upper-case uuid", (d) => { d.cases[0].call.course_id = "00000000-0000-0000-0107-0A0000000001"; }, /not lower case/],
    ["an unknown symbol", (d) => { d.cases[0].call.user_id = "@Nobody"; }, /unknown symbol @Nobody/],
    ["an id outside the parity range", (d) => { d.ids["@C"] = "00000000-0000-0000-0000-020000000001"; }, /is not 00000000-0000-0000-0107/],
    ["two symbols sharing one id", (d) => { d.ids["@C"] = d.ids["@L"]; }, /share/],
    ["a name without the pair's prefix", (d) => { d.cases[0].name = "minimal"; }, /does not start with "official\/"/],
    ["an attempt row that does not name its started_at", (d) => {
      (d.cases[0].given as Tables).course_attempts = [{ id: "@L", course_version_id: "@C", user_id: "@L", organization_id: "@C", context_kind: "individual",
        context_key: "individual", status: "in_progress", completion_status: "in_progress", success_status: "unknown" }];
    }, /does not name started_at/],
    ["call and expect disagreeing on the resolved rule", (d) => { d.cases[0].call.pass_required = true; }, /pass_required differ/],
  ];
  for (const [what, edit, re] of refusals) {
    const err = tryLoad(what.replace(/\W+/g, "-"), edit);
    ok(`refused: ${what}`, err !== null && re.test(err) ? [] : [`got ${err ?? "no error"}`]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
