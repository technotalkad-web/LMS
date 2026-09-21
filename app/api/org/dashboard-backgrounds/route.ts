import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  backgroundKindFromUrl,
  type BackgroundFit,
} from "@/lib/theme/dashboard-background";

/**
 * Dashboard background themes (0074). Admin-only (super_owner / owner / admin).
 *
 *   GET    /api/org/dashboard-backgrounds?orgSlug=          → { backgrounds }
 *   POST   /api/org/dashboard-backgrounds                   { orgSlug, name, asset_url,
 *            fit?, opacity?, is_enabled?, starts_at?, ends_at? } → { background }
 *   PATCH  /api/org/dashboard-backgrounds                   { orgSlug, id, ...fields }
 *   DELETE /api/org/dashboard-backgrounds                   { orgSlug, id }
 *
 * asset_url must point at a file this org uploaded through
 * POST /api/upload/image (kind "background") — never an arbitrary URL, so
 * the learner dashboard can only ever load validated, self-hosted assets.
 */

const FITS: BackgroundFit[] = ["cover", "contain", "tile"];

async function ctx(orgSlug: string | undefined) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase
    .from("organizations")
    .select("id, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (mem?.role as string) ?? "";
  if (!["super_owner", "owner", "admin"].includes(role)) {
    return { error: "Admins only", status: 403 as const };
  }
  return { supabase, orgId: org.id as string, orgSlug: org.slug as string, userId: user.id };
}

function ownAssetUrl(url: unknown, orgSlug: string): string | null {
  if (typeof url !== "string") return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const prefix = `${base}/storage/v1/object/public/public-assets/${orgSlug}/background/`;
  return base && url.startsWith(prefix) && !url.includes("..") ? url : null;
}

function parseWhen(v: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) {
    return { ok: false, error: `${label} must be an ISO date-time` };
  }
  return { ok: true, value: new Date(v).toISOString() };
}

type Body = {
  orgSlug?: string;
  id?: string;
  name?: string;
  asset_url?: string;
  fit?: string;
  opacity?: number | string;
  is_enabled?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
};

/** Validates the editable fields present in `body`; returns the update map. */
function fieldsFrom(body: Body, orgSlug: string, requireAll: boolean) {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined || requireAll) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return { error: "name must be 1–80 characters" };
    out.name = name;
  }
  if (body.asset_url !== undefined || requireAll) {
    const url = ownAssetUrl(body.asset_url, orgSlug);
    if (!url) return { error: "asset_url must be a file uploaded to this workspace's background folder" };
    out.asset_url = url;
    out.asset_kind = backgroundKindFromUrl(url);
  }
  if (body.fit !== undefined) {
    if (!FITS.includes(body.fit as BackgroundFit)) return { error: `fit must be one of: ${FITS.join(", ")}` };
    out.fit = body.fit;
  }
  if (body.opacity !== undefined) {
    const o = Number(body.opacity);
    if (!Number.isFinite(o) || o <= 0 || o > 1) return { error: "opacity must be between 0.05 and 1" };
    out.opacity = Math.round(Math.max(0.05, o) * 100) / 100;
  }
  if (body.is_enabled !== undefined) {
    if (typeof body.is_enabled !== "boolean") return { error: "is_enabled must be boolean" };
    out.is_enabled = body.is_enabled;
  }
  if (body.starts_at !== undefined) {
    const r = parseWhen(body.starts_at, "starts_at");
    if (!r.ok) return { error: r.error };
    out.starts_at = r.value;
  }
  if (body.ends_at !== undefined) {
    const r = parseWhen(body.ends_at, "ends_at");
    if (!r.ok) return { error: r.error };
    out.ends_at = r.value;
  }
  return { fields: out };
}

export async function GET(request: Request) {
  const c = await ctx(new URL(request.url).searchParams.get("orgSlug") ?? undefined);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const { data, error } = await c.supabase
    .from("dashboard_backgrounds")
    .select("*")
    .eq("organization_id", c.orgId)
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ backgrounds: data ?? [] });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const v = fieldsFrom(body, c.orgSlug, true);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });
  const f = v.fields;
  if (f.starts_at && f.ends_at && (f.ends_at as string) <= (f.starts_at as string)) {
    return NextResponse.json({ error: "End must be after start" }, { status: 400 });
  }
  const { data, error } = await c.supabase
    .from("dashboard_backgrounds")
    .insert({ organization_id: c.orgId, created_by: c.userId, ...f })
    .select("*")
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not save theme (is migration 0074 applied?)" },
      { status: 400 }
    );
  }
  return NextResponse.json({ background: data });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const v = fieldsFrom(body, c.orgSlug, false);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });
  const { data: current } = await c.supabase
    .from("dashboard_backgrounds")
    .select("starts_at, ends_at")
    .eq("id", body.id)
    .eq("organization_id", c.orgId)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  const starts = (v.fields.starts_at ?? (current as { starts_at: string | null }).starts_at) as string | null;
  const ends = (v.fields.ends_at ?? (current as { ends_at: string | null }).ends_at) as string | null;
  if (starts && ends && ends <= starts) {
    return NextResponse.json({ error: "End must be after start" }, { status: 400 });
  }
  const { data, error } = await c.supabase
    .from("dashboard_backgrounds")
    .update({ ...v.fields, updated_at: new Date().toISOString() })
    .eq("id", body.id)
    .eq("organization_id", c.orgId)
    .select("*")
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Theme not found" }, { status: error ? 400 : 404 });
  }
  return NextResponse.json({ background: data });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const { data: row } = await c.supabase
    .from("dashboard_backgrounds")
    .select("id, asset_url")
    .eq("id", body.id)
    .eq("organization_id", c.orgId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  const { error } = await c.supabase
    .from("dashboard_backgrounds")
    .delete()
    .eq("id", body.id)
    .eq("organization_id", c.orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Best-effort: drop the file unless another saved theme still uses it.
  const url = (row as { asset_url: string }).asset_url;
  const { count } = await c.supabase
    .from("dashboard_backgrounds")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", c.orgId)
    .eq("asset_url", url);
  const marker = "/public-assets/";
  if ((count ?? 0) === 0 && url.includes(marker)) {
    try {
      const svc = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      );
      await svc.storage.from("public-assets").remove([url.slice(url.indexOf(marker) + marker.length)]);
    } catch {
      /* the row is gone; a stray file is harmless */
    }
  }
  return NextResponse.json({ ok: true });
}
