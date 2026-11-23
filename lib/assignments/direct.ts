import type { SupabaseClient } from "@supabase/supabase-js";
import { RECIPIENTS_UNREADABLE, mailCounts, sendMany, type MailOutcome } from "@/lib/notifications/send";
import { ADMIN_REQUEST_OWN_CALLS, openRun, recordRecipientsUnreadable, requestBudget } from "@/lib/notifications/smtp-state";
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

/**
 * An assignment row as the writes below need it: whom it names. The four
 * partial unique indexes (0005, 0007, 0008, 0069) key a row by its course or
 * path and its assignee: the user, the team, the group, or the organisation.
 * `group_id` is present on a group row only, so a database before 0069 never
 * sees the column on any other.
 */
export type AssigneeRow = {
  organization_id: string;
  assignee_type: "user" | "org" | "team" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
};

/** One row's outcome, as today's one insert per row answered it. */
export type RowWrite =
  | { kind: "inserted"; data: Record<string, unknown> }
  /** 23505: the row is already there (the unique index). */
  | { kind: "duplicate" }
  /** No row came back and no error: the insert's answer had nothing to read. */
  | { kind: "silent" }
  | { kind: "failed"; error: { code?: string | null; message?: string | null } };

const ASSIGNEE_ID = { user: "user_id", team: "team_id", group: "group_id" } as const;
const KEY_COLUMNS = ["assignee_type", "user_id", "team_id"] as const;
const keyOf = (r: { assignee_type?: unknown; user_id?: unknown; team_id?: unknown; group_id?: unknown }) =>
  [r.assignee_type, r.user_id, r.team_id, r.group_id].map((v) => (v === null || v === undefined ? "" : String(v).toLowerCase())).join("|");
const codeOf = (e: PgError) => (e as { code?: string | null } | null | undefined)?.code ?? null;

/**
 * Write an administrator's assignment rows in one insert per 150 rows (ADR
 * 0029 gate G3: one insert per named learner passed the platform's 50 calls
 * a request from 11 learners on, before any mail). The result is what one
 * insert per row answered, row by row:
 *
 *   1. One read per assignee type present (150 ids a read) finds the rows
 *      already there; each is a duplicate without an insert, as its 23505
 *      was. A failed read finds nothing: the batch then meets the 23505.
 *   2. The rest go in one insert per 150 rows, every row of an insert with
 *      the same keys (`group_id` on all of them when one is a group row), and
 *      what comes back is matched to its row by the assignee.
 *   3. An insert that answers 23505 (a row written since the read) is done
 *      again one row at a time, today's way. So is any other error when
 *      `stopAtError` is false (a caller answering each learner, who fails one
 *      learner and goes on); when it is true (the routes, which answer 400 at
 *      the first error) the error is returned at once with the rows written
 *      so far, and nothing after it is tried.
 *
 * Nothing changes the database's own rules: no row is updated or ignored by
 * an upsert, and a row's defaults are its own. `calls` counts every call
 * made, for the request's budget.
 */
