import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { sendMany, type SendResult } from "@/lib/notifications/send";
import { MAIL_CALL_COSTS, SENDS_AT_ONCE, cronBudget, hasRoom, openRun, sendDueAlert, spendCalls, type MailRun } from "@/lib/notifications/smtp-state";
import { buildMailCronDetail, owedAfterRun, type CronErrorCounts, type CronErrorWord } from "@/lib/ops/health-status";
import { countingMemberIds } from "@/lib/auth/org-membership";
import {
  computeJourneyState,
  courseDaysOf,
  dateOfDay,
  parseVersionDays,
  reminderCountsFrom,
  reminderCreditedDays,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";

/**
 *   POST /api/cron/journey-nudges
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Daily journey reminders (migrations 0059/0065/0088/0089). For every active,
 * published, nudge-enabled program this sends ONE org-branded email per day to
 * each active learner with pending work, naming their next mission, until they
 * catch up:
 *   - Calendar journeys: a learner with one or more released-but-incomplete
 *     missions (pending_days ≥ 1). "Caught up" = nothing released is pending.
 *   - Progress journeys: a learner who hasn't completed a mission that day and
 *     isn't finished. "Caught up" = completed today's mission (or finished).
 *
 * TIME: admin-configurable per journey (journey_programs.reminder_hour, org
 * local, default 11:00). This endpoint runs HOURLY and, per program, acts only
 * once the org-local hour has reached reminder_hour.
 *
 * EXACTLY-ONCE/DAY: the send is gated by an ATOMIC CLAIM — a conditional
 * UPDATE of last_daily_reminder_on=today that only one invocation can win — so
 * overlapping/retried runs never double-send. A failed send is rolled back
 * (un-stamped) so a later run retries it the same day. Per-run work is bounded
 * (MAX_REMINDERS_PER_RUN) and the hourly cadence drains any backlog; the
 * batched journey_reminder_counts RPC keeps it to ~2 queries per page of
 * candidates rather than one per learner.
 *
 * Manager escalation (0065) stays CALENDAR-ONLY (a self-paced journey has no
 * "behind") and keeps its own nudge_cooldown_days clock via last_nudged_at.
 *
 * ADR 0030 rule 10: only members that count (active, in an organisation that
 * is not deleted) are mailed. A deleted organisation's programs are skipped;
 * each other organisation's members that count are read once per run, and
 * an organisation whose read fails is skipped for this run. A learner whose
 * membership does not count is skipped before the claim (no reminder, no
 * stamp, and no escalation about them); an escalation goes only to a
 * manager whose membership counts.
 *
 * Such a skip fails the run (ADR 0030, note "Pull request B build
 * decisions", change 2): the organisations whose members could not be read
 * are counted as `unreadable_orgs`, and `ok` is true only when that count is
 * zero, so the heartbeat reads error and the answer is 500. The other
 * organisations' programs are finished first. `skipped_org_programs` keeps
 * its meaning (programs skipped, a deleted organisation's included); a
 * deleted organisation is not a failure. The organisation's id is in the
 * mail_recipients_unreadable log line, not in a count. The next scheduled
 * run is the retry.
 *
 * ADR 0029 (rules T2, T5, FP2, FP3, FP7 and FP8; the note of 2026-11-20,
 * part 2):
 *   - The call first sends at most one tenant alert that is due (rule FP3),
 *     the oldest, and its cost is in the call's sum.
 *   - The sends are runs: one for each organisation, on this call's one
 *     clock and one count. For each page of due learners: one read of the
 *     learners' and managers' profiles, one read of the course titles, and
 *     the claim taken for each group in one conditional update just before
 *     its sends, so a nudge that is not started holds no claim. A claim is
 *     given back after a failure of any class but a timeout (the mail may
 *     still arrive), and after a send that was not attempted.
 *   - A failed run is the job's own failed read or write, or the platform's
 *     call limit: the programs, a time zone, the members that count, the
 *     line managers, a page of enrolments, the progress counts, the
 *     profiles, a course title, a claim or its giving back, the escalation
 *     marks, the alert step. A failed read is never a default: a program
 *     whose time zone could not be read is left for the next call, and a
 *     learner whose profile could not be read takes no claim and is left.
 *   - The answer and the heartbeat are built by buildMailCronDetail: counts
 *     and fixed words only. No organisation's slug or id, and no database
 *     message, is answered or stored; the numbers for one organisation go to
 *     a Worker log line with its id.
 *
 * Scheduled hourly from .github/workflows/cron.yml.
 */

const PAGE = 500;
const MAX_REMINDERS_PER_RUN = 500; // bounded per invocation; hourly runs drain any backlog

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Current org-local hour (0-23). */
function hourInTz(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
    10
  );
}

