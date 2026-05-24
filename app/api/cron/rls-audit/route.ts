import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/auth/require-platform-owner";

/**
 *   POST /api/cron/rls-audit
 *   header: x-cron-secret: <CRON_SECRET>
 *
 * Reads `platform_tables_without_rls` (view defined in 0022) and
 * compares the result against a known allowlist of intentionally-open
 * tables (e.g. subscription_plans is global, not per-tenant). Any
 * tenant-scoped table found without RLS is a CRITICAL finding: we
 * (a) write an entry to platform_audit_log, and (b) auto-post a
 * "critical" broadcast so the active platform owner sees it the
 * next time they open any page.
 */
const KNOWN_PUBLIC = new Set<string>([
  // Reference data, shared across all tenants — intentionally readable.
  "subscription_plans",
  "platform_owners", // RLS-on but listed only to be explicit
  "platform_audit_log",
  "platform_broadcasts",
  "platform_broadcast_reads",
  "platform_impersonation_sessions",
]);

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function run() {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: rows, error } = await svc
    .from("platform_tables_without_rls")
    .select("tablename");
  if (error) {
    return { ok: false, error: error.message, offenders: [] as string[] };
  }

  const offenders = ((rows ?? []) as Array<{ tablename: string }>)
    .map((r) => r.tablename)
    .filter((t) => !KNOWN_PUBLIC.has(t));

  await auditLog({
    actorUserId: "00000000-0000-0000-0000-000000000000",
    action: "security.rls_audit",
    metadata: { offenders, considered: rows?.length ?? 0 },
  });

  if (offenders.length > 0) {
    // Surface as an active broadcast to every super_owner.
    await svc.from("platform_broadcasts").insert({
      title: "RLS audit: tables without row-level security",
      body_md: `Found ${offenders.length} tenant-scoped table(s) without RLS: ${offenders.join(", ")}. Patch immediately.`,
      tone: "critical",
      audience: "super_owners_only",
      dismissable: false,
      is_active: true,
    });
  }

  return { ok: true, offenders };
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return unauthorized();
  }
  const result = await run();
  return NextResponse.json(result);
}

export async function GET(request: Request) {
  return POST(request);
}
