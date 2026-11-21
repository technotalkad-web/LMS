import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog, requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";
import { TENANT_MAIL_NEEDS_0114 } from "@/lib/notifications/smtp-state";
import { isMissingRelation } from "@/lib/scoring/attempt-kind";

/**
 *   POST /api/super/email/limit     { organization_id, daily_limit }
 *   POST /api/super/email/limit     { organization_id, use_default: true }
 *
 * Sets one organisation's daily email limit (ADR 0029 step 17; rule FP4 of
 * the note of 2026-11-18): tenant_smtp_state.daily_limit, a whole number
 * from 1 to 100,000. Going back to the default is its own request,
 * `use_default: true`, which stores null; a daily_limit of null, or of
 * anything that is not such a number, is refused with 400 and nothing is
 * written, so a value the form could not read never resets the limit. A
 * platform owner only (requirePlatformOwnerApi "full"); a tenant's
 * administrators see the number and cannot change it.
 *
 * Reads the number it replaces first, writes the organisation's id, the
 * number and the time and nothing else, then writes one platform_audit_log
 * row with the number before and after. A deleted organisation, or one that
 * does not exist, is 404. Without migration 0114 (the table is missing,
 * read by the error's code) it is refused with the console's sentence that
 * names the migration, and nothing is written. Any other failed read or
 * write is 503 and writes no audit row.
 *
 * Answers { ok, daily_limit, previous, audited }: numbers and booleans only.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_TABLE = "tenant_smtp_state";
const LIMIT_RULE = "The daily limit is a whole number from 1 to 100,000. To go back to the default, choose Use the default.";
const ONE_OF_THEM = "Send a daily limit or use_default, not both.";
const TRY_AGAIN = "Could not change the limit right now. Please try again.";

export async function POST(request: Request) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: { organization_id?: unknown; daily_limit?: unknown; use_default?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const orgId = typeof body?.organization_id === "string" ? body.organization_id : "";
  if (!UUID.test(orgId)) return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
  // The default is asked for by name; a null limit is never read as it.
  const useDefault = body?.use_default === true;
  if (useDefault && body?.daily_limit !== undefined && body?.daily_limit !== null) {
    return NextResponse.json({ error: ONE_OF_THEM }, { status: 400 });
  }
  const next: number | null = useDefault ? null : typeof body?.daily_limit === "number" ? body.daily_limit : NaN;
  if (next !== null && !(Number.isInteger(next) && next >= 1 && next <= 100_000)) {
    return NextResponse.json({ error: LIMIT_RULE }, { status: 400 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: org, error: orgErr } = await svc.from("organizations").select("id, deleted_at").eq("id", orgId).maybeSingle();
  if (orgErr) return NextResponse.json({ error: TRY_AGAIN }, { status: 503 });
  if (!org || (org as { deleted_at: string | null }).deleted_at !== null) {
    return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
  }

  const { data: prior, error: readErr } = await svc.from(STATE_TABLE).select("daily_limit").eq("organization_id", orgId).maybeSingle();
  if (readErr) {
    return isMissingRelation(readErr, STATE_TABLE)
      ? NextResponse.json({ error: TENANT_MAIL_NEEDS_0114 }, { status: 503 })
      : NextResponse.json({ error: TRY_AGAIN }, { status: 503 });
  }
  const raw = (prior as { daily_limit?: unknown } | null)?.daily_limit;
  const previous = typeof raw === "number" && Number.isInteger(raw) ? raw : null;

  const { error: writeErr } = await svc
    .from(STATE_TABLE)
    .upsert({ organization_id: orgId, daily_limit: next, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
  if (writeErr) {
    return isMissingRelation(writeErr, STATE_TABLE)
      ? NextResponse.json({ error: TENANT_MAIL_NEEDS_0114 }, { status: 503 })
      : NextResponse.json({ error: TRY_AGAIN }, { status: 503 });
  }

  const audit = await auditLog({
    actorUserId: guard.userId,
    action: "tenant_email.daily_limit",
    targetType: "organization",
    targetId: orgId,
    metadata: { previous, daily_limit: next },
  });
  return NextResponse.json({ ok: true, daily_limit: next, previous, audited: audit.error === null });
}
