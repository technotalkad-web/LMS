/**
 * The journey draft-days reader (ADR 0024 phase 2, P2-8 items 2 and 4; step
 * 92, P2-N8, decision A19): a program's active journey_days rows, each with
 * its id and its own pass rule, read once and in one place for the three
 * readers of a draft: the journey admin page (the editor's rows), the
 * publish and the publish dry run (the rows freezeVersionDays freezes).
 *
 *   - One select, `id, day_number, course_id, mission_title, pass_required`,
 *     on the caller's client, filtered to the program and to rows with a
 *     number (a removed day has none and is never read), ascending by
 *     number. No request per day.
 *   - Deploy-safe in both orders (docs/ARCHITECTURE.md principle 6, A19):
 *     pass_required is a 0107 column, so it goes through
 *     readWithOptionalColumn, and DRAFT_DAY_BASE names only columns every
 *     database has (0058). On a missing-column error naming pass_required
 *     the rows are read once more without it, and every row answers
 *     `pass_required: null` (the course's rule), so journey admin still
 *     renders on a database without 0107. Any other error is returned as it
 *     is: a failed read is never "no days" (an empty editor, saved, would
 *     insert every slot again).
 *   - Every row's pass_required is true, false or null: the column's value
 *     when it is a boolean, else null. The editor sends it back unchanged and
 *     the freeze copies it only when it is a boolean (P2-N8).
 *
 * Server-side by use, but free of next/* and Supabase runtime imports (the
 * shape of lib/journey/credits-read.ts), so it runs under a stubbed fetch in
 * tests/unit/journey-publish-route.test.ts, which also holds both callers
 * to it.
 */
import { readWithOptionalColumn, type PgError } from "@/lib/scoring/attempt-kind";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** The draft select's columns on every database (0058); pass_required (0107) is added through the fallback. */
export const DRAFT_DAY_BASE = "id, day_number, course_id, mission_title";

/** One active draft day as the journey admin page, the publish and the dry run read it. */
export type DraftDay = {
  id: string;
  day_number: number;
  course_id: string | null;
  mission_title: string | null;
  /** The day's own rule; null = the course's rule, and on a database without 0107. */
  pass_required: boolean | null;
};

export async function readDraftDays(
  client: AnyClient,
  programId: string
): Promise<{ data: DraftDay[]; error: null } | { data: null; error: NonNullable<PgError> }> {
  const { data, error } = await readWithOptionalColumn<unknown[]>(
    "pass_required",
    (columns) =>
      client
        .from("journey_days")
        .select(columns)
        .eq("program_id", programId)
        .not("day_number", "is", null)
        .order("day_number", { ascending: true }),
    DRAFT_DAY_BASE
  );
  if (error) return { data: null, error };
  const rows = ((data ?? []) as Array<Omit<DraftDay, "pass_required"> & { pass_required?: unknown }>).map((r) => ({
    id: r.id,
    day_number: r.day_number,
    course_id: r.course_id,
    mission_title: r.mission_title,
    pass_required: typeof r.pass_required === "boolean" ? r.pass_required : null,
  }));
  return { data: rows, error: null };
}
