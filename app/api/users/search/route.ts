import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";

/**
 *   GET /api/users/search?orgSlug=...&q=...&limit=50
 *
 * Server-side search across an org's members for the assign-flow
 * MemberCombobox (and any future picker that needs to scale past
 * the ~5k client-side limit).
 *
 * Returns up to `limit` (capped at 100) matching members, ranked:
 *   1. exact match in any field (rank 0)
 *   2. starts-with                (rank 1)
 *   3. contains                   (rank 2)
 *
 * Searchable fields: email, employee_id, first_name, last_name,
 * concatenated "first last".
 *
 * Admin-only (canManage), tenant-scoped. RLS on organization_members
 * also enforces tenant scope as a defense-in-depth.
 *
 * Why not Supabase full-text search:
 *   The membership table has at most a few thousand rows per org —
 *   in-memory scoring is sub-10ms on the Worker and keeps the SQL
 *   side untouched. If we ever go past 50k members in one org, swap
 *   to a tsvector index on a generated "search_text" column.
 *
 * History: introduced for ticket #149.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("orgSlug");
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT)
  );

  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();

  // ---- fetch member rows (full set; ranked + sliced in memory) ----
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id, role, employee_id")
    .eq("organization_id", org.id);
  type MemberRow = {
    user_id: string;
    role: string;
    employee_id: string | null;
  };
  const members = (memberRows ?? []) as MemberRow[];

  if (members.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // ---- fetch profile names ----
  const userIds = members.map((m) => m.user_id);
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: profileRows } = await svc
    .from("profiles")
    .select("id, first_name, last_name")
    .in("id", userIds);
  const profileById = new Map<
    string,
    { first_name: string | null; last_name: string | null }
  >();
  for (const p of (profileRows ?? []) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
  }>) {
    profileById.set(p.id, {
      first_name: p.first_name,
      last_name: p.last_name,
    });
  }

  // ---- fetch emails (auth.users) ----
  // listUsers paginates at 1000; cap at 50 pages = 50k members (well
  // beyond any single-org realistic ceiling).
  const emailByUser = new Map<string, string>();
  let pageNum = 1;
  while (true) {
    const { data: authPage } = await svc.auth.admin.listUsers({
      page: pageNum,
      perPage: 1000,
    });
    const users = authPage?.users ?? [];
    for (const u of users) {
      if (u.email) emailByUser.set(u.id, u.email);
    }
    if (users.length < 1000) break;
    pageNum += 1;
    if (pageNum > 50) break;
  }

  // ---- rank + slice ----
  type Enriched = {
    user_id: string;
    email: string;
    role: string;
    employee_id: string | null;
    first_name: string | null;
    last_name: string | null;
  };
  const enriched: Enriched[] = members.map((m) => ({
    user_id: m.user_id,
    email: emailByUser.get(m.user_id) ?? "",
    role: m.role,
    employee_id: m.employee_id,
    first_name: profileById.get(m.user_id)?.first_name ?? null,
    last_name: profileById.get(m.user_id)?.last_name ?? null,
  }));

  if (!q) {
    // Empty query: return first `limit`, alpha by email. Useful for
    // the initial open of the popover.
    const initial = enriched
      .slice()
      .sort((a, b) => a.email.localeCompare(b.email))
      .slice(0, limit);
    return NextResponse.json({ results: initial });
  }

  const qLower = q.toLowerCase();
  const rank = (m: Enriched): number => {
    const fields = [
      m.email,
      m.employee_id ?? "",
      m.first_name ?? "",
      m.last_name ?? "",
      `${m.first_name ?? ""} ${m.last_name ?? ""}`.trim(),
    ]
      .map((s) => s.toLowerCase())
      .filter(Boolean);
    if (fields.some((s) => s === qLower)) return 0;
    if (fields.some((s) => s.startsWith(qLower))) return 1;
    if (fields.some((s) => s.includes(qLower))) return 2;
    return Infinity;
  };

  const results = enriched
    .map((m) => ({ m, r: rank(m) }))
    .filter((x) => x.r !== Infinity)
    .sort((a, b) => a.r - b.r || a.m.email.localeCompare(b.m.email))
    .slice(0, limit)
    .map((x) => x.m);

  return NextResponse.json({ results });
}
