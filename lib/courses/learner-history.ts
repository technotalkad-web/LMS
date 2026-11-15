import type { SupabaseClient } from "@supabase/supabase-js";
import { readWithContextFilter, withoutPreviews, type ContextFilterState } from "@/lib/scoring/context-read";

/**
 * "Learner attempt" for the record-protection delete rules (ADR 0003 step 10
 * and decision 3), the route-side count beside the database's delete guards:
 * any course_attempts row on the version(s) that is not a Preview. A Preview is
 * told by its context, `context_kind = 'preview'` (ADR 0024 step 23, P2-5 item
 * 4), never by its member's role: a staff member's real attempt counts like a
 * learner's, and so does a former member's history.
 *
 * A by-role row the 0107 paste labelled (a Preview made before Preview by
 * mode) is a Preview here, but 0107's recreated guards still count it (step 7),
 * so a course that holds one is refused by the guard on delete, after this
 * count has read 0 (the route's 409 then names no count). On a database without
 * 0107 the filter's missing-column error reads today's select once
 * (readWithContextFilter) and every row counts: no preview split (step 72's
 * fallback-safe readers).
 *
 * Callers pass a service-role client: attempts belong to other users and RLS
 * only shows a member their own.
 */

/** How many learner attempts exist on these versions. Throws on a read error (fail closed). */
export async function countLearnerAttempts(svc: SupabaseClient, versionIds: string[]): Promise<number> {
  const unique = [...new Set(versionIds.filter(Boolean))];
  // One decision for every chunk and page of this count.
  const previews: ContextFilterState = { applies: null };
  let count = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const ids = unique.slice(i, i + 100);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await readWithContextFilter(previews, (apply) =>
        withoutPreviews(svc.from("course_attempts").select("id").in("course_version_id", ids), apply)
          .order("id")
          .range(from, from + 999)
      );
      if (error) throw new Error(`learner-history: attempts read failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string }>;
      count += rows.length;
      if (rows.length < 1000) break;
    }
  }
  return count;
}

/** Learner attempts on any version of the course. */
export async function countLearnerAttemptsOnCourse(svc: SupabaseClient, courseId: string): Promise<number> {
  const { data, error } = await svc.from("course_versions").select("id").eq("course_id", courseId);
  if (error) throw new Error(`learner-history: versions read failed: ${error.message}`);
  return countLearnerAttempts(svc, ((data ?? []) as Array<{ id: string }>).map((v) => v.id));
}

/** True when a Postgres error is the 0098 delete guard. */
export function isLearnerHistoryError(e: { message?: string } | null | undefined): boolean {
  return !!e?.message && /learner_history_exists/.test(e.message);
}
