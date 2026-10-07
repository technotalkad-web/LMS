import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { notifyBackground } from "@/lib/notifications/send";
import { type ActionError, type PerLearnerResult } from "@/lib/actions/types";
import { namesAndEmails } from "@/lib/users/people";
import {
  DEFAULT_JOURNEY_TZ,
  computeJourneyState,
  courseDaysOf,
  dateOfDay,
  parseVersionDays,
  todayStr,
} from "@/lib/journey/journey";
import { loadScopes } from "@/lib/content/scopes";
import { loadManagerContext, partitionByScope, type ManagerContext } from "./access";
import { isVisible, loadCoverage } from "./coverage";
import { computeLearnerInsights } from "./insights";

/**
 * Manager actions. Since Phase 4a (approved addendum, decision 12) managers
 * VIEW + ANALYSE + SUPPORT: the only direct action left is "send a reminder
 * now" (decision 13). Grant retry and assign a course were withdrawn — a
 * manager raises a support ticket with the context and an admin acts from it
 * (lib/tickets/*). The pattern stays: verify the session, resolve the viewer's
 * people on the server from the three hierarchy fields, refuse the whole
 * request if any target is outside them (never a partial leak), then write
 * on the service role.
 */

export type ManagerActionContext = {
  svc: SupabaseClient;
  org: { id: string; name: string; slug: string };
  user: { id: string; email: string | null };
  ctx: ManagerContext;
  origin: string;
};

export type { ActionError, PerLearnerResult } from "@/lib/actions/types";

const svcClient = () =>
  createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

