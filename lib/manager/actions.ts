import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { resolveOrgMembership } from "@/lib/auth/org-membership";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { sendMany, type SendResult } from "@/lib/notifications/send";
import {
  GROUP_TAIL_CALLS,
  MAIL_CALL_COSTS,
  MIDDLEWARE_CALLS,
  SENDS_AT_ONCE,
  countCalls,
  hasRoom,
  openRun,
  requestBudget,
  spendCalls,
  type MailBudget,
} from "@/lib/notifications/smtp-state";
import { type ActionError, type PerLearnerResult } from "@/lib/actions/types";
import { namesAndEmails } from "@/lib/users/people";
import {
  DEFAULT_JOURNEY_TZ,
  computeJourneyState,
  courseDaysOf,
  dateOfDay,
  parseVersionDays,
  reminderCountsFrom,
  reminderCreditedDays,
  todayStr,
  type ReminderCounts,
} from "@/lib/journey/journey";
import { loadScopes } from "@/lib/content/scopes";
import { loadManagerContext, partitionByScope, type ManagerContext } from "./access";
import { isVisible, loadCoverage } from "./coverage";
import { readCourseReminderLines } from "./insights";

/**
 * Manager actions. Since Phase 4a (approved addendum, decision 12) managers
 * VIEW + ANALYSE + SUPPORT: the only direct action left is "send a reminder
 * now" (decision 13). Grant retry and assign a course were withdrawn — a
 * manager raises a support ticket with the context and an admin acts from it
 * (lib/tickets/*). The pattern stays: verify the session, resolve the viewer's
 * people on the server from the three hierarchy fields, refuse the whole
 * request if any target is outside them (never a partial leak), then write
 * on the service role.
 *
 * ADR 0029 rule FP2: the request is one budget, counted from its first
 * call (the middleware's, then the session, the membership and the
 * reporting line here), each call where it is made, every page and
 * fallback of the reminder's reads included, so the reminders' mail is
 * sized on the calls really made and stops at the limit: the rest is
 * answered as not sent for room ("try again"). A course reminder decides
 * who is due with its own read, narrowed to the named learners and the
 * course (readCourseReminderLines, ADR 0029 note of 2026-11-25, part 1),
 * not with the Report Card's reader of the whole organisation; each press
 * then mails the next learners due.
 */

export type ManagerActionContext = {
  svc: SupabaseClient;
  org: { id: string; name: string; slug: string };
  user: { id: string; email: string | null };
  ctx: ManagerContext;
  origin: string;
  /** The request's budget, its count holding the request's calls so far. */
  budget: MailBudget;
};

export type { ActionError, PerLearnerResult } from "@/lib/actions/types";

const svcClient = () =>
  createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

/**
 * Session → org → manager scope. Impersonation never carries a hierarchy.
 * `budget`: the request's, made in the route's first line (ADR 0029 rule
 * FP2); else one made here, counting the middleware's call.
 */
export async function authorizeManager(
  orgSlug: string | undefined,
  budget: MailBudget = requestBudget({ spent: MIDDLEWARE_CALLS })
): Promise<ManagerActionContext | ActionError> {
  if (!orgSlug) return { error: "orgSlug required", status: 400 };
  const supabase = await createClient();
  spendCalls(budget, 1);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };
  // ADR 0030: a membership that counts (active, in an org that is not
  // deleted); anything else is answered as a signed-in non-member is.
  // Two calls: the organisation by its slug, then the caller's member row.
  spendCalls(budget, 2);
  const m = await resolveOrgMembership<{ id: string; name: string | null; slug: string }>(
    supabase,
    { slug: orgSlug },
    user.id,
    "id, name, slug"
  );
  if (m === "unreadable") return { error: CHECK_FAILED, status: 503 };
  if (m === "none") return { error: "Organization not found", status: 404 };
  const org = m.org;
  const svc = svcClient();
  const ctx = await loadManagerContext(svc, org.id, user.id, countCalls(budget));
  if (!ctx.isManager) return { error: "You are not mapped as anyone's manager.", status: 403 };
  return {
    svc,
    org: { id: org.id, name: org.name ?? "your org", slug: org.slug },
    user: { id: user.id, email: user.email ?? null },
    ctx,
    origin: await originFromRequest(),
    budget,
  };
}

