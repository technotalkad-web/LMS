import type { SupabaseClient } from "@supabase/supabase-js";
import { isSchemaMissing, type PgError } from "@/lib/scoring/attempt-kind";
import { readLang } from "./extract-xapi";

/**
 * Learner Feedback (ADR 0021): the figures, the comment list and the CSV rows
 * of the Learner Feedback section on each course's Reports page.
 *
 * Source: KIVO's feedback slides send `responded` statements (never scored,
 * K-15). Migration 0106 holds the one eligibility rule, in the view
 * `v_course_feedback_responses` (no staff preview, no revision visit, no
 * reset attempt; `is_latest` marks a learner's newest response to a
 * question), and aggregates it in `course_feedback_summary(uuid)`. Both are
 * granted to `service_role` only, so every reader here takes the service
 * client, and every caller sits behind `canManage` with a course id the
 * caller's own client has confirmed belongs to the organisation (ADR 0021
 * section A).
 *
 * Fail rules, the lib/attempts/revision-visits.ts form: a database without
 * 0106 (isSchemaMissing) answers `missing: true`; any other error answers
 * `failed: true` and writes one JSON log line with the course id and the
 * error code, never a row, a name or a comment.
 *
 * Type-only Supabase import and no next/* import, so unit tests load this file.
 */

/** The two verb spellings the view admits (as 0031 admits both for answered). */
export const RESPONDED_VERBS = ["http://adlnet.gov/expapi/verbs/responded", "responded"] as const;

/** The summary's bucket for a written comment: its text never enters the summary. */
export const TEXT_BUCKET = "__text__";

/** Interaction types read as written comments, in the summary and the comment list alike. */
export const COMMENT_TYPES = ["long-fill-in", "fill-in"] as const;

/** Rows per read (the PostgREST row cap). */
export const FEEDBACK_PAGE = 1000;

/** Pages the CSV reads before it answers 413 (20,000 rows; owner decision 7). */
export const FEEDBACK_EXPORT_MAX_PAGES = 20;
export const FEEDBACK_EXPORT_MAX_ROWS = FEEDBACK_PAGE * FEEDBACK_EXPORT_MAX_PAGES;

/** Comments shown on the page (owner decision 6); the CSV has all of them. */
export const COMMENTS_SHOWN = 50;

/** Display cap of one comment on the page (owner decision 6); the CSV has the full text. */
export const COMMENT_DISPLAY_CAP = 1000;

/** One row of course_feedback_summary(uuid): a (question, bucket) pair. */
export type FeedbackSummaryRow = {
  interaction_id: string;
  interaction_type: string;
  /** The response id, TEXT_BUCKET for a written comment, null for "No answer". */
  response: string | null;
  /** Counted responses (is_latest) in the bucket. */
  learners: number;
  /** Every eligible row of the question, counted or not. */
  responses: number;
  first_at: string | null;
  last_at: string | null;
  question: unknown;
  question_name: unknown;
  scale: unknown;
  choices: unknown;
  slot_languages: string[] | null;
};

/** One row of v_course_feedback_responses: an eligible feedback statement. */
export type FeedbackResponseRow = {
  statement_row_id: string;
  statement_id: string;
  attempt_id: string;
  user_id: string;
  organization_id: string;
  course_id: string;
  course_version_id: string;
  package_id: string | null;
  slot_language: string | null;
  slot_display_name: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  employee_id: string | null;
  stored: string;
  responded_at: string | null;
  interaction_id: string;
  interaction_type: string | null;
  question: unknown;
  question_name: unknown;
  scale: unknown;
  choices: unknown;
  response: string | null;
  unanswered: boolean;
  is_latest: boolean;
};

/** The columns the comment list reads. */
export type FeedbackCommentRow = Pick<
  FeedbackResponseRow,
  "statement_row_id" | "interaction_id" | "question" | "question_name" | "email" | "first_name" | "last_name" | "stored" | "response" | "slot_language"
>;

export type QuestionKind = "stars" | "likert" | "choice" | "comment" | "other";

