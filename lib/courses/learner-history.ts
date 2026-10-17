import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * "Learner attempt" for the record-protection delete rules (ADR 0003 step 10
 * and decision 3), the TypeScript twin of the 0098 delete-guard triggers:
 * any course_attempts row on the version(s) EXCEPT those whose user currently
 * holds super_owner, admin or data_analyst in the attempt's organisation. A
 * missing membership counts as a learner, so a former member's history still
 * blocks. After migration 0099 this becomes `is_preview = false`.
 *
 * Callers pass a service-role client: attempts belong to other users and RLS
 * only shows a member their own.
 */
export const STAFF_ROLES = ["super_owner", "admin", "data_analyst"] as const;

type AttemptOwner = { user_id: string; organization_id: string };

async function attemptOwnersOn(svc: SupabaseClient, versionIds: string[]): Promise<AttemptOwner[]> {
  const out: AttemptOwner[] = [];
  for (let i = 0; i < versionIds.length; i += 100) {
    const ids = versionIds.slice(i, i + 100);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await svc
        .from("course_attempts")
        .select("user_id, organization_id")
        .in("course_version_id", ids)
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(`learner-history: attempts read failed: ${error.message}`);
      const rows = (data ?? []) as AttemptOwner[];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
  }
  return out;
}

/** How many learner attempts exist on these versions. Throws on a read error (fail closed). */
export async function countLearnerAttempts(svc: SupabaseClient, versionIds: string[]): Promise<number> {
  const owners = await attemptOwnersOn(svc, [...new Set(versionIds.filter(Boolean))]);
  if (owners.length === 0) return 0;
  const userIds = [...new Set(owners.map((o) => o.user_id))];
  const staff = new Set<string>();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data, error } = await svc
      .from("organization_members")
      .select("organization_id, user_id")
      .in("user_id", userIds.slice(i, i + 200))
      .in("role", [...STAFF_ROLES]);
    if (error) throw new Error(`learner-history: memberships read failed: ${error.message}`);
    for (const m of (data ?? []) as AttemptOwner[]) staff.add(`${m.organization_id}:${m.user_id}`);
  }
  return owners.filter((o) => !staff.has(`${o.organization_id}:${o.user_id}`)).length;
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
