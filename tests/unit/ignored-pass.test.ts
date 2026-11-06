/**
 * Unit tests for lib/xapi/ignored-pass.ts and the surfaces of ADR 0017: the record's
 * merge rules (step 12), the Attention provider through collectAttention on the
 * recording fake (step 13), the Reports section (step 14), the attempt page's block
 * and chip (step 15) and the course-page notice (step 16). A server component cannot
 * render in the unit job, so the pages are the pure models plus source checks of the
 * reading of them; spec 62 proves them in the browser.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/ignored-pass.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { collectAttention } from "../../lib/attention/collect";
import { ATTENTION_PROVIDERS, effectiveConfig } from "../../lib/attention/types";
import {
  APPLIED_ENTRY_LINE,
  IGNORED_ENTRIES_CAP,
  NOT_APPLIED_CHIP,
  NOT_APPLIED_CSV_HEADER,
  NOT_APPLIED_REPORT_LIMIT,
  NOTICE_NO_REQUEST_LINE,
  REMEDY_ADMIN_LINE,
  attemptBlockModel,
  attentionContextLine,
  ignoredPassCount,
  ignoredPassStatementIds,
  mergeIgnoredResult,
  newIgnoredRecord,
  notAppliedNotice,
  notAppliedReportRows,
  notAppliedStatementIds,
  readIgnoredRecord,
  type IgnoredEntry,
  type IgnoredRecord,
} from "../../lib/xapi/ignored-pass";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const base = (runtime: IgnoredRecord["runtime"] = "cmi5") =>
  newIgnoredRecord({ runtime, course_version_id: "v1", engine_version: "2026.10.28", floor: "2026.10.28", failed: { at: "2026-11-05T10:00:00.000Z", score: 0.5 } });
const passEntry = (id: string, at: string, extra: Partial<IgnoredEntry> = {}): IgnoredEntry => ({ verb: "passed", received_at: at, score: 1, statement_id: id, ...extra });

/** The owner's accepted wording, verbatim, with N % and the date. */
const WORDING = (facts: string) =>
  `Your official result for this module is Not passed (${facts}). The module may have shown 'Passed' in another session. That result was not applied: your first final result stands. A badge or certificate offered in that session does not reflect your recorded result.`;

