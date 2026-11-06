/**
 * The new-engine result guard's record (ADR 0017 step 12): one JSON object in
 * `course_attempts.ignored_pass` (migration 0104), written by the server only and
 * never a grading input, with the texts and row models of its surfaces (steps
 * 13 to 16).
 *
 * `count` is the number of ignored passes: entries with verb `passed` and no
 * `applied`. Every surface fires on ignoredPassCount(record) > 0, never on the
 * column merely being non-null. A score-only entry (a later result with another
 * score, held but not a pass) and an applied entry (the one-time upgrade kept
 * because the engine version could not be read) show only in the attempt page's
 * block.
 *
 * Deliberately free of next/* and Supabase imports so unit tests can load it. Pure.
 */
import type { EngineReadError } from "../courses/engine-version";

export type IgnoredRuntime = "cmi5" | "xapi" | "scorm12";

export type IgnoredEntry = {
  /** `passed` or `failed`; for another scored result the statement's short verb, or on SCORM the lesson_status. */
  verb: string;
  received_at: string;
  score: number | null;
  statement_id?: string;
  timestamp?: string;
  session_id?: string;
  /** cmi5 only: the entry's session is the failing statement's. Null on plain xAPI and SCORM. */
  same_session?: boolean | null;
  lesson_status?: string;
  repeats?: number;
  applied?: true;
  reason?: "unknown" | "unreadable";
  /** The class of the failed read, never its raw text: a learner can read this row through the Data API. */
  error?: EngineReadError;
};

export type IgnoredRecord = {
  v: 1;
  runtime: IgnoredRuntime;
  course_version_id: string;
  engine_version: string | null;
  floor: string;
  failed: {
    at: string | null;
    score: number | null;
    statement_id?: string;
    timestamp?: string;
    session_id?: string;
  };
  count: number;
  first_at: string | null;
  last_at: string | null;
  entries: IgnoredEntry[];
};

/** The record keeps at most this many entries, the oldest kept. */
export const IGNORED_ENTRIES_CAP = 20;

export function newIgnoredRecord(base: Pick<IgnoredRecord, "runtime" | "course_version_id" | "engine_version" | "floor" | "failed">): IgnoredRecord {
  return { v: 1, ...base, count: 0, first_at: null, last_at: null, entries: [] };
}

/** The row's record when it has the shape merges and surfaces need; anything else is no record. */
export function readIgnoredRecord(value: unknown): IgnoredRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<IgnoredRecord>;
  return r.v === 1 && Array.isArray(r.entries) && !!r.failed && typeof r.failed === "object" ? (r as IgnoredRecord) : null;
}

const isIgnoredPass = (e: IgnoredEntry) => e.verb === "passed" && !e.applied;

/**
 * One result into the record. `changed` false means the update carries no
 * `ignored_pass`.
 *   cmi5 and plain xAPI: keyed by statement id, so a re-POST of a recorded id never
 *   counts twice and is not logged again.
 *   SCORM: a commit repeating the last entry's (lesson_status, score) raises that
 *   entry's `repeats` and moves nothing else, so one pass is one entry however many
 *   times the same dictionary is posted, and a marked-read item does not come back.
 *   At the cap the record does not change: no entry, no count, no last_at. `capped`
 *   says so, because the result was still held and the guard still logs it (ADR 0017
 *   step 6). Its id is kept nowhere, so a re-POST of it logs again, and no marker
 *   reaches it.
 */
export function mergeIgnoredResult(existing: IgnoredRecord, entry: IgnoredEntry): { record: IgnoredRecord; changed: boolean; capped?: true } {
  const entries = existing.entries;
  if (entry.statement_id !== undefined && entries.some((e) => e.statement_id === entry.statement_id)) {
    return { record: existing, changed: false };
  }
  const last = entries[entries.length - 1];
  if (
    existing.runtime === "scorm12" &&
    !entry.applied &&
    last &&
    !last.applied &&
    last.lesson_status === entry.lesson_status &&
    last.score === entry.score
  ) {
    const bumped = { ...last, repeats: (last.repeats ?? 1) + 1 };
    return { record: { ...existing, entries: [...entries.slice(0, -1), bumped] }, changed: true };
  }
  if (entries.length >= IGNORED_ENTRIES_CAP) return { record: existing, changed: false, capped: true };
  const next = [...entries, entry];
  return {
    record: {
      ...existing,
      entries: next,
      count: next.filter(isIgnoredPass).length,
      first_at: existing.first_at ?? entry.received_at,
      last_at: entry.received_at,
    },
    changed: true,
  };
}