/** Session → org → manager scope. Impersonation never carries a hierarchy. */
export async function authorizeManager(orgSlug: string | undefined): Promise<ManagerActionContext | ActionError> {
  if (!orgSlug) return { error: "orgSlug required", status: 400 };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };
  const { data: org } = await supabase.from("organizations").select("id, name, slug").eq("slug", orgSlug).maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role, status")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!mem || (mem as { status?: string }).status !== "active") return { error: "Forbidden", status: 403 };
  const svc = svcClient();
  const ctx = await loadManagerContext(svc, org.id as string, user.id);
  if (!ctx.isManager) return { error: "You are not mapped as anyone's manager.", status: 403 };
  return {
    svc,
    org: { id: org.id as string, name: (org.name as string) ?? "your org", slug: org.slug as string },
    user: { id: user.id, email: user.email ?? null },
    ctx,
    origin: await originFromRequest(),
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

async function orgTimezone(svc: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await svc.from("gamification_settings").select("timezone").eq("organization_id", orgId).maybeSingle();
  return (data as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
}

async function orgCourse(svc: SupabaseClient, orgId: string, courseId: string | undefined) {
  if (!courseId) return null;
  const { data } = await svc
    .from("courses")
    .select("id, title, is_active")
    .eq("id", courseId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return (data as { id: string; title: string; is_active: boolean } | null) ?? null;
}

/** A send that did not go out, in words the manager can act on. */
function sendReason(status: string | undefined): string {
  if (status === "paused") return "email reminders are paused for your organisation";
  if (status === "queued") return "queued — no email transport configured";
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
  const people = await namesAndEmails(a.svc, ids);
  const results: PerLearnerResult[] = [];
  const nowIso = new Date().toISOString();

  // Rule 1 (Phase 4c): a manager may only act on content they can see.
  const coverage = await loadCoverage(a.svc, a.org.id, a.user.id);

  if (target === "course") {
    const course = await orgCourse(a.svc, a.org.id, body.contentId ?? undefined);
    if (!course) return { error: "Course not found", status: 404 };
    const scopes = await loadScopes(a.svc, a.org.id, [{ type: "course", id: course.id }]);
    if (!isVisible(coverage, scopes.get(`course:${course.id}`))) return { error: "Course not found", status: 404 };
    // Re-derive entitlement and status NOW (dynamic groups change; the page
    // the manager clicked may be stale): the same rules as the Report Card,
    // narrowed to this course. Not assigned/attempted → skip; official result
    // already in → skip.
    const { learners } = await computeLearnerInsights(a.svc, {
      orgId: a.org.id,
      orgSlug: a.org.slug,
      userIds: ids,
      periodDays: null,
      content: `course:${course.id}`,
    });
    const lineOf = new Map(learners.map((l) => [l.userId, l.courses.find((c) => c.courseId === course.id) ?? null]));
    const { data: stateRows } = await a.svc
      .from("reminder_state")
      .select("user_id, first_assigned_at, last_nudge_at, nudge_count")
      .eq("course_id", course.id)
      .in("user_id", ids);
    const state = new Map<string, { first_assigned_at: string; last_nudge_at: string | null; nudge_count: number }>();
    for (const s of (stateRows ?? []) as Array<{ user_id: string; first_assigned_at: string; last_nudge_at: string | null; nudge_count: number }>) state.set(s.user_id, s);
    const link = a.origin ? `${a.origin}/${a.org.slug}/courses/${course.id}/launch` : `/${a.org.slug}/courses/${course.id}/launch`;
    for (const uid of ids) {
      const who = people.get(uid);
      if (!who?.email) { results.push({ userId: uid, status: "skipped", reason: "no email" }); continue; }
      const line = lineOf.get(uid);
      if (!line) { results.push({ userId: uid, status: "skipped", reason: "not assigned this course" }); continue; }
      if (line.status === "completed" || line.status === "passed" || line.status === "failed") {
        results.push({ userId: uid, status: "skipped", reason: "already completed" });
        continue;
      }
      const st = state.get(uid);
      if (st?.last_nudge_at && Date.now() - new Date(st.last_nudge_at).getTime() < REMINDER_WINDOW_MS) {
        results.push({ userId: uid, status: "skipped", reason: "reminded in the last day" });
        continue;
      }
      const res = await notifyBackground({
        organizationId: a.org.id,
        event: "asset_reminder",
        to: { user_id: uid, email: who.email },
        context: {
          learner_name: who.name,
          learner_email: who.email,
          course_name: course.title,
          course_id: course.id,
          org_name: a.org.name,
          direct_link: link,
        },
      });
      if (res?.status === "sent") {
        // Record the send immediately (a later failure in the loop must not
        // lose the fact that this person WAS emailed → duplicate on retry).
        const { error } = await a.svc.from("reminder_state").upsert(
          {
            user_id: uid,
            course_id: course.id,
            organization_id: a.org.id,
            first_assigned_at: st?.first_assigned_at ?? nowIso,
            last_nudge_at: nowIso,
            nudge_count: (st?.nudge_count ?? 0) + 1,
            stopped: false,
          },
          { onConflict: "user_id,course_id" }
        );
        results.push(error ? { userId: uid, status: "sent", reason: "sent, but the reminder could not be recorded" } : { userId: uid, status: "sent" });
      } else {
        results.push({ userId: uid, status: "failed", reason: sendReason(res?.status) });
      }
    }
    return { results };
  }

  // Journey: the learner's ACTIVE enrollment on the given program (or their only active one).
  const tz = await orgTimezone(a.svc, a.org.id);
  const today = todayStr(tz);
  let q = a.svc
    .from("journey_enrollments")
    .select("id, user_id, program_id, start_date, last_daily_reminder_on, journey_versions!inner(days, days_total, count_sundays, unlock_mode), journey_programs!inner(id, name, is_active, deadline_days)")
    .eq("organization_id", a.org.id)
    .eq("status", "active")
    .in("user_id", ids);
  if (body.contentId) q = q.eq("program_id", body.contentId);
  const { data: enrRows } = await q;
  type Enr = {
    id: string; user_id: string; program_id: string; start_date: string; last_daily_reminder_on: string | null;
    journey_versions: { days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null } | Array<{ days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }>;
    journey_programs: { id: string; name: string; is_active: boolean; deadline_days?: number | null } | Array<{ id: string; name: string; is_active: boolean; deadline_days?: number | null }>;
  };
  const byUser = new Map<string, Enr>();
  for (const e of (enrRows ?? []) as Enr[]) if (!byUser.has(e.user_id)) byUser.set(e.user_id, e);
  // Enrollments on journeys outside the manager's coverage are not theirs to remind.
  const programIds = [...new Set([...byUser.values()].map((e) => e.program_id))];
  const journeyScopes = await loadScopes(a.svc, a.org.id, programIds.map((id) => ({ type: "journey" as const, id })));
  for (const [uid, e] of [...byUser]) if (!isVisible(coverage, journeyScopes.get(`journey:${e.program_id}`))) byUser.delete(uid);
  // One batched round-trip for completed-day counts + "done today" (the same
  // RPC the hourly cron uses), instead of a query per learner.
  const counts = new Map<string, { done: number; done_today: boolean }>();
  if (byUser.size) {
    const { data: cntRows } = await a.svc.rpc("journey_reminder_counts", { p_ids: [...byUser.values()].map((e) => e.id) });
    for (const c of (cntRows ?? []) as Array<{ enrollment_id: string; done: number; done_today: boolean }>) {
      counts.set(c.enrollment_id, { done: c.done ?? 0, done_today: c.done_today === true });
    }
  }
  const courseTitle = new Map<string, string>();
  for (const uid of ids) {
    const who = people.get(uid);
    const e = byUser.get(uid);
    if (!who?.email) { results.push({ userId: uid, status: "skipped", reason: "no email" }); continue; }
    if (!e) { results.push({ userId: uid, status: "skipped", reason: "no active journey" }); continue; }
    const v = Array.isArray(e.journey_versions) ? e.journey_versions[0] : e.journey_versions;
    const p = Array.isArray(e.journey_programs) ? e.journey_programs[0] : e.journey_programs;
    if (!v || !p || p.is_active === false) { results.push({ userId: uid, status: "skipped", reason: "journey inactive" }); continue; }
    if (e.last_daily_reminder_on === today) { results.push({ userId: uid, status: "skipped", reason: "already reminded today" }); continue; }
    const unlockMode = v.unlock_mode === "progress" ? "progress" : "calendar";
    const cnt = counts.get(e.id) ?? { done: 0, done_today: false };
    const st = computeJourneyState({
      startDate: e.start_date, today, completedCount: cnt.done, daysTotal: v.days_total,
      countSundays: v.count_sundays === true, unlockMode, courseDays: courseDaysOf(v.days, v.days_total),
    });
    if (st.finished) { results.push({ userId: uid, status: "skipped", reason: "journey finished" }); continue; }
    // Same "due" gate as the cron: calendar → something released is pending;
    // progress → today's mission is open and nothing was completed today.
    const due = unlockMode === "calendar" ? st.pendingDays >= 1 : st.todayUnlocked && !cnt.done_today;
    if (!due) { results.push({ userId: uid, status: "skipped", reason: "nothing pending today" }); continue; }
    const entry = parseVersionDays(v.days).get(st.currentDay);
    let nextModule = entry?.mission_title ?? null;
    if (!nextModule && entry?.course_id) {
      if (!courseTitle.has(entry.course_id)) {
        const { data: c } = await a.svc.from("courses").select("title").eq("id", entry.course_id).maybeSingle();
        courseTitle.set(entry.course_id, (c as { title?: string } | null)?.title ?? "your next module");
      }
      nextModule = courseTitle.get(entry.course_id) ?? null;
    }
    nextModule = nextModule ?? "your next module";
    const reminderLine =
      unlockMode === "calendar" && st.behindDays >= 1
        ? `You're **${st.behindDays} day${st.behindDays === 1 ? "" : "s"} behind** — missed missions can be caught up one after another.`
        : "Pick up where you left off — it only takes a few minutes.";
    const deadline = typeof p.deadline_days === "number" && p.deadline_days > 0 ? dateOfDay(e.start_date, p.deadline_days, v.count_sundays === true) : null;
    // Claim today's reminder atomically so the hourly cron cannot send a second one.
    const { data: claim } = await a.svc
      .from("journey_enrollments")
      .update({ last_daily_reminder_on: today })
      .eq("id", e.id)
      .or(`last_daily_reminder_on.is.null,last_daily_reminder_on.lt.${today}`)
      .select("id");
    if ((claim?.length ?? 0) === 0) { results.push({ userId: uid, status: "skipped", reason: "already reminded today" }); continue; }
    const link = a.origin ? `${a.origin}/${a.org.slug}/journey` : `/${a.org.slug}/journey`;
    const res = await notifyBackground({
      organizationId: a.org.id,
      event: "journey_nudge",
      to: { user_id: uid, email: who.email },
      context: {
        learner_name: who.name,
        learner_email: who.email,
        org_name: a.org.name,
        journey_name: p.name,
        day: String(st.currentDay),
        days_total: String(st.daysTotal),
        behind_days: String(st.behindDays),
        next_module: nextModule,
        reminder_line: reminderLine,
        deadline_date: deadline ?? "",
        direct_link: link,
        portal_url: link,
      },
    });
    if (res?.status === "sent") results.push({ userId: uid, status: "sent" });
    else {
      // Release the claim so the cron can retry later today.
      await a.svc.from("journey_enrollments").update({ last_daily_reminder_on: e.last_daily_reminder_on }).eq("id", e.id);
      results.push({ userId: uid, status: "failed", reason: sendReason(res?.status) });
    }
  }
  return { results };
}
