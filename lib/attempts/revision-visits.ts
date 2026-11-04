/**
 * Revision-visit counts (ADR 0014 step 7, "the visit counts";
 * the aggregation bound). `revision_visits` is deny-all (0103) and is read
 * through the service client only (ADR 0014:148, :169). PostgREST has no
 * group-by without a view or an RPC, and either would be a migration, which
 * PR 1b does not make, so these readers page the rows in pages of 1,000,
 * ordered by (launched_at, id), and aggregate in memory, bounded by a page
 * cap (100 pages by default): past it the reader stops and answers
 * `capped: true`, which the surfaces show as "N+". A count view or RPC is a
 * recorded later option.
 *
 * Fail rules, the same in every reader:
 *   - a missing table (isSchemaMissing: a database without 0103) is "no
 *     visits", `failed: false` (before 0103 no visit exists, so zero is true);
 *   - any other error is logged ({ event: "revision_visits_read_failed" })
 *     and answers empty with `failed: true`: the pages show "—" and the CRM
 *     feeds answer null for revision_visits and last_revision_at, never a
 *     silent 0.
 *
 * No next/* import and no runtime Supabase import, so unit tests load it.
 */
import { isSchemaMissing, type PgError } from "@/lib/scoring/attempt-kind";

// Supabase's builder generics get "excessively deep" when threaded through
// helpers; the calls here are simple enough that a loose client is safer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** Rows per page (the PostgREST row cap). */
const PAGE = 1000;
/** `.in()` chunk for course and user ids. */
const CHUNK = 300;
/** Pages read before a reader stops and answers `capped` (100,000 rows). */
export const REVISION_VISITS_PAGE_CAP = 100;

export type VisitStat = { count: number; last: string | null };

export type RevisionVisitStats = {
  /** Keyed `${user_id}:${course_id}`; a pair with no visit is absent. */
  byPair: Map<string, VisitStat>;
  /** The page cap was reached: the counts are a floor ("N+"). */
  capped: boolean;
  /** The read failed for a reason other than a missing table: show "—" / null. */
  failed: boolean;
};

export type CourseRevisitSummary = {
  /** Visits on the course. */
  total: number;
  /** Learners who revisited the course. */
  learners: number;
  /** Visits launched at or after `sinceIso`. */
  recent: number;
  capped: boolean;
  failed: boolean;
  /**
   * The table is absent (isSchemaMissing: a database without 0103): the
   * Course Reports tile is then not shown.
   */
  missing: boolean;
};

type VisitRow = { user_id: string; course_id: string; launched_at: string };

function chunks(ids: string[] | undefined): Array<string[] | null> {
  if (ids === undefined) return [null];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}

function logFailure(courseIds: string[] | undefined, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code ?? null : null;
  console.warn(
    JSON.stringify({
      event: "revision_visits_read_failed",
      course_id: courseIds && courseIds.length === 1 ? courseIds[0] : null,
      code: typeof code === "string" ? code : null,
    })
  );
}

