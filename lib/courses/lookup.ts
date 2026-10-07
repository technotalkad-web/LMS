import type { SupabaseClient } from "@supabase/supabase-js";

export type OrgCourse = { id: string; title: string; is_active: boolean };

/** A course by id, only if it belongs to the org. */
export async function orgCourse(svc: SupabaseClient, orgId: string, courseId: string | null | undefined): Promise<OrgCourse | null> {
  if (!courseId) return null;
  const { data } = await svc
    .from("courses")
    .select("id, title, is_active")
    .eq("id", courseId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return (data as OrgCourse | null) ?? null;
}