type Program = {
  id: string;
  organization_id: string;
  name: string;
  nudge_cooldown_days: number;
  reminder_hour?: number | null; // 0088 — undefined before the migration → 11
  deadline_days?: number | null; // 0065
  escalation_enabled?: boolean;
  escalation_after_days?: number;
  organizations:
    | { name: string; slug: string; deleted_at?: string | null }
    | Array<{ name: string; slug: string; deleted_at?: string | null }>;
};

type Enrolment = {
  id: string;
  user_id: string;
  start_date: string;
  last_nudged_at: string | null;
  last_daily_reminder_on: string | null;
  journey_versions:
    | { days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }
    | Array<{ days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }>;
};

type Profile = { id: string; first_name: string | null; last_name: string | null; email: string | null };

/** A learner's nudge of one page: the mail's context, and the claim's previous value to give back. */
type Nudge = { enrolment: string; userId: string; email: string; previous: string | null; context: Record<string, string> };

async function run() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const t0 = Date.now();
  // LEGITIMATE NEXT_PUBLIC_SITE_URL use: crons have no inbound request to
  // derive an origin from (same pattern as api/cron/reminders).
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const budget = cronBudget();
  const errors: CronErrorCounts = {};
  const fail = (word: CronErrorWord, n = 1) => {
    errors[word] = (errors[word] ?? 0) + n;
  };

  let reminded = 0;
  let escalated = 0;
  let scanned = 0;
  let skippedEarly = 0;
  let capped = false;
  let skippedOrg = 0;
  // Organisations (not programs) whose members could not be read: the run
  // fails when there is one.
  let unreadableOrgs = 0;
  let leftOrgs = 0;
  let leftComplete = true;
  let due = 0;
  let failedNudges = 0;
  let notStarted = 0;
  let leftDailyLimit = 0;
  const failedClasses: string[] = [];
  let no0114 = false;
  let stoppedBeforeSend = false;

  const finish = () =>
    buildMailCronDetail(
      {
        errors,
        unreadableOrgs,
        stoppedBeforeSend,
        no0114,
        ...(stoppedBeforeSend
          ? {}
          : {
              due,
              sent: reminded,
              failed: failedNudges,
              left: owedAfterRun("journey-nudges", { notStarted, failedClasses }),
              leftComplete,
              leftDailyLimit,
              leftOrgs,
            }),
      },
      {
        total_ms: Date.now() - t0,
        scanned,
        reminded,
        escalated,
        skipped_early: skippedEarly,
        skipped_org_programs: skippedOrg,
        capped,
      }
    );

  // 1. At most one alert that is due, the oldest (rule FP3), before the
  //    call's own mail: what it costs is not left for the nudges.
  const alert = await sendDueAlert({ baseUrl: base, budget, db: svc });
  if (alert.kind === "failed") fail("alert");

  // 2. The programs. A failed read is never "no programs".
  // `*` on the program keeps this deploy-safe across program-column
  // migrations — 0065/0088 fields arrive as undefined before they run.
  spendCalls(budget, 1);
  const { data: progRows, error: progErr } = await svc
    .from("journey_programs")
    .select("*, organizations!inner(name, slug, deleted_at)")
    .eq("is_active", true)
    .eq("nudge_enabled", true)
    .not("current_version_id", "is", null);
  if (progErr || !Array.isArray(progRows)) {
    fail("config_read");
    stoppedBeforeSend = true;
    return finish();
  }

  const courseTitle = new Map<string, string>(); // courseId → title (cross-program cache)
  // Rule 10: the members that count, read once per organisation in this run.
  const countingByOrg = new Map<string, ReadonlySet<string> | "unreadable">();
  // One run for each organisation, opened when its first mail is due.
  const runs = new Map<string, MailRun>();
  const runFor = async (orgId: string): Promise<MailRun> => {
    const open = runs.get(orgId);
    if (open) return open;
    const r = await openRun({ organizationId: orgId, budget, db: svc });
    if (r.no0114) no0114 = true;
    runs.set(orgId, r);
    return r;
  };
  const perOrg = new Map<string, { reminded: number; escalated: number }>();

  for (const p of progRows as Program[]) {
    if (reminded >= MAX_REMINDERS_PER_RUN) {
      capped = true;
      break;
    }
    const org = Array.isArray(p.organizations) ? p.organizations[0] : p.organizations;
    // Rule 10: a deleted organisation is skipped by the run, before any read.
    if (!org || org.deleted_at !== null) {
      skippedOrg++;
      continue;
    }
    // A program this call has no room left for is left for the next call.
    if (!hasRoom(budget, 4 + MAIL_CALL_COSTS.open + MAIL_CALL_COSTS.send + 3)) {
      leftOrgs++;
      leftComplete = false;
      continue;
    }
    spendCalls(budget, 1);
    const { data: gsRow, error: tzErr } = await svc
      .from("gamification_settings")
      .select("timezone")
      .eq("organization_id", p.organization_id)
      .maybeSingle();
    if (tzErr) {
      // A failed read is not the default time zone: the program is left.
      fail("config_read");
      leftComplete = false;
      continue;
    }
    const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
    const today = todayStr(tz);
    const reminderHour = Math.min(23, Math.max(0, p.reminder_hour ?? 11));
    // Hourly cron: act only once the org-local hour has reached the configured
    // reminder time. Earlier runs this day are a no-op for this program.
    if (hourInTz(tz) < reminderHour) {
      skippedEarly++;
      continue;
    }
    if (!countingByOrg.has(p.organization_id)) {
      spendCalls(budget, 2);
      const read = await countingMemberIds(svc, p.organization_id);
      if (read === "unreadable") unreadableOrgs++;
      countingByOrg.set(p.organization_id, read);
    }
    const counting = countingByOrg.get(p.organization_id)!;
    if (counting === "unreadable") {
      console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site: "cron/journey-nudges", org_id: p.organization_id, program_id: p.id }));
      skippedOrg++;
      continue;
    }
    const cooldownCutoff = new Date(Date.now() - (p.nudge_cooldown_days ?? 3) * 86400000);
    let escalationOn = p.escalation_enabled === true;
    const escalateAfter = p.escalation_after_days ?? 3;

    // L1 managers for this org (0011 line_manager_id), fetched once per program:
    // the learners' own rows, active only (rule 10). Whether the manager's own
    // membership counts is tested at the send. A failed read means no
    // escalation for this program in this call; the learners' own reminders go on.
    let managerOf = new Map<string, string>();
    if (escalationOn) {
      spendCalls(budget, 1);
      const { data: memRows, error: memErr } = await svc
        .from("organization_members")
        .select("user_id, line_manager_id")
        .eq("organization_id", p.organization_id)
        .eq("status", "active")
        .not("line_manager_id", "is", null);
      if (memErr || !Array.isArray(memRows)) {
        fail("members_read");
        escalationOn = false;
      } else {
        managerOf = new Map(
          (memRows as Array<{ user_id: string; line_manager_id: string }>).map(
            (m) => [m.user_id, m.line_manager_id]
          )
        );
      }
    }

    const tally = perOrg.get(p.organization_id) ?? { reminded: 0, escalated: 0 };
    perOrg.set(p.organization_id, tally);
    // Keyset pagination by id (stable while we stamp non-id columns); the daily
    // guard filter drops learners already reminded today.
    let lastId = "";
    for (;;) {
      if (reminded >= MAX_REMINDERS_PER_RUN) {
        capped = true;
        break;
      }
      if (!hasRoom(budget, 4 + MAIL_CALL_COSTS.send + 3)) {
        // No room for another page: the rest of this program is left.
        leftComplete = false;
        break;
      }
      let q = svc
        .from("journey_enrollments")
        .select(
          "id, user_id, start_date, last_nudged_at, last_daily_reminder_on, journey_versions!inner(days, days_total, count_sundays, unlock_mode)"
        )
        .eq("program_id", p.id)
        .eq("status", "active")
        .or(`last_daily_reminder_on.is.null,last_daily_reminder_on.lt.${today}`)
        .order("id", { ascending: true })
        .limit(PAGE);
      if (lastId) q = q.gt("id", lastId);
      spendCalls(budget, 1);
      const { data: enrRows, error: enrErr } = await q;
      if (enrErr || !Array.isArray(enrRows)) {
        // A failed read is not "no learners": the program's other pages are left.
        fail("assignments_read");
        leftComplete = false;
        break;
      }
      const batch = enrRows as Enrolment[];
      if (batch.length === 0) break;

      // One batched round-trip for the page: the credited days + whether a
      // day was completed today (org-local), instead of a query per learner.
      // `credited` (0107) is the day numbers credited by day id;
      // reminderCreditedDays falls back to the first `done` course days on a
      // database without it (ADR 0024 step 45). A failed read reminds
      // nobody on the page: it is never "nothing done", which would email
      // every learner that they are behind (reminderCountsFrom).
      spendCalls(budget, 1);
      const { data: cntRows, error: cntErr } = await svc.rpc("journey_reminder_counts", {
        p_ids: batch.map((e) => e.id),
      });
      const counts = reminderCountsFrom(cntRows, cntErr);
      if (cntErr) {
        fail("progress_read");
        leftComplete = false;
        console.warn(JSON.stringify({ event: "journey_reminder_counts_failed", program_id: p.id, code: cntErr.code ?? null }));
      }

      // Who on the page is due, and who needs an escalation.
      type Candidate = {
        e: Enrolment;
        due: boolean;
        escalate: boolean;
        state: ReturnType<typeof computeJourneyState>;
        unlockMode: "calendar" | "progress";
        deadlineDate: string | null;
        courseId: string | null;
        missionTitle: string | null;
      };
      const candidates: Candidate[] = [];
      for (const e of batch) {
        scanned++;
        // Rule 10: a learner whose membership does not count gets no reminder,
        // is not stamped, and raises no escalation.
        if (!counting.has(e.user_id)) continue;
        const v = Array.isArray(e.journey_versions)
          ? e.journey_versions[0]
          : e.journey_versions;
        if (!v) continue;
        const unlockMode = v.unlock_mode === "progress" ? "progress" : "calendar";
        const cnt = counts.ok ? counts.countOf(e.id) : null;
        if (!cnt) continue;
        const courseDays = courseDaysOf(v.days, v.days_total);
        const state = computeJourneyState({
          startDate: e.start_date,
          today,
          creditedDays: reminderCreditedDays(cnt, courseDays),
          daysTotal: v.days_total,
          countSundays: v.count_sundays === true,
          unlockMode,
          courseDays,
        });
        if (state.finished) continue;

        // Pending work worth a reminder today?
        const isDue =
          unlockMode === "progress"
            ? state.todayUnlocked && !cnt.done_today // has an open mission, none done today
            : state.pendingDays >= 1; // one or more released missions pending

        // Deadline (0065) → manager escalation (calendar-only).
        const deadlineDate =
          typeof p.deadline_days === "number" && p.deadline_days > 0
            ? dateOfDay(e.start_date, p.deadline_days, v.count_sundays === true)
            : null;
        const overdue = deadlineDate !== null && today > deadlineDate;
        const needsEscalation =
          escalationOn &&
          unlockMode === "calendar" &&
          (state.behindDays >= escalateAfter || overdue) &&
          (e.last_nudged_at === null || new Date(e.last_nudged_at) < cooldownCutoff);

        if (!isDue && !needsEscalation) continue;
        const entry = parseVersionDays(v.days).get(state.currentDay);
        candidates.push({
          e,
          due: isDue,
          escalate: needsEscalation,
          state,
          unlockMode,
          deadlineDate,
          courseId: entry?.course_id ?? null,
          missionTitle: entry?.mission_title ?? null,
        });
      }

      if (candidates.length > 0) {
        // The learners' and their managers' profiles, in one read. A failed
        // read is not "no address": nobody on the page takes a claim, and
        // they are left for the next call.
        const managersOnPage = candidates
          .filter((c) => c.escalate)
          .map((c) => managerOf.get(c.e.user_id))
          .filter((m): m is string => !!m && counting.has(m));
        const profileIds = [...new Set([...candidates.map((c) => c.e.user_id), ...managersOnPage])];
        spendCalls(budget, 1);
        const { data: profRows, error: profErr } = await svc
          .from("profiles")
          .select("id, first_name, last_name, email")
          .in("id", profileIds);
        if (profErr || !Array.isArray(profRows)) {
          fail("profiles_read");
          leftComplete = false;
          const owed = candidates.filter((c) => c.due).length;
          due += owed;
          notStarted += owed;
        } else {
          const profileOf = new Map((profRows as Profile[]).map((r) => [r.id, r]));

          // The next missions' course titles, in one read. A failed read
          // sends the mail with the general words, as before.
          const titleIds = [...new Set(candidates.filter((c) => !c.missionTitle && c.courseId && !courseTitle.has(c.courseId)).map((c) => c.courseId!))];
          if (titleIds.length > 0) {
            spendCalls(budget, 1);
            const { data: titleRows, error: titleErr } = await svc.from("courses").select("id, title").in("id", titleIds);
            if (titleErr || !Array.isArray(titleRows)) fail("unknown");
            else for (const c of titleRows as Array<{ id: string; title?: string | null }>) if (c.title) courseTitle.set(c.id, c.title);
          }

          const nudges: Nudge[] = [];
          const escalations: Array<{ enrolment: string; managerId: string; email: string; context: Record<string, string> }> = [];
          for (const c of candidates) {
            const profile = profileOf.get(c.e.user_id);
            if (!profile?.email) continue;
            const learnerName =
              [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() ||
              profile.email.split("@")[0];
            const nextModule = c.missionTitle ?? (c.courseId ? courseTitle.get(c.courseId) : undefined) ?? "your next module";
            // Mode-appropriate reason line (keeps "days behind" only where it means
            // something; progress journeys never say "behind").
            const reminderLine =
              c.unlockMode === "calendar" && c.state.behindDays >= 1
                ? `You're **${c.state.behindDays} day${c.state.behindDays === 1 ? "" : "s"} behind** — missed missions can be caught up one after another.`
                : "Pick up where you left off — it only takes a few minutes.";
            const journeyCtx = {
              learner_name: learnerName,
              learner_email: profile.email,
              org_name: org?.name ?? "",
              journey_name: p.name,
              day: String(c.state.currentDay),
              days_total: String(c.state.daysTotal),
              behind_days: String(c.state.behindDays),
              next_module: nextModule,
              reminder_line: reminderLine,
              deadline_date: c.deadlineDate ?? "",
              direct_link: base ? `${base}/${org?.slug}/journey` : `/${org?.slug}/journey`,
              portal_url: base ? `${base}/${org?.slug}/journey` : `/${org?.slug}/journey`,
            };
            if (c.due) nudges.push({ enrolment: c.e.id, userId: c.e.user_id, email: profile.email, previous: c.e.last_daily_reminder_on, context: journeyCtx });
            if (c.escalate) {
              const managerId = managerOf.get(c.e.user_id);
              // Rule 10: only a manager whose membership counts is mailed.
              const manager = managerId && counting.has(managerId) ? profileOf.get(managerId) : undefined;
              if (managerId && manager?.email) {
                escalations.push({
                  enrolment: c.e.id,
                  managerId,
                  email: manager.email,
                  context: {
                    ...journeyCtx,
                    manager_name:
                      [manager.first_name, manager.last_name].filter(Boolean).join(" ").trim() ||
                      manager.email.split("@")[0],
                    direct_link: base
                      ? `${base}/${org?.slug}/team-performance`
                      : `/${org?.slug}/team-performance`,
                  },
                });
              }
            }
          }
          due += nudges.length;

          // The nudges: one group at a time, each claimed just before its sends.
          const room = Math.max(0, MAX_REMINDERS_PER_RUN - reminded);
          const nudgesNow = nudges.slice(0, room);
          if (nudges.length > nudgesNow.length) {
            capped = true;
            notStarted += nudges.length - nudgesNow.length;
          }
          if (nudgesNow.length > 0) {
            const r = await runFor(p.organization_id);
            const claimed = new Set<string>();
            // A group whose claim could not be written sends nothing; its
            // learners stay owed, and the count is no longer complete.
            const unclaimed = new Set<string>();
            const results: SendResult[] = await sendMany(
              r,
              nudgesNow,
              (n) => ({
                event: "journey_nudge",
                to: { user_id: n.userId, email: n.email },
                context: {
                  learner_name: n.context.learner_name,
                  learner_email: n.context.learner_email,
                  org_name: n.context.org_name,
                  journey_name: n.context.journey_name,
                  day: n.context.day,
                  days_total: n.context.days_total,
                  behind_days: n.context.behind_days,
                  next_module: n.context.next_module,
                  reminder_line: n.context.reminder_line,
                  deadline_date: n.context.deadline_date,
                  direct_link: n.context.direct_link,
                  portal_url: n.context.portal_url,
                },
              }),
              {
                hooks: {
                  // ATOMIC CLAIM for the daily reminder, for the group: only
                  // the invocation whose conditional UPDATE matches (not yet
                  // reminded today) wins a learner's send.
                  beforeCalls: 1,
                  before: async (group) => {
                    const ids = group.map((n) => n.enrolment);
                    const upd = svc.from("journey_enrollments").update({ last_daily_reminder_on: today });
                    const { data: won, error: claimErr } = await (ids.length === 1 ? upd.eq("id", ids[0]) : upd.in("id", ids))
                      .or(`last_daily_reminder_on.is.null,last_daily_reminder_on.lt.${today}`)
                      .select("id");
                    if (claimErr || !Array.isArray(won)) {
                      fail("state_write");
                      leftComplete = false;
                      for (const n of group) unclaimed.add(n.enrolment);
                      return { keep: group.map(() => false), calls: 1 };
                    }
                    const set = new Set((won as Array<{ id: string }>).map((w) => w.id));
                    for (const id of set) claimed.add(id);
                    return { keep: group.map((n) => set.has(n.enrolment)), calls: 1 };
                  },
                  // A claim is given back after a failure of any class but a
                  // timeout, and after a send that was not attempted, so a
                  // later run retries it the same day (rule T2). One write
                  // for each earlier date in the group, at most one a mail.
                  afterCalls: SENDS_AT_ONCE,
                  after: async (entries) => {
                    const giveBack = entries.filter(
                      (x) => claimed.has(x.item.enrolment) && x.result.status !== "sent" && !(x.result.status === "failed" && x.result.cls === "timeout")
                    );
                    const byPrevious = new Map<string | null, string[]>();
                    for (const { item } of giveBack) byPrevious.set(item.previous, [...(byPrevious.get(item.previous) ?? []), item.enrolment]);
                    let calls = 0;
                    for (const [previous, ids] of byPrevious) {
                      calls++;
                      const rel = svc.from("journey_enrollments").update({ last_daily_reminder_on: previous });
                      const { error: relErr } = await (ids.length === 1 ? rel.eq("id", ids[0]) : rel.in("id", ids));
                      if (relErr) fail("state_write");
                    }
                    return { calls };
                  },
                },
              }
            );
            results.forEach((res, k) => {
              if (res.errorClass === "withdrawn" && unclaimed.has(nudgesNow[k].enrolment)) notStarted++;
            });
            for (const res of results) {
              if (res.status === "sent") {
                reminded++;
                tally.reminded++;
              } else if (res.attempted) {
                failedNudges++;
                failedClasses.push(String(res.errorClass ?? "unknown"));
              } else if (res.errorClass !== "withdrawn") {
                notStarted++;
                if (res.errorClass === "daily_limit") leftDailyLimit++;
              }
            }
          }

          // The escalations, after the page's nudges; then their marks in one
          // write. Today's order stays: the mail, then the mark.
          if (escalations.length > 0) {
            const r = await runFor(p.organization_id);
            const results = await sendMany(r, escalations, (x) => ({
              event: "journey_escalation",
              to: { user_id: x.managerId, email: x.email },
              context: {
                learner_name: x.context.learner_name,
                learner_email: x.context.learner_email,
                org_name: x.context.org_name,
                journey_name: x.context.journey_name,
                day: x.context.day,
                days_total: x.context.days_total,
                behind_days: x.context.behind_days,
                next_module: x.context.next_module,
                reminder_line: x.context.reminder_line,
                deadline_date: x.context.deadline_date,
                manager_name: x.context.manager_name,
                direct_link: x.context.direct_link,
                portal_url: x.context.portal_url,
              },
            }));
            const marked = escalations.filter((_, k) => results[k].attempted).map((x) => x.enrolment);
            if (marked.length > 0 && hasRoom(budget, 1)) {
              spendCalls(budget, 1);
              const mark = svc.from("journey_enrollments").update({ last_nudged_at: new Date().toISOString() });
              const { error: markErr } = await (marked.length === 1 ? mark.eq("id", marked[0]) : mark.in("id", marked));
              if (markErr) fail("state_write");
            }
            escalated += marked.length;
            tally.escalated += marked.length;
          }
        }
      }

      if (capped) break;
      if (batch.length < PAGE) break;
      lastId = batch[batch.length - 1].id;
    }
  }

  for (const r of runs.values()) {
    for (const word of Object.keys(r.errors) as CronErrorWord[]) fail(word, r.errors[word] ?? 0);
  }
  // One organisation's numbers go to the Worker's log with its id, never to
  // the answer or the heartbeat.
  for (const [orgId, t] of perOrg) {
    if (t.reminded > 0 || t.escalated > 0) {
      console.log(JSON.stringify({ event: "journey_nudges_org", org_id: orgId, reminded: t.reminded, escalated: t.escalated }));
    }
  }
  return finish();
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const detail = await run();
  await recordHeartbeat("journey-nudges", detail.heartbeat, detail.ok, { carryLastOk: true });
  return NextResponse.json(detail.answer, { status: detail.ok ? 200 : 500 });
}

export const GET = POST;