export const isActionError = (x: unknown): x is ActionError =>
  !!x && typeof x === "object" && "error" in x && "status" in x;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One action emails up to this many people; each email is several Workers subrequests. */
export const MAX_TARGETS = 50;

/** Every target must be inside the manager's hierarchy. */
function requireAllInScope(a: ManagerActionContext, userIds: unknown): ActionError | string[] {
  if (!Array.isArray(userIds)) return { error: "userIds must be an array", status: 400 };
  const ids = [...new Set(userIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))];
  if (ids.length === 0) return { error: "No learners selected", status: 400 };
  if (ids.length !== userIds.length) return { error: "Invalid learner id", status: 400 };
  if (ids.length > MAX_TARGETS) return { error: `Too many learners in one action (max ${MAX_TARGETS})`, status: 400 };
  const { denied } = partitionByScope(a.ctx, ids);
  if (denied.length > 0) return { error: "One or more learners are not in your reporting line.", status: 403 };
  return ids;
}

async function orgTimezone(svc: SupabaseClient, orgId: string, budget: MailBudget): Promise<string> {
  spendCalls(budget, 1);
  const { data } = await svc.from("gamification_settings").select("timezone").eq("organization_id", orgId).maybeSingle();
  return (data as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
}

async function orgCourse(svc: SupabaseClient, orgId: string, courseId: string | undefined, budget: MailBudget) {
  if (!courseId) return null;
  spendCalls(budget, 1);
  const { data } = await svc
    .from("courses")
    .select("id, title, is_active")
    .eq("id", courseId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return (data as { id: string; title: string; is_active: boolean } | null) ?? null;
}

/** A reminder the request had no room for: not attempted, and said so. */
const NO_ROOM_REASON = "not sent: the request had no room left; try again";

/**
 * Whether the request has room for its run's first send (ADR 0029 rule
 * FP2): the run's opening, its template, one send, and its group's tail
 * with the caller's own calls around the group (`hookCalls`), as the run
 * sizes a group. The reads before it are what decide who is due, and they
 * are made whatever they cost; with no room left after them the run is not
 * opened and every learner due is answered as left for room.
 */
const roomForFirstSend = (budget: MailBudget, hookCalls: number) =>
  hasRoom(budget, MAIL_CALL_COSTS.open + MAIL_CALL_COSTS.template + MAIL_CALL_COSTS.send + GROUP_TAIL_CALLS + hookCalls);
/** The course reminder's own call around a group: the reminder state's write after it. */
const COURSE_HOOK_CALLS = 1;
/** The journey reminder's own calls around a group: the day's claim before it, and up to one give-back a mail after it. */
const JOURNEY_HOOK_CALLS = 1 + SENDS_AT_ONCE;

/** A send that did not go out, in words the manager can act on. */
function sendReason(r: SendResult): string {
  if (r.status === "paused") return "email reminders are paused for your organisation";
  if (r.errorClass === "timeout") return "not confirmed: the mail may still arrive";
  if (r.errorClass === "daily_limit") return "your organisation reached its daily email limit";
  if (r.errorClass === "left") return NO_ROOM_REASON;
  if (r.errorClass === "not_configured" || r.errorClass === "not_ready") return "your organisation's email is not working";
  return "email could not be sent";
}

// ---------------------------------------------------------------------------
// 1. Send reminder now
// ---------------------------------------------------------------------------

/** Manual reminders on the same course/journey are rate-limited to once per this window. */
const REMINDER_WINDOW_MS = 20 * 60 * 60 * 1000;

export async function sendReminders(
  a: ManagerActionContext,
  body: { userIds?: string[]; target?: "course" | "start" | "journey"; contentId?: string | null }
): Promise<ActionError | { results: PerLearnerResult[] }> {
  const ids = requireAllInScope(a, body.userIds ?? []);
  if (isActionError(ids)) return ids;
  const target = body.target === "journey" ? "journey" : "course";
  // The request's one budget (ADR 0029 rule FP2): every call below is
  // counted where it is made, and the run opens on it.
  const budget = a.budget;
  const count = countCalls(budget);
  // The learners' addresses decide who is mailed: a failed read answers 503
  // and sends nothing (ADR 0029, part 3), never "no email" for everyone.
  let people: Awaited<ReturnType<typeof namesAndEmails>>;
  try {
    people = await namesAndEmails(a.svc, ids, count);
  } catch {
    return { error: "The learners' details could not be read. Nothing was sent; try again.", status: 503 };
  }
  const results: PerLearnerResult[] = [];
  const nowIso = new Date().toISOString();

  // Rule 1 (Phase 4c): a manager may only act on content they can see.
  const coverage = await loadCoverage(a.svc, a.org.id, a.user.id, count);

  if (target === "course") {
    const course = await orgCourse(a.svc, a.org.id, body.contentId ?? undefined, budget);
    if (!course) return { error: "Course not found", status: 404 };
    const scopes = await loadScopes(a.svc, a.org.id, [{ type: "course", id: course.id }], count);
    if (!isVisible(coverage, scopes.get(`course:${course.id}`))) return { error: "Course not found", status: 404 };
    // Re-derive entitlement and status NOW (dynamic groups change; the page
    // the manager clicked may be stale), with the reminder's own read (ADR
    // 0029, note of 2026-11-25, part 1): for the named learners and this
    // course only, by the Report Card's rules, whether each has a line and
    // its status (readCourseReminderLines, beside the Report Card's reader).
    // No line → skip; official result already in → skip. Every read of it
    // decides who is mailed, so each is strict: a failed read, the grants'
    // included, answers 503 and sends nothing (stage 2's one rule), never
    // "not assigned this course". Each call is counted where it is made.
    let lines: Awaited<ReturnType<typeof readCourseReminderLines>>;
    try {
      lines = await readCourseReminderLines(a.svc, {
        orgId: a.org.id,
        courseId: course.id,
        courseActive: course.is_active !== false,
        userIds: ids,
        countCall: count,
      });
    } catch {
      return { error: "The learners' assignments could not be read. Nothing was sent; try again.", status: 503 };
    }
    spendCalls(budget, 1);
    const { data: stateRows, error: stateErr } = await a.svc
      .from("reminder_state")
      .select("user_id, first_assigned_at, last_nudge_at, nudge_count")
      .eq("course_id", course.id)
      .in("user_id", ids);
    // A failed read is never "never reminded" (ADR 0029, part 3): nothing is sent.
    if (stateErr) return { error: "The learners' reminder records could not be read. Nothing was sent; try again.", status: 503 };
    const state = new Map<string, { first_assigned_at: string; last_nudge_at: string | null; nudge_count: number }>();
    for (const s of (stateRows ?? []) as Array<{ user_id: string; first_assigned_at: string; last_nudge_at: string | null; nudge_count: number }>) state.set(s.user_id, s);
    const link = a.origin ? `${a.origin}/${a.org.slug}/courses/${course.id}/launch` : `/${a.org.slug}/courses/${course.id}/launch`;
    const byUser = new Map<string, PerLearnerResult>();
    const due: Array<{ uid: string; name: string; email: string }> = [];
    for (const uid of ids) {
      const who = people.get(uid);
      if (!who?.email) { byUser.set(uid, { userId: uid, status: "skipped", reason: "no email" }); continue; }
      const line = lines.get(uid);
      if (!line) { byUser.set(uid, { userId: uid, status: "skipped", reason: "not assigned this course" }); continue; }
      if (line.status === "completed" || line.status === "passed" || line.status === "failed") {
        byUser.set(uid, { userId: uid, status: "skipped", reason: "already completed" });
        continue;
      }
      const st = state.get(uid);
      if (st?.last_nudge_at && Date.now() - new Date(st.last_nudge_at).getTime() < REMINDER_WINDOW_MS) {
        byUser.set(uid, { userId: uid, status: "skipped", reason: "reminded in the last day" });
        continue;
      }
      due.push({ uid, name: who.name, email: who.email });
    }
    // One run (ADR 0029 rules T4 and FP7): the sends go through the run's
    // shape and budgets, and each group's state is written with the group,
    // so a later failure in the request cannot lose the fact that a person
    // WAS emailed. The run is on the request's budget, so the mail stops
    // where the request's calls do, and the rest is answered as left.
    if (due.length > 0 && !roomForFirstSend(budget, COURSE_HOOK_CALLS)) {
      for (const d of due) byUser.set(d.uid, { userId: d.uid, status: "failed", reason: NO_ROOM_REASON });
    } else if (due.length > 0) {
      const run = await openRun({ organizationId: a.org.id, budget, db: a.svc });
      const unrecorded = new Set<string>();
      const sent = await sendMany(
        run,
        due,
        (d) => ({
          event: "asset_reminder",
          to: { user_id: d.uid, email: d.email },
          context: {
            learner_name: d.name,
            learner_email: d.email,
            course_name: course.title,
            course_id: course.id,
            org_name: a.org.name,
            direct_link: link,
          },
        }),
        {
          hooks: {
            afterCalls: COURSE_HOOK_CALLS,
            after: async (entries) => {
              const rows = entries.filter((e) => e.result.status === "sent").map(({ item: d }) => {
                const st = state.get(d.uid);
                return {
                  user_id: d.uid,
                  course_id: course.id,
                  organization_id: a.org.id,
                  first_assigned_at: st?.first_assigned_at ?? nowIso,
                  last_nudge_at: nowIso,
                  nudge_count: (st?.nudge_count ?? 0) + 1,
                  stopped: false,
                };
              });
              if (rows.length === 0) return { calls: 0 };
              const { error } = await a.svc.from("reminder_state").upsert(rows, { onConflict: "user_id,course_id" });
              if (error) for (const r of rows) unrecorded.add(r.user_id);
              return { calls: 1 };
            },
          },
        }
      );
      sent.forEach((r, k) => {
        const uid = due[k].uid;
        if (r.status === "sent") {
          byUser.set(uid, unrecorded.has(uid) ? { userId: uid, status: "sent", reason: "sent, but the reminder could not be recorded" } : { userId: uid, status: "sent" });
        } else {
          byUser.set(uid, { userId: uid, status: "failed", reason: sendReason(r) });
        }
      });
    }
    for (const uid of ids) results.push(byUser.get(uid)!);
    return { results };
  }

  // Journey: the learner's ACTIVE enrollment on the given program (or their only active one).
  const tz = await orgTimezone(a.svc, a.org.id, budget);
  const today = todayStr(tz);
  let q = a.svc
    .from("journey_enrollments")
    .select("id, user_id, program_id, start_date, last_daily_reminder_on, journey_versions!inner(days, days_total, count_sundays, unlock_mode), journey_programs!inner(id, name, is_active, deadline_days)")
    .eq("organization_id", a.org.id)
    .eq("status", "active")
    .in("user_id", ids);
  if (body.contentId) q = q.eq("program_id", body.contentId);
  spendCalls(budget, 1);
  const { data: enrRows, error: enrErr } = await q;
  // A failed read is never "no active journey" (ADR 0029, part 3): nothing is sent.
  if (enrErr) return { error: "The learners' journeys could not be read. Nothing was sent; try again.", status: 503 };
  type Enr = {
    id: string; user_id: string; program_id: string; start_date: string; last_daily_reminder_on: string | null;
    journey_versions: { days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null } | Array<{ days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }>;
    journey_programs: { id: string; name: string; is_active: boolean; deadline_days?: number | null } | Array<{ id: string; name: string; is_active: boolean; deadline_days?: number | null }>;
  };
  const enrolments = new Map<string, Enr>();
  for (const e of (enrRows ?? []) as Enr[]) if (!enrolments.has(e.user_id)) enrolments.set(e.user_id, e);
  // Enrollments on journeys outside the manager's coverage are not theirs to remind.
  const programIds = [...new Set([...enrolments.values()].map((e) => e.program_id))];
  const journeyScopes = await loadScopes(a.svc, a.org.id, programIds.map((id) => ({ type: "journey" as const, id })), count);
  for (const [uid, e] of [...enrolments]) if (!isVisible(coverage, journeyScopes.get(`journey:${e.program_id}`))) enrolments.delete(uid);
  // One batched round-trip for the credited days + "done today" (the same
  // RPC the hourly cron uses), instead of a query per learner. `credited`
  // (0107) is the day numbers credited by day id; reminderCreditedDays falls
  // back to the first `done` course days on a database without it (ADR 0024
  // step 45). A failed read reminds nobody: it is never "nothing done"
  // (reminderCountsFrom).
  let counts: ReminderCounts = reminderCountsFrom([], null);
  if (enrolments.size) {
    spendCalls(budget, 1);
    const { data: cntRows, error: cntErr } = await a.svc.rpc("journey_reminder_counts", { p_ids: [...enrolments.values()].map((e) => e.id) });
    counts = reminderCountsFrom(cntRows, cntErr);
  }
  type Due = {
    uid: string;
    name: string;
    email: string;
    enrolment: string;
    previous: string | null;
    journeyName: string;
    day: string;
    daysTotal: string;
    behindDays: string;
    nextModule: string;
    reminderLine: string;
    deadline: string;
  };
  const byUser = new Map<string, PerLearnerResult>();
  const due: Array<Pick<Due, "uid" | "name" | "email" | "enrolment" | "previous"> & { st: ReturnType<typeof computeJourneyState>; p: { name: string; deadline_days?: number | null }; v: { count_sundays: boolean }; startDate: string; unlockMode: "calendar" | "progress"; courseId: string | null; missionTitle: string | null }> = [];
  for (const uid of ids) {
    const who = people.get(uid);
    const e = enrolments.get(uid);
    if (!who?.email) { byUser.set(uid, { userId: uid, status: "skipped", reason: "no email" }); continue; }
    if (!e) { byUser.set(uid, { userId: uid, status: "skipped", reason: "no active journey" }); continue; }
    const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
    const p = Array.isArray(e.journey_programs) ? e.journey_programs[0] : e.journey_programs;
    if (!v || !p || p.is_active === false) { byUser.set(uid, { userId: uid, status: "skipped", reason: "journey inactive" }); continue; }
    if (e.last_daily_reminder_on === today) { byUser.set(uid, { userId: uid, status: "skipped", reason: "already reminded today" }); continue; }
    const unlockMode = v.unlock_mode === "progress" ? "progress" : "calendar";
    const cnt = counts.ok ? counts.countOf(e.id) : null;
    if (!cnt) { byUser.set(uid, { userId: uid, status: "skipped", reason: "journey progress unreadable" }); continue; }
    const courseDays = courseDaysOf(v.days, v.days_total);
    const st = computeJourneyState({
      startDate: e.start_date, today, creditedDays: reminderCreditedDays(cnt, courseDays), daysTotal: v.days_total,
      countSundays: v.count_sundays === true, unlockMode, courseDays,
    });
    if (st.finished) { byUser.set(uid, { userId: uid, status: "skipped", reason: "journey finished" }); continue; }
    // Same "due" gate as the cron: calendar → something released is pending;
    // progress → today's mission is open and nothing was completed today.
    const isDue = unlockMode === "calendar" ? st.pendingDays >= 1 : st.todayUnlocked && !cnt.done_today;
    if (!isDue) { byUser.set(uid, { userId: uid, status: "skipped", reason: "nothing pending today" }); continue; }
    const entry = parseVersionDays(v.days).get(st.currentDay);
    due.push({
      uid, name: who.name, email: who.email, enrolment: e.id, previous: e.last_daily_reminder_on,
      st, p, v: { count_sundays: v.count_sundays === true }, startDate: e.start_date, unlockMode,
      courseId: entry?.course_id ?? null, missionTitle: entry?.mission_title ?? null,
    });
  }
  // The course titles of the next missions, in one read (rule FP7). A failed
  // read sends the mail with the general words, as before.
  const titleIds = [...new Set(due.filter((d) => !d.missionTitle && d.courseId).map((d) => d.courseId!))];
  const courseTitle = new Map<string, string>();
  if (titleIds.length > 0) {
    spendCalls(budget, 1);
    const { data: titleRows } = await a.svc.from("courses").select("id, title").in("id", titleIds);
    for (const c of (titleRows ?? []) as Array<{ id: string; title?: string | null }>) if (c.title) courseTitle.set(c.id, c.title);
  }
  const link = a.origin ? `${a.origin}/${a.org.slug}/journey` : `/${a.org.slug}/journey`;
  const mails: Due[] = due.map((d) => {
    const nextModule = d.missionTitle ?? (d.courseId ? courseTitle.get(d.courseId) : undefined) ?? "your next module";
    const reminderLine =
      d.unlockMode === "calendar" && d.st.behindDays >= 1
        ? `You're **${d.st.behindDays} day${d.st.behindDays === 1 ? "" : "s"} behind** — missed missions can be caught up one after another.`
        : "Pick up where you left off — it only takes a few minutes.";
    const deadline = typeof d.p.deadline_days === "number" && d.p.deadline_days > 0 ? dateOfDay(d.startDate, d.p.deadline_days, d.v.count_sundays) : null;
    return {
      uid: d.uid, name: d.name, email: d.email, enrolment: d.enrolment, previous: d.previous,
      journeyName: d.p.name,
      day: String(d.st.currentDay),
      daysTotal: String(d.st.daysTotal),
      behindDays: String(d.st.behindDays),
      nextModule,
      reminderLine,
      deadline: deadline ?? "",
    };
  });
  if (mails.length > 0 && !roomForFirstSend(budget, JOURNEY_HOOK_CALLS)) {
    for (const d of mails) byUser.set(d.uid, { userId: d.uid, status: "failed", reason: NO_ROOM_REASON });
  } else if (mails.length > 0) {
    // One run (ADR 0029 rules T2, T4 and FP7). Today's reminder is claimed for
    // each group in one conditional update just before its sends, so the
    // hourly cron cannot send a second one and a nudge that is not started
    // holds no claim. A claim is given back after a failure of any class but
    // a timeout (the mail may still arrive), so the cron can try later today.
    // The run is on the request's budget, as the course's.
    const run = await openRun({ organizationId: a.org.id, budget, db: a.svc });
    const claimed = new Set<string>();
    const sent = await sendMany(
      run,
      mails,
      (d) => ({
        event: "journey_nudge",
        to: { user_id: d.uid, email: d.email },
        context: {
          learner_name: d.name,
          learner_email: d.email,
          org_name: a.org.name,
          journey_name: d.journeyName,
          day: d.day,
          days_total: d.daysTotal,
          behind_days: d.behindDays,
          next_module: d.nextModule,
          reminder_line: d.reminderLine,
          deadline_date: d.deadline,
          direct_link: link,
          portal_url: link,
        },
      }),
      {
        hooks: {
          beforeCalls: 1,
          before: async (group) => {
            const ids = group.map((d) => d.enrolment);
            const q = a.svc.from("journey_enrollments").update({ last_daily_reminder_on: today });
            const { data, error } = await (ids.length === 1 ? q.eq("id", ids[0]) : q.in("id", ids))
              .or(`last_daily_reminder_on.is.null,last_daily_reminder_on.lt.${today}`)
              .select("id");
            if (error) return { keep: group.map(() => false), calls: 1 };
            const won = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
            for (const id of won) claimed.add(id);
            return { keep: group.map((d) => won.has(d.enrolment)), calls: 1 };
          },
          // One write for each earlier date in the group, at most one a mail.
          afterCalls: SENDS_AT_ONCE,
          after: async (entries) => {
            const giveBack = entries.filter(
              (e) => claimed.has(e.item.enrolment) && e.result.status !== "sent" && !(e.result.status === "failed" && e.result.cls === "timeout")
            );
            const byPrevious = new Map<string | null, string[]>();
            for (const { item } of giveBack) byPrevious.set(item.previous, [...(byPrevious.get(item.previous) ?? []), item.enrolment]);
            let calls = 0;
            for (const [previous, enrolments] of byPrevious) {
              calls++;
              await a.svc.from("journey_enrollments").update({ last_daily_reminder_on: previous }).in("id", enrolments).eq("last_daily_reminder_on", today);
            }
            return { calls };
          },
        },
      }
    );
    sent.forEach((r, k) => {
      const uid = mails[k].uid;
      if (r.status === "sent") byUser.set(uid, { userId: uid, status: "sent" });
      else if (r.errorClass === "withdrawn") byUser.set(uid, { userId: uid, status: "skipped", reason: "already reminded today" });
      else byUser.set(uid, { userId: uid, status: "failed", reason: sendReason(r) });
    });
  }
  for (const uid of ids) results.push(byUser.get(uid)!);
  return { results };
}
