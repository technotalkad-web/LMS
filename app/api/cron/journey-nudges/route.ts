import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { notifyBackground } from "@/lib/notifications/send";
import {
  computeJourneyState,
  courseDaysOf,
  dateOfDay,
  parseVersionDays,
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

  // `*` on the program keeps this deploy-safe across program-column
  // migrations — 0065/0088 fields arrive as undefined before they run.
  const { data: progRows, error: progErr } = await svc
    .from("journey_programs")
    .select("*, organizations!inner(name, slug)")
    .eq("is_active", true)
    .eq("nudge_enabled", true)
    .not("current_version_id", "is", null);
  if (progErr) return { ok: false, error: progErr.message, total_ms: Date.now() - t0 };

  let reminded = 0;
  let escalated = 0;
  let scanned = 0;
  let skippedEarly = 0;
  let capped = false;
  const details: Array<{ org: string; reminded: number; escalated: number }> = [];
  const courseTitle = new Map<string, string>(); // courseId → title (cross-program cache)

  for (const p of (progRows ?? []) as Array<{
    id: string;
    organization_id: string;
    name: string;
    nudge_cooldown_days: number;
    reminder_hour?: number | null; // 0088 — undefined before the migration → 11
    deadline_days?: number | null; // 0065
    escalation_enabled?: boolean;
    escalation_after_days?: number;
    organizations: { name: string; slug: string } | Array<{ name: string; slug: string }>;
  }>) {
    if (reminded >= MAX_REMINDERS_PER_RUN) {
      capped = true;
      break;
    }
    const org = Array.isArray(p.organizations) ? p.organizations[0] : p.organizations;
    const { data: gsRow } = await svc
      .from("gamification_settings")
      .select("timezone")
      .eq("organization_id", p.organization_id)
      .maybeSingle();
    const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
    const today = todayStr(tz);
    const reminderHour = Math.min(23, Math.max(0, p.reminder_hour ?? 11));
    // Hourly cron: act only once the org-local hour has reached the configured
    // reminder time. Earlier runs this day are a no-op for this program.
    if (hourInTz(tz) < reminderHour) {
      skippedEarly++;
      continue;
    }
    const cooldownCutoff = new Date(Date.now() - (p.nudge_cooldown_days ?? 3) * 86400000);
    const escalationOn = p.escalation_enabled === true;
    const escalateAfter = p.escalation_after_days ?? 3;

    // L1 managers for this org (0011 line_manager_id), fetched once per program.
    let managerOf = new Map<string, string>();
    if (escalationOn) {
      const { data: memRows } = await svc
        .from("organization_members")
        .select("user_id, line_manager_id")
        .eq("organization_id", p.organization_id)
        .not("line_manager_id", "is", null);
      managerOf = new Map(
        ((memRows ?? []) as Array<{ user_id: string; line_manager_id: string }>).map(
          (m) => [m.user_id, m.line_manager_id]
        )
      );
    }

    let orgReminded = 0;
    let orgEscalated = 0;
    // Keyset pagination by id (stable while we stamp non-id columns); the daily
    // guard filter drops learners already reminded today.
    let lastId = "";
    for (;;) {
      if (reminded >= MAX_REMINDERS_PER_RUN) {
        capped = true;
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
      const { data: enrRows } = await q;
      const batch = (enrRows ?? []) as Array<{
        id: string;
        user_id: string;
        start_date: string;
        last_nudged_at: string | null;
        last_daily_reminder_on: string | null;
        journey_versions:
          | { days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }
          | Array<{ days: unknown; days_total: number; count_sundays: boolean; unlock_mode?: string | null }>;
      }>;
      if (batch.length === 0) break;

      // One batched round-trip for the page: completed-day count + whether a
      // day was completed today (org-local), instead of a query per learner.
      const { data: cntRows } = await svc.rpc("journey_reminder_counts", {
        p_ids: batch.map((e) => e.id),
      });
      const counts = new Map<string, { done: number; done_today: boolean }>();
      for (const c of (cntRows ?? []) as Array<{ enrollment_id: string; done: number; done_today: boolean }>) {
        counts.set(c.enrollment_id, { done: c.done ?? 0, done_today: c.done_today === true });
      }

      for (const e of batch) {
        scanned++;
        if (reminded >= MAX_REMINDERS_PER_RUN) {
          capped = true;
          break;
        }
        const v = Array.isArray(e.journey_versions)
          ? e.journey_versions[0]
          : e.journey_versions;
        if (!v) continue;
        const unlockMode = v.unlock_mode === "progress" ? "progress" : "calendar";
        const cnt = counts.get(e.id);
        const done = cnt?.done ?? 0;
        const doneToday = cnt?.done_today ?? false;
        const state = computeJourneyState({
          startDate: e.start_date,
          today,
          completedCount: done,
          daysTotal: v.days_total,
          countSundays: v.count_sundays === true,
          unlockMode,
          courseDays: courseDaysOf(v.days, v.days_total),
        });
        if (state.finished) continue;

        // Pending work worth a reminder today?
        const due =
          unlockMode === "progress"
            ? state.todayUnlocked && !doneToday // has an open mission, none done today
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

        if (!due && !needsEscalation) continue;

        // ATOMIC CLAIM for the daily reminder: only the invocation whose
        // conditional UPDATE matches (not yet reminded today) wins the send.
        let claimed = false;
        if (due) {
          const { data: claim } = await svc
            .from("journey_enrollments")
            .update({ last_daily_reminder_on: today })
            .eq("id", e.id)
            .or(`last_daily_reminder_on.is.null,last_daily_reminder_on.lt.${today}`)
            .select("id");
          claimed = (claim?.length ?? 0) > 0;
        }
        if (!claimed && !needsEscalation) continue;

        const { data: prof } = await svc
          .from("profiles")
          .select("first_name, last_name, email")
          .eq("id", e.user_id)
          .maybeSingle();
        const profile = prof as {
          first_name?: string | null;
          last_name?: string | null;
          email?: string | null;
        } | null;
        if (!profile?.email) {
          // Can't email → release the claim so a later run can retry.
          if (claimed) {
            await svc
              .from("journey_enrollments")
              .update({ last_daily_reminder_on: e.last_daily_reminder_on })
              .eq("id", e.id);
          }
          continue;
        }
        const learnerName =
          [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() ||
          profile.email.split("@")[0];

        // Next mission's name (the learner's current incomplete day).
        const entry = parseVersionDays(v.days).get(state.currentDay);
        let nextModule = entry?.mission_title ?? null;
        if (!nextModule && entry?.course_id) {
          if (!courseTitle.has(entry.course_id)) {
            const { data: cRow } = await svc
              .from("courses")
              .select("title")
              .eq("id", entry.course_id)
              .maybeSingle();
            courseTitle.set(entry.course_id, (cRow as { title?: string } | null)?.title ?? "your next module");
          }
          nextModule = courseTitle.get(entry.course_id) ?? "your next module";
        }
        nextModule = nextModule ?? "your next module";

        // Mode-appropriate reason line (keeps "days behind" only where it means
        // something; progress journeys never say "behind").
        const reminderLine =
          unlockMode === "calendar" && state.behindDays >= 1
            ? `You're **${state.behindDays} day${state.behindDays === 1 ? "" : "s"} behind** — missed missions can be caught up one after another.`
            : "Pick up where you left off — it only takes a few minutes.";

        const journeyCtx = {
          learner_name: learnerName,
          learner_email: profile.email,
          org_name: org?.name ?? "",
          journey_name: p.name,
          day: String(state.currentDay),
          days_total: String(state.daysTotal),
          behind_days: String(state.behindDays),
          next_module: nextModule,
          reminder_line: reminderLine,
          deadline_date: deadlineDate ?? "",
          direct_link: base ? `${base}/${org?.slug}/journey` : `/${org?.slug}/journey`,
          portal_url: base ? `${base}/${org?.slug}/journey` : `/${org?.slug}/journey`,
        };

        if (claimed) {
          const res = await notifyBackground({
            organizationId: p.organization_id,
            event: "journey_nudge",
            to: { user_id: e.user_id, email: profile.email },
            context: journeyCtx,
          });
          if (res?.status === "sent") {
            reminded++;
            orgReminded++;
          } else {
            // Send failed/queued → release the claim so a later run retries
            // rather than burning the learner's one reminder for the day.
            await svc
              .from("journey_enrollments")
              .update({ last_daily_reminder_on: e.last_daily_reminder_on })
              .eq("id", e.id);
          }
        }

        if (needsEscalation) {
          const managerId = managerOf.get(e.user_id);
          if (managerId) {
            const { data: mgr } = await svc
              .from("profiles")
              .select("first_name, last_name, email")
              .eq("id", managerId)
              .maybeSingle();
            const manager = mgr as {
              first_name?: string | null;
              last_name?: string | null;
              email?: string | null;
            } | null;
            if (manager?.email) {
              await notifyBackground({
                organizationId: p.organization_id,
                event: "journey_escalation",
                to: { user_id: managerId, email: manager.email },
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
              await svc
                .from("journey_enrollments")
                .update({ last_nudged_at: new Date().toISOString() })
                .eq("id", e.id);
              escalated++;
              orgEscalated++;
            }
          }
        }
      }

      if (capped) break;
      if (batch.length < PAGE) break;
      lastId = batch[batch.length - 1].id;
    }
    if (orgReminded > 0 || orgEscalated > 0) {
      details.push({
        org: org?.slug ?? p.organization_id,
        reminded: orgReminded,
        escalated: orgEscalated,
      });
    }
  }

  return {
    ok: true,
    total_ms: Date.now() - t0,
    scanned,
    reminded,
    escalated,
    skipped_early: skippedEarly,
    capped,
    details,
  };
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  await recordHeartbeat("journey-nudges", result, result.ok);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export const GET = POST;
