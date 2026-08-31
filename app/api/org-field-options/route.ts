import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  GOVERNED_FIELDS,
  type GovernedField,
} from "@/lib/org/field-options";

/**
 *   GET    /api/org-field-options?orgSlug=...        → { options, require_manager_fields }
 *   POST   /api/org-field-options { orgSlug, field, value }         (Super Owner)
 *   DELETE /api/org-field-options { orgSlug, id }                   (Super Owner)
 *   PATCH  /api/org-field-options { orgSlug, require_manager_fields } (Super Owner)
 *
 * Master value lists for the governed Organization-details fields. Reads are
 * open to any admin-page caller via RLS (members read); writes are enforced
 * both here and by RLS (super owner only) — the user-bound client is used
 * throughout, so RLS is the final authority.
 */

async function resolveOrg(orgSlug: string | null) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase
    .from("organizations")
    .select("id, slug, require_manager_fields")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!mem) return { error: "Forbidden", status: 403 as const };
  const role = mem.role as string;
  return {
    supabase,
    org,
    isSuperOwner: role === "super_owner" || role === "owner",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ctx = await resolveOrg(url.searchParams.get("orgSlug"));
  if ("error" in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { data: rows } = await ctx.supabase
    .from("org_field_options")
    .select("id, field, value")
    .eq("organization_id", ctx.org.id)
    .order("value", { ascending: true });
  return NextResponse.json({
    options: rows ?? [],
    require_manager_fields:
      (ctx.org as { require_manager_fields?: boolean }).require_manager_fields ===
      true,
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    field?: string;
    value?: string;
  };
  const ctx = await resolveOrg(body.orgSlug ?? null);
  if ("error" in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  if (!ctx.isSuperOwner) {
    return NextResponse.json(
      { error: "Only the Super Owner can maintain master values" },
      { status: 403 }
    );
  }
  const field = body.field as GovernedField;
  const value = (body.value ?? "").trim();
  if (!GOVERNED_FIELDS.includes(field)) {
    return NextResponse.json({ error: "Invalid field" }, { status: 400 });
  }
  if (!value) {
    return NextResponse.json({ error: "Value required" }, { status: 400 });
  }
  // RLS (super owner) is the write authority; unique index dedupes (23505).
  const { data: row, error } = await ctx.supabase
    .from("org_field_options")
    .insert({ organization_id: ctx.org.id, field, value })
    .select("id, field, value")
    .single();
  if (error) {
    const msg = error.code === "23505" ? "That value already exists." : error.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ ok: true, option: row });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    id?: string;
  };
  const ctx = await resolveOrg(body.orgSlug ?? null);
  if ("error" in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  if (!ctx.isSuperOwner) {
    return NextResponse.json(
      { error: "Only the Super Owner can maintain master values" },
      { status: 403 }
    );
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await ctx.supabase
    .from("org_field_options")
    .delete()
    .eq("organization_id", ctx.org.id)
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    require_manager_fields?: boolean;
  };
  const ctx = await resolveOrg(body.orgSlug ?? null);
  if ("error" in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  if (!ctx.isSuperOwner) {
    return NextResponse.json(
      { error: "Only the Super Owner can change this setting" },
      { status: 403 }
    );
  }
  if (typeof body.require_manager_fields !== "boolean") {
    return NextResponse.json(
      { error: "require_manager_fields boolean required" },
      { status: 400 }
    );
  }
  const { error } = await ctx.supabase
    .from("organizations")
    .update({ require_manager_fields: body.require_manager_fields })
    .eq("id", ctx.org.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
