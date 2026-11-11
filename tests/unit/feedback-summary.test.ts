/**
 * Unit tests for lib/interactions/feedback.ts (ADR 0021 G.1): the Learner
 * Feedback section's figures and the CSV rows, and the three readers against
 * a recording fake of the supabase-js query builder (the
 * tests/unit/revision-visits.test.ts pattern):
 *   - groupQuestions keeps scale order, zero-fills a scale position with no
 *     bucket and keeps the "No answer" bucket apart;
 *   - isStarScale, starAverage, distribution, yesNoShares, bucketLabel
 *     (readLang: en-US, hi, a single foreign key, the id fallback),
 *     truncateComment, feedbackCsvRow (raw cells: the route escapes them),
 *     exportRange (blank, date-only inclusive, invalid);
 *   - readFeedbackSummary: the RPC, the order, the page, `capped` at 1,000
 *     rows; `missing` on 42P01 and on a missing function; `failed` on any
 *     other error with one log line holding no row;
 *   - readFeedbackComments and pageFeedbackRows: filters, order, pages, the
 *     20-page cap and its one-row probe.
 *
 * Run:  npx tsx tests/unit/feedback-summary.test.ts   (or npm run test:unit)
 * (No DB: a recording fake stands in for the supabase-js query builder.)
 */
import {
  bucketLabel,
  COMMENTS_SHOWN,
  distribution,
  exportRange,
  feedbackCsvHeader,
  feedbackCsvRow,
  FEEDBACK_EXPORT_MAX_PAGES,
  groupQuestions,
  isStarScale,
  learnerName,
  pageFeedbackRows,
  questionKind,
  readFeedbackComments,
  readFeedbackSummary,
  starAverage,
  TEXT_BUCKET,
  truncateComment,
  yesNoShares,
  type FeedbackResponseRow,
  type FeedbackSummaryRow,
} from "../../lib/interactions/feedback";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- fake supabase client (the revision-visits.test.ts pattern, plus rpc, not, gte, lt) ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; rpc: boolean; ops: Op[] };
type Responder = (q: Query) => { data?: unknown; error?: unknown };

function fakeClient(respond: Responder) {
  const queries: Query[] = [];
  const builder = (q: Query) => {
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "in", "not", "gte", "lt", "order", "limit", "range"]) {
      b[op] = (...args: unknown[]) => {
        q.ops.push({ op, args });
        return b;
      };
    }
    const settle = () => Promise.resolve({ data: null, error: null, ...respond(q) });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
    return b;
  };
  const client = {
    from(table: string) {
      const q: Query = { table, rpc: false, ops: [] };
      queries.push(q);
      return builder(q);
    },
    rpc(fn: string, args: unknown) {
      const q: Query = { table: fn, rpc: true, ops: [{ op: "args", args: [args] }] };
      queries.push(q);
      return builder(q);
    },
  };
  return { client: client as never, queries };
}
const all = (q: Query, op: string) => q.ops.filter((o) => o.op === op).map((o) => o.args);
const arg = (q: Query, op: string, col?: string) => q.ops.find((o) => o.op === op && (col === undefined || o.args[0] === col))?.args;

function captureWarn<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  return fn()
    .then((value) => ({ value, lines }))
    .finally(() => {
      console.warn = real;
    });
}

/* ---------------- fixtures: the A.1 shapes (ADR 0021 Context) ---------------- */

const AU = "https://lms.example/au/pkg-1";
const LIKERT_SCALE = ["Not Applicable", "Strongly Disagree", "Disagree", "Agree", "Strongly Agree"].map((d, i) => ({
  id: `likert_${i}`,
  description: { "en-US": d },
}));
const STAR_SCALE = [1, 2, 3, 4, 5].map((n) => ({ id: `star_${n}`, description: { "en-US": String(n) } }));
const YES_NO = [
  { id: "yes", description: { "en-US": "Sure" } },
  { id: "no", description: { "en-US": "Not really" } },
];

function sr(over: Partial<FeedbackSummaryRow>): FeedbackSummaryRow {
  return {
    interaction_id: `${AU}/s1`,
    interaction_type: "likert",
    response: null,
    learners: 0,
    responses: 0,
    first_at: "2026-11-01T10:00:00Z",
    last_at: "2026-11-02T10:00:00Z",
    question: { "en-US": "The pace was right" },
    question_name: { "en-US": "Pace" },
    scale: null,
    choices: null,
    slot_languages: ["en"],
    ...over,
  };
}

