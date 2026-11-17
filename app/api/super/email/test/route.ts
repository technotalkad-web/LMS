import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog, requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";
import { sendPlatformEmail } from "@/lib/email/platform-sender";

/**
 *   POST /api/super/email/test     (no body)
 *
 * Sends the platform sender's fixed test message (platform_test, ADR 0029
 * section F) to the signed-in platform owner's own address, read server side
 * from their user id; the request chooses neither the recipient, the subject
 * nor the text. Writes one platform_audit_log row with the outcome (status
 * and error class, and whether the sender's log row was written; no
 * address). The sender's own limits apply: 5 tests an hour and 10 a day for
 * each owner, counting the tests that reached the mail server.
 *
 * Answers 200 with { status, error_code, logged } for every outcome of the
 * send, so the console shows it: sent; suppressed (a reserved test domain,
 * or a domain outside PLATFORM_EMAIL_ALLOW_DOMAINS); refused (the account
 * limit); failed (not_configured, an error class, or log_unreadable when the
 * log cannot be read, e.g. before migration 0113). logged false: the
 * outcome has no platform_email_log row, so the limits and the health
 * check do not count it.
 */
export async function POST() {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data, error } = await svc.auth.admin.getUserById(guard.userId);
  if (error) return NextResponse.json({ error: "try again" }, { status: 503 });
  const email = data?.user?.email;
  if (!email) return NextResponse.json({ error: "no_address" }, { status: 409 });

  const result = await sendPlatformEmail({
    event: "platform_test",
    to: { userId: guard.userId, email, platformOwner: true },
    organizationId: null,
    content: {},
  });
  const audit = await auditLog({
    actorUserId: guard.userId,
    action: "platform_email.test",
    targetType: "platform_email",
    metadata: { status: result.status, error_code: result.errorCode, logged: result.logged },
  });
  return NextResponse.json({
    status: result.status,
    error_code: result.errorCode,
    logged: result.logged,
    audited: audit.error === null,
  });
}
