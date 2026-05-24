import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/auth/require-platform-owner";

/**
 *   POST /api/cron/billing
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Runs daily. For every tenant_subscriptions row:
 *
 *   active     + current_period_end < now()       → past_due  (stamp past_due_at)
 *   past_due   + past_due_at < now() - 7 days     → suspended (stamp suspended_at)
 *   suspended  + suspended_at < now() - 14 days   → still suspended; we leave the
 *                                                   tenant alone. Hard reaping happens
 *                                                   under /api/cron/reaper for
 *                                                   scheduled_deletion_at, not billing.
 *
 * This endpoint also stamps last_billing_check_at on every row it
 * processes so admins can see the cron is running.
 */

const PAST_DUE_GRACE_DAYS = 7;

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function run() {
  const s = svc();
  const now = new Date();
  const nowIso = now.toISOString();
  const pastDueCutoff = new Date(now.getTime() - PAST_DUE_GRACE_DAYS * 86400_000);

  const { data: subs } = await s
    .from("tenant_subscriptions")
    .select("organization_id, billing_status, past_due_at, current_period_end, suspended_at");

  let toPastDue = 0;
  let toSuspended = 0;
  let unchanged = 0;
  const errors: string[] = [];

  for (const sub of (subs ?? []) as Array<{
    organization_id: string;
    billing_status: string;
    past_due_at: string | null;
    current_period_end: string | null;
    suspended_at: string | null;
  }>) {
    if (sub.billing_status === "active") {
      if (sub.current_period_end && new Date(sub.current_period_end) < now) {
        const { error } = await s
          .from("tenant_subscriptions")
          .update({
            billing_status: "past_due",
            past_due_at: nowIso,
            last_billing_check_at: nowIso,
            updated_at: nowIso,
          })
          .eq("organization_id", sub.organization_id);
        if (error) errors.push(error.message);
        else {
          toPastDue++;
          await auditLog({
            actorUserId: "00000000-0000-0000-0000-000000000000",
            action: "billing.cron.past_due",
            targetType: "organization",
            targetId: sub.organization_id,
          });
        }
      } else {
        await s
          .from("tenant_subscriptions")
          .update({ last_billing_check_at: nowIso })
          .eq("organization_id", sub.organization_id);
        unchanged++;
      }
    } else if (sub.billing_status === "past_due") {
      if (sub.past_due_at && new Date(sub.past_due_at) < pastDueCutoff) {
        const { error } = await s
          .from("tenant_subscriptions")
          .update({
            billing_status: "suspended",
            suspended_at: nowIso,
            last_billing_check_at: nowIso,
            updated_at: nowIso,
          })
          .eq("organization_id", sub.organization_id);
        if (error) errors.push(error.message);
        else {
          toSuspended++;
          await auditLog({
            actorUserId: "00000000-0000-0000-0000-000000000000",
            action: "billing.cron.suspended",
            targetType: "organization",
            targetId: sub.organization_id,
            metadata: { reason: "past_due_grace_exceeded" },
          });
        }
      } else {
        await s
          .from("tenant_subscriptions")
          .update({ last_billing_check_at: nowIso })
          .eq("organization_id", sub.organization_id);
        unchanged++;
      }
    } else {
      await s
        .from("tenant_subscriptions")
        .update({ last_billing_check_at: nowIso })
        .eq("organization_id", sub.organization_id);
      unchanged++;
    }
  }

  return { processed: subs?.length ?? 0, toPastDue, toSuspended, unchanged, errors };
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  return NextResponse.json({ ok: true, ...result });
}

// Convenience for Vercel cron (no body, header only).
export async function GET(request: Request) {
  return POST(request);
}
