import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { resolveOrgMembership } from "@/lib/auth/org-membership";
import {
  maskedConfig,
  saveLrsConfig,
  STATEMENT_PROFILES,
  type StatementProfile,
} from "@/lib/lrs/config";

/**
 *   GET  /api/org/lrs?orgSlug=...        → config with auth_secret MASKED
 *   POST /api/org/lrs                    → upsert config (admin only)
 *
 * Admin-only. The raw auth_secret is never returned; on POST it's written only
 * when a genuine new value is supplied.
 */

async function requireAdmin(orgSlug: string | null) {
  if (!orgSlug) return { error: NextResponse.json({ error: "orgSlug required" }, { status: 400 }) };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  // ADR 0030: the org and the caller's role, from a membership that counts.
  const mem = await resolveOrgMembership(supabase, { slug: orgSlug }, user.id);
  if (mem === "unreadable") return { error: NextResponse.json({ error: CHECK_FAILED }, { status: 503 }) };
  if (mem === "none") return { error: NextResponse.json({ error: "Org not found" }, { status: 404 }) };
  const org = mem.org;
  const role = mem.role;
  if (!(role === "super_owner" || role === "owner" || role === "admin")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { orgId: org.id as string };
}

export async function GET(request: Request) {
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  const ctx = await requireAdmin(orgSlug);
  if (ctx.error) return ctx.error;
  return NextResponse.json({ config: await maskedConfig(ctx.orgId) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    enabled?: boolean;
    endpoint?: string | null;
    auth_key?: string | null;
    auth_secret?: string | null;
    xapi_version?: string;
    statement_profile?: string;
  };
  const ctx = await requireAdmin(body.orgSlug ?? null);
  if (ctx.error) return ctx.error;

  if (
    body.statement_profile !== undefined &&
    !STATEMENT_PROFILES.includes(body.statement_profile as StatementProfile)
  ) {
    return NextResponse.json({ error: "Unknown statement profile." }, { status: 400 });
  }

  // Guard: can't enable without an endpoint.
  if (body.enabled && !(body.endpoint && body.endpoint.trim())) {
    return NextResponse.json(
      { error: "An LRS endpoint is required to enable forwarding." },
      { status: 400 }
    );
  }

  const res = await saveLrsConfig(ctx.orgId, {
    enabled: body.enabled,
    endpoint: body.endpoint,
    auth_key: body.auth_key,
    auth_secret: body.auth_secret,
    xapi_version: body.xapi_version,
    statement_profile: body.statement_profile as StatementProfile | undefined,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, config: await maskedConfig(ctx.orgId) });
}