const SUMMARY: FeedbackSummaryRow[] = [
  // s1 likert: likert_1 x2, likert_4 x1, one blank; 5 responses (a retake answered twice)
  sr({ interaction_id: `${AU}/s1`, response: "likert_1", learners: 2, responses: 5, scale: LIKERT_SCALE }),
  sr({ interaction_id: `${AU}/s1`, response: "likert_4", learners: 1, responses: 5, scale: LIKERT_SCALE }),
  sr({ interaction_id: `${AU}/s1`, response: null, learners: 1, responses: 5, scale: LIKERT_SCALE }),
  // s2 stars: 3 x star_5, 2 x star_4, 1 x star_2, 1 x star_1 → 26 / 7 = 3.71
  sr({ interaction_id: `${AU}/s2`, response: "star_1", learners: 1, responses: 7, scale: STAR_SCALE, question: { "en-US": "Rate the module" } }),
  sr({ interaction_id: `${AU}/s2`, response: "star_2", learners: 1, responses: 7, scale: STAR_SCALE, question: { "en-US": "Rate the module" } }),
  sr({ interaction_id: `${AU}/s2`, response: "star_4", learners: 2, responses: 7, scale: STAR_SCALE, question: { "en-US": "Rate the module" } }),
  sr({ interaction_id: `${AU}/s2`, response: "star_5", learners: 3, responses: 7, scale: STAR_SCALE, question: { "en-US": "Rate the module" } }),
  // s3 yes/no: yes x3, no x1, custom labels
  sr({ interaction_id: `${AU}/s3`, interaction_type: "choice", response: "no", learners: 1, responses: 4, choices: YES_NO }),
  sr({ interaction_id: `${AU}/s3`, interaction_type: "choice", response: "yes", learners: 3, responses: 4, choices: YES_NO }),
  // s4 comments
  sr({ interaction_id: `${AU}/s4`, interaction_type: "long-fill-in", response: TEXT_BUCKET, learners: 2, responses: 2, question: null, question_name: { "en-US": "Anything else?" } }),
  // s5 a third-party type
  sr({ interaction_id: `${AU}/s5`, interaction_type: "numeric", response: "7", learners: 1, responses: 3, question: null, question_name: null }),
  sr({ interaction_id: `${AU}/s5`, interaction_type: "numeric", response: "9", learners: 2, responses: 3, question: null, question_name: null }),
];

