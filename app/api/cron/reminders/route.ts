import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { sendMany } from "@/lib/notifications/send";
import { MAIL_CALL_COSTS, cronBudget, hasRoom, openRun, spendCalls } from "@/lib/notifications/smtp-state";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { buildMailCronDetail, owedAfterRun, type CronErrorCounts, type CronErrorWord } from "@/lib/ops/health-status";
import { isReleased } from "@/lib/learner/release";
import { countingMemberIds } from "@/lib/auth/org-membership";
import { isMissingRelation } from "@/lib/scoring/attempt-kind";
import { resolveManyGroupsStrict } from "@/lib/org/groups";
import { chunk, readAllStrict, readByIdsStrict } from "@/lib/db/chunked";

/**
 *   POST /api/cron/reminders
 *   header: x-cron-secret: <CRON_SECRET env var>
 *
 * Daily scheduled task (.github/workflows/cron.yml). For each course with
 * reminders enabled:
 *   - Resolve every learner currently assigned (user/team/org/group). A
 *     self-enrolment row (source 'self') is no assignment (decision A22).
 *   - ADR 0030 rule 10: only members that count are reminded (active, in
 *     an organisation that is not deleted). A deleted organisation's
 *     courses are skipped; each other organisation's members that count
 *     are read once per run, and an organisation whose read fails is
 *     skipped for this run (nothing sent, no state written), counted as
 *     `unreadable_orgs`, and fails the run. The other organisations' mail
 *     and reminder state are finished first. A deleted organisation is not
 *     a failure. The organisation's id is in the mail_recipients_unreadable
 *     log line, never in the answer.
 *   - Skip learners who have already completed/passed the course.
 *   - Skip learners whose first_assigned_at is older than cap_days.
 *   - Skip learners whose last_nudge_at is newer than cadence_days ago.
 *   - For survivors, send asset_reminder + update reminder_state.
 *
 * ADR 0029 (rules T5, FP2, FP4, FP7 and FP8; the hand-over note of
 * 2026-11-19, point 4; the note of 2026-11-20, part 2):
 *   - The sends are runs: one for each organisation, all on this call's one
 *     clock and one count. Longest waiting first: never reminded, then the
 *     oldest last reminder, across organisations. What the call has no room
 *     for is left for the next call and counted (`left`, `left_orgs`), as is
 *     what a daily limit stopped (`left_daily_limit`).
 *   - The reminders' state is written with each group of sends. A tried
 *     reminder is a reminder whatever its result; one not attempted gets no
 *     state, so a later call takes it.
 *   - A failed run is the job's own failed read or write, or the platform's
 *     call limit: the settings, the members that count, the assignments,
 *     the team and group members, the completed attempts, the reminder
 *     state, the addresses, the state writes. A failed read of the
 *     settings, the assignments, a team or group, the attempts, the state
 *     or the addresses stops the run before any send (a failed read is
 *     never "no courses", "nobody" or "never reminded"). A tenant's failed
 *     send, a daily limit, a paused organisation and a database without
 *     migration 0114 are clean runs.
 *   - Every read before the sends follows the house rule (lib/db/chunked.ts):
 *     `.in()` lists of 150 ids and pages of 1000 rows, so no set is cut at
 *     the server's row cap. A set is used whole or not at all. Every read
 *     before the sends asks for room first, keeping back the write that stops
 *     reminders past their cap, one opening and one group of sends (the note
 *     of 2026-11-21, part 2 (a)). This job reads its sets from the start at
 *     every call, so a read it has no room to finish, or reminders due with
 *     no room to open any run, is the job's own failed step: call_limit,
 *     stopped before any send, with one fixed line (cron_no_room). An
 *     organisation left once other mail went is left for the next call, a
 *     clean run (rule T5).
 *   - The finished attempts are asked for by the attempt row's own columns
 *     (completed or passed), the same test the route makes on each row.
 *   - The answer and the heartbeat are built by buildMailCronDetail: counts
 *     and fixed words only, never an id, a name, an address or a database
 *     message. A failed run carries its last successful run (last_ok_at).
 */

