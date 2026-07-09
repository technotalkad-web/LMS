import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/auth/require-platform-owner";
import { recordHeartbeat } from "@/lib/ops/heartbeat";

/**
 *   POST /api/cron/reaper
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * For every org whose `scheduled_deletion_at` is in the past:
 *   - stamp deleted_at = now()  (soft-delete sentinel; we don't issue
 *     a destructive DELETE because tenant data has FK ripples across
 *     ~20 tables and we want a recovery path beyond the 30-day grace)
 *   - cascade: mark tenant_subscriptions billing_status = 'cancelled'
 *   - audit-log the action
 *
 * If you need hard-delete with row removal, build it explicitly: this
 * job only handles the sentinel transition.
 */
function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function run() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const nowIso = new Date().toISOString();

  const { data: targets } = await svc
    .from("organizations")
    .select("id, name, slug")
    .lt("scheduled_deletion_at", nowIso)
    .is("deleted_at", null);

  const ids = ((targets ?? []) as Array<{ id: string; name: string; slug: string }>).map((o) => o);
  let reaped = 0;
  const errors: string[] = [];

  for (const o of ids) {
    const { error: e1 } = await svc
      .from("organizations")
      .update({ deleted_at: nowIso })
      .eq("id", o.id);
    if (e1) {
      errors.push(`${o.slug}: ${e1.message}`);
      continue;
    }
    await svc
      .from("tenant_subscriptions")
      .update({
        billing_status: "cancelled",
        updated_at: nowIso,
      })
      .eq("organization_id", o.id);
    await auditLog({
      actorUserId: "00000000-0000-0000-0000-000000000000",
      action: "tenant.reaped",
      targetType: "organization",
      targetId: o.id,
      metadata: { slug: o.slug, name: o.name },
    });
    reaped++;
  }

  return { reaped, considered: ids.length, errors };
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  await recordHeartbeat("reaper", result, result.errors.length === 0);
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(request: Request) {
  return POST(request);
}