async function main() {
  console.log("\nisStarScale / questionKind");
  {
    eq("star_1..5 is a star scale", isStarScale(STAR_SCALE), true);
    eq("likert_0..4 is not", isStarScale(LIKERT_SCALE), false);
    eq("a mixed scale is not", isStarScale([...STAR_SCALE, { id: "likert_0" }]), false);
    eq("no scale is not", [isStarScale(null), isStarScale([])], [false, false]);
    eq("kinds", [
      questionKind("likert", STAR_SCALE), questionKind("likert", LIKERT_SCALE), questionKind("choice", YES_NO),
      questionKind("long-fill-in", null), questionKind("fill-in", null), questionKind("numeric", null), questionKind(null, null),
    ], ["stars", "likert", "choice", "comment", "comment", "other", "other"]);
  }

  console.log("\nstarAverage / distribution / yesNoShares");
  {
    const stars = SUMMARY.filter((r) => r.interaction_id === `${AU}/s2`);
    eq("starAverage = 3.7 for the fixture", starAverage(stars), 3.7);
    eq("starAverage null with no counted rating (a blank only)", starAverage([{ response: null, learners: 4 }]), null);
    eq("starAverage null with no rows", starAverage([]), null);
    const d = distribution(SUMMARY.filter((r) => r.interaction_id === `${AU}/s1`));
    eq("distribution: answered and no answer apart", [d.answered, d.noAnswer], [3, 1]);
    eq("distribution: shares sum to 1 excluding No answer", Math.round(d.buckets.reduce((a, b) => a + (b.share ?? 0), 0) * 1e9) / 1e9, 1);
    eq("distribution: no answered row → share null", distribution([{ response: null, learners: 2 }]).buckets, []);
    const yn = yesNoShares(SUMMARY.filter((r) => r.interaction_id === `${AU}/s3`), YES_NO);
    eq("yesNoShares: choice order and custom labels", yn.map((b) => [b.id, b.label, b.learners, b.share]), [
      ["yes", "Sure", 3, 0.75],
      ["no", "Not really", 1, 0.25],
    ]);
    eq("yesNoShares: a choice with no row is 0", yesNoShares([{ response: "yes", learners: 2 }], YES_NO).map((b) => [b.id, b.learners, b.share]), [
      ["yes", 2, 1],
      ["no", 0, 0],
    ]);
  }

  console.log("\nbucketLabel (readLang)");
  {
    const scale = (description: unknown) => [{ id: "likert_3", description }];
    eq("en-US", bucketLabel({ response: "likert_3" }, { scale: scale({ "en-US": "Agree", hi: "सहमत" }) }), "Agree");
    eq("hi only", bucketLabel({ response: "likert_3" }, { scale: scale({ hi: "सहमत" }) }), "सहमत");
    eq("a single foreign key", bucketLabel({ response: "likert_3" }, { scale: scale({ "hi-Latn": "Sahmat" }) }), "Sahmat");
    eq("the id fallback (no description)", bucketLabel({ response: "likert_3" }, { scale: [{ id: "likert_3" }] }), "likert_3");
    eq("an id the definition does not name", bucketLabel({ response: "likert_9" }, { scale: LIKERT_SCALE }), "likert_9");
    eq("a choice", bucketLabel({ response: "no" }, { choices: YES_NO }), "Not really");
    eq("No answer", bucketLabel({ response: null }, { scale: LIKERT_SCALE }), "No answer");
    eq("the comment bucket", bucketLabel({ response: TEXT_BUCKET }, {}), "Comment");
  }

  console.log("\ngroupQuestions");
  {
    const qs = groupQuestions(SUMMARY);
    eq("one question per interaction id, in id order", qs.map((q) => q.interactionId.slice(AU.length)), ["/s1", "/s2", "/s3", "/s4", "/s5"]);
    const [likert, stars, yn, comment, other] = qs;
    eq("likert: scale order, zero-filled, No answer apart", likert.buckets.map((b) => [b.id, b.label, b.learners]), [
      ["likert_0", "Not Applicable", 0],
      ["likert_1", "Strongly Disagree", 2],
      ["likert_2", "Disagree", 0],
      ["likert_3", "Agree", 0],
      ["likert_4", "Strongly Agree", 1],
    ]);
    eq("likert: counts", [likert.kind, likert.responses, likert.learners, likert.answered, likert.noAnswer, likert.average], ["likert", 5, 4, 3, 1, null]);
    eq("likert: shares of the answered", likert.buckets.map((b) => b.share === null ? null : Math.round(b.share * 100)), [0, 67, 0, 0, 33]);
    eq("likert: title and name", [likert.title, likert.name], ["The pace was right", "Pace"]);
    eq("stars: kind, average and every star", [stars.kind, stars.average, stars.buckets.map((b) => b.learners)], ["stars", 3.7, [1, 1, 0, 2, 3]]);
    eq("yes/no: choice order with labels", [yn.kind, yn.buckets.map((b) => `${b.label}:${b.learners}`)], ["choice", ["Sure:3", "Not really:1"]]);
    eq("comment: no buckets, counted comments, the name as title", [comment.kind, comment.buckets, comment.answered, comment.title, comment.name], ["comment", [], 2, "Anything else?", null]);
    eq("other: raw values, most frequent first, the id as title", [other.kind, other.buckets.map((b) => `${b.id}:${b.learners}`), other.title], ["other", ["9:2", "7:1"], `${AU}/s5`]);
    eq("slot languages and dates", [likert.slotLanguages, likert.firstAt, likert.lastAt], [["en"], "2026-11-01T10:00:00Z", "2026-11-02T10:00:00Z"]);
    eq("no rows → no questions", groupQuestions([]), []);
    eq("a question without a scale shows its raw answers in order met", groupQuestions([sr({ response: "likert_2", learners: 1, responses: 1, scale: null })])[0].buckets.map((b) => b.id), ["likert_2"]);
  }

  console.log("\ntruncateComment / learnerName");
  {
    const long = "x".repeat(1001);
    eq("cut at 1,000 characters with an ellipsis", [truncateComment(long).length, truncateComment(long).endsWith("…")], [1001, true]);
    eq("unchanged at 1,000", truncateComment("y".repeat(1000)), "y".repeat(1000));
    eq("unchanged below", truncateComment("short"), "short");
    eq("code points, not UTF-16 units", truncateComment("😀".repeat(3), 2), "😀😀…");
    eq("name: first and last", learnerName({ first_name: "Asha", last_name: "Rao", email: "a@example.test" }), "Asha Rao");
    eq("name: the email fallback", learnerName({ first_name: " ", last_name: null, email: "a@example.test" }), "a@example.test");
  }

  console.log("\nfeedbackCsvHeader / feedbackCsvRow (raw cells)");
  {
    const header = feedbackCsvHeader();
    eq("16 columns in the ADR's order", header, [
      "Responded at (ISO)", "Stored at (ISO)", "Employee ID", "Email", "First name", "Last name", "Question", "Question id",
      "Type", "Response", "Response label", "Counted", "Version id", "Slot language", "Attempt id", "Statement id",
    ]);
    const row: FeedbackResponseRow = {
      statement_row_id: "r1", statement_id: "st1", attempt_id: "at1", user_id: "u1", organization_id: "o1", course_id: "c1",
      course_version_id: "v1", package_id: "p1", slot_language: "hi", slot_display_name: "Hindi",
      email: "a@example.test", first_name: "Asha", last_name: "Rao", employee_id: "EMP-1",
      stored: "2026-11-02T10:00:00.123456+00:00", responded_at: "2026-11-02T15:29:59+05:30",
      interaction_id: `${AU}/s1`, interaction_type: "likert", question: { "en-US": "Pace?" }, question_name: null,
      scale: LIKERT_SCALE, choices: null, response: "likert_3", unanswered: false, is_latest: true,
    };
    const cells = feedbackCsvRow(row);
    eq("a likert row in header order", cells, [
      "2026-11-02T09:59:59.000Z", "2026-11-02T10:00:00.123Z", "EMP-1", "a@example.test", "Asha", "Rao", "Pace?", `${AU}/s1`,
      "likert", "likert_3", "Agree", "yes", "v1", "hi", "at1", "st1",
    ]);
    eq("as many cells as the header", cells.length, header.length);
    const comment = feedbackCsvRow({ ...row, interaction_type: "long-fill-in", scale: null, response: "=SUM(1)+1 clear", is_latest: false });
    eq("a comment stays raw (=SUM(1) is escaped by the route), empty label, Counted no", [comment[9], comment[10], comment[11]], ["=SUM(1)+1 clear", "", "no"]);
    const blank = feedbackCsvRow({ ...row, response: null, unanswered: true });
    eq("an item left blank: empty response, label No answer", [blank[9], blank[10]], ["", "No answer"]);
    const marked = feedbackCsvRow({ ...row, response: "likert_2", unanswered: true });
    eq("a response with the unanswered extension is labelled by the response, as the summary buckets it", [marked[9], marked[10]], ["likert_2", "Disagree"]);
    const bare = feedbackCsvRow({ ...row, responded_at: null, employee_id: null, slot_language: null, first_name: null, last_name: null, question: null, question_name: { "en-US": "Slide" }, interaction_type: null });
    eq("absent values are empty cells; the name stands in for the question", [bare[0], bare[2], bare[4], bare[5], bare[6], bare[8], bare[13]], ["", "", "", "", "Slide", "", ""]);
    eq("a yes/no label", feedbackCsvRow({ ...row, interaction_type: "choice", scale: null, choices: YES_NO, response: "no" })[10], "Not really");
  }

  console.log("\nexportRange");
  {
    eq("absent and blank are absent", [exportRange(null, null), exportRange("", " ")], [
      { ok: true, gte: null, lt: null, from: null, to: null },
      { ok: true, gte: null, lt: null, from: null, to: null },
    ]);
    eq("a date-only to is inclusive (next day, exclusive bound)", exportRange("2026-11-01", "2026-11-02"), {
      ok: true, gte: "2026-11-01T00:00:00.000Z", lt: "2026-11-03T00:00:00.000Z", from: "2026-11-01", to: "2026-11-02",
    });
    eq("a full timestamp to is exclusive as given", exportRange(null, "2026-11-02T12:00:00Z").ok && (exportRange(null, "2026-11-02T12:00:00Z") as { lt: string }).lt, "2026-11-02T12:00:00.000Z");
    eq("an invalid from", exportRange("not-a-date", null), { ok: false, param: "from" });
    eq("an invalid to", exportRange(null, "2026-13-45"), { ok: false, param: "to" });
  }

  console.log("\nreadFeedbackSummary");
  {
    const { client, queries } = fakeClient(() => ({ data: SUMMARY.map((r) => ({ ...r, learners: String(r.learners) })) }));
    const r = await readFeedbackSummary(client, "course-1");
    eq("one RPC call with p_course_id", [queries.length, queries[0].rpc, queries[0].table, all(queries[0], "args")[0]], [1, true, "course_feedback_summary", [{ p_course_id: "course-1" }]]);
    eq("ordered by (interaction_id, response), nulls last", all(queries[0], "order"), [
      ["interaction_id", { ascending: true }],
      ["response", { ascending: true, nullsFirst: false }],
    ]);
    eq("one page of 1,000", arg(queries[0], "range"), [0, 999]);
    eq("rows read, counts as numbers, not capped", [r.rows.length, r.rows[0].learners, r.capped, r.missing, r.failed], [SUMMARY.length, 2, false, false, false]);
    const full = fakeClient(() => ({ data: Array.from({ length: 1000 }, (_, i) => sr({ interaction_id: `q${i}`, response: "x", learners: 1, responses: 1 })) }));
    eq("capped when 1,000 rows return", (await readFeedbackSummary(full.client, "course-1")).capped, true);
    const missing = await captureWarn(() => readFeedbackSummary(fakeClient(() => ({ error: { code: "42P01", message: 'relation "public.v_course_feedback_responses" does not exist' } })).client, "course-1"));
    eq("42P01 → missing, no log", [missing.value.missing, missing.value.failed, missing.value.rows, missing.lines], [true, false, [], []]);
    const noFn = await captureWarn(() => readFeedbackSummary(fakeClient(() => ({ error: { code: "PGRST202", message: "Could not find the function public.course_feedback_summary(p_course_id) in the schema cache" } })).client, "course-1"));
    eq("a missing function (PGRST202) → missing", [noFn.value.missing, noFn.value.failed], [true, false]);
    const failed = await captureWarn(() => readFeedbackSummary(fakeClient(() => ({ error: { code: "57014", message: "canceling statement due to statement timeout" } })).client, "course-1"));
    eq("any other error → failed, rows empty", [failed.value.missing, failed.value.failed, failed.value.rows], [false, true, []]);
    eq("one log line: event, course id and code only", failed.lines.map((l) => JSON.parse(l)), [{ event: "feedback_read_failed", course_id: "course-1", code: "57014" }]);
    const threw = await captureWarn(() => readFeedbackSummary({ rpc() { throw new Error("network"); } } as never, "course-1"));
    eq("a thrown error → failed", [threw.value.failed, threw.lines.length], [true, 1]);
  }

  console.log("\nreadFeedbackComments");
  {
    const rows = [{ statement_row_id: "r2", interaction_id: `${AU}/s4`, response: "Great" }];
    const { client, queries } = fakeClient(() => ({ data: rows }));
    const r = await readFeedbackComments(client, "course-1");
    const q = queries[0];
    eq("reads the view", [q.rpc, q.table], [false, "v_course_feedback_responses"]);
    eq("the select names no statement JSON beyond the question", String(arg(q, "select")?.[0]).includes("raw"), false);
    eq("course, comment types, answered, counted only", [arg(q, "eq", "course_id"), arg(q, "in"), arg(q, "not"), arg(q, "eq", "is_latest")], [
      ["course_id", "course-1"],
      ["interaction_type", ["long-fill-in", "fill-in"]],
      ["response", "is", null],
      ["is_latest", true],
    ]);
    eq("newest first", all(q, "order"), [["stored", { ascending: false }], ["statement_row_id", { ascending: false }]]);
    eq("the newest 50", [arg(q, "limit"), COMMENTS_SHOWN], [[50], 50]);
    eq("rows returned", [r.rows.length, r.missing, r.failed], [1, false, false]);
    const missing = await readFeedbackComments(fakeClient(() => ({ error: { code: "PGRST205", message: "Could not find the table 'public.v_course_feedback_responses' in the schema cache" } })).client, "course-1");
    eq("a missing view → missing", [missing.missing, missing.failed], [true, false]);
    const failed = await captureWarn(() => readFeedbackComments(fakeClient(() => ({ error: { code: "XX000", message: "boom" } })).client, "course-1"));
    eq("any other error → failed with one log line", [failed.value.failed, failed.lines.length, failed.lines[0].includes("Great")], [true, 1, false]);
  }

  console.log("\npageFeedbackRows");
  {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ statement_row_id: `r${i}` }));
    // 2,500 rows: three pages, the last short
    let total = 2500;
    const { client, queries } = fakeClient((q) => {
      const [from, to] = arg(q, "range") as [number, number];
      return { data: mk(Math.max(0, Math.min(to, total - 1) - from + 1)) };
    });
    const seen: number[] = [];
    const r = await pageFeedbackRows(client, "course-1", { gte: "2026-11-01T00:00:00.000Z", lt: "2026-11-03T00:00:00.000Z" }, (rows) => seen.push(rows.length));
    eq("three pages read and handed over", [queries.length, seen, r.rows, r.capped, r.failed, r.missing], [3, [1000, 1000, 500], 2500, false, false, false]);
    eq("the ranges", queries.map((q) => arg(q, "range")), [[0, 999], [1000, 1999], [2000, 2999]]);
    eq("course and stored bounds", [arg(queries[0], "eq", "course_id"), arg(queries[0], "gte"), arg(queries[0], "lt")], [
      ["course_id", "course-1"],
      ["stored", "2026-11-01T00:00:00.000Z"],
      ["stored", "2026-11-03T00:00:00.000Z"],
    ]);
    eq("ordered by (stored, statement_row_id)", all(queries[0], "order"), [["stored", { ascending: true }], ["statement_row_id", { ascending: true }]]);
    const noBounds = fakeClient(() => ({ data: [] }));
    await pageFeedbackRows(noBounds.client, "course-1", {}, () => {});
    eq("no bounds → no gte or lt", [all(noBounds.queries[0], "gte").length, all(noBounds.queries[0], "lt").length, noBounds.queries.length], [0, 0, 1]);
    // exactly 20,000 rows: 20 full pages, the probe finds nothing → not capped
    total = 20000;
    const exact = fakeClient((q) => {
      const [from, to] = arg(q, "range") as [number, number];
      return { data: mk(Math.max(0, Math.min(to, total - 1) - from + 1)) };
    });
    const e = await pageFeedbackRows(exact.client, "course-1", {}, () => {});
    eq("exactly 20,000 rows: 20 pages and a one-row probe, not capped", [exact.queries.length, arg(exact.queries[20], "range"), e.rows, e.capped], [21, [20000, 20000], 20000, false]);
    // 20,001 rows: capped
    total = 20001;
    const over = fakeClient((q) => {
      const [from, to] = arg(q, "range") as [number, number];
      return { data: mk(Math.max(0, Math.min(to, total - 1) - from + 1)) };
    });
    const o = await pageFeedbackRows(over.client, "course-1", {}, () => {});
    eq(`more than ${FEEDBACK_EXPORT_MAX_PAGES} pages: capped after 21 reads`, [over.queries.length, o.capped], [21, true]);
    const missing = await pageFeedbackRows(fakeClient(() => ({ error: { code: "42P01", message: "does not exist" } })).client, "course-1", {}, () => {});
    eq("a missing view → missing", [missing.missing, missing.failed, missing.rows], [true, false, 0]);
    const failed = await captureWarn(() => pageFeedbackRows(fakeClient(() => ({ error: { code: "57014", message: "timeout" } })).client, "course-1", {}, () => {}));
    eq("any other error → failed with one log line", [failed.value.failed, failed.lines.length], [true, 1]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