export async function writeAssignmentRows<R extends AssigneeRow>(
  client: SupabaseClient,
  table: "course_assignments" | "learning_path_assignments",
  scope: { column: "course_id" | "path_id"; id: string },
  rows: R[],
  select: string,
  opts: { stopAtError: boolean }
): Promise<{ outcomes: RowWrite[]; error: { code?: string | null; message?: string | null } | null; calls: number }> {
  const outcomes: RowWrite[] = new Array(rows.length);
  let calls = 0;

  // 1. The rows already there.
  const there = new Set<string>();
  for (const type of ["user", "team", "group"] as const) {
    const col = ASSIGNEE_ID[type];
    const ids = [...new Set(rows.filter((r) => r.assignee_type === type).map((r) => r[col]).filter((v): v is string => !!v))];
    for (const part of chunk(ids, 150)) {
      calls++;
      const { data, error } = await client.from(table).select(col).eq(scope.column, scope.id).eq("assignee_type", type).in(col, part);
      if (error) continue;
      for (const r of (data ?? []) as Array<Record<string, string | null>>) {
        there.add(keyOf({ assignee_type: type, user_id: type === "user" ? r.user_id : null, team_id: type === "team" ? r.team_id : null, group_id: type === "group" ? r.group_id : null }));
      }
    }
  }
  const orgRow = rows.find((r) => r.assignee_type === "org");
  if (orgRow) {
    calls++;
    const { data, error } = await client.from(table).select("id").eq(scope.column, scope.id).eq("assignee_type", "org").eq("organization_id", orgRow.organization_id);
    if (!error && (data ?? []).length > 0) there.add(keyOf({ assignee_type: "org" }));
  }
  const todo: number[] = [];
  rows.forEach((r, i) => {
    if (there.has(keyOf(r))) outcomes[i] = { kind: "duplicate" };
    else todo.push(i);
  });

  // 3. Today's one insert per row, for one part.
  const oneByOne = async (part: number[]) => {
    for (const i of part) {
      calls++;
      const { data, error } = await client.from(table).insert(rows[i]).select(select).maybeSingle();
      if (data) outcomes[i] = { kind: "inserted", data: data as unknown as Record<string, unknown> };
      else if (!error) outcomes[i] = { kind: "silent" };
      else if (codeOf(error) === "23505") outcomes[i] = { kind: "duplicate" };
      else {
        outcomes[i] = { kind: "failed", error };
        if (opts.stopAtError) return error;
      }
    }
    return null;
  };

  // 2. The rest, 150 rows an insert.
  for (const part of chunk(todo, 150)) {
    const anyGroup = part.some((i) => rows[i].group_id !== undefined);
    const body = part.map((i) => (anyGroup ? { ...rows[i], group_id: rows[i].group_id ?? null } : rows[i]));
    // The assignee's columns come back too, to match each row to its own;
    // a column the caller did not ask for is taken out again.
    const asked = select.split(",").map((c) => c.trim()).filter(Boolean);
    const added = asked.includes("*") ? [] : [...KEY_COLUMNS, ...(anyGroup ? ["group_id"] : [])].filter((c) => !asked.includes(c));
    calls++;
    const { data, error } = await client.from(table).insert(body).select(added.length ? [select, ...added].join(", ") : select);
    if (error) {
      if (codeOf(error) !== "23505" && opts.stopAtError) return { outcomes, error, calls };
      const stop = await oneByOne(part);
      if (stop) return { outcomes, error: stop, calls };
      continue;
    }
    const slots = new Map<string, number[]>();
    for (const i of part) slots.set(keyOf(rows[i]), [...(slots.get(keyOf(rows[i])) ?? []), i]);
    const strip = (r: Record<string, unknown>) => {
      if (!added.length) return r;
      const out = { ...r };
      for (const c of added) delete out[c];
      return out;
    };
    const unmatched: Record<string, unknown>[] = [];
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const i = slots.get(keyOf(r))?.shift();
      if (i === undefined) unmatched.push(r);
      else outcomes[i] = { kind: "inserted", data: strip(r) };
    }
    for (const i of part) {
      if (outcomes[i]) continue;
      const r = unmatched.shift();
      outcomes[i] = r ? { kind: "inserted", data: strip(r) } : { kind: "silent" };
    }
  }
  return { outcomes, error: null, calls };
}

/**
 * New dates on the rows already there (a re-assign is how an administrator
 * changes the schedule): one update per assignee type and 150 ids, with the
 * filters today's update of each row had, so `updated` is the sum of the
 * rows each update answered. The first error is returned.
 */
