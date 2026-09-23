import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadLrsConfig } from "@/lib/lrs/config";

/**
 *   POST /api/org/lrs/backfill   { orgSlug }
 *
 * Asks the sweeper (run by /api/cron/lrs-forward every 5 minutes) to re-send
 * the org's ENTIRE history to its external LRS in the analytics profile:
 * engine statements, LMS-derived events and translated SCORM outcomes. The
 * request only stamps backfill_requested_at; the cron resets the cursors on
 * its next run and works through history in small chunks. Statements keep
 * their ids, so an LRS that already holds one keeps its first copy.
 *
 * Admin-only. Requires migration 0078.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string };
  if (!body.orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = mem?.role as string | undefined;
  if (!(role === "super_owner" || role === "owner" || role === "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await loadLrsConfig(org.id as string);
  if (!cfg) return NextResponse.json({ error: "LRS config not found" }, { status: 404 });
  if (!("backfill_cursor" in cfg)) {
    return NextResponse.json(
      { error: "History backfill needs database migration 0078. Apply it and try again." },
      { status: 409 }
    );
  }
  if (!cfg.enabled || !cfg.endpoint) {
    return NextResponse.json(
      { error: "Enable forwarding with an endpoint first, then request the backfill." },
      { status: 400 }
    );
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const now = new Date().toISOString();
  const { error } = await svc
    .from("tenant_lrs_config")
    .update({ backfill_requested_at: now, updated_at: now })
    .eq("organization_id", org.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, backfill_requested_at: now });
}
