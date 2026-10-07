import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadOrgGovernance } from "@/lib/org/field-options";
import { checkScopes, loadScopes, saveScopesBulk, type ContentType } from "@/lib/content/scopes";

/**
 *   GET /api/content-scopes?orgSlug=&type=course|path|journey&id=
 *     → { scopes: { common, pairs[] } }
 *   PUT /api/content-scopes
 *     body: { orgSlug, items: [{ type, id }], scopes: { common, pairs: [{ vertical, department? }] } }
 *     → replaces the mapping of every item (bulk from the review page, one from a content form)
 *
 * Content → Business Vertical + Department mapping (0096, decision 16).
 * Admin-only. Pairs are validated against master data and stored with the
 * canonical spelling; the content must belong to the org. Mapping is not
 * visibility — nothing is assigned or unlocked here.
 */
const TYPES: ContentType[] = ["course", "path", "journey"];
const TABLE: Record<ContentType, string> = { course: "courses", path: "learning_paths", journey: "journey_programs" };

async function ctx(orgSlug: string | null) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase.from("organizations").select("id, slug").eq("slug", orgSlug).maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase.from("organization_members").select("role, status").eq("organization_id", org.id).eq("user_id", user.id).maybeSingle();
  const m = mem as { role: string; status: string } | null;
  if (!m || m.status !== "active") return { error: "Forbidden", status: 403 as const };
  const admin = ["super_owner", "owner", "admin"].includes(m.role);
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  return { svc, org: org as { id: string; slug: string }, user, admin };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const c = await ctx(url.searchParams.get("orgSlug"));
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const type = url.searchParams.get("type") as ContentType | null;
  const id = url.searchParams.get("id");
  if (!type || !TYPES.includes(type) || !id) return NextResponse.json({ error: "type and id required" }, { status: 400 });
  const scopes = (await loadScopes(c.svc, c.org.id, [{ type, id }])).get(`${type}:${id}`) ?? { common: false, pairs: [] };
  return NextResponse.json({ scopes });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string; items?: unknown; scopes?: unknown };
  const c = await ctx(body.orgSlug ?? null);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!c.admin) return NextResponse.json({ error: "Only admins can map content" }, { status: 403 });
  const items = (Array.isArray(body.items) ? body.items : []) as Array<{ type?: unknown; id?: unknown }>;
  if (items.length === 0 || items.length > 1000) return NextResponse.json({ error: "items: 1–1000 content items" }, { status: 400 });
  const clean: Array<{ type: ContentType; id: string }> = [];
  for (const it of items) {
    if (!TYPES.includes(it.type as ContentType) || typeof it.id !== "string" || !/^[0-9a-f-]{36}$/i.test(it.id)) {
      return NextResponse.json({ error: "Each item needs a type (course | path | journey) and an id" }, { status: 400 });
    }
    clean.push({ type: it.type as ContentType, id: it.id });
  }
  const gov = await loadOrgGovernance(c.svc, c.org.id);
  const check = checkScopes(gov, body.scopes);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  // Every item must belong to this org.
  for (const type of TYPES) {
    const ids = clean.filter((i) => i.type === type).map((i) => i.id);
    if (ids.length === 0) continue;
    const { data } = await c.svc.from(TABLE[type]).select("id").eq("organization_id", c.org.id).in("id", ids);
    const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    if (ids.some((id) => !found.has(id))) return NextResponse.json({ error: `A ${type} in the list does not belong to this organisation` }, { status: 400 });
  }
  const r = await saveScopesBulk(c.svc, c.org.id, clean, check.scopes, c.user.id);
  if (r.error) {
    const msg = /content_scopes/.test(r.error) && /does not exist|schema cache/.test(r.error) ? "Content mapping is not enabled yet (migration 0096)" : r.error;
    return NextResponse.json({ error: msg, saved: 0 }, { status: 400 });
  }
  return NextResponse.json({ ok: true, saved: r.saved, scopes: check.scopes });
}