function mergeRules() {
  console.log("\nnewIgnoredRecord");
  eq("a new record is empty", base(), {
    v: 1, runtime: "cmi5", course_version_id: "v1", engine_version: "2026.10.28", floor: "2026.10.28",
    failed: { at: "2026-11-05T10:00:00.000Z", score: 0.5 }, count: 0, first_at: null, last_at: null, entries: [],
  });

  console.log("\nmergeIgnoredResult: the cmi5 id key");
  const one = mergeIgnoredResult(base(), passEntry("s1", "t1"));
  eq("the first pass: changed, count 1", [one.changed, one.record.count, one.record.entries.length], [true, 1, 1]);
  eq("first_at and last_at", [one.record.first_at, one.record.last_at], ["t1", "t1"]);
  const same = mergeIgnoredResult(one.record, passEntry("s1", "t2"));
  eq("the same id again: unchanged, the very record", [same.changed, same.record === one.record], [false, true]);
  const two = mergeIgnoredResult(one.record, passEntry("s2", "t2"));
  eq("another id: count 2, first_at kept, last_at moved", [two.changed, two.record.count, two.record.first_at, two.record.last_at], [true, 2, "t1", "t2"]);
  const scoreOnly = mergeIgnoredResult(two.record, { verb: "failed", received_at: "t3", score: 0.9, statement_id: "s3" });
  eq("a score-only entry: count stays, last_at moves", [scoreOnly.record.count, scoreOnly.record.entries.length, scoreOnly.record.last_at], [2, 3, "t3"]);
  const applied = mergeIgnoredResult(base(), { verb: "passed", received_at: "t1", score: 1, applied: true, reason: "unknown" });
  eq("an applied entry: never counted", [applied.changed, applied.record.count, applied.record.entries.length], [true, 0, 1]);
  const start = base();
  const merged = mergeIgnoredResult(start, passEntry("s1", "t1"));
  eq("the first argument is not mutated", [start.entries.length, start.count, start.first_at, merged.record.entries.length], [0, 0, null, 1]);

  console.log("\nmergeIgnoredResult: the SCORM pair key");
  const entry = (lesson: string | undefined, score: number | null, at: string): IgnoredEntry => ({ verb: "passed", received_at: at, score, ...(lesson ? { lesson_status: lesson } : {}) });
  const s1 = mergeIgnoredResult(base("scorm12"), entry("passed", 1, "t1"));
  const s2 = mergeIgnoredResult(s1.record, entry("passed", 1, "t2"));
  eq("the same pair again: changed, repeats 2, one entry", [s2.changed, s2.record.entries[0].repeats, s2.record.entries.length], [true, 2, 1]);
  eq("…count, first_at and last_at do not move", [s2.record.count, s2.record.first_at, s2.record.last_at], [1, "t1", "t1"]);
  const s3 = mergeIgnoredResult(s2.record, entry("passed", 1, "t3"));
  eq("and again: repeats 3", s3.record.entries[0].repeats, 3);
  const s4 = mergeIgnoredResult(s3.record, entry("passed", 0.9, "t4"));
  eq("another score: a new entry", [s4.record.entries.length, s4.record.count, s4.record.last_at], [2, 2, "t4"]);
  const s5 = mergeIgnoredResult(s4.record, entry("incomplete", 0.9, "t5"));
  eq("another lesson_status: a new entry", s5.record.entries.length, 3);
  const s6 = mergeIgnoredResult(s5.record, entry("passed", 1, "t6"));
  eq("the pair is against the last entry only", s6.record.entries.length, 4);
  const appliedScorm = mergeIgnoredResult(s1.record, { ...entry("passed", 1, "t9"), applied: true, reason: "unreadable" });
  eq("an applied entry is never a repeat", appliedScorm.record.entries.length, 2);
  const afterApplied = mergeIgnoredResult(appliedScorm.record, entry("passed", 1, "t10"));
  eq("nothing repeats an applied entry", afterApplied.record.entries.length, 3);
  const cmi = mergeIgnoredResult(mergeIgnoredResult(base(), entry("passed", 1, "t1")).record, entry("passed", 1, "t2"));
  eq("the pair key is SCORM's: on cmi5 an id-less pair adds", cmi.record.entries.length, 2);

  console.log("\nmergeIgnoredResult: the cap");
  let full = base();
  for (let n = 0; n < IGNORED_ENTRIES_CAP; n++) full = mergeIgnoredResult(full, passEntry(`s${n}`, `t${n}`)).record;
  eq("the cap is 20", [IGNORED_ENTRIES_CAP, full.entries.length, full.count], [20, 20, 20]);
  const over = mergeIgnoredResult(full, passEntry("s-new", "t-new"));
  eq("the 21st: unchanged, no entry, no count, no last_at", [over.changed, over.record === full, over.record.last_at], [false, true, "t19"]);
  eq("…and the merge says so, for the log line", over.capped, true);
  eq("the oldest kept", over.record.entries[0].statement_id, "s0");
  eq("a re-POST of a dropped id brings nothing back", mergeIgnoredResult(full, passEntry("s-new", "t-later")).record.count, 20);
  eq("a re-POST of a recorded id at the cap is no capped result", mergeIgnoredResult(full, passEntry("s3", "t-later")).capped, undefined);
  eq("below the cap the flag is never there", "capped" in mergeIgnoredResult(base(), passEntry("s1", "t1")), false);
  let fullScorm = base("scorm12");
  for (let n = 0; n < IGNORED_ENTRIES_CAP; n++) fullScorm = mergeIgnoredResult(fullScorm, entry("passed", n / 100, `t${n}`)).record;
  const repeatAtCap = mergeIgnoredResult(fullScorm, entry("passed", 19 / 100, "t-r"));
  eq("at the cap a SCORM repeat still raises repeats", [repeatAtCap.changed, repeatAtCap.record.entries[19].repeats, repeatAtCap.record.entries.length], [true, 2, 20]);
  eq("…with no flag", "capped" in repeatAtCap, false);

  console.log("\nignoredPassCount and readIgnoredRecord");
  eq("no record, bad shapes → 0", [null, undefined, "x", 7, [], {}, { count: "3" }, { count: -1 }, { count: Number.NaN }, { count: 0 }].map(ignoredPassCount), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  eq("a record → its count", ignoredPassCount(two.record), 2);
  eq("readIgnoredRecord: a record", readIgnoredRecord(two.record) === two.record, true);
  eq("readIgnoredRecord: bad shapes → null", [null, "x", {}, { v: 2, entries: [], failed: {} }, { v: 1, entries: "x", failed: {} }, { v: 1, entries: [] }, { v: 1, entries: [], failed: "x" }].map(readIgnoredRecord), [null, null, null, null, null, null, null]);

  console.log("\nthe ids the surfaces read");
  const mixed = mergeIgnoredResult(mergeIgnoredResult(mergeIgnoredResult(base(), passEntry("p1", "t1")).record, { verb: "failed", received_at: "t2", score: 0.9, statement_id: "f1" }).record, { verb: "passed", received_at: "t3", score: 1, applied: true, reason: "unknown" }).record;
  eq("the marker: every held result, ignored passes and score-only alike; never an applied entry", notAppliedStatementIds(mixed), ["p1", "f1"]);
  eq("the chip: ignored passes only", ignoredPassStatementIds(mixed), ["p1"]);
  eq("an applied entry that carried an id would still not be marked", notAppliedStatementIds({ ...mixed, entries: [{ verb: "passed", received_at: "t", score: 1, statement_id: "x", applied: true }] }), []);
  eq("…nor chipped", ignoredPassStatementIds({ ...mixed, entries: [{ verb: "passed", received_at: "t", score: 1, statement_id: "x", applied: true }] }), []);
  eq("bad shapes → no ids", [notAppliedStatementIds(null), ignoredPassStatementIds("x")], [[], []]);
}

function texts() {
  console.log("\nthe learner notice: the owner's wording, verbatim");
  eq("with N % and the date", notAppliedNotice({ score: 0.5, at: "2026-11-05T10:00:00.000Z" }), WORDING("50 %, 2026-11-05"));
  eq("N is an integer percent with the space", notAppliedNotice({ score: 0.875, at: "2026-11-05T10:00:00.000Z" }), WORDING("88 %, 2026-11-05"));
  eq("a score of 0 is a score", notAppliedNotice({ score: 0, at: "2026-11-05T10:00:00.000Z" }), WORDING("0 %, 2026-11-05"));
  eq("a fail recorded with no score: the date alone, never null %", notAppliedNotice({ score: null, at: "2026-11-05T10:00:00.000Z" }), WORDING("2026-11-05"));
  eq("a fail recorded with no date: the score alone", notAppliedNotice({ score: 0.5, at: null }), WORDING("50 %"));
  eq("neither: no brackets", notAppliedNotice({ score: null, at: null }).startsWith("Your official result for this module is Not passed. The module"), true);
  eq("the else line", NOTICE_NO_REQUEST_LINE, "If you think this is wrong, contact your administrator.");
  eq("the chip", NOT_APPLIED_CHIP, "Not applied: the official result was already final");
  eq("the applied line", APPLIED_ENTRY_LINE, "Today's one-time upgrade applied (engine version unreadable)");

  console.log("\nattentionContextLine");
  const rec = mergeIgnoredResult(base(), passEntry("p1", "2026-11-06T09:00:00.000Z", { score: 0.9, same_session: false })).record;
  eq("the facts in the order of the ADR", attentionContextLine(rec, "Home loans"),
    "Home loans · cmi5 · engine 2026.10.28 · recorded Not passed 50 % on 2026-11-05 · pass of 90 % not applied on 2026-11-06 (1 time; same session: no)");
  const twice = mergeIgnoredResult(rec, passEntry("p2", "2026-11-07T09:00:00.000Z", { score: 1, same_session: true })).record;
  eq("K times, the last pass's score and session", attentionContextLine(twice, "Home loans"),
    "Home loans · cmi5 · engine 2026.10.28 · recorded Not passed 50 % on 2026-11-05 · pass of 100 % not applied on 2026-11-07 (2 times; same session: yes)");
  const xapi = mergeIgnoredResult(newIgnoredRecord({ runtime: "xapi", course_version_id: "v1", engine_version: null, floor: "2026.10.28", failed: { at: null, score: null } }), passEntry("p1", "2026-11-06T09:00:00.000Z", { score: null, same_session: null })).record;
  eq("no course, no scores, no dates, n.a.", attentionContextLine(xapi, null),
    "a course · xapi · engine unknown · recorded Not passed · pass not applied on 2026-11-06 (1 time; same session: n.a.)");
  const afterScoreOnly = mergeIgnoredResult(rec, { verb: "failed", received_at: "2026-11-07T09:00:00.000Z", score: 0.2, same_session: true }).record;
  eq("a later score-only entry does not change which pass is described", attentionContextLine(afterScoreOnly, "C").includes("pass of 90 %") && attentionContextLine(afterScoreOnly, "C").includes("same session: no"), true);

  console.log("\nattemptBlockModel");
  eq("no record → no block", [attemptBlockModel(null), attemptBlockModel(undefined), attemptBlockModel({})], [null, null, null]);
  const b = attemptBlockModel(rec)!;
  eq("count > 0: the heading, the notice, the count line", [b.heading, b.showNotice, b.countLine], ["Passed result not applied", true, "Ignored passes: 1"]);
  eq("the engine and floor", b.engineLine, "Engine 2026.10.28 · floor 2026.10.28");
  eq("the recorded fail", b.failedLine, "Recorded fail · 2026-11-05 10:00 · 50 %");
  eq("the entry", b.entries.map((e) => [e.line, e.adminNote]), [["2026-11-06 09:00 · passed · 90 % · same session: no", null]]);
  const sc = attemptBlockModel(mergeIgnoredResult(base(), { verb: "failed", received_at: "2026-11-06T09:00:00.000Z", score: 0.9, statement_id: "f1" }).record)!;
  eq("a score-only record: Result notes, no notice, no count line", [sc.heading, sc.showNotice, sc.countLine], ["Result notes", false, null]);
  const ap = attemptBlockModel(mergeIgnoredResult(base(), { verb: "passed", received_at: "2026-11-06T09:00:00.000Z", score: 1, applied: true, reason: "unreadable", error: "no_object" }).record)!;
  eq("an applied-only record: Result notes, the fixed line, no not-applied wording anywhere", [ap.heading, ap.showNotice, ap.entries[0].line], ["Result notes", false, `${APPLIED_ENTRY_LINE} · 2026-11-06`]);
  eq("the applied entry's reason and read error, for admins", ap.entries[0].adminNote, "Reason: unreadable · Read error: no_object");
  const ap2 = attemptBlockModel(mergeIgnoredResult(base(), { verb: "passed", received_at: "2026-11-06T09:00:00.000Z", score: 1, applied: true, reason: "unknown" }).record)!;
  eq("reason unknown, no error", ap2.entries[0].adminNote, "Reason: unknown");
  const rep = attemptBlockModel(mergeIgnoredResult(mergeIgnoredResult(base("scorm12"), { verb: "passed", received_at: "2026-11-06T09:00:00.000Z", score: 1, lesson_status: "passed", same_session: null }).record, { verb: "passed", received_at: "x", score: 1, lesson_status: "passed" }).record)!;
  eq("repeats and n.a. on SCORM", rep.entries[0].line, "2026-11-06 09:00 · passed · 100 % · same session: n.a. · received 2 times");
  const sess = attemptBlockModel(mergeIgnoredResult(newIgnoredRecord({ runtime: "cmi5", course_version_id: "v", engine_version: "2026.10.28", floor: "2026.10.28", failed: { at: "2026-11-05T10:00:00.000Z", score: 0.5, session_id: "A" } }), passEntry("p", "2026-11-06T09:00:00.000Z", { session_id: "B", same_session: false })).record)!;
  eq("the sessions", [sess.failedLine, sess.entries[0].line], ["Recorded fail · 2026-11-05 10:00 · 50 % · session A", "2026-11-06 09:00 · passed · 100 % · session B · same session: no"]);
  eq("the remedy line names the three paths and the gap", [/Attempt Requests/.test(REMEDY_ADMIN_LINE), /support ticket/.test(REMEDY_ADMIN_LINE), /bulk grant/.test(REMEDY_ADMIN_LINE), /no per-learner grant/.test(REMEDY_ADMIN_LINE)], [true, true, true, true]);

  console.log("\nnotAppliedReportRows");
  const attempts = [{ id: "a1", n: 1 }, { id: "a2", n: 2 }, { id: "a3", n: 3 }, { id: "a4", n: 4 }];
  const withPass = { ...rec, last_at: "last-at" };
  const scoreOnlyRec = mergeIgnoredResult(base(), { verb: "failed", received_at: "t", score: 0.9, statement_id: "f" }).record;
  const appliedRec = mergeIgnoredResult(base(), { verb: "passed", received_at: "t", score: 1, applied: true, reason: "unknown" }).record;
  eq("a row for each count > 0, in the read's order; none for score-only, applied-only or an unknown attempt",
    notAppliedReportRows([
      { id: "a3", ignored_pass: withPass },
      { id: "a2", ignored_pass: scoreOnlyRec },
      { id: "a4", ignored_pass: appliedRec },
      { id: "a1", ignored_pass: twice },
      { id: "a9", ignored_pass: withPass },
    ], attempts).map((r) => [r.attempt.id, r.ignoredPasses, r.lastAt]),
    [["a3", 1, "last-at"], ["a1", 2, "2026-11-07T09:00:00.000Z"]]);
  eq("the CSV header carries the attempt id", NOT_APPLIED_CSV_HEADER, ["Learner", "Course", "Recorded result", "Score", "Ignored passes", "Last ignored at", "Attempt id"]);
  eq("the ceiling", NOT_APPLIED_REPORT_LIMIT, 500);
}

/* ---------------- the Attention provider ---------------- */
type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
function fakeClient(respond: (q: Query) => { data?: unknown; error?: unknown }) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "in", "is", "not", "order", "limit"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve({ data: null, error: null, ...respond(q) });
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries };
}

