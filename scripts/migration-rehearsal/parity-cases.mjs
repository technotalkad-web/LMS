// scripts/migration-rehearsal/parity-cases.mjs — the one loader of the twins'
// parity fixtures (ADR 0024 steps 62 and 63; build notes N16 and N17; the
// twins contract, section 6). Both sides import it: run.mjs's `cases` step
// binds each resolved file as one jsonb parameter into a temporary table that
// assert-0107-parity.sql expands (the SQL side), and the unit tests
// tests/unit/context-parity.test.ts and tests/unit/launch-context-facts.test.ts
// run the same cases through the TypeScript twins. Node built-ins only.
//
// The four files, under fixtures/: parity-official (pair 1, the official
// rule), parity-path (pair 2, the path rule), parity-journey (pair 3, the
// journey credit rule; its TypeScript side waits for phase 2, N17) and
// parity-launch (pair 4, launch_context's facts and the resolver's decision).
//
// What the loader enforces, so that neither side can pass by omission:
//   - format 1, a known pair, `now` an ISO time (the TypeScript side's now);
//   - ids: every symbol `@Name` maps to a lower-case uuid of the form
//     00000000-0000-0000-0107-xxxxxxxxxxxx, no uuid twice, so a fixture id
//     never collides with seed.sql or another assert file's rows;
//   - symbols: in every string value at any depth each `@Name` token is
//     replaced by its uuid (keys are never replaced); an unknown token fails;
//     after it, no upper-case uuid is left anywhere (contract 1.1: the two
//     sides order ids alike only on lower-case hex);
//   - times compared with now(): every `release_at`, `due_at` and
//     `expires_at` is null, at or before 2001-01-01 or at or after
//     2999-01-01 (contract 1.5), so the database's clock and the file's `now`
//     agree on every such comparison;
//   - cases: unique names that start with the pair (`official/` ...), sides
//     a non-empty subset of ts and sql (default both), `writer` a boolean;
//   - expect: exactly the fields of the pair's projection (FIELDS below), at
//     every level the projection names, so a field one side compares cannot
//     be missing and a field neither side compares cannot be there. A
//     `writer` case also carries expect.writer with exactly its fields.
//   - attempt and grant rows name the columns whose table defaults the two
//     sides would otherwise read differently (ROW_REQUIRED).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PAIRS = ["official", "path", "journey", "launch"];

export const ID_RE = /^00000000-0000-0000-0107-[0-9a-f]{12}$/;
const SYMBOL_RE = /@[A-Za-z][A-Za-z0-9_]*/g;
const UUID_ANY = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const TIME_KEYS = new Set(["release_at", "due_at", "expires_at"]);
const PAST = Date.parse("2001-01-01T00:00:00Z");
const FUTURE = Date.parse("2999-01-01T00:00:00Z");

// The projection of each pair (twins contract 2.4, 3.4, 4.3, 5.3; build notes
// N10, N11, N12, O1-d, O1-e). `sql` = what the SQL side compares, `ts` = what
// the TypeScript side compares; expect holds exactly their union.
export const FIELDS = {
  official: {
    sql: [
      "official_attempt_id", "official_status", "official_score", "first_score", "best_score", "latest_score",
      "completed_attempts", "scored_attempts", "practice_attempts", "attempt_count", "live_attempt_count",
      "pass_required",
    ],
    ts: [
      "official_attempt_id", "official_status", "official_score", "first_score", "best_score", "latest_score",
      "completed_attempts", "scored_attempts", "practice_attempts", "attempt_count", "live_attempt_count",
      "pass_required", "status", "stored", "done", "live_retake", "unused_grant_id",
    ],
  },
  path: {
    top: ["steps", "progress", "terms"],
    steps: [
      "course_id", "step_number", "release_at", "pass_required", "passed_ever", "passed_by_rule", "done_recorded_at",
      "latest_result", "latest_score", "done", "official_attempt_id", "retake_live", "failed", "open_attempt",
    ],
    progress: [
      "steps_total", "steps_done", "next_step", "next_course_id", "path_score", "completed", "status", "due_at",
      "enrolled_at", "started_at", "completed_at", "overdue",
    ],
    terms: ["due_at", "enrolled_at"],
  },
  journey: {
    sql: [
      "required_days", "credited_days", "credited", "credited_day_ids", "next_day", "next_day_id", "finished",
      "resumable_day_ids",
    ],
  },
  launch: { top: ["facts", "decision"] },
  // record_learning_activity's answer for a case marked writer (contract 6.4;
  // build notes N13, O1-c, O1-e). fact_written: a path row's step holds its
  // learning_path_step_completions row after the call (its done_at is the
  // call's now(), so only its presence is pinned).
  writer: ["official", "done", "passed_ever", "passed_by_rule", "path_completed", "attempt_number", "fact_written"],
};

