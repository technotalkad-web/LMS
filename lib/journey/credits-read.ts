/**
 * The journey credit reader (ADR 0024 phase 2, P2-4; steps 13 and 45,
 * decision A27, build note N18): the credit rows of a list of enrolments,
 * each with the day id it credits, and the `day_ids` map of each enrolment's
 * pinned version, which creditedDaysFor() (lib/journey/journey.ts) needs to
 * turn the rows into the day numbers the twin takes. Every reader of
 * journey_day_progress that feeds computeJourneyState reads through here;
 * tests/unit/journey-credit-sites.test.ts holds them to it.
 *
 * Two reads, each request with its own abort signal (step 25: Next memoizes
 * identical GET fetches inside one server render, so a re-read of the same
 * rows would otherwise answer the first read's rows):
 *   1. journey_day_progress (enrollment_id, day_number, completed_at and
 *      day_id) for the enrolments, in chunks of ids and pages of 1,000 rows
 *      (readPagedWithOptionalColumn, the first page deciding for every
 *      chunk);
 *   2. journey_versions (id, day_ids) for the enrolments' pinned versions.
 *
 * Deploy-safe in both orders (docs/ARCHITECTURE.md principle 6): when the
 * first read answers a missing-column error naming day_id (isMissingColumn),
 * the database has no 0107, so it reads the rows without the column and
 * makes no second read: every version answers `day_ids: null`, which
 * creditedDaysFor reads by day number (today's reading). On a database with
 * 0107 a version whose day_ids is not an object answers `{}` and credits
 * nothing, as journey_credit_state does. Any other error, and a missing
 * day_ids while day_id is present, answers `{ok: false}`: a failed read is
 * never "no credits", and each caller treats it as its own failed read.
 *
 * Server-side by use, but free of next/* and Supabase runtime imports (the
 * shape of lib/scoring/context-read.ts), so every branch is unit-tested with
 * a stub client (tests/unit/journey-state.test.ts).
 */
import { readPagedWithOptionalColumn, type OptionalColumnState, type PgError } from "@/lib/scoring/attempt-kind";
import type { JourneyCreditRow } from "@/lib/journey/journey";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** Ids per `.in(...)` filter: well inside a request line's length. */
const CHUNK = 150;
const BASE = "enrollment_id, day_number, completed_at";
const DAY_ID = "day_id";

export type JourneyCredits =
  | {
      ok: true;
      /** False when the database has no 0107 and the rows were read by number. */
      byDayId: boolean;
      /** The enrolment's credit rows (none when it holds no credit). */
      rowsOf: (enrollmentId: string) => JourneyCreditRow[];
      /** The pinned version's day_ids for creditedDaysFor: the map, `{}` when the version has none, null when read by number. */
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
  enrollments: ReadonlyArray<{ id: string; version_id: string }>
): Promise<JourneyCredits> {
  const enrollmentIds = [...new Set(enrollments.map((e) => e.id).filter(Boolean))];
  const versionIds = [...new Set(enrollments.map((e) => e.version_id).filter(Boolean))];
  const byEnrollment = new Map<string, JourneyCreditRow[]>();
  const dayIds = new Map<string, Record<string, unknown>>();
  const decided: OptionalColumnState = { columns: null };

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
        completed_at: typeof r.completed_at === "string" ? r.completed_at : null,
      };
      const list = byEnrollment.get(enr);
      if (list) list.push(row);
      else byEnrollment.set(enr, [row]);
    }
  }

  // No enrolment, so no read decided: nothing to map either way.
  const byDayId = decided.columns === null || decided.columns.includes(DAY_ID);
  if (byDayId && enrollmentIds.length > 0) {
    for (const part of chunk(versionIds, CHUNK)) {
      const { data, error } = await client
        .from("journey_versions")
        .select("id, day_ids")
        .in("id", part)
        .abortSignal(fresh());
      // day_id is there, so 0107 is: a missing day_ids is an error here, never a fallback.
      if (error) return { ok: false, error };
      if (data == null) return { ok: false, error: { code: "empty_answer", message: "the versions read answered neither rows nor an error" } };
      for (const v of data as Array<{ id: string; day_ids: unknown }>) dayIds.set(v.id, isMap(v.day_ids) ? v.day_ids : {});
    }
  }

  return {
    ok: true,
    byDayId,
    rowsOf: (enrollmentId) => byEnrollment.get(enrollmentId) ?? [],
    dayIdsOf: (versionId) => (byDayId ? dayIds.get(versionId) ?? {} : null),
  };
}