type ReminderRow = {
  course_id: string;
  enabled: boolean;
  cadence_days: 1 | 2 | 3;
  cap_days: number;
  courses?: {
    id: string;
    title: string;
    organization_id: string;
    organizations?: { name?: string; slug?: string; deleted_at?: string | null } | null;
  } | null;
};

type Assignment = {
  course_id: string;
  organization_id: string;
  assignee_type: "user" | "team" | "org" | "group";
  user_id: string | null;
  team_id: string | null;
  group_id?: string | null;
  release_at: string | null;
  /** 0107 (ADR 0024 D15): 'admin' or 'self'; absent on a database without it. */
  source?: string | null;
};

/**
 * The first group of a run's sends (rule T4: the first send goes alone): its
 * template, the send, the group's log insert, a state write, an alert mark,
 * and the reminders' state written with the group.
 */
const FIRST_GROUP_CALLS =
  MAIL_CALL_COSTS.template + MAIL_CALL_COSTS.send + MAIL_CALL_COSTS.logInsert + MAIL_CALL_COSTS.stateWrite + MAIL_CALL_COSTS.alertMark + 1;
/** What a run needs to open and send its first group. */
const RUN_ROOM = MAIL_CALL_COSTS.open + FIRST_GROUP_CALLS;
/**
 * What every read before the sends keeps back (ADR 0029, note of 2026-11-21,
 * part 2 (a)): the write that stops reminders past their cap, one opening,
 * and one group of sends.
 */
const SEND_RESERVE = 1 + RUN_ROOM;

