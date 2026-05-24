import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  startImpersonation,
  endImpersonation,
  getImpersonation,
} from "@/lib/auth/impersonation";
import { auditLog } from "@/lib/auth/require-platform-owner";

/**
 *   POST   /api/super/impersonate
 *     body: { org_id: string, reason?: string }
 *     starts a 60-minute impersonation session on the target tenant.
 *
 *   DELETE /api/super/impersonate
 *     ends the active impersonation (cookie + DB row).
 *
 *   GET    /api/super/impersonate
 *     returns the active session (or null) so the banner can render.
 */

async function assertPlatformOwner(): Promise<
  { ok: true; userId: string } | { ok: false; res: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: row } = await svc
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}

export async function POST(request: Request) {
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;

  const body = (await request.json().catch(() => ({}))) as {
    org_id?: string;
    reason?: string;
  };
  if (!body.org_id) {
    return NextResponse.json({ error: "org_id required" }, { status: 400 });
  }

  // Resolve target org for the redirect + audit.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: org } = await svc
    .from("organizations")
    .select("id, name, slug")
    .eq("id", body.org_id)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  const o = org as { id: string; name: string; slug: string };

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = request.headers.get("user-agent") ?? null;

  const sessionId = await startImpersonation({
    actorUserId: guard.userId,
    targetOrgId: o.id,
    reason: body.reason,
    ip,
    userAgent: ua,
  });

  await auditLog({
    actorUserId: guard.userId,
    action: "tenant.impersonate_start",
    targetType: "organization",
    targetId: o.id,
    metadata: { reason: body.reason ?? null, session_id: sessionId, slug: o.slug },
    ip,
    userAgent: ua,
  });

  return NextResponse.json({
    ok: true,
    session_id: sessionId,
    redirect: `/${o.slug}/dashboard`,
  });
}

export async function DELETE() {
  const guard = await assertPlatformOwner();
  if (!guard.ok) return guard.res;

  const active = await getImpersonation();
  await endImpersonation();

  if (active) {
    await auditLog({
      actorUserId: guard.userId,
      action: "tenant.impersonate_end",
      targetType: "organization",
      targetId: active.target_org_id,
      metadata: { session_id: active.id },
    });
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const session = await getImpersonation();
  return NextResponse.json({ session });
}
