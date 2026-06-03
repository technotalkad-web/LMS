import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { sendNotification } from "@/lib/notifications/send";

/**
 *   POST /api/cron/reminders
 *   header: x-cron-secret: <CRON_SECRET env var>
 *
 * Hourly scheduled task. For each course with reminders enabled:
 *   - Resolve every learner currently assigned (user/team/org).
 *   - Skip learners who have already completed/passed the course.
 *   - Skip learners whose first_assigned_at is older than cap_days.
 *   - Skip learners whose last_nudge_at is newer than cadence_days ago.
 *   - For survivors, send asset_reminder + update reminder_state.
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
    organizations?: { name?: string; slug?: string } | null;
  } | null;
};

type Assignment = {
  course_id: string;
  organization_id: string;
  assignee_type: "user" | "team" | "org";
  user_id: string | null;
  team_id: string | null;
};

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

  // 1) Courses with reminders enabled.
  const { data: settings } = await svc
    .from("course_reminder_settings")
    .select(
      "course_id, enabled, cadence_days, cap_days, courses(id, title, organization_id, organizations(name, slug))"
    )
    .eq("enabled", true);
  const enabledCourses = ((settings ?? []) as unknown[]).map((r) => {
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
    };
  });
  if (enabledCourses.length === 0) {
    return NextResponse.json({ scanned: 0, sent: 0, skipped: 0 });
  }

  const courseIds = enabledCourses.map((c) => c.course_id);

  // 2) All assignments + memberships + completed user/course pairs.
  const { data: assignmentRows } = await svc
    .from("course_assignments")
    .select("course_id, organization_id, assignee_type, user_id, team_id")
    .in("course_id", courseIds);
  const assignments = (assignmentRows ?? []) as Assignment[];

  // Teams used by assignments
  const teamIds = Array.from(
    new Set(
      assignments
        .filter((a) => a.assignee_type === "team" && a.team_id)
        .map((a) => a.team_id as string)
    )
  );
  const { data: teamMembers } = teamIds.length
    ? await svc.from("team_members").select("team_id, user_id").in("team_id", teamIds)
    : { data: [] };
  const teamUserIds = new Map<string, Set<string>>();
  for (const m of teamMembers ?? []) {
    const tid = m.team_id as string;
    const s = teamUserIds.get(tid) ?? new Set<string>();
    s.add(m.user_id as string);
    teamUserIds.set(tid, s);
  }

  // Org members per org
  const orgIds = Array.from(new Set(assignments.map((a) => a.organization_id)));
  const { data: orgMembers } = orgIds.length
    ? await svc
        .from("organization_members")
        .select("organization_id, user_id")
        .in("organization_id", orgIds)
    : { data: [] };
  const orgUserIds = new Map<string, Set<string>>();
  for (const m of orgMembers ?? []) {
    const oid = m.organization_id as string;
    const s = orgUserIds.get(oid) ?? new Set<string>();
    s.add(m.user_id as string);
    orgUserIds.set(oid, s);
  }

  // Completed pairs
  const { data: completedAttempts } = await svc
    .from("course_attempts")
    .select("user_id, course_versions(course_id), completion_status, success_status")
    .in("course_versions.course_id", courseIds);
  const completedPairs = new Set<string>(); // `user|course`
  for (const a of completedAttempts ?? []) {
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

  // Existing reminder state
  const { data: stateRows } = await svc
    .from("reminder_state")
    .select(
      "user_id, course_id, first_assigned_at, last_nudge_at, nudge_count, stopped"
    )
    .in("course_id", courseIds);
  const stateByKey = new Map<
    string,
    {
      first_assigned_at: string;
      last_nudge_at: string | null;
      nudge_count: number;
      stopped: boolean;
    }
  >();
  for (const s of stateRows ?? []) {
    stateByKey.set(`${s.user_id}|${s.course_id}`, {
      first_assigned_at: s.first_assigned_at as string,
      last_nudge_at: (s.last_nudge_at as string | null) ?? null,
      nudge_count: (s.nudge_count as number) ?? 0,
      stopped: (s.stopped as boolean) ?? false,
    });
  }

  // Resolve user emails (one bulk call)
  const allUserIds = new Set<string>();
  for (const a of assignments) {
    if (a.assignee_type === "user" && a.user_id) allUserIds.add(a.user_id);
    if (a.assignee_type === "team" && a.team_id) {
      for (const uid of teamUserIds.get(a.team_id) ?? []) allUserIds.add(uid);
    }
    if (a.assignee_type === "org") {
      for (const uid of orgUserIds.get(a.organization_id) ?? []) allUserIds.add(uid);
    }
  }
  const emailById = new Map<string, string>();
  if (allUserIds.size > 0) {
    const { data: listed } = await svc.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    for (const u of listed?.users ?? []) {
      if (u.email && allUserIds.has(u.id)) emailById.set(u.id, u.email);
    }
  }

  const now = Date.now();
  // LEGITIMATE NEXT_PUBLIC_SITE_URL use: cron triggers have no inbound
  // request, so there are no headers to read. The build-time value is
  // the only option here. See lib/http/origin.ts for the full rationale
  // and ticket #146 for the rest of the codebase sweep.
  const portalBase =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";

  let sent = 0;
  let skipped = 0;
  const stateUpserts: Array<{
    user_id: string;
    course_id: string;
    organization_id: string;
    first_assigned_at: string;
    last_nudge_at: string;
    nudge_count: number;
    stopped: boolean;
  }> = [];

  for (const course of enabledCourses) {
    const cadenceMs = course.cadence_days * 24 * 60 * 60 * 1000;
    const capMs = course.cap_days * 24 * 60 * 60 * 1000;

    // Resolve assigned learners for this course.
    const learnerIds = new Set<string>();
    for (const a of assignments) {
      if (a.course_id !== course.course_id) continue;
      if (a.assignee_type === "user" && a.user_id) learnerIds.add(a.user_id);
      if (a.assignee_type === "team" && a.team_id) {
        for (const uid of teamUserIds.get(a.team_id) ?? []) learnerIds.add(uid);
      }
      if (a.assignee_type === "org") {
        for (const uid of orgUserIds.get(a.organization_id) ?? []) learnerIds.add(uid);
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
          stateUpserts.push({
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

      const directLink = portalBase
        ? `${portalBase}/${course.org_slug}/courses/${course.course_id}/launch`
        : `/${course.org_slug}/courses/${course.course_id}/launch`;

      const result = await sendNotification({
        organizationId: course.organization_id,
        event: "asset_reminder",
        to: { user_id: uid, email },
        context: {
          learner_name: email,
          learner_email: email,
          course_name: course.title,
          course_id: course.course_id,
          org_name: course.org_name,
          direct_link: directLink,
        },
      });

      if (result.status === "sent") sent++;
      else skipped++;

      stateUpserts.push({
        user_id: uid,
        course_id: course.course_id,
        organization_id: course.organization_id,
        first_assigned_at: st
          ? st.first_assigned_at
          : new Date(firstAssigned).toISOString(),
        last_nudge_at: new Date(now).toISOString(),
        nudge_count: (st?.nudge_count ?? 0) + 1,
        stopped: false,
      });
    }
  }

  if (stateUpserts.length > 0) {
    await svc
      .from("reminder_state")
      .upsert(stateUpserts, { onConflict: "user_id,course_id" });
  }

  return NextResponse.json({
    scanned: enabledCourses.length,
    sent,
    skipped,
    upserts: stateUpserts.length,
  });
}