// Columns a row must name, because a table default would be read by SQL and
// not by TypeScript (started_at defaults to now(), the statuses to their
// defaults): the fixture says them, so both sides read the same row.
const ROW_REQUIRED = {
  course_attempts: [
    "id", "course_version_id", "user_id", "organization_id", "context_kind", "context_key", "status",
    "completion_status", "success_status", "started_at",
  ],
  attempt_requests: ["id", "organization_id", "user_id", "course_id", "status", "context_kind", "context_key", "created_at"],
};

class ParityFixtureError extends Error {
  constructor(file, message) {
    super(`${path.basename(file)}: ${message}`);
    this.name = "ParityFixtureError";
  }
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function sameKeys(have, want) {
  const a = [...have].sort().join(",");
  const b = [...want].sort().join(",");
  return a === b;
}

function keyProblem(where, obj, want) {
  if (!isObject(obj)) return `${where} is not an object`;
  const keys = Object.keys(obj);
  if (sameKeys(keys, want)) return null;
  const missing = want.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !want.includes(k));
  return `${where}: ${missing.length ? `missing ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `not in the projection ${extra.join(", ")}` : ""}`;
}

// Replace every symbol in every string value, at any depth; keys stay.
function resolve(value, ids, file, where) {
  if (typeof value === "string") {
    return value.replace(SYMBOL_RE, (tok) => {
      if (!Object.prototype.hasOwnProperty.call(ids, tok)) throw new ParityFixtureError(file, `${where}: unknown symbol ${tok}`);
      return ids[tok];
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => resolve(v, ids, file, `${where}[${i}]`));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, ids, file, `${where}.${k}`);
    return out;
  }
  return value;
}

function walk(value, visit, where = "") {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      visit(null, v, `${where}[${i}]`);
      walk(v, visit, `${where}[${i}]`);
    });
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v, `${where}.${k}`);
      walk(v, visit, `${where}.${k}`);
    }
  }
}

function checkTimesAndIds(doc, file) {
  walk(doc, (k, v, where) => {
    if (TIME_KEYS.has(k) && v !== null && v !== undefined) {
      const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
      if (!Number.isFinite(t) || (t > PAST && t < FUTURE)) {
        throw new ParityFixtureError(file, `${where}: ${JSON.stringify(v)} is compared with now(); use null, a time at or before 2001-01-01 or at or after 2999-01-01`);
      }
    }
    if (typeof v === "string") {
      for (const m of v.matchAll(UUID_ANY)) {
        if (m[0] !== m[0].toLowerCase()) throw new ParityFixtureError(file, `${where}: the uuid ${m[0]} is not lower case`);
      }
    }
  });
}

function checkRows(tables, file, where) {
  if (tables === undefined) return;
  if (!isObject(tables)) throw new ParityFixtureError(file, `${where} is not an object of tables`);
  for (const [table, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows)) throw new ParityFixtureError(file, `${where}.${table} is not a list of rows`);
    for (const [i, r] of rows.entries()) {
      if (!isObject(r)) throw new ParityFixtureError(file, `${where}.${table}[${i}] is not a row`);
      for (const col of ROW_REQUIRED[table] ?? []) {
        if (!(col in r)) throw new ParityFixtureError(file, `${where}.${table}[${i}] does not name ${col}`);
      }
    }
  }
}

function checkExpect(doc, c, file) {
  const e = c.expect;
  const where = `${c.name}: expect`;
  const problems = [];
  const writerKeys = c.writer ? ["writer"] : [];
  if (doc.pair === "official") {
    if (c.sides.length === 1 && c.sides[0] === "ts" && isObject(e) && "throws" in e) {
      problems.push(keyProblem(where, e, ["throws"]));
    } else {
      problems.push(keyProblem(where, e, [...FIELDS.official.ts, ...writerKeys]));
    }
  } else if (doc.pair === "path") {
    problems.push(keyProblem(where, e, [...FIELDS.path.top, ...writerKeys]));
    if (isObject(e)) {
      if (!Array.isArray(e.steps)) problems.push(`${where}.steps is not a list`);
      else e.steps.forEach((s, i) => problems.push(keyProblem(`${where}.steps[${i}]`, s, FIELDS.path.steps)));
      problems.push(keyProblem(`${where}.progress`, e.progress, FIELDS.path.progress));
      problems.push(keyProblem(`${where}.terms`, e.terms, FIELDS.path.terms));
    }
  } else if (doc.pair === "journey") {
    problems.push(keyProblem(where, e, FIELDS.journey.sql));
  } else if (doc.pair === "launch") {
    problems.push(keyProblem(where, e, FIELDS.launch.top));
    if (isObject(e) && e.facts === null && c.sides.includes("sql")) problems.push(`${where}.facts is null on a case the SQL side runs`);
  }
  if (c.writer && isObject(e)) problems.push(keyProblem(`${where}.writer`, e.writer, FIELDS.writer));
  const bad = problems.filter(Boolean);
  if (bad.length) throw new ParityFixtureError(file, bad.join("; "));
}

/**
 * Read, validate and resolve one cases file. `file` is a path relative to
 * this folder (as expectations.json names it) or an absolute path.
 */
export function loadCases(file) {
  const abs = path.isAbsolute(file) ? file : path.join(HERE, file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ParityFixtureError(abs, `cannot be read as JSON: ${e?.message ?? e}`);
  }
  if (raw.format !== 1) throw new ParityFixtureError(abs, `format ${JSON.stringify(raw.format)} (expected 1)`);
  if (!PAIRS.includes(raw.pair)) throw new ParityFixtureError(abs, `unknown pair ${JSON.stringify(raw.pair)}`);
  if (typeof raw.now !== "string" || !Number.isFinite(Date.parse(raw.now))) throw new ParityFixtureError(abs, "now is not an ISO time");
  if (!isObject(raw.ids)) throw new ParityFixtureError(abs, "ids is not an object");
  const seen = new Map();
  for (const [sym, id] of Object.entries(raw.ids)) {
    if (!/^@[A-Za-z][A-Za-z0-9_]*$/.test(sym)) throw new ParityFixtureError(abs, `ids: ${sym} is not a symbol (@Name)`);
    if (typeof id !== "string" || !ID_RE.test(id)) throw new ParityFixtureError(abs, `ids: ${sym} = ${JSON.stringify(id)} is not 00000000-0000-0000-0107-<12 lower-case hex>`);
    if (seen.has(id)) throw new ParityFixtureError(abs, `ids: ${sym} and ${seen.get(id)} share ${id}`);
    seen.set(id, sym);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new ParityFixtureError(abs, "cases is empty");

  const doc = {
    $comment: raw.$comment,
    format: 1,
    pair: raw.pair,
    now: raw.now,
    ids: raw.ids,
    world: resolve(raw.world ?? {}, raw.ids, abs, "world"),
    cases: [],
  };
  checkRows(doc.world, abs, "world");
  const names = new Set();
  for (const [i, c0] of raw.cases.entries()) {
    if (!isObject(c0)) throw new ParityFixtureError(abs, `cases[${i}] is not an object`);
    const name = c0.name;
    if (typeof name !== "string" || !name.startsWith(`${raw.pair}/`)) {
      throw new ParityFixtureError(abs, `cases[${i}]: the name ${JSON.stringify(name)} does not start with "${raw.pair}/"`);
    }
    if (names.has(name)) throw new ParityFixtureError(abs, `two cases are named ${JSON.stringify(name)}`);
    names.add(name);
    const sides = c0.sides ?? ["ts", "sql"];
    if (!Array.isArray(sides) || sides.length === 0 || sides.some((s) => s !== "ts" && s !== "sql") || new Set(sides).size !== sides.length) {
      throw new ParityFixtureError(abs, `${name}: sides ${JSON.stringify(c0.sides)} (a non-empty subset of ts, sql)`);
    }
    if (c0.writer !== undefined && typeof c0.writer !== "boolean") throw new ParityFixtureError(abs, `${name}: writer is not a boolean`);
    const known = new Set(["name", "$comment", "sides", "writer", "given", "call", "expect"]);
    const unknown = Object.keys(c0).filter((k) => !known.has(k));
    if (unknown.length) throw new ParityFixtureError(abs, `${name}: unknown key ${unknown.join(", ")}`);
    if (!isObject(c0.call)) throw new ParityFixtureError(abs, `${name}: call is not an object`);
    const c = {
      name,
      sides: [...sides].sort(),
      writer: c0.writer === true,
      given: resolve(c0.given ?? {}, raw.ids, abs, `${name}.given`),
      call: resolve(c0.call, raw.ids, abs, `${name}.call`),
      expect: resolve(c0.expect, raw.ids, abs, `${name}.expect`),
    };
    if (c.writer && !c.sides.includes("sql")) throw new ParityFixtureError(abs, `${name}: a writer case runs on the SQL side`);
    if (raw.pair === "official" && !(isObject(c.expect) && "throws" in c.expect) && c.call.pass_required !== c.expect?.pass_required) {
      // TypeScript reads the resolved rule from call; SQL asserts that
      // instance_pass_required() answers expect's (contract 1.4)
      throw new ParityFixtureError(abs, `${name}: call.pass_required and expect.pass_required differ`);
    }
    checkRows(c.given, abs, `${name}.given`);
    checkExpect(doc, c, abs);
    doc.cases.push(c);
  }
  checkTimesAndIds(doc, abs);
  return doc;
}

/** The four files, in pair order, as expectations.json and the tests name them. */
export const CASE_FILES = PAIRS.map((p) => `fixtures/parity-${p}.cases.json`);
