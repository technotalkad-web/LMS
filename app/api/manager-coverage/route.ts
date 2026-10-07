import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { loadOrgGovernance } from "@/lib/org/field-options";
import { checkScopeTarget } from "@/lib/org/scope-groups";
import { listManagers, loadCoverageRows } from "@/lib/manager/coverage";
import { namesAndEmails } from "@/lib/users/people";

/**
 *   GET    /api/manager-coverage?orgSlug=   → { managers: [{ user_id, name, vertical, department, coverage: [{ id, vertical, department }] }], enforce }
 *   POST   /api/manager-coverage { orgSlug, user_id, vertical, department? }   (admin) — grant a pair
 *   DELETE /api/manager-coverage { orgSlug, id }                               (admin) — revoke a pair
 *
 * Manager coverage (0097, decision 14): extra Vertical + Department pairs for
 * a manager whose hierarchy spans verticals. Their own pair comes from the
 * employee record. Pairs are validated against master data.
 */
async function ctx(orgSlug: string | null) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase.from("organizations").select("id, slug").eq("slug", orgSlug).maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase.from("organization_members").select("role, status").eq("organization_id", org.id).eq("user_id", user.id).maybeSingle();
  const m = mem as { role: string; status: string } | null;
  if (!m || m.status !== "active" || !["super_owner", "owner", "admin"].includes(m.role)) return { error: "Forbidden", status: 403 as const };
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  return { svc, org: org as { id: string; slug: string }, user };
}

export async function GET(request: Request) {
  const c = await ctx(new URL(request.url).searchParams.get("orgSlug"));
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const managers = await listManagers(c.svc, c.org.id);
  const ids = managers.map((m) => m.user_id);
  const [people, coverage, { data: org }] = await Promise.all([
    namesAndEmails(c.svc, ids),
    loadCoverageRows(c.svc, c.org.id, ids),
    c.svc.from("organizations").select("enforce_content_mapping").eq("id", c.org.id).maybeSingle(),
  ]);
  return NextResponse.json({
    enforce: (org as { enforce_content_mapping?: boolean } | null)?.enforce_content_mapping === true,
    managers: managers
      .map((m) => ({ user_id: m.user_id, name: people.get(m.user_id)?.name ?? m.user_id.slice(0, 8), vertical: m.vertical, department: m.department, coverage: coverage.get(m.user_id) ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string; user_id?: string; vertical?: string; department?: string | null };
  const c = await ctx(body.orgSlug ?? null);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!body.user_id || !/^[0-9a-f-]{36}$/i.test(body.user_id)) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  const { data: mem } = await c.svc.from("organization_members").select("user_id, status").eq("organization_id", c.org.id).eq("user_id", body.user_id).maybeSingle();
  if (!mem || (mem as { status: string }).status !== "active") return NextResponse.json({ error: "That person is not an active member" }, { status: 400 });
  const gov = await loadOrgGovernance(c.svc, c.org.id);
  const t = checkScopeTarget(gov, { vertical: body.vertical, department: body.department ?? "" });
  if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 });
  const { data, error } = await c.svc
    .from("manager_coverage")
    .insert({ organization_id: c.org.id, user_id: body.user_id, vertical: t.pair.vertical, department: t.pair.department, created_by: c.user.id })
    .select("id, vertical, department")
    .single();
  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "That coverage already exists" }, { status: 400 });
    if (/manager_coverage/.test(error.message) && /does not exist|schema cache/.test(error.message)) return NextResponse.json({ error: "Manager coverage needs migration 0097" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, coverage: data });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string; id?: string };
  const c = await ctx(body.orgSlug ?? null);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await c.svc.from("manager_coverage").delete().eq("organization_id", c.org.id).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
