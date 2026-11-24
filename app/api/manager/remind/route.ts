import { NextResponse } from "next/server";
import { authorizeManager, isActionError, sendReminders } from "@/lib/manager/actions";
import { MIDDLEWARE_CALLS, requestBudget } from "@/lib/notifications/smtp-state";

/**
 *   POST /api/manager/remind
 *   body: { orgSlug, userIds: string[], target: "course" | "start" | "journey", contentId?: string }
 *
 * Manager action "send reminder now" (Report Card, decision 6). The caller
 * must be mapped as the learners' L1 manager; course reminders reuse the
 * asset_reminder template + reminder_state, journey reminders the daily
 * journey_nudge (and claim the day so the cron does not send a second one).
 *
 * ADR 0029 rule FP2: the request's one budget starts with the request and
 * counts from its first call (the middleware's), each call where it is
 * made (authorizeManager, sendReminders), so the reminders are sized on the
 * calls really made. Its 45 seconds start there too.
 */
export async function POST(request: Request) {
  const budget = requestBudget({ spent: MIDDLEWARE_CALLS });
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    userIds?: string[];
    target?: "course" | "start" | "journey";
    contentId?: string | null;
  };
  const a = await authorizeManager(body.orgSlug, budget);
  if (isActionError(a)) return NextResponse.json({ error: a.error }, { status: a.status });
  const r = await sendReminders(a, body);
  if (isActionError(r)) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, ...r });
}