/** Pages every visit of the organisation matching the filters, up to `cap` pages. */
async function drainVisits(
  svc: AnyClient,
  args: { orgId: string; courseIds?: string[]; userIds?: string[]; cap?: number }
): Promise<{ rows: VisitRow[]; capped: boolean; failed: boolean; missing: boolean }> {
  const courseIds = args.courseIds === undefined ? undefined : [...new Set(args.courseIds.filter(Boolean))];
  const userIds = args.userIds === undefined ? undefined : [...new Set(args.userIds.filter(Boolean))];
  const rows: VisitRow[] = [];
  if (!args.orgId || courseIds?.length === 0 || userIds?.length === 0) return { rows, capped: false, failed: false, missing: false };
  const cap = args.cap ?? REVISION_VISITS_PAGE_CAP;
  let pages = 0;
  try {
    for (const courseChunk of chunks(courseIds)) {
      for (const userChunk of chunks(userIds)) {
        for (let from = 0; ; from += PAGE) {
          if (pages >= cap) return { rows, capped: true, failed: false, missing: false };
          let q = svc.from("revision_visits").select("user_id, course_id, launched_at").eq("organization_id", args.orgId);
          if (courseChunk) q = q.in("course_id", courseChunk);
          if (userChunk) q = q.in("user_id", userChunk);
          const { data, error } = (await q
            .order("launched_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1)) as { data: VisitRow[] | null; error: PgError };
          pages++;
          if (error) {
            if (isSchemaMissing(error)) return { rows: [], capped: false, failed: false, missing: true };
            logFailure(courseIds, error);
            return { rows: [], capped: false, failed: true, missing: false };
          }
          const page = data ?? [];
          rows.push(...page);
          if (page.length < PAGE) break;
        }
      }
    }
  } catch (e) {
    logFailure(courseIds, e);
    return { rows: [], capped: false, failed: true, missing: false };
  }
  return { rows, capped: false, failed: false, missing: false };
}

const later = (a: string | null, b: string): string => (a === null || Date.parse(b) > Date.parse(a) ? b : a);

/**
 * Visit count and last visit per (learner, course), scoped by the caller to
 * what the surface shows: a page of learners, one course's enrolled
 * learners, the flagged learners, or one batch of the CRM feed.
 */
export async function fetchRevisionVisitStats(
  svc: AnyClient,
  args: { orgId: string; courseIds?: string[]; userIds?: string[]; cap?: number }
): Promise<RevisionVisitStats> {
  const { rows, capped, failed } = await drainVisits(svc, args);
  const byPair = new Map<string, VisitStat>();
  for (const r of rows) {
    const k = `${r.user_id}:${r.course_id}`;
    const s = byPair.get(k) ?? { count: 0, last: null };
    s.count++;
    s.last = later(s.last, r.launched_at);
    byPair.set(k, s);
  }
  return { byPair, capped, failed };
}

/** The Course Reports tile: "Revisits: total · learners who revisited · last 30 days". */
export async function fetchCourseRevisitSummary(
  svc: AnyClient,
  args: { orgId: string; courseId: string; sinceIso: string; cap?: number }
): Promise<CourseRevisitSummary> {
  const { rows, capped, failed, missing } = await drainVisits(svc, { orgId: args.orgId, courseIds: [args.courseId], cap: args.cap });
  const since = Date.parse(args.sinceIso);
  const learners = new Set<string>();
  let recent = 0;
  for (const r of rows) {
    learners.add(r.user_id);
    if (Date.parse(r.launched_at) >= since) recent++;
  }
  return { total: rows.length, learners: learners.size, recent, capped, failed, missing };
}

/**
 * The learner course page's one line, "Revisited N times" (ADR 0014:186,
 * "service-client read"): one head count and one newest-row read, scoped to
 * the signed-in learner's own id and course. A missing table on either read
 * is zero; any other error answers `failed` and the page hides the line.
 */
export async function fetchMyRevisits(
  svc: AnyClient,
  userId: string,
  courseId: string
): Promise<{ count: number; last: string | null; failed: boolean }> {
  const none = { count: 0, last: null, failed: false };
  if (!userId || !courseId) return none;
  try {
    const [countRes, lastRes] = (await Promise.all([
      svc.from("revision_visits").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("course_id", courseId),
      svc
        .from("revision_visits")
        .select("launched_at")
        .eq("user_id", userId)
        .eq("course_id", courseId)
        .order("launched_at", { ascending: false })
        .limit(1),
    ])) as [
      { count: number | null; error: PgError },
      { data: Array<{ launched_at: string }> | null; error: PgError },
    ];
    if (isSchemaMissing(countRes.error) || isSchemaMissing(lastRes.error)) return none;
    if (countRes.error || lastRes.error) {
      logFailure([courseId], countRes.error ?? lastRes.error);
      return { count: 0, last: null, failed: true };
    }
    return { count: countRes.count ?? 0, last: lastRes.data?.[0]?.launched_at ?? null, failed: false };
  } catch (e) {
    logFailure([courseId], e);
    return { count: 0, last: null, failed: true };
  }
}
