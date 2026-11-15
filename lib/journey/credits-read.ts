/**
 * The journey credit reader (ADR 0024 phase 2, P2-4; steps 13 and 45,
 * decision A27, build note N18): the credit rows of a list of enrolments,
 * each with the day id it credits and the course it was earned on, and the
 * `day_ids` map of each enrolment's pinned version, which creditedDaysFor()
 * (lib/journey/journey.ts) needs to turn the rows into the day numbers the
 * twin takes. Every reader of
 * journey_day_progress that feeds computeJourneyState reads through here;
 * tests/unit/journey-credit-sites.test.ts holds them to it.
 *
 * Two reads, each request with its own abort signal (step 25: Next memoizes
 * identical GET fetches inside one server render, so a re-read of the same
 * rows would otherwise answer the first read's rows):
 *   1. journey_day_progress (enrollment_id, day_number, completed_at,
 *      course_id and day_id) for the enrolments, in chunks of ids and pages
 *      of 1,000 rows (readPagedWithOptionalColumn, the first page deciding
 *      for every chunk). course_id is on every database (0058), so it is in
 *      the base select and needs no fallback; creditCoursesFor reads it;
 *   2. journey_versions (id, day_ids) for the pinned versions of the
 *      enrolments that hold a credit row (creditedDaysFor over no rows is []
 *      whatever the map, so an enrolment without credits costs no version
 *      read, and dayIdsOf answers `{}` for a version it did not read).
 *
 * Deploy-safe in both orders (docs/ARCHITECTURE.md principle 6): a
 * missing-column error naming day_id or day_ids (isMissingColumn) means the
 * database has no 0107, and the reader answers today's reading by number:
 * every version answers `day_ids: null`, which creditedDaysFor reads by day
 * number. On day_id the rows are read once more without the column and no
 * version is read; on day_ids the rows already read are kept. On a database
 * with 0107 a version whose day_ids is not an object answers `{}` and
 * credits nothing, as journey_credit_state does. Any other error, and a
 * pinned version the versions read did not answer, is `{ok: false}`: a
 * failed read is never "no credits", and each caller treats it as its own
 * failed read.
 *
 * `opts.state` lets several calls in one request share the first page's
 * decision on day_id (the CRM feed reads per batch of learners), so a
 * database without 0107 pays its one failed read of day_id once per
 * request, not per call. The day_ids decision is not shared: a database
 * with day_id and without day_ids (impossible on a real database, since
 * 0107 adds both columns) pays its failed versions read once per call.
 * Never kept between requests.
 *
 * Server-side by use, but free of next/* and Supabase runtime imports (the
 * shape of lib/scoring/context-read.ts), so every branch is unit-tested with
 * a stub client (tests/unit/journey-state.test.ts).
 */
import {
  isMissingColumn,
  readPagedWithOptionalColumn,
  type OptionalColumnState,
  type PgError,
} from "@/lib/scoring/attempt-kind";
import type { JourneyCreditRow } from "@/lib/journey/journey";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** Ids per `.in(...)` filter: well inside a request line's length. */
const CHUNK = 150;
const BASE = "enrollment_id, day_number, completed_at, course_id";
const DAY_ID = "day_id";
const DAY_IDS = "day_ids";

export type JourneyCredits =
  | {
      ok: true;
      /** False when the database has no 0107 and the rows were read by number. */
      byDayId: boolean;
      /** The enrolment's credit rows (none when it holds no credit). */
      rowsOf: (enrollmentId: string) => JourneyCreditRow[];
      /** The pinned version's day_ids for creditedDaysFor: the map; `{}` when the version has none, or was not read because none of its enrolments holds a credit; null when read by number. */
      dayIdsOf: (versionId: string) => Record<string, unknown> | null;
    }
  | { ok: false; error: PgError };

const fresh = () => new AbortController().signal;

function chunk<T>(list: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const isMap = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * The credits of `enrollments` (each with the version it is pinned to), read
 * with `client` (the caller's own: a learner's session reads their own rows
 * under row-level security, a report reads with the service role).
 */
export async function readJourneyCredits(
  client: AnyClient,
  enrollments: ReadonlyArray<{ id: string; version_id: string }>,
  opts: { state?: OptionalColumnState } = {}
): Promise<JourneyCredits> {
  const enrollmentIds = [...new Set(enrollments.map((e) => e.id).filter(Boolean))];
  const byEnrollment = new Map<string, JourneyCreditRow[]>();
  const dayIds = new Map<string, Record<string, unknown>>();
  const decided: OptionalColumnState = opts.state ?? { columns: null };

  for (const part of chunk(enrollmentIds, CHUNK)) {
    const res = await readPagedWithOptionalColumn<Record<string, unknown>>(
      DAY_ID,
      (columns, from, to) =>
        client
          .from("journey_day_progress")
          .select(columns)
          .in("enrollment_id", part)
          .order("id", { ascending: true })
          .range(from, to)
          .abortSignal(fresh()),
      BASE,
      { state: decided, nullIsError: true }
    );
    if (res.error) return { ok: false, error: res.error };
    for (const r of res.data) {
      const enr = typeof r.enrollment_id === "string" ? r.enrollment_id : null;
      const n = Number(r.day_number);
      if (!enr || !Number.isFinite(n)) continue;
      const row: JourneyCreditRow = {
        day_id: typeof r.day_id === "string" ? r.day_id.toLowerCase() : null,
        day_number: n,
        course_id: typeof r.course_id === "string" && r.course_id ? r.course_id : null,
        completed_at: typeof r.completed_at === "string" ? r.completed_at : null,
      };
      const list = byEnrollment.get(enr);
      if (list) list.push(row);
      else byEnrollment.set(enr, [row]);
    }
  }

  // No enrolment, so no read decided: nothing to map either way.
  let byDayId = decided.columns === null || decided.columns.includes(DAY_ID);
  // Only the versions of enrolments that hold a credit row are read.
  const versionIds = [
    ...new Set(enrollments.filter((e) => byEnrollment.has(e.id)).map((e) => e.version_id).filter(Boolean)),
  ];
  if (byDayId && versionIds.length > 0) {
    for (const part of chunk(versionIds, CHUNK)) {
      const { data, error } = await client
        .from("journey_versions")
        .select("id, day_ids")
        .in("id", part)
        .abortSignal(fresh());
      if (error && isMissingColumn(error, DAY_IDS)) {
        // day_ids is not on this database: today's reading by number for
        // every version (the rows already read keep their day_number);
        // dayIdsOf answers null for every version from here, so the map
        // read so far is never consulted.
        byDayId = false;
        break;
      }
      if (error) return { ok: false, error };
      if (data == null) return { ok: false, error: { code: "empty_answer", message: "the versions read answered neither rows nor an error" } };
      for (const v of data as Array<{ id: string; day_ids: unknown }>) dayIds.set(v.id, isMap(v.day_ids) ? v.day_ids : {});
      // A pinned version asked for and not answered is a failed read, never
      // a version that credits nothing.
      if (part.some((id) => !dayIds.has(id))) {
        return { ok: false, error: { code: "version_unreadable", message: "a pinned version did not come back from the versions read" } };
      }
    }
  }

  return {
    ok: true,
    byDayId,
    rowsOf: (enrollmentId) => byEnrollment.get(enrollmentId) ?? [],
    dayIdsOf: (versionId) => (byDayId ? dayIds.get(versionId) ?? {} : null),
  };
}
