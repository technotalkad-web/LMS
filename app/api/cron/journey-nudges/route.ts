import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recordHeartbeat } from "@/lib/ops/heartbeat";
import { notifyBackground } from "@/lib/notifications/send";
import {
  computeJourneyState,
  courseDaysOf,
  dateOfDay,
  todayStr,
  DEFAULT_JOURNEY_TZ,
} from "@/lib/journey/journey";

/**
 *   POST /api/cron/journey-nudges
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Daily behind-schedule nudges for the Yoddha Journey (migration 0059).
 * For every active, published, nudge-enabled program: active enrollments
 * that are ≥ nudge_behind_days behind their pinned version's drip — and
 * outside the nudge_cooldown_days window — get one org-branded email
 * (event 'journey_nudge', template admin-editable). last_nudged_at tracks
 * delivery. Capped per run so a large backlog never blows the Workers CPU
 * budget; the daily cadence drains it across runs.
 *
 * Scheduled daily from .github/workflows/cron.yml (04:00 UTC ≈ 09:30 IST).
 */

const MAX_NUDGES_PER_RUN = 50;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  // migrations — 0065's escalation fields arrive as undefined before it.
  const { data: progRows, error: progErr } = await svc
    .from("journey_programs")
    .select("*, organizations!inner(name, slug)")
    .eq("is_active", true)
    .eq("nudge_enabled", true)
    .not("current_version_id", "is", null);
  if (progErr) return { ok: false, error: progErr.message, total_ms: Date.now() - t0 };

  let nudged = 0;
  let escalated = 0;
  let scanned = 0;
  const details: Array<{ org: string; nudged: number; escalated: number }> = [];

  for (const p of (progRows ?? []) as Array<{
    id: string;
    organization_id: string;
    name: string;
    nudge_behind_days: number;
    nudge_cooldown_days: number;
    // 0065 — undefined before the migration runs.
    deadline_days?: number | null;
    escalation_enabled?: boolean;
    escalation_after_days?: number;
    organizations: { name: string; slug: string } | Array<{ name: string; slug: string }>;
  }>) {
    if (nudged >= MAX_NUDGES_PER_RUN) break;
    const org = Array.isArray(p.organizations) ? p.organizations[0] : p.organizations;
    const { data: gsRow } = await svc
      .from("gamification_settings")
      .select("timezone")
      .eq("organization_id", p.organization_id)
      .maybeSingle();
    const tz = (gsRow as { timezone?: string } | null)?.timezone || DEFAULT_JOURNEY_TZ;
    const today = todayStr(tz);
    const cooldownCutoff = new Date(
      Date.now() - p.nudge_cooldown_days * 86400000
    ).toISOString();
    const escalationOn = p.escalation_enabled === true;
    const escalateAfter = p.escalation_after_days ?? 3;

    // L1 managers for this org (0011 line_manager_id — the mapping that
    // powers the Verticals board), fetched once per program.
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

    const { data: enrRows } = await svc
      .from("journey_enrollments")
      .select(
        "id, user_id, start_date, last_nudged_at, journey_versions!inner(days, days_total, count_sundays)"
      )
      .eq("program_id", p.id)
      .eq("status", "active")
      .or(`last_nudged_at.is.null,last_nudged_at.lt.${cooldownCutoff}`)
      .limit(500);

    let orgNudged = 0;
    let orgEscalated = 0;
    for (const e of (enrRows ?? []) as Array<{
      id: string;
      user_id: string;
      start_date: string;
      last_nudged_at: string | null;
      journey_versions:
        | { days: unknown; days_total: number; count_sundays: boolean }
        | Array<{ days: unknown; days_total: number; count_sundays: boolean }>;
    }>) {
      if (nudged >= MAX_NUDGES_PER_RUN) break;
      scanned++;
      const v = Array.isArray(e.journey_versions)
        ? e.journey_versions[0]
        : e.journey_versions;
      if (!v) continue;
      const { count } = await svc
        .from("journey_day_progress")
        .select("id", { count: "exact", head: true })
        .eq("enrollment_id", e.id);
      const state = computeJourneyState({
        startDate: e.start_date,
        today,
        completedCount: count ?? 0,
        daysTotal: v.days_total,
        countSundays: v.count_sundays === true,
        courseDays: courseDaysOf(v.days, v.days_total),
      });
      if (state.finished) continue;
      // Deadline (0065): counted like the drip; overrunning it always
      // escalates, regardless of the behind threshold.
      const deadlineDate =
        typeof p.deadline_days === "number" && p.deadline_days > 0
          ? dateOfDay(e.start_date, p.deadline_days, v.count_sundays === true)
          : null;
      const overdue = deadlineDate !== null && today > deadlineDate;
      const needsNudge = state.behindDays >= p.nudge_behind_days || overdue;
      const needsEscalation =
        escalationOn && (state.behindDays >= escalateAfter || overdue);
      if (!needsNudge && !needsEscalation) continue;

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
      if (!profile?.email) continue;

      const learnerName =
        [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() ||
        profile.email.split("@")[0];
      const journeyCtx = {
        learner_name: learnerName,
        learner_email: profile.email,
        org_name: org?.name ?? "",
        journey_name: p.name,
        day: String(state.currentDay),
        days_total: String(state.daysTotal),
        behind_days: String(state.behindDays),
        deadline_date: deadlineDate ?? "",
        direct_link: base ? `${base}/${org?.slug}/journey` : `/${org?.slug}/journey`,
        portal_url: base ? `${base}/${org?.slug}/journey` : `/${org?.slug}/journey`,
      };

      if (needsNudge) {
        await notifyBackground({
          organizationId: p.organization_id,
          event: "journey_nudge",
          to: { user_id: e.user_id, email: profile.email },
          context: journeyCtx,
        });
      }

      // Manager escalation (0065): the learner's L1 gets their own
      // manager-worded email, on the same cooldown as the learner nudge.
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
                direct_link: base ? `${base}/${org?.slug}/dashboard` : `/${org?.slug}/dashboard`,
              },
            });
            escalated++;
            orgEscalated++;
          }
        }
      }

      await svc
        .from("journey_enrollments")
        .update({ last_nudged_at: new Date().toISOString() })
        .eq("id", e.id);
      nudged++;
      orgNudged++;
    }
    if (orgNudged > 0 || orgEscalated > 0) {
      details.push({
        org: org?.slug ?? p.organization_id,
        nudged: orgNudged,
        escalated: orgEscalated,
      });
    }
  }

  return { ok: true, total_ms: Date.now() - t0, scanned, nudged, escalated, details };
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