export type FeedbackBucket = {
  /** The response id (likert_3, star_4, yes, or a raw value under "Other"). */
  id: string;
  label: string;
  /** Counted responses in the bucket. */
  learners: number;
  /** Share of the question's answered counted responses ("No answer" excluded); null when none answered. */
  share: number | null;
};

export type FeedbackQuestion = {
  interactionId: string;
  interactionType: string;
  kind: QuestionKind;
  /** The question text (description), else its name, else the id. */
  title: string;
  /** The slide title when it differs from the question text. */
  name: string | null;
  /** Every eligible response, counted or not. */
  responses: number;
  /** Counted responses: one per learner, "No answer" included. */
  learners: number;
  /** Counted responses with an answer. */
  answered: number;
  /** Counted responses left blank. */
  noAnswer: number;
  /** In scale or choice order, every position present (zero-filled); unknown ids after. Empty for a comment question. */
  buckets: FeedbackBucket[];
  /** Stars only: the mean rating, one decimal; null with no counted rating. */
  average: number | null;
  slotLanguages: string[];
  firstAt: string | null;
  lastAt: string | null;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

type Component = { id: string; label: string };

/** The ids and labels of an interaction's scale or choices, in their order. */
export function components(list: unknown): Component[] {
  if (!Array.isArray(list)) return [];
  const out: Component[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const id = (c as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    out.push({ id, label: readLang((c as { description?: unknown }).description) ?? id });
  }
  return out;
}

/** A star scale: a non-empty scale whose every id is star_<n>. */
export function isStarScale(scale: unknown): boolean {
  const ids = components(scale).map((c) => c.id);
  return ids.length > 0 && ids.every((id) => /^star_\d+$/.test(id));
}

/** How a question is shown (ADR 0021 C.1–C.6). */
export function questionKind(interactionType: string | null | undefined, scale: unknown): QuestionKind {
  if (interactionType === "likert") return isStarScale(scale) ? "stars" : "likert";
  if (interactionType === "choice") return "choice";
  if (interactionType && (COMMENT_TYPES as readonly string[]).includes(interactionType)) return "comment";
  return "other";
}

/**
 * The label of a bucket: "No answer" for a blank item, "Comment" for the
 * comment bucket, else the scale or choice description in the package's
 * language (readLang: en-US, en, und, then any one string), else the id.
 */
export function bucketLabel(row: { response: string | null }, summary: { scale?: unknown; choices?: unknown }): string {
  if (row.response === null) return "No answer";
  if (row.response === TEXT_BUCKET) return "Comment";
  const hit = [...components(summary.scale), ...components(summary.choices)].find((c) => c.id === row.response);
  return hit ? hit.label : row.response;
}

type CountRow = { response: string | null; learners: number };

/**
 * Counted responses per answer, with each answer's share of the answered ones
 * ("No answer" is counted apart and excluded from every share).
 */
export function distribution(rows: readonly CountRow[]): {
  buckets: Array<{ id: string; learners: number; share: number | null }>;
  answered: number;
  noAnswer: number;
} {
  const counts = new Map<string, number>();
  let noAnswer = 0;
  for (const r of rows) {
    const n = Number(r.learners) || 0;
    if (r.response === null) noAnswer += n;
    else counts.set(r.response, (counts.get(r.response) ?? 0) + n);
  }
  const answered = [...counts.values()].reduce((a, b) => a + b, 0);
  const buckets = [...counts].map(([id, learners]) => ({ id, learners, share: answered > 0 ? learners / answered : null }));
  return { buckets, answered, noAnswer };
}

/** The mean star rating over counted ratings, rounded to one decimal; null with none. */
export function starAverage(rows: readonly CountRow[]): number | null {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const m = r.response === null ? null : /^star_(\d+)$/.exec(r.response);
    if (!m) continue;
    const k = Number(r.learners) || 0;
    sum += Number(m[1]) * k;
    n += k;
  }
  return n > 0 ? Math.round((sum / n) * 10) / 10 : null;
}

/**
 * The buckets in the order of `ordered` (a scale or the choices), every
 * position present with 0 when it has no row, then any answered id the
 * definition does not name, in the order met.
 */
function orderedBuckets(rows: readonly CountRow[], ordered: Component[]): FeedbackBucket[] {
  const { buckets, answered } = distribution(rows);
  const byId = new Map(buckets.map((b) => [b.id, b]));
  const out: FeedbackBucket[] = ordered.map((c) => {
    const b = byId.get(c.id);
    return { id: c.id, label: c.label, learners: b?.learners ?? 0, share: answered > 0 ? (b?.learners ?? 0) / answered : null };
  });
  const named = new Set(ordered.map((c) => c.id));
  for (const b of buckets) if (!named.has(b.id)) out.push({ id: b.id, label: b.id, learners: b.learners, share: b.share });
  return out;
}

/** Yes/No (and any choice item): count and share per choice, labels from `choices`, in choice order. */
export function yesNoShares(rows: readonly CountRow[], choices: unknown): FeedbackBucket[] {
  return orderedBuckets(rows, components(choices));
}

/** The summary rows of one course grouped per question, in interaction id order. */
export function groupQuestions(summaryRows: readonly FeedbackSummaryRow[]): FeedbackQuestion[] {
  const byId = new Map<string, FeedbackSummaryRow[]>();
  for (const r of summaryRows) {
    const list = byId.get(r.interaction_id) ?? [];
    list.push(r);
    byId.set(r.interaction_id, list);
  }
  const out: FeedbackQuestion[] = [];
  for (const id of [...byId.keys()].sort()) {
    const rows = byId.get(id)!;
    const head = rows[0];
    const kind = questionKind(head.interaction_type, head.scale);
    const { buckets: raw, answered, noAnswer } = distribution(rows);
    let buckets: FeedbackBucket[];
    if (kind === "stars" || kind === "likert") buckets = orderedBuckets(rows, components(head.scale));
    else if (kind === "choice") buckets = yesNoShares(rows, head.choices);
    else if (kind === "comment") buckets = [];
    else
      buckets = raw
        .slice()
        .sort((a, b) => b.learners - a.learners || a.id.localeCompare(b.id))
        .map((b) => ({ id: b.id, label: bucketLabel({ response: b.id }, head), learners: b.learners, share: b.share }));
    const description = readLang(head.question);
    const name = readLang(head.question_name);
    const firsts = rows.map((r) => r.first_at).filter((x): x is string => !!x).sort();
    const lasts = rows.map((r) => r.last_at).filter((x): x is string => !!x).sort();
    out.push({
      interactionId: id,
      interactionType: head.interaction_type,
      kind,
      title: description ?? name ?? id,
      name: description && name && name !== description ? name : null,
      responses: Number(head.responses) || 0,
      learners: answered + noAnswer,
      answered,
      noAnswer,
      buckets,
      average: kind === "stars" ? starAverage(rows) : null,
      slotLanguages: [...new Set(rows.flatMap((r) => r.slot_languages ?? []))].sort(),
      firstAt: firsts[0] ?? null,
      lastAt: lasts[lasts.length - 1] ?? null,
    });
  }
  return out;
}

/** A comment cut to `max` characters (code points) with an ellipsis; unchanged at or below. */
export function truncateComment(text: string, max = COMMENT_DISPLAY_CAP): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** First and last name, else the email (ADR 0021 C.4). */
export function learnerName(row: { first_name: string | null; last_name: string | null; email: string | null }): string {
  const name = [row.first_name, row.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return name || row.email || "Unknown learner";
}

/** The question text of a row: description, else name, else the id. */
export function questionText(row: { question: unknown; question_name: unknown; interaction_id: string }): string {
  return readLang(row.question) ?? readLang(row.question_name) ?? row.interaction_id;
}

const iso = (value: string | null | undefined): string => {
  if (!value) return "";
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : value;
};

const CSV_HEADER = [
  "Responded at (ISO)",
  "Stored at (ISO)",
  "Employee ID",
  "Email",
  "First name",
  "Last name",
  "Question",
  "Question id",
  "Type",
  "Response",
  "Response label",
  "Counted",
  "Version id",
  "Slot language",
  "Attempt id",
  "Statement id",
];

/** The CSV header (ADR 0021 E.4), raw cells. */
export function feedbackCsvHeader(): string[] {
  return [...CSV_HEADER];
}

/**
 * One CSV row in the header's column order, raw cells: the route escapes
 * every cell (csvEscape) in its one join expression. Responded at is the
 * engine's timestamp, Stored at when the LMS received the statement. An item
 * left blank (no response) has an empty Response and the label "No answer",
 * the summary's rule (ADR 0021 C.5): a row that carries a response is labelled
 * by it even when the unanswered extension is set. A comment's label is empty.
 */
export function feedbackCsvRow(row: FeedbackResponseRow): string[] {
  const kind = questionKind(row.interaction_type, row.scale);
  const blank = row.response === null;
  const label = blank
    ? "No answer"
    : kind === "comment"
      ? ""
      : ([...components(row.scale), ...components(row.choices)].find((c) => c.id === row.response)?.label ?? "");
  return [
    iso(row.responded_at),
    iso(row.stored),
    row.employee_id ?? "",
    row.email ?? "",
    row.first_name ?? "",
    row.last_name ?? "",
    readLang(row.question) ?? readLang(row.question_name) ?? "",
    row.interaction_id,
    row.interaction_type ?? "",
    row.response ?? "",
    label,
    row.is_latest ? "yes" : "no",
    row.course_version_id,
    row.slot_language ?? "",
    row.attempt_id,
    row.statement_id,
  ];
}

/**
 * The CSV's optional date range (ADR 0021 E.4): an empty value is absent (a
 * blank date input is sent as `from=`); a present value must parse; a
 * date-only `to` (YYYY-MM-DD) is inclusive, so its bound is the next day.
 * A date-only value is a UTC day (Date.parse reads YYYY-MM-DD as UTC
 * midnight); the form's labels say so. Both bounds apply to `stored`. `from`/`to` echo the values as sent (null
 * when absent) for the audit row.
 */
export function exportRange(
  fromRaw: string | null,
  toRaw: string | null
):
  | { ok: true; gte: string | null; lt: string | null; from: string | null; to: string | null }
  | { ok: false; param: "from" | "to" } {
  const from = fromRaw?.trim() || null;
  const to = toRaw?.trim() || null;
  let gte: string | null = null;
  let lt: string | null = null;
  if (from !== null) {
    const t = Date.parse(from);
    if (!Number.isFinite(t)) return { ok: false, param: "from" };
    gte = new Date(t).toISOString();
  }
  if (to !== null) {
    const t = Date.parse(to);
    if (!Number.isFinite(t)) return { ok: false, param: "to" };
    lt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? t + 86_400_000 : t).toISOString();
  }
  return { ok: true, gte, lt, from, to };
}

// ---------------------------------------------------------------------------
// Readers (service client only; ADR 0021 section A)
// ---------------------------------------------------------------------------

type ReadState = { missing: boolean; failed: boolean };

function logFailure(courseId: string, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code ?? null : null;
  console.warn(JSON.stringify({ event: "feedback_read_failed", course_id: courseId, code: typeof code === "string" ? code : null }));
}

function outcome(courseId: string, error: PgError | unknown): ReadState {
  if (isSchemaMissing(error as PgError)) return { missing: true, failed: false };
  logFailure(courseId, error);
  return { missing: false, failed: true };
}

/**
 * The section's figures: one call of course_feedback_summary, ordered by
 * (interaction_id, response), inside one PostgREST page. `capped` when the
 * page is full: the page then says the list is cut off.
 */
export async function readFeedbackSummary(
  svc: SupabaseClient,
  courseId: string
): Promise<ReadState & { rows: FeedbackSummaryRow[]; capped: boolean }> {
  try {
    const { data, error } = (await svc
      .rpc("course_feedback_summary", { p_course_id: courseId })
      .order("interaction_id", { ascending: true })
      .order("response", { ascending: true, nullsFirst: false })
      .range(0, FEEDBACK_PAGE - 1)) as { data: FeedbackSummaryRow[] | null; error: PgError };
    if (error) return { rows: [], capped: false, ...outcome(courseId, error) };
    const rows = (data ?? []).map((r) => ({ ...r, learners: Number(r.learners) || 0, responses: Number(r.responses) || 0 }));
    return { rows, capped: rows.length >= FEEDBACK_PAGE, missing: false, failed: false };
  } catch (e) {
    logFailure(courseId, e);
    return { rows: [], capped: false, missing: false, failed: true };
  }
}

const COMMENT_COLUMNS =
  "statement_row_id, interaction_id, question, question_name, email, first_name, last_name, stored, response, slot_language";

/**
 * The newest counted comments of the course (is_latest rows only, so the list
 * matches the counted figure), newest first.
 */
export async function readFeedbackComments(
  svc: SupabaseClient,
  courseId: string,
  limit = COMMENTS_SHOWN
): Promise<ReadState & { rows: FeedbackCommentRow[] }> {
  try {
    const { data, error } = (await svc
      .from("v_course_feedback_responses")
      .select(COMMENT_COLUMNS)
      .eq("course_id", courseId)
      .in("interaction_type", [...COMMENT_TYPES])
      .not("response", "is", null)
      .eq("is_latest", true)
      .order("stored", { ascending: false })
      .order("statement_row_id", { ascending: false })
      .limit(limit)) as { data: FeedbackCommentRow[] | null; error: PgError };
    if (error) return { rows: [], ...outcome(courseId, error) };
    return { rows: data ?? [], missing: false, failed: false };
  } catch (e) {
    logFailure(courseId, e);
    return { rows: [], missing: false, failed: true };
  }
}

/**
 * Every eligible row of the course for the CSV, in pages of 1,000 ordered by
 * (stored, statement_row_id), within the optional `stored` bounds, each page
 * handed to `onPage`. Past `maxPages` full pages one more row is probed:
 * when it exists the reader stops with `capped: true` (the route answers 413).
 */
export async function pageFeedbackRows(
  svc: SupabaseClient,
  courseId: string,
  bounds: { gte?: string | null; lt?: string | null },
  onPage: (rows: FeedbackResponseRow[]) => void,
  maxPages = FEEDBACK_EXPORT_MAX_PAGES
): Promise<ReadState & { rows: number; capped: boolean }> {
  const query = (from: number, to: number) => {
    let q = svc.from("v_course_feedback_responses").select("*").eq("course_id", courseId);
    if (bounds.gte) q = q.gte("stored", bounds.gte);
    if (bounds.lt) q = q.lt("stored", bounds.lt);
    return q
      .order("stored", { ascending: true })
      .order("statement_row_id", { ascending: true })
      .range(from, to) as unknown as Promise<{ data: FeedbackResponseRow[] | null; error: PgError }>;
  };
  let total = 0;
  try {
    for (let page = 0; page < maxPages; page++) {
      const { data, error } = await query(page * FEEDBACK_PAGE, page * FEEDBACK_PAGE + FEEDBACK_PAGE - 1);
      if (error) return { rows: 0, capped: false, ...outcome(courseId, error) };
      const rows = data ?? [];
      total += rows.length;
      onPage(rows);
      if (rows.length < FEEDBACK_PAGE) return { rows: total, capped: false, missing: false, failed: false };
    }
    const probeAt = maxPages * FEEDBACK_PAGE;
    const { data, error } = await query(probeAt, probeAt);
    if (error) return { rows: 0, capped: false, ...outcome(courseId, error) };
    return { rows: total, capped: (data ?? []).length > 0, missing: false, failed: false };
  } catch (e) {
    logFailure(courseId, e);
    return { rows: 0, capped: false, missing: false, failed: true };
  }
}