/** The one key every surface reads. 0 on no record or a bad shape. */
export function ignoredPassCount(record: unknown): number {
  if (!record || typeof record !== "object") return 0;
  const n = (record as { count?: unknown }).count;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The statement ids the tenant-LRS marker sets: every held result. An applied entry has no id of its own. */
export function notAppliedStatementIds(record: unknown): string[] {
  const r = readIgnoredRecord(record);
  if (!r) return [];
  return r.entries.filter((e) => !e.applied && typeof e.statement_id === "string").map((e) => e.statement_id as string);
}

/** The statement ids that carry the attempt page's chip: ignored passes only, not a score-only entry. */
export function ignoredPassStatementIds(record: unknown): string[] {
  const r = readIgnoredRecord(record);
  if (!r) return [];
  return r.entries.filter((e) => isIgnoredPass(e) && typeof e.statement_id === "string").map((e) => e.statement_id as string);
}

// ---- texts ------------------------------------------------------------------

/** YYYY-MM-DD, the attempt rows' date form; null for a missing or unreadable timestamp. */
export function ignoredDate(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** "N %": a score stored 0..1, as an integer percent; null without a score. */
export function ignoredPct(score: number | null | undefined): string | null {
  return typeof score === "number" && Number.isFinite(score) ? `${Math.round(score * 100)} %` : null;
}

export const NOT_APPLIED_TITLE = "Passed result not applied";
export const NOT_APPLIED_SECTION_TITLE = "Passed results not applied";
export const RESULT_NOTES_TITLE = "Result notes";
export const NOT_APPLIED_CHIP = "Not applied: the official result was already final";
export const APPLIED_ENTRY_LINE = "Today's one-time upgrade applied (engine version unreadable)";
export const NOTICE_NO_REQUEST_LINE = "If you think this is wrong, contact your administrator.";
export const REMEDY_ADMIN_LINE =
  "Another official attempt: the learner asks from their course page and an admin approves in Attempt Requests; a support ticket's grant action for a learner who did not pass; or the bulk grant for every learner on the module who did not pass. There is no per-learner grant without a request or a ticket.";

/**
 * The learner notice (the owner's wording, ADR 0017 step 16). N and the date are
 * the recorded fail's. A fail recorded with no score, or with no date, leaves
 * that part out.
 */
export function notAppliedNotice(failed: { score: number | null | undefined; at: string | null | undefined }): string {
  const facts = [ignoredPct(failed.score), ignoredDate(failed.at)].filter(Boolean).join(", ");
  const recorded = facts ? `Not passed (${facts})` : "Not passed";
  return `Your official result for this module is ${recorded}. The module may have shown 'Passed' in another session. That result was not applied: your first final result stands. A badge or certificate offered in that session does not reflect your recorded result.`;
}

const yesNo = (v: boolean | null | undefined) => (v === true ? "yes" : v === false ? "no" : "n.a.");

/** The last ignored pass, which the Attention item and the Reports row describe. */
function lastIgnoredPass(r: IgnoredRecord): IgnoredEntry | null {
  for (let i = r.entries.length - 1; i >= 0; i--) if (isIgnoredPass(r.entries[i])) return r.entries[i];
  return null;
}

/** The Attention item's context line (ADR 0017 step 13). */
export function attentionContextLine(record: IgnoredRecord, courseTitle: string | null | undefined): string {
  const recorded = [`recorded Not passed`, ignoredPct(record.failed.score), ignoredDate(record.failed.at) ? `on ${ignoredDate(record.failed.at)}` : null]
    .filter(Boolean)
    .join(" ");
  const last = lastIgnoredPass(record);
  const pass = ["pass", last && ignoredPct(last.score) ? `of ${ignoredPct(last.score)}` : null, "not applied", ignoredDate(record.last_at) ? `on ${ignoredDate(record.last_at)}` : null]
    .filter(Boolean)
    .join(" ");
  const times = ignoredPassCount(record);
  const tail = `(${times} ${times === 1 ? "time" : "times"}; same session: ${yesNo(last?.same_session)})`;
  return `${courseTitle ?? "a course"} · ${record.runtime} · engine ${record.engine_version ?? "unknown"} · ${recorded} · ${pass} ${tail}`;
}

// ---- the attempt page's block (ADR 0017 step 15) ------------------------------

export type AttemptBlockEntry = {
  key: string;
  line: string;
  /** Admins only: the applied entry's reason and the class of the read error. */
  adminNote: string | null;
};

export type AttemptBlock = {
  heading: string;
  showNotice: boolean;
  engineLine: string;
  failedLine: string;
  countLine: string | null;
  entries: AttemptBlockEntry[];
};

function entryLine(e: IgnoredEntry): string {
  if (e.applied) return [APPLIED_ENTRY_LINE, ignoredDate(e.received_at)].filter(Boolean).join(" · ");
  return [
    e.received_at ? e.received_at.slice(0, 16).replace("T", " ") : null,
    e.verb,
    ignoredPct(e.score),
    e.session_id ? `session ${e.session_id}` : null,
    `same session: ${yesNo(e.same_session)}`,
    typeof e.repeats === "number" && e.repeats > 1 ? `received ${e.repeats} times` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the block shows, or null when the row has no record. */
export function attemptBlockModel(record: unknown): AttemptBlock | null {
  const r = readIgnoredRecord(record);
  if (!r) return null;
  const count = ignoredPassCount(r);
  return {
    // A block holding only score-only or applied entries never reads "not applied".
    heading: count > 0 ? NOT_APPLIED_TITLE : RESULT_NOTES_TITLE,
    showNotice: count > 0,
    engineLine: `Engine ${r.engine_version ?? "unknown"} · floor ${r.floor}`,
    failedLine: [
      "Recorded fail",
      r.failed.at ? r.failed.at.slice(0, 16).replace("T", " ") : null,
      ignoredPct(r.failed.score),
      r.failed.session_id ? `session ${r.failed.session_id}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    countLine: count > 0 ? `Ignored passes: ${count}` : null,
    entries: r.entries.map((e, i) => ({
      key: `${i}-${e.statement_id ?? e.received_at}`,
      line: entryLine(e),
      adminNote: e.applied ? [e.reason ? `Reason: ${e.reason}` : null, e.error ? `Read error: ${e.error}` : null].filter(Boolean).join(" · ") || null : null,
    })),
  };
}

// ---- the Reports section (ADR 0017 step 14) -----------------------------------

export const NOT_APPLIED_REPORT_LIMIT = 500;
export const NOT_APPLIED_CSV_HEADER = ["Learner", "Course", "Recorded result", "Score", "Ignored passes", "Last ignored at", "Attempt id"];

export type NotAppliedRow<A> = {
  attempt: A;
  ignoredPasses: number;
  lastAt: string | null;
};

/**
 * The section's rows: every attempt the read returned whose record holds an
 * ignored pass, joined by id to what the page already has in memory, in the
 * read's order. A score-only or applied-only record gives no row.
 */
export function notAppliedReportRows<A extends { id: string }>(
  read: Array<{ id: string; ignored_pass: unknown }>,
  attempts: A[]
): NotAppliedRow<A>[] {
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const rows: NotAppliedRow<A>[] = [];
  for (const row of read) {
    const n = ignoredPassCount(row.ignored_pass);
    const attempt = byId.get(row.id);
    if (n <= 0 || !attempt) continue;
    rows.push({ attempt, ignoredPasses: n, lastAt: (row.ignored_pass as { last_at?: string | null }).last_at ?? null });
  }
  return rows;
}
