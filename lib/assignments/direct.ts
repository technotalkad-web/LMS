import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import { DEFAULT_JOURNEY_TZ } from "@/lib/journey/journey";
import { orgCourse } from "@/lib/courses/lookup";
import { namesAndEmails } from "@/lib/users/people";
import type { ActionError, PerLearnerResult } from "@/lib/actions/types";

/** Local calendar date → the last instant of that day in `tz`, as a Date. */
export function endOfDayInTz(date: string, tz: string): Date {
  // Find the UTC instant at which `date 23:59:59` occurs in `tz` by measuring the zone offset at that moment.
  const guess = new Date(`${date}T23:59:59Z`);
  if (Number.isNaN(guess.getTime())) return guess; // the caller treats an invalid Date as a 400
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(guess)
    .reduce<Record<string, string>>((acc, p) => (p.type !== "literal" ? { ...acc, [p.type]: p.value } : acc), {});
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offsetMs = local - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

export async function orgTimezone(svc: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await svc.from("gamification_settings").select("timezone").eq("organization_id", orgId).maybeSingle();
  return (data as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
}

/**
 * Assign a course directly to named learners (one `assignee_type = user` row
 * each) and email them. A date-only due date means the END of that day in the
 * org's time zone. Re-assigning someone already assigned directly updates the
 * due date instead. Admin-only since Phase 4a (decision 12): called from the
 * admin API and from a manager's ticket (assign / extend due date).
 */
export async function assignCourseDirect(
  svc: SupabaseClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    assignedBy: string;
    courseId: string | null | undefined;
    userIds: string[];
    dueAt?: string | null;
    /** false = a due-date change on people who already hold the course: no "you have been assigned" email. */
    notify?: boolean;
  }
): Promise<ActionError | { results: PerLearnerResult[]; courseTitle: string; dueAt: string | null }> {
  const ids = [...new Set(args.userIds)];
  if (ids.length === 0) return { error: "No learners named", status: 400 };
  const course = await orgCourse(svc, args.orgId, args.courseId);
  if (!course || !course.is_active) return { error: "Course not found", status: 404 };
  let dueAt: string | null = null;
  if (args.dueAt && args.dueAt.trim()) {
    const raw = args.dueAt.trim();
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? endOfDayInTz(raw, await orgTimezone(svc, args.orgId)) : new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: "dueAt must be a date", status: 400 };
    if (d.getTime() < Date.now()) return { error: "Due date must be today or later", status: 400 };
    dueAt = d.toISOString();
  }
  const results: PerLearnerResult[] = [];
  const inserted: string[] = [];
  for (const uid of ids) {
    const { data, error } = await svc
      .from("course_assignments")
      .insert({
        course_id: course.id, organization_id: args.orgId, assignee_type: "user", user_id: uid, team_id: null,
        due_at: dueAt, release_at: null, assigned_by: args.assignedBy,
      })
      .select("id")
      .maybeSingle();
    if (data) { inserted.push(uid); results.push({ userId: uid, status: "assigned" }); continue; }
    if (error && error.code === "23505") {
      if (dueAt) {
        await svc.from("course_assignments").update({ due_at: dueAt })
          .eq("course_id", course.id).eq("organization_id", args.orgId).eq("assignee_type", "user").eq("user_id", uid);
      }
      results.push({ userId: uid, status: "already", reason: dueAt ? "already assigned — due date updated" : "already assigned" });
      continue;
    }
    results.push({ userId: uid, status: "failed", reason: error?.message ?? "insert failed" });
  }
  if (inserted.length && args.notify !== false) {
    const people = await namesAndEmails(svc, inserted);
    const link = args.origin ? `${args.origin}/${args.orgSlug}/courses/${course.id}/launch` : `/${args.orgSlug}/courses/${course.id}/launch`;
    for (const uid of inserted) {
      const who = people.get(uid);
      if (!who?.email) continue;
      await notifyBackground({
        organizationId: args.orgId,
        event: "asset_assignment",
        to: { user_id: uid, email: who.email },
        context: {
          learner_name: who.name,
          learner_email: who.email,
          course_name: course.title,
          course_id: course.id,
          org_name: args.orgName,
          direct_link: link,
          due_date: dueAt ? `Due ${dueAt.slice(0, 10)}.` : "No due date.",
        },
      });
    }
  }
  return { results, courseTitle: course.title, dueAt };
}
