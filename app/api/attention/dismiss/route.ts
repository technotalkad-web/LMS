import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { resolveOrgMembership } from "@/lib/auth/org-membership";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { ADMIN_ROLES } from "@/lib/attempts/requests";

/**
 *   POST /api/attention/dismiss?orgSlug=acme   body: { itemKey }
 *
 * Mark an Attention Center item as read/done for the org. Admin-only; upserts
 * attention_dismissals on the service-role client. The item stays hidden while
 * its latest activity is at/before dismissed_at — a recurring alert reappears
 * when something new happens after it was cleared.
 */
function svc() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}
function normalizeRole(raw: string | null | undefined): string {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw ?? "";
}

export async function POST(request: Request) {
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  if (!orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as { itemKey?: string };
  const itemKey = (body.itemKey ?? "").trim();
  if (!itemKey || itemKey.length > 200) return NextResponse.json({ error: "itemKey required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // ADR 0030: the org and the caller's role, from a membership that counts.
  const caller = await resolveOrgMembership(supabase, { slug: orgSlug }, user.id);
  if (caller === "unreadable") return NextResponse.json({ error: CHECK_FAILED }, { status: 503 });
  if (caller === "none") return NextResponse.json({ error: "Org not found" }, { status: 404 });
  const org = caller.org;
  if (!ADMIN_ROLES.includes(normalizeRole(caller.role) as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error } = await svc().from("attention_dismissals").upsert(
    {
      organization_id: org.id,
      item_key: itemKey,
      dismissed_by: user.id,
      dismissed_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,item_key" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