async function attention() {
  console.log("\nthe registry");
  eq("the entry", ATTENTION_PROVIDERS.find((p) => p.type === "ignored-pass"), {
    type: "ignored-pass",
    label: "Passed result not applied",
    description: "A pass received after a final fail on the same attempt was not applied (new-engine rule).",
    defaultEnabled: true,
    defaultPriority: "high",
    configurablePriority: true,
  });
  eq("effectiveConfig(null) gives every organisation the default", effectiveConfig(null).byType["ignored-pass"], { enabled: true, priority: "high" });
  eq("it is appended last", ATTENTION_PROVIDERS[ATTENTION_PROVIDERS.length - 1].type, "ignored-pass");
  eq("collect.ts dispatches it under run(", /p\.type === "ignored-pass"\) jobs\.push\(run\(ignoredPassItems\(svc, orgId, orgSlug, c\.priority\)\)\);/.test(read("lib/attention/collect.ts")), true);

  const onlyThis = { enabled: true, config: Object.fromEntries(ATTENTION_PROVIDERS.filter((p) => p.type !== "ignored-pass").map((p) => [p.type, { enabled: false }])) };
  const rec = mergeIgnoredResult(base(), passEntry("p1", "2026-11-06T09:00:00.000Z", { score: 0.9, same_session: false })).record;
  const scoreOnly = mergeIgnoredResult(base(), { verb: "failed", received_at: "t", score: 0.9, statement_id: "f" }).record;
  const applied = mergeIgnoredResult(base(), { verb: "passed", received_at: "t", score: 1, applied: true, reason: "unknown" }).record;
  const answer = (rows: unknown[]) => (q: Query) => {
    if (q.table === "course_attempts") return { data: rows };
    if (q.table === "profiles") {
      const s = String(q.ops.find((o) => o.op === "select")?.args[0]);
      return { data: s.includes("email") ? [{ id: "u1", email: "learner@example.test" }, { id: "u2", email: "other@example.test" }] : [{ id: "u1", first_name: "Test", last_name: "Learner" }] };
    }
    if (q.table === "courses") return { data: [{ id: "c1", title: "Home loans" }] };
    return { data: [] };
  };
  const row = (id: string, user: string, record: unknown, courseId: string | null = "c1") => ({
    id, user_id: user, course_version_id: "v1", score: 0.5, completed_at: "2026-11-05T10:00:00.000Z", ignored_pass: record, course_versions: courseId ? { course_id: courseId } : null,
  });
  console.log("\nignoredPassItems, through collectAttention");
  {
    const { client, queries } = fakeClient(answer([row("a1", "u1", rec), row("a2", "u2", scoreOnly), row("a3", "u2", applied), row("a4", "u2", null)]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map() });
    eq("one item per attempt that holds an ignored pass; none for score-only, applied-only or no record", res.items.map((i) => i.key), ["ignored-pass:a1"]);
    const it = res.items[0];
    eq("the item", it, {
      key: "ignored-pass:a1",
      type: "ignored-pass",
      priority: "high",
      title: "Passed result not applied",
      who: "Test Learner",
      context: "Home loans · cmi5 · engine 2026.10.28 · recorded Not passed 50 % on 2026-11-05 · pass of 90 % not applied on 2026-11-06 (1 time; same session: no)",
      occurredAt: "2026-11-06T09:00:00.000Z",
      actionLabel: "Review the attempt",
      href: "/acme/courses/c1/attempts/a1",
      inline: null,
      dismissible: true,
    });
    const q = queries.find((x) => x.table === "course_attempts")!;
    const op = (name: string) => q.ops.filter((o) => o.op === name).map((o) => o.args);
    eq("the read: the embed, the org, failed rows with a record, newest first, up to 200", [op("select"), op("eq"), op("not"), op("order"), op("limit")], [
      [["id, user_id, course_version_id, score, completed_at, ignored_pass, course_versions(course_id)"]],
      [["organization_id", "o1"], ["success_status", "failed"]],
      [["ignored_pass", "is", null]],
      [["ignored_pass->>last_at", { ascending: false }]],
      [[200]],
    ]);
    eq("the budget: one read, then the three name reads", queries.map((x) => x.table).sort(), ["course_attempts", "courses", "profiles", "profiles"]);
  }
  {
    const { client } = fakeClient(answer([row("a1", "u1", rec)]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map([["ignored-pass:a1", "2026-11-06T09:00:00.000Z"]]) });
    eq("marked read at last_at: hidden", res.items.length, 0);
    const later = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map([["ignored-pass:a1", "2026-11-06T08:00:00.000Z"]]) });
    eq("a later ignored pass brings it back", later.items.length, 1);
  }
  {
    const two = mergeIgnoredResult(mergeIgnoredResult(base(), passEntry("p1", "2026-11-06T08:00:00.000Z")).record, passEntry("p2", "2026-11-06T09:00:00.000Z")).record;
    const { client } = fakeClient(answer([row("a1", "u1", two)]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map([["ignored-pass:a1", "2026-11-06T08:30:00.000Z"]]) });
    eq("two passes, marked read between them: it comes back, dated by the last", res.items.map((i) => i.occurredAt), ["2026-11-06T09:00:00.000Z"]);
  }
  {
    const { client, queries } = fakeClient(() => ({ error: { code: "42703", message: "column course_attempts.ignored_pass does not exist" } }));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map() });
    eq("{ error } on the read (before 0104): no items, no further read", [res.items, queries.length], [[], 1]);
  }
  {
    const { client } = fakeClient((q) => (q.table === "course_attempts" ? { data: [row("a1", "u1", rec)], error: { code: "57014", message: "timeout" } } : {}));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map() });
    eq("an answer with an error is not read, whatever else it holds", res.items, []);
  }
  {
    const { client, queries } = fakeClient(answer([]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map() });
    eq("no rows: no items, one read", [res.items, queries.length], [[], 1]);
  }
  {
    const { client } = fakeClient(answer([{ ...row("a1", "u1", rec), course_versions: [{ course_id: "c1" }] }]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map() });
    eq("an array embed: the href is still built from course_id", res.items[0].href, "/acme/courses/c1/attempts/a1");
  }
  {
    const { client } = fakeClient(answer([row("a1", "u1", rec, null)]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map() });
    eq("no course on the embed: the Reports section, and no invented title", [res.items[0].href, res.items[0].context?.startsWith("a course · ")], ["/acme/reports#not-applied", true]);
  }
  {
    const { client } = fakeClient(answer([row("a1", "u9", rec)]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: onlyThis, dismissals: new Map() });
    eq("no name, no email: the id's head", res.items[0].who, "u9");
  }
  {
    const off = { enabled: true, config: { ...onlyThis.config, "ignored-pass": { enabled: false } } };
    const { client, queries } = fakeClient(answer([row("a1", "u1", rec)]));
    const res = await collectAttention({ svc: client, orgId: "o1", orgSlug: "acme", settings: off, dismissals: new Map() });
    eq("the type off: nothing read", [res.items, queries.length], [[], 0]);
  }

  console.log("\nthe order on real postgrest-js, under a stubbed fetch");
  {
    const realFetch = globalThis.fetch;
    let order: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      order = new URL(input instanceof Request ? input.url : String(input)).searchParams.get("order");
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const sb = createClient("http://stub.supabase.test", "stub-key", { auth: { persistSession: false } });
      await sb.from("course_attempts").select("id, ignored_pass").order("ignored_pass->>last_at", { ascending: false });
      eq("the JSON path reaches the URL verbatim", order, "ignored_pass->>last_at.desc");
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

function pages() {
  console.log("\nReports (source)");
  const reports = read("app/[org]/(admin)/reports/page.tsx");
  const attemptsRead = reports.slice(reports.indexOf("const ATTEMPT_COLUMNS ="), reports.indexOf("const attempts = attemptRows as Attempt[];"));
  eq("the attempts read never names the column", attemptsRead.includes("ignored_pass"), false);
  eq("the separate read: the org, failed, with a record, newest first, the ceiling",
    /\.select\("id, ignored_pass"\)\s*\.eq\("organization_id", org\.id\)\s*\.eq\("success_status", "failed"\)\s*\.not\("ignored_pass", "is", null\)\s*\.order\("ignored_pass->>last_at", \{ ascending: false \}\)\s*\.limit\(NOT_APPLIED_REPORT_LIMIT\);/.test(reports), true);
  eq("on the page's service client, after the role gate", reports.indexOf("canViewReports(role)") < reports.indexOf('select("id, ignored_pass")'), true);
  eq("a full page is logged, ids only", /\.length >= NOT_APPLIED_REPORT_LIMIT\) \{\s*console\.warn\(JSON\.stringify\(\{ event: "ignored_pass_reports_truncated", organization_id: org\.id \}\)\);/.test(reports), true);
  eq("{ error } on either read → no rows at all (null), which removes the section, the card and the marker", /const \{ data: attemptRows, error: attemptsErr \} = await readPagedWithOptionalColumn/.test(reports) && /const notAppliedRows =\s*ignoredErr \|\| attemptsErr\s*\? null\s*: notAppliedReportRows\(/.test(reports), true);
  eq("the section renders only on a clean read", /\{notAppliedRows && \(\s*<section id="not-applied"/.test(reports), true);
  eq("the card only on a clean read, its badge the count, its link the section", /\.\.\.\(notAppliedRows\s*\? \[\s*\{\s*title: NOT_APPLIED_SECTION_TITLE,[\s\S]*?href: `#not-applied`,\s*badge: `\$\{notAppliedRows\.length\}`,/.test(reports), true);
  eq("a clean read with no row: the at-risk layout's empty state", /notAppliedRows\.length === 0 \? \(\s*<Card className="p-0">\s*<EmptyState/.test(reports), true);
  eq("the marker reads the same set", /const notAppliedAttemptIds = new Set\(\(notAppliedRows \?\? \[\]\)\.map\(\(r\) => r\.attempt\.id\)\);/.test(reports) && /notAppliedAttemptIds\.has\(a\.id\) && \(/.test(reports), true);
  eq("the table caps at 50 with the footer", /notAppliedRows\.slice\(0, 50\)/.test(reports) && /Showing 50 of \{notAppliedRows\.length\}\. Use CSV download for the full list\./.test(reports), true);
  eq("each row links to the attempt page", /href=\{`\/\$\{orgSlug\}\/courses\/\$\{course\.id\}\/attempts\/\$\{r\.attempt\.id\}`\}/.test(reports), true);
  eq("the CSV rows end with the attempt id", /r\.lastAt \?\? "",\s*r\.attempt\.id,\s*\];/.test(reports), true);

  console.log("\nthe attempt page (source)");
  const attempt = read("app/[org]/(learner)/courses/[courseId]/attempts/[attemptId]/page.tsx");
  eq("the read is select(*), so a database without 0104 still renders", /\.from\("course_attempts"\)\s*\.select\("\*"\)\s*\.eq\("id", attemptId\)/.test(attempt), true);
  eq("the block comes after the stat grid, before the interactions", attempt.indexOf('label="Time on course"') < attempt.indexOf('data-testid="ignored-pass-block"') && attempt.indexOf('data-testid="ignored-pass-block"') < attempt.indexOf('<h2 className="serif text-2xl">Interactions</h2>'), true);
  eq("the chip reads the ignored passes' ids", /s\.id && ignoredPassIds\.has\(s\.id\) && \(/.test(attempt) && /new Set\(ignoredPassStatementIds\(a\.ignored_pass\)\)/.test(attempt), true);
  eq("the remedy line and the read error are admins' only", /\{isAdmin && ignoredBlock\.showNotice && \(/.test(attempt) && /\{isAdmin && e\.adminNote && /.test(attempt), true);
  eq("the sentence shows only on the official attempt: the render cases are in attempt-page-official-sentence.test.ts", /\{officialSentence && ignoredRecord && \(/.test(attempt), true);
  eq("the reads run only with count > 0, on the page's RLS client, for the row's learner and the version's course", /const officialSentence =\s*ignoredBlock\?\.showNotice === true && \(await officialFailedAttemptId\(supabase, a\.user_id, v\.course_id\)\) === a\.id;/.test(attempt), true);
  eq("the learner gate stays: the hidden-history redirect", /show_attempts_history === false/.test(attempt) && /!isAdmin &&/.test(attempt), true);

  console.log("\nthe course page (source)");
  const course = read("app/[org]/(learner)/courses/[courseId]/page.tsx");
  eq("the notice's condition: a clean grant read, official failed and count > 0, nothing else", /const notAppliedText =\s*!historyUnavailable && scoring\.officialStatus === "failed" && ignoredPassCount\(officialRecord\) > 0\s*\?/.test(course), true);
  eq("the record comes from the official attempt", /\(scoring\.officialAttempt as \{ ignored_pass\?: unknown \} \| null\)\?\.ignored_pass/.test(course), true);
  eq("the attempts read stays select(*)", /\.from\("course_attempts"\)\s*\/\/ select\("\*"\) for 0075 deploy safety \(progress_pct\)\.\s*\.select\("\*"\)/.test(course), true);
  const scoreAt = course.indexOf("Official score");
  const noticeAt = course.indexOf('data-testid="not-applied-notice"');
  eq("the notice sits inside the result card, after the score and before the history", scoreAt > 0 && scoreAt < noticeAt && noticeAt < course.indexOf('data-testid="official-result-history"'), true);
  eq("the card wraps, the notice takes the full width", /bg-canvas\/40 flex flex-wrap items-center justify-between gap-3/.test(course) && /className="w-full text-sm text-ink" data-testid="not-applied-notice"/.test(course), true);
  eq("the else line shows only when the button does not", /\{!canRequestAttempt && \(\s*<p className="mt-1 text-xs text-muted" data-testid="not-applied-contact">/.test(course), true);
  eq("one request button, not moved", (course.match(/<RequestAttemptButton /g) ?? []).length, 1);
}

async function main() {
  mergeRules();
  texts();
  await attention();
  pages();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