export async function rescheduleAssignments(
  client: SupabaseClient,
  table: "course_assignments",
  scope: { column: "course_id"; id: string; orgId: string },
  rows: AssigneeRow[],
  patch: { due_at: string | null; release_at?: string | null }
): Promise<{ updated: number; error: PgError; calls: number }> {
  let updated = 0;
  let calls = 0;
  const base = () => client.from(table).update(patch).eq(scope.column, scope.id).eq("organization_id", scope.orgId);
  if (rows.some((r) => r.assignee_type === "org")) {
    calls++;
    const { data, error } = await base().eq("assignee_type", "org").is("user_id", null).is("team_id", null).select("id");
    if (error) return { updated, error, calls };
    updated += data?.length ?? 0;
  }
  for (const type of ["user", "team", "group"] as const) {
    const col = ASSIGNEE_ID[type];
    const ids = [...new Set(rows.filter((r) => r.assignee_type === type).map((r) => r[col]).filter((v): v is string => !!v))];
    for (const part of chunk(ids, 150)) {
      calls++;
      let q = base().eq("assignee_type", type);
      if (type !== "user") q = q.is("user_id", null);
      if (type !== "team") q = q.is("team_id", null);
      const { data, error } = await q.in(col, part).select("id");
      if (error) return { updated, error, calls };
      updated += data?.length ?? 0;
    }
  }
  return { updated, error: null, calls };
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
): Promise<ActionError | { results: PerLearnerResult[]; courseTitle: string; dueAt: string | null; email: MailOutcome | null }> {
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
  // The rows in one insert per 150 (ADR 0029 gate G3), each learner's
  // outcome what their own insert answered: a learner whose row fails is
  // failed and the others go on (writeAssignmentRows then inserts that part
  // one row at a time, as before).
  const rows = ids.map((uid) => ({
    course_id: course.id, organization_id: args.orgId, assignee_type: "user" as const, user_id: uid, team_id: null,
    due_at: dueAt, release_at: null, assigned_by: args.assignedBy,
  }));
  const written = await writeAssignmentRows(svc, "course_assignments", { column: "course_id", id: course.id }, rows, "id", { stopAtError: false });
  /** The calls this assignment's writes made, for the mail's budget. */
  let writeCalls = written.calls;
  written.outcomes.forEach((o, i) => {
    const uid = ids[i];
    if (o.kind === "inserted") { inserted.push(uid); results.push({ userId: uid, status: "assigned" }); return; }
    if (o.kind === "duplicate") {
      already.push(uid);
      results.push({ userId: uid, status: "already", reason: dueAt ? "already assigned — due date updated" : "already assigned" });
      return;
    }
    results.push({ userId: uid, status: "failed", reason: (o.kind === "failed" ? o.error.message : null) ?? "insert failed" });
  });
  // The new due date on the rows already there: one update per 150 learners
  // (its answer is not read, as before).
  if (already.length && dueAt) {
    const dated = await rescheduleAssignments(
      svc, "course_assignments", { column: "course_id", id: course.id, orgId: args.orgId },
      already.map((uid) => ({ organization_id: args.orgId, assignee_type: "user" as const, user_id: uid, team_id: null })),
      { due_at: dueAt }
    );
    writeCalls += dated.calls;
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
    writeCalls += chunk([...new Set(already)], 150).length;
    const converted = new Set(conversion.converted);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "already") continue;
      if (converted.has(r.userId)) results[i] = { userId: r.userId, status: "assigned", reason: "self-enrolment converted to an assignment" };
      else if (conversion.error) results[i] = { userId: r.userId, status: "failed", reason: `self-enrolment not converted: ${conversion.error.message ?? "update failed"}` };
    }
  }
  // The assignment mail (ADR 0029 rule T4): one run within the request's
  // budgets. The rows are saved; a failed read of the learners' addresses
  // mails nobody, records the skip, and the outcome says so.
  let email: MailOutcome | null = null;
  if (inserted.length && args.notify !== false) {
    email = await (async (): Promise<MailOutcome | null> => {
      let people: Awaited<ReturnType<typeof namesAndEmails>>;
      try {
        people = await namesAndEmails(svc, inserted);
      } catch {
        await recordRecipientsUnreadable("assign-direct", args.orgId);
        return RECIPIENTS_UNREADABLE;
      }
      try {
        const link = args.origin ? `${args.origin}/${args.orgSlug}/courses/${course.id}/launch` : `/${args.orgSlug}/courses/${course.id}/launch`;
        const learners = inserted.flatMap((uid) => {
          const who = people.get(uid);
          return who?.email ? [{ uid, name: who.name, email: who.email }] : [];
        });
        const run = await openRun({ organizationId: args.orgId, budget: requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS + writeCalls }), db: svc });
        const sent = await sendMany(run, learners, (l) => ({
          event: "asset_assignment",
          to: { user_id: l.uid, email: l.email },
          context: {
            learner_name: l.name,
            learner_email: l.email,
            course_name: course.title,
            course_id: course.id,
            org_name: args.orgName,
            direct_link: link,
            due_date: dueAt ? `Due ${dueAt.slice(0, 10)}.` : "No due date.",
          },
        }));
        return mailCounts(sent, inserted.length - learners.length);
      } catch (e) {
        console.warn(JSON.stringify({ event: "assignment_mail_failed", site: "assign-direct", org_id: args.orgId, error: e instanceof Error ? e.name : "unknown" }));
        return null;
      }
    })();
  }
  return { results, courseTitle: course.title, dueAt, email };
}
