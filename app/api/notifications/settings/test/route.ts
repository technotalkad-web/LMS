import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { resolveOrgMembership } from "@/lib/auth/org-membership";
import { canManage } from "@/lib/auth/permissions";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { runSettingsTest } from "@/lib/notifications/send";

/**
 *   POST /api/notifications/settings/test   body: { orgSlug }
 *
 * "Send test" on the SMTP tab (ADR 0029 section C, step 11): the Settings
 * test on demand, to the signed-in administrator's own address, through the
 * organisation's own SMTP only. The caller's membership is read by ADR
 * 0030's resolver and only an administrator (canManage) is served; a failed
 * read answers 503 and sends nothing. The answer carries the outcome and the
 * organisation's reading after it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string };
  if (!body.orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const membership = await resolveOrgMembership(supabase, { slug: body.orgSlug }, user.id);
  if (membership === "unreadable") return NextResponse.json({ error: CHECK_FAILED }, { status: 503 });
  if (membership === "none") return NextResponse.json({ error: "Org not found" }, { status: 404 });
  if (!canManage(membership.role as OrgRole)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const test = await runSettingsTest({ organizationId: membership.org.id, user: { id: user.id, email: user.email ?? null } });
  return NextResponse.json({ ok: true, test });
}