export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  const got = request.headers.get("x-cron-secret");
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }
  if (got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const budget = cronBudget();
  const errors: CronErrorCounts = {};
  const fail = (word: CronErrorWord) => {
    errors[word] = (errors[word] ?? 0) + 1;
  };
  /** One call for a page of a read before the sends, while the call still keeps its reserve for the sends. */
  const pageRoom = () => {
    if (!hasRoom(budget, 1 + SEND_RESERVE)) return false;
    spendCalls(budget, 1);
    return true;
  };
  /**
   * The call's own stop in a step that no later call can finish (ADR 0029,
   * note of 2026-11-21, part 2 (a)): this job reads its sets whole, from the
   * start, at every call, so a read it has no room to finish today it cannot
   * finish tomorrow. The job's own failed step, call_limit, with one fixed
   * line: the job, the step's word, the calls spent, and whether the count
   * or the clock ended it. Numbers and fixed words only.
   */
  const noRoom = (step: CronErrorWord) => {
    const endedBy = budget.now() - budget.startedAt >= budget.windowMs ? "clock" : "count";
    console.warn(JSON.stringify({ event: "cron_no_room", job: "reminders", step, calls: budget.calls, ended_by: endedBy }));
    fail("call_limit");
  };
  /** A read that was not finished: its own word, or the call's own stop when it had no room to read it whole. */
  const readFailed = (answer: "unreadable" | "no_room", word: CronErrorWord) => (answer === "no_room" ? noRoom(word) : fail(word));
  let unreadableOrgs = 0;
  let scanned = 0;
  let skipped = 0;
  let upserts = 0;

  /** The run's end: one heartbeat and one answer, from one builder. */
  const finish = async (counts: { stoppedBeforeSend: boolean; due?: number; sent?: number; failed?: number; left?: number; leftComplete?: boolean; leftDailyLimit?: number; leftOrgs?: number; no0114?: boolean }) => {
    const detail = buildMailCronDetail(
      { errors, unreadableOrgs, no0114: counts.no0114 === true, ...counts },
      { scanned, skipped, upserts }
    );
    await recordHeartbeat("reminders", detail.heartbeat, detail.ok, { carryLastOk: true });
    return NextResponse.json(detail.answer, { status: detail.ok ? 200 : 500 });
  };

  // 1) Courses with reminders enabled. A failed read is never "no courses".
  const settings = await readAllStrict<ReminderRow>(
    (from, to) =>
      svc
        .from("course_reminder_settings")
        .select(
          "course_id, enabled, cadence_days, cap_days, courses(id, title, organization_id, organizations(name, slug, deleted_at))"
        )
        .eq("enabled", true)
        .order("course_id")
        .range(from, to),
    pageRoom
  );
  if (settings === "unreadable" || settings === "no_room") {
    readFailed(settings, "config_read");
    return finish({ stoppedBeforeSend: true });
  }
  const allCourses = (settings as unknown[]).map((r) => {
    const row = r as ReminderRow;
    const c = row.courses;
    const orgSubraw = c?.organizations;
    const orgSub = Array.isArray(orgSubraw) ? orgSubraw[0] : orgSubraw;
    return {
      course_id: row.course_id,
      cadence_days: row.cadence_days,
      cap_days: row.cap_days,
      title: c?.title ?? "the course",
      organization_id: c?.organization_id ?? "",
      org_name: orgSub?.name ?? "your org",
      org_slug: orgSub?.slug ?? "",
      // Rule 10: a deleted organisation is skipped by the run. A course whose
      // organisation was not read is not taken for live either.
      org_live: !!orgSub && orgSub.deleted_at === null,
    };
  });

  // ADR 0030 rule 10: the members that count, read once per organisation for
  // this run. A deleted organisation's courses are dropped before any read;
  // an organisation whose read fails is dropped for this run and logged with
  // its id. An organisation this call has no room left to read is left for
  // the next call.
  const countingByOrg = new Map<string, ReadonlySet<string>>();
  let leftOrgs = 0;
  for (const oid of new Set(allCourses.filter((c) => c.org_live).map((c) => c.organization_id))) {
    if (!hasRoom(budget, 2 + SEND_RESERVE)) {
      leftOrgs++;
      continue;
    }
    spendCalls(budget, 2);
    const counting = await countingMemberIds(svc, oid);
    if (counting === "unreadable") {
      console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site: "cron/reminders", org_id: oid }));
      unreadableOrgs++;
      continue;
    }
    countingByOrg.set(oid, counting);
  }
  const enabledCourses = allCourses.filter((c) => countingByOrg.has(c.organization_id));
  if (enabledCourses.length === 0) {
    // A successful run with nothing to do must still heartbeat, or the health
    // probe reads reminders as never-seen/stale → false "degraded" (which is
    // exactly what happened on pre-launch prod: no reminder-enabled courses).
    // A run left with nothing because no organisation could be read is not
    // successful: it records an errored heartbeat and answers 500.
    return finish(
      leftOrgs > 0
        ? { stoppedBeforeSend: false, leftOrgs, leftComplete: false }
        : { stoppedBeforeSend: false, due: 0, sent: 0, failed: 0, left: 0, leftComplete: unreadableOrgs === 0, leftDailyLimit: 0, leftOrgs: 0 }
    );
  }
  scanned = enabledCourses.length;
  const courseIds = enabledCourses.map((c) => c.course_id);

  // 2) All assignments + memberships + completed user/course pairs.
  // select("*") for 0069 deploy safety (group_id may not be migrated yet).
  const assignmentRows = await readByIdsStrict<Assignment>(
    courseIds,
    (ids, from, to) => svc.from("course_assignments").select("*").in("course_id", ids).order("id").range(from, to),
    pageRoom
  );
  if (assignmentRows === "unreadable" || assignmentRows === "no_room") {
    readFailed(assignmentRows, "assignments_read");
    return finish({ stoppedBeforeSend: true, leftOrgs });
  }
  // Decision A22 (ADR 0024 step 49's reminders row, P2-6 item 2): a learner's
  // own self-enrolment (source 'self', written when they pressed Start on an
  // "Everyone" course) is no assignment and reminds nobody. The row, not the
  // learner: a team, group or org row still reminds them. select("*") is the
  // missing-column fallback: without 0107 no row has a source and none is
  // skipped, today's run.
  const assignments = (assignmentRows as Assignment[]).filter((a) => a.source !== "self");

  // Teams used by assignments, read strictly: a failed read is not "no members".
  const teamIds = Array.from(
    new Set(
      assignments
        .filter((a) => a.assignee_type === "team" && a.team_id)
        .map((a) => a.team_id as string)
    )
  );
  const teamUserIds = new Map<string, Set<string>>();
  if (teamIds.length > 0) {
    const teamMembers = await readByIdsStrict<{ team_id: string; user_id: string }>(
      teamIds,
      (ids, from, to) => svc.from("team_members").select("team_id, user_id").in("team_id", ids).order("team_id").order("user_id").range(from, to),
      pageRoom
    );
    if (teamMembers === "unreadable" || teamMembers === "no_room") {
      readFailed(teamMembers, "members_read");
      return finish({ stoppedBeforeSend: true, leftOrgs });
    }
    for (const m of teamMembers) {
      const set = teamUserIds.get(m.team_id) ?? new Set<string>();
      set.add(m.user_id);
      teamUserIds.set(m.team_id, set);
    }
  }

  // Custom Groups used by assignments (0069), membership resolved LIVE. A
  // database without the groups table (before 0067) has no group rows; any
  // other failed read stops the run before a send.
  const groupIds = Array.from(
    new Set(
      assignments
        .filter((a) => a.assignee_type === "group" && a.group_id)
        .map((a) => a.group_id as string)
    )
  );
  const groupUserIds = new Map<string, Set<string>>();
  if (groupIds.length > 0) {
    // One row for each id, in lists of 150 ids.
    const groupRows: Array<{ id: string; organization_id: string }> = [];
    for (const ids of chunk(groupIds, 150)) {
      if (!pageRoom()) {
        noRoom("members_read");
        return finish({ stoppedBeforeSend: true, leftOrgs });
      }
      const { data, error: groupErr } = await svc.from("org_groups").select("id, organization_id").in("id", ids);
      if (groupErr && isMissingRelation(groupErr, "org_groups")) break;
      if (groupErr || !Array.isArray(data)) {
        fail("members_read");
        return finish({ stoppedBeforeSend: true, leftOrgs });
      }
      groupRows.push(...(data as Array<{ id: string; organization_id: string }>));
    }
    for (const g of groupRows) {
      // Each group's members are two calls: asked for first, as every read
      // before the sends is.
      if (!hasRoom(budget, 2 + SEND_RESERVE)) {
        noRoom("members_read");
        return finish({ stoppedBeforeSend: true, leftOrgs });
      }
      spendCalls(budget, 2);
      const ids = await resolveManyGroupsStrict(svc, g.organization_id, [g.id]);
      if (ids === "unreadable") {
        fail("members_read");
        return finish({ stoppedBeforeSend: true, leftOrgs });
      }
      groupUserIds.set(g.id, ids);
    }
  }

  // Org members per org: an org-wide row reaches the members that count,
  // read once above (rule 10).
  const orgUserIds = countingByOrg;

  // Completed pairs. `!inner` makes the embedded-column filter actually
  // restrict parent rows to the courses we care about (without it the filter
  // is a no-op and scans all attempts). A failed read stops the run: an empty
  // completed-set would re-nudge learners who have already finished. Read
  // in pages: a set cut at the row cap would remind finished learners too.
  // Only finished rows are asked for, by the attempt row's own columns (ADR
  // 0029, note of 2026-11-21, part 2 (b)): the same test the loop below makes
  // on each row, which it still makes; fewer pages are read.
  const completedAttempts = await readByIdsStrict<unknown>(
    courseIds,
    (ids, from, to) =>
      svc
        .from("course_attempts")
        .select(
          "user_id, course_versions!inner(course_id), completion_status, success_status"
        )
        .in("course_versions.course_id", ids)
        .or("completion_status.eq.completed,success_status.eq.passed")
        .order("id")
        .range(from, to),
    pageRoom
  );
  if (completedAttempts === "unreadable" || completedAttempts === "no_room") {
    readFailed(completedAttempts, "progress_read");
    return finish({ stoppedBeforeSend: true, leftOrgs });
  }
  const completedPairs = new Set<string>(); // `user|course`
  for (const a of completedAttempts) {
    const row = a as {
      user_id?: string;
      course_versions?:
        | { course_id?: string }
        | { course_id?: string }[];
      completion_status?: string;
      success_status?: string;
    };
    const cv = Array.isArray(row.course_versions)
      ? row.course_versions[0]
      : row.course_versions;
    if (
      row.user_id &&
      cv?.course_id &&
      (row.completion_status === "completed" ||
        row.success_status === "passed")
    ) {
      completedPairs.add(`${row.user_id}|${cv.course_id}`);
    }
  }

  // Existing reminder state. A failed read would make every learner look
  // never reminded, mail them again and write over their state: it stops the
  // run before any send. Read in pages for the same reason: a learner past
  // the row cap would look never reminded too.
  const stateRows = await readByIdsStrict<Record<string, unknown>>(
    courseIds,
    (ids, from, to) =>
      svc
        .from("reminder_state")
        .select(
          "user_id, course_id, first_assigned_at, last_nudge_at, nudge_count, stopped"
        )
        .in("course_id", ids)
        .order("user_id")
        .order("course_id")
        .range(from, to),
    pageRoom
  );
  if (stateRows === "unreadable" || stateRows === "no_room") {
    readFailed(stateRows, "state_read");
    return finish({ stoppedBeforeSend: true, leftOrgs });
  }
  const stateByKey = new Map<
    string,
    {
      first_assigned_at: string;
      last_nudge_at: string | null;
      nudge_count: number;
      stopped: boolean;
    }
  >();
  for (const st of stateRows) {
    stateByKey.set(`${st.user_id}|${st.course_id}`, {
      first_assigned_at: st.first_assigned_at as string,
      last_nudge_at: (st.last_nudge_at as string | null) ?? null,
      nudge_count: (st.nudge_count as number) ?? 0,
      stopped: (st.stopped as boolean) ?? false,
    });
  }

  // The addresses, for members that count only, in one strict read: a
  // failed read is never "no address".
  const allUserIds = new Set<string>();
  for (const a of assignments) {
    const counting = countingByOrg.get(a.organization_id);
    const add = (uid: string) => {
      if (counting?.has(uid)) allUserIds.add(uid);
    };
    if (a.assignee_type === "user" && a.user_id) add(a.user_id);
    if (a.assignee_type === "team" && a.team_id) {
      for (const uid of teamUserIds.get(a.team_id) ?? []) add(uid);
    }
    if (a.assignee_type === "group" && a.group_id) {
      for (const uid of groupUserIds.get(a.group_id) ?? []) add(uid);
    }
    if (a.assignee_type === "org") {
      for (const uid of orgUserIds.get(a.organization_id) ?? []) add(uid);
    }
  }
  // One call for each list of 150 addresses, asked for first.
  const addressCalls = Math.ceil(allUserIds.size / 150);
  if (!hasRoom(budget, addressCalls + SEND_RESERVE)) {
    noRoom("profiles_read");
    return finish({ stoppedBeforeSend: true, leftOrgs });
  }
  spendCalls(budget, addressCalls);
  const emailById = await resolveEmailsStrict(svc, allUserIds);
  if (emailById === "unreadable") {
    fail("profiles_read");
    return finish({ stoppedBeforeSend: true, leftOrgs });
  }

  const now = Date.now();
  // LEGITIMATE NEXT_PUBLIC_SITE_URL use: cron triggers have no inbound
  // request, so there are no headers to read. The build-time value is
  // the only option here. See lib/http/origin.ts for the full rationale
  // and ticket #146 for the rest of the codebase sweep.
  const portalBase =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";

  type StateUpsert = {
    user_id: string;
    course_id: string;
    organization_id: string;
    first_assigned_at: string;
    last_nudge_at: string;
    nudge_count: number;
    stopped: boolean;
  };
  const stopUpserts: StateUpsert[] = [];

  // Phase 1: apply all skip rules and build the list of due reminders.
  type Job = {
    uid: string;
    email: string;
    course: (typeof enabledCourses)[number];
    firstAssignedIso: string;
    nudgeCount: number;
    lastNudgeMs: number;
    directLink: string;
  };
  const jobs: Job[] = [];

  for (const course of enabledCourses) {
    const cadenceMs = course.cadence_days * 24 * 60 * 60 * 1000;
    const capMs = course.cap_days * 24 * 60 * 60 * 1000;

    // Resolve assigned learners for this course.
    const learnerIds = new Set<string>();
    for (const a of assignments) {
      if (a.course_id !== course.course_id) continue;
      // Scheduled release: don't nudge learners about content they can't open
      // yet. A row that HAS released still qualifies its learners.
      if (!isReleased(a.release_at, now)) continue;
      if (a.assignee_type === "user" && a.user_id) learnerIds.add(a.user_id);
      if (a.assignee_type === "team" && a.team_id) {
        for (const uid of teamUserIds.get(a.team_id) ?? []) learnerIds.add(uid);
      }
      if (a.assignee_type === "group" && a.group_id) {
        for (const uid of groupUserIds.get(a.group_id) ?? []) learnerIds.add(uid);
      }
      if (a.assignee_type === "org") {
        for (const uid of orgUserIds.get(a.organization_id) ?? []) learnerIds.add(uid);
      }
    }
    // Rule 10: a person named directly, in a team or in a static group may
    // hold a row that does not count. They are skipped before every other
    // rule, so no reminder state is written for them either.
    const counting = countingByOrg.get(course.organization_id);
    for (const uid of learnerIds) {
      if (!counting?.has(uid)) {
        learnerIds.delete(uid);
        skipped++;
      }
    }

    for (const uid of learnerIds) {
      const key = `${uid}|${course.course_id}`;
      if (completedPairs.has(key)) {
        skipped++;
        continue;
      }
      const st = stateByKey.get(key);
      const firstAssigned = st?.first_assigned_at
        ? new Date(st.first_assigned_at).getTime()
        : now;
      // Past cap → stop
      if (now - firstAssigned >= capMs) {
        if (st && !st.stopped) {
          stopUpserts.push({
            user_id: uid,
            course_id: course.course_id,
            organization_id: course.organization_id,
            first_assigned_at: new Date(firstAssigned).toISOString(),
            last_nudge_at: st.last_nudge_at ?? new Date(firstAssigned).toISOString(),
            nudge_count: st.nudge_count,
            stopped: true,
          });
        }
        skipped++;
        continue;
      }
      // Last nudge too recent → skip
      const lastNudgeTime = st?.last_nudge_at
        ? new Date(st.last_nudge_at).getTime()
        : 0;
      if (lastNudgeTime > 0 && now - lastNudgeTime < cadenceMs) {
        skipped++;
        continue;
      }
      const email = emailById.get(uid);
      if (!email) {
        skipped++;
        continue;
      }

      jobs.push({
        uid,
        email,
        course,
        firstAssignedIso: st
          ? st.first_assigned_at
          : new Date(firstAssigned).toISOString(),
        nudgeCount: st?.nudge_count ?? 0,
        lastNudgeMs: lastNudgeTime,
        directLink: portalBase
          ? `${portalBase}/${course.org_slug}/courses/${course.course_id}/launch`
          : `/${course.org_slug}/courses/${course.course_id}/launch`,
      });
    }
  }

  // Reminders past their cap are stopped in one write, before any send.
  if (stopUpserts.length > 0) {
    spendCalls(budget, 1);
    const { error } = await svc.from("reminder_state").upsert(stopUpserts, { onConflict: "user_id,course_id" });
    if (error) fail("state_write");
    else upserts += stopUpserts.length;
  }

  // Phase 2: the sends. Longest waiting first, across organisations: never
  // reminded (0), then the oldest last reminder. One run for each
  // organisation, taken in the order of its longest-waiting learner, all on
  // this call's one budget.
  jobs.sort((a, b) => a.lastNudgeMs - b.lastNudgeMs);
  const byOrg = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = byOrg.get(job.course.organization_id) ?? [];
    list.push(job);
    byOrg.set(job.course.organization_id, list);
  }
  let sent = 0;
  let failedSends = 0;
  let notStarted = 0;
  let leftDailyLimit = 0;
  let no0114 = false;
  let runsOpened = 0;
  const nowIso = new Date(now).toISOString();
  for (const [orgId, orgJobs] of byOrg) {
    if (!hasRoom(budget, RUN_ROOM)) {
      // No room to open this organisation's run: its reminders are left.
      notStarted += orgJobs.length;
      leftOrgs++;
      continue;
    }
    runsOpened++;
    const run = await openRun({ organizationId: orgId, budget, db: svc });
    if (run.no0114) no0114 = true;
    const results = await sendMany(
      run,
      orgJobs,
      (job) => ({
        event: "asset_reminder",
        to: { user_id: job.uid, email: job.email },
        context: {
          learner_name: job.email,
          learner_email: job.email,
          course_name: job.course.title,
          course_id: job.course.course_id,
          org_name: job.course.org_name,
          direct_link: job.directLink,
        },
      }),
      {
        hooks: {
          // The reminders' state is written with each group (rule FP7): a
          // tried reminder counts whatever its result; one not attempted is
          // left for a later call.
          afterCalls: 1,
          after: async (entries) => {
            const rows: StateUpsert[] = entries
              .filter((e) => e.result.status === "sent" || e.result.status === "failed")
              .map(({ item: job }) => ({
                user_id: job.uid,
                course_id: job.course.course_id,
                organization_id: job.course.organization_id,
                first_assigned_at: job.firstAssignedIso,
                last_nudge_at: nowIso,
                nudge_count: job.nudgeCount + 1,
                stopped: false,
              }));
            if (rows.length === 0) return { calls: 0 };
            const { error } = await svc.from("reminder_state").upsert(rows, { onConflict: "user_id,course_id" });
            if (error) fail("state_write");
            else upserts += rows.length;
            return { calls: 1 };
          },
        },
      }
    );
    for (const word of Object.keys(run.errors) as CronErrorWord[]) {
      errors[word] = (errors[word] ?? 0) + (run.errors[word] ?? 0);
    }
    for (const r of results) {
      if (r.status === "sent") sent++;
      else if (r.attempted) failedSends++;
      else {
        notStarted++;
        if (r.errorClass === "daily_limit") leftDailyLimit++;
      }
    }
  }
  skipped += failedSends + notStarted;

  // Reminders were due and the call had no room to open any organisation's
  // run: the next call reads the same sets and arrives at the same place, so
  // this is the job's own failed step (note of 2026-11-21, part 2 (a)), with
  // its counts. An organisation left once other mail had gone stays clean
  // (rule T5).
  if (jobs.length > 0 && runsOpened === 0) {
    noRoom("mail_status_read");
    return finish({
      stoppedBeforeSend: true,
      due: jobs.length,
      sent: 0,
      failed: 0,
      left: notStarted,
      leftComplete: false,
      leftDailyLimit: 0,
      leftOrgs,
    });
  }

  return finish({
    stoppedBeforeSend: false,
    due: jobs.length,
    sent,
    failed: failedSends,
    left: owedAfterRun("reminders", { notStarted, failedClasses: [] }),
    leftComplete: leftOrgs === 0 && unreadableOrgs === 0,
    leftDailyLimit,
    leftOrgs,
    no0114,
  });
}
