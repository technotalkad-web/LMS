import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import { DEFAULT_JOURNEY_TZ } from "@/lib/journey/journey";
import { orgCourse } from "@/lib/courses/lookup";
import { namesAndEmails } from "@/lib/users/people";
import type { ActionError, PerLearnerResult } from "@/lib/actions/types";
import { chunk } from "@/lib/db/chunked";
import { isMissingColumn, type PgError } from "@/lib/scoring/attempt-kind";

/**
 * An admin's assignment converts a learner's self-enrolment (ADR 0024 step
 * 24, P2-6 item 2). The launch page records a Start on an "Everyone" course or
 * path as the learner's own `user` row with source = 'self'. When an admin
 * then assigns that learner, the insert answers 23505; the caller runs its
 * own 23505 handling first, unchanged, and passes those learners here. One
 * update per 150 ids (lib/db/chunked.ts) turns each of their self rows into
 * an assignment: source 'admin', assigned_by the admin, and the dates `set`
 * names (a date the caller's own handling already wrote is not named again).
 * The filter names source = 'self', so an admin row is never touched: an
 * undated re-assign keeps its dates and its assigned_by, as before.
 *
 * The source column is 0107's (decision A19). On a missing-column error
 * naming it (isMissingColumn: PGRST204 from the payload, 42703 from the
 * filter) the caller's own handling, today's, was the whole of it: `missing`
 * is true, nothing more is written and no error is returned. Any other error
 * is returned as it is, with the learners converted before it. No state
 * outlives the call.
 */
export async function convertSelfEnrolments(
  client: SupabaseClient,
  table: "course_assignments" | "learning_path_assignments",
  where: { orgId: string; column: "course_id" | "path_id"; id: string; userIds: string[] },
  set: { assignedBy: string; dueAt?: string | null; releaseAt?: string | null }
): Promise<{ converted: string[]; missing: boolean; error: PgError }> {
  const converted: string[] = [];
  const ids = [...new Set(where.userIds.filter(Boolean))];
  const patch: Record<string, unknown> = { source: "admin", assigned_by: set.assignedBy };
  if (set.dueAt !== undefined) patch.due_at = set.dueAt;
  if (set.releaseAt !== undefined) patch.release_at = set.releaseAt;
  for (const part of chunk(ids, 150)) {
    const { data, error } = await client
      .from(table)
      .update(patch)
      .eq(where.column, where.id)
      .eq("organization_id", where.orgId)
      .eq("assignee_type", "user")
      .in("user_id", part)
      .eq("source", "self")
      .select("user_id");
    if (error) {
      if (isMissingColumn(error, "source")) return { converted, missing: true, error: null };
      return { converted, missing: false, error };
    }
    for (const r of (data ?? []) as Array<{ user_id: string }>) converted.push(r.user_id);
  }
  return { converted, missing: false, error: null };
}

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
 * due date instead, and a learner's own self-enrolment becomes an assignment
 * (convertSelfEnrolments). Admin-only since Phase 4a (decision 12): called from the
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
  /** Learners whose row was already there: each may be their own self-enrolment (convertSelfEnrolments). */
  const already: string[] = [];
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
      already.push(uid);
      if (dueAt) {
        await svc.from("course_assignments").update({ due_at: dueAt })
          .eq("course_id", course.id).eq("organization_id", args.orgId).eq("assignee_type", "user").eq("user_id", uid);
      }
      results.push({ userId: uid, status: "already", reason: dueAt ? "already assigned — due date updated" : "already assigned" });
      continue;
    }
    results.push({ userId: uid, status: "failed", reason: error?.message ?? "insert failed" });
  }
  // ADR 0024 step 24: a learner who only pressed Start holds a self row; the
  // admin's assignment converts it (the due date above is already on it). A
  // converted learner is assigned, so a ticket's "assign" and "extend due
  // date" count them. No email: only an inserted row is emailed, as before.
  // Without 0107's column nothing changes. Any other error leaves each such
  // learner's outcome unknown, so each reads as failed with the reason.
  if (already.length) {
    const conversion = await convertSelfEnrolments(
      svc, "course_assignments",
      { orgId: args.orgId, column: "course_id", id: course.id, userIds: already },
      { assignedBy: args.assignedBy }
    );
    const converted = new Set(conversion.converted);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "already") continue;
      if (converted.has(r.userId)) results[i] = { userId: r.userId, status: "assigned", reason: "self-enrolment converted to an assignment" };
      else if (conversion.error) results[i] = { userId: r.userId, status: "failed", reason: `self-enrolment not converted: ${conversion.error.message ?? "update failed"}` };
    }
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
