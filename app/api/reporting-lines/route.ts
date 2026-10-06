import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  fetchHierarchyMembers,
  messagesOf,
  suggestBackfill,
  validateManagerAssignment,
  LEVEL_FIELDS,
  type ManagerAssignment,
} from "@/lib/org/reporting-line";
import { loadReportingLines } from "@/lib/org/reporting-lines-data";

/**
 *   GET   /api/reporting-lines?orgSlug=…                       → { members, issues, suggestions }
 *   PATCH /api/reporting-lines { orgSlug, user_id, line_manager_id?, indirect_manager_id?, l3_manager_id? }
 *   POST  /api/reporting-lines { orgSlug, apply: [{ user_id, level, manager_id }] }   (backfill)
 *
 * Master Data → Reporting lines (migration 0091). Super Owner only, like the
 * rest of Master Data. Reads/writes go through the service role AFTER the
 * caller's role is checked with their own session (RLS on
 * organization_members is own-row/admin only).
 *
 * Every write runs the same integrity rules as the user forms, bulk CSV and
 * CRM sync (lib/org/reporting-line.ts): self-reference, inactive/non-member
 * managers and L1 cycles are refused; a chain mismatch is returned as a
 * warning. A backfill only applies pairs that are STILL suggested by the
 * current data — a stale or hand-crafted apply list is skipped, not written.
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
  if (!mem) return { error: "Forbidden", status: 403 as const };
  const role = mem.role as string;
  if (role !== "super_owner" && role !== "owner") {
    return { error: "Only the Super Owner can maintain reporting lines", status: 403 as const };
  }
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  return { svc, orgId: org.id as string };
}

export async function GET(request: Request) {
  const ctx = await resolveOrg(new URL(request.url).searchParams.get("orgSlug"));
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  return NextResponse.json(await loadReportingLines(ctx.svc, ctx.orgId));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOrNull = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return typeof v === "string" && UUID_RE.test(v) ? v : undefined;
};

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    user_id?: string;
    line_manager_id?: string | null;
    indirect_manager_id?: string | null;
    l3_manager_id?: string | null;
  };
  const ctx = await resolveOrg(body.orgSlug ?? null);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const userId = body.user_id;
  if (!userId || !UUID_RE.test(userId)) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  const patch: ManagerAssignment = {};
  for (const col of Object.values(LEVEL_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
    const v = idOrNull(body[col]);
    if (v === undefined) return NextResponse.json({ error: `Invalid ${col}` }, { status: 400 });
    patch[col] = v;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const hierarchy = await fetchHierarchyMembers(ctx.svc, ctx.orgId);
  if (!hierarchy.some((m) => m.user_id === userId)) {
    return NextResponse.json({ error: "User is not a member of this organization" }, { status: 404 });
  }
  const check = validateManagerAssignment(hierarchy, userId, patch);
  if (check.errors.length > 0) {
    return NextResponse.json({ error: messagesOf(check.errors).join(" ") }, { status: 400 });
  }
  const { error } = await ctx.svc
    .from("organization_members")
    .update(patch)
    .eq("organization_id", ctx.orgId)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, warnings: messagesOf(check.warnings) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    apply?: Array<{ user_id?: string; level?: number; manager_id?: string }>;
  };
  const ctx = await resolveOrg(body.orgSlug ?? null);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const apply = Array.isArray(body.apply) ? body.apply : [];
  if (apply.length === 0) return NextResponse.json({ error: "apply[] required" }, { status: 400 });
  if (apply.length > 5000) return NextResponse.json({ error: "Too many rows (max 5000)" }, { status: 400 });

  // Only pairs the CURRENT data still suggests are written.
  const hierarchy = await fetchHierarchyMembers(ctx.svc, ctx.orgId);
  const current = new Map(
    suggestBackfill(hierarchy).map((s) => [`${s.user_id}:${s.level}`, s.suggested])
  );
  const perUser = new Map<string, ManagerAssignment>();
  let skipped = 0;
  for (const a of apply) {
    const level = a.level === 2 || a.level === 3 ? a.level : null;
    if (!a.user_id || !level || !a.manager_id || current.get(`${a.user_id}:${level}`) !== a.manager_id) {
      skipped++;
      continue;
    }
    const cur = perUser.get(a.user_id) ?? {};
    cur[LEVEL_FIELDS[level]] = a.manager_id;
    perUser.set(a.user_id, cur);
  }

  // One UPDATE per distinct patch (most people under the same L1 share the
  // same L2/L3), chunked — never one round-trip per user: on Workers each
  // Supabase call is a subrequest with a hard per-request budget.
  const groups = new Map<string, { patch: ManagerAssignment; ids: string[] }>();
  for (const [userId, patch] of perUser) {
    const key = JSON.stringify([patch.indirect_manager_id ?? "", patch.l3_manager_id ?? ""]);
    const g = groups.get(key) ?? { patch, ids: [] };
    g.ids.push(userId);
    groups.set(key, g);
  }
  let applied = 0;
  const failed: string[] = [];
  try {
    for (const g of groups.values()) {
      const fields = Object.keys(g.patch).length;
      for (let i = 0; i < g.ids.length; i += 500) {
        const chunk = g.ids.slice(i, i + 500);
        const { error } = await ctx.svc
          .from("organization_members")
          .update(g.patch)
          .eq("organization_id", ctx.orgId)
          .in("user_id", chunk);
        if (error) failed.push(`${chunk.length} member(s): ${error.message}`);
        else applied += chunk.length * fields;
      }
    }
  } catch (e) {
    // Budget/transport failure mid-way: report what was written so far.
    failed.push(e instanceof Error ? e.message : "write failed");
  }
  return NextResponse.json({ ok: failed.length === 0, applied, skipped, failed });
}
