import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  fetchActiveMembers,
  parseGroupRules,
  resolveGroupMembers,
  rulesAreEmpty,
  type GroupRow,
} from "@/lib/org/groups";

/**
 *   POST   /api/org/groups { orgSlug, name, description?, group_type, rules? }
 *   POST   { orgSlug, action: "preview", rules }            → live match count + sample
 *   POST   { orgSlug, action: "members", group_id }         → resolved member list
 *   POST   { orgSlug, action: "add_members"|"remove_members", group_id, user_ids }
 *   POST   { orgSlug, action: "refresh_count", group_id }
 *   PATCH  { orgSlug, group_id, name?, description?, rules?, is_active?, group_type? }
 *   DELETE { orgSlug, group_id }
 *
 * Admin-only (role check + RLS on org_groups). Dynamic membership is always
 * resolved LIVE via lib/org/groups; member_count on the row is a display
 * cache refreshed by these endpoints.
 */

async function ctx(orgSlug: string | undefined) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
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
    return { error: "Forbidden", status: 403 as const };
  }
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  return { supabase, svc, org, userId: user.id };
}

async function namesFor(
  svc: SupabaseClient,
  ids: string[]
): Promise<Array<{ user_id: string; name: string; email: string }>> {
  const out: Array<{ user_id: string; name: string; email: string }> = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await svc
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", ids.slice(i, i + 150));
    for (const p of (data ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      out.push({
        user_id: p.id,
        name:
          [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
          (p.email ?? "").split("@")[0],
        email: p.email ?? "",
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadGroup(
  c: { supabase: SupabaseClient; org: { id: string } },
  groupId: string | undefined
) {
  if (!groupId) return null;
  const { data } = await c.supabase
    .from("org_groups")
    .select("*")
    .eq("id", groupId)
    .eq("organization_id", c.org.id)
    .maybeSingle();
  return (data ?? null) as GroupRow | null;
}

async function refreshCount(
  c: { supabase: SupabaseClient; svc: SupabaseClient },
  group: GroupRow
): Promise<number> {
  const ids = await resolveGroupMembers(c.svc, group);
  await c.supabase
    .from("org_groups")
    .update({ member_count: ids.length, member_count_at: new Date().toISOString() })
    .eq("id", group.id);
  return ids.length;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    action?: string;
    group_id?: string;
    name?: string;
    description?: string;
    group_type?: string;
    rules?: unknown;
    user_ids?: string[];
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });

  // ---- Live preview of a rule set (before saving anything) ----
  if (body.action === "preview") {
    const rules = parseGroupRules(body.rules);
    const ids = await resolveGroupMembers(
      c.svc,
      { id: "preview", organization_id: c.org.id, group_type: "dynamic", rules },
      await fetchActiveMembers(c.svc, c.org.id)
    );
    const sample = await namesFor(c.svc, ids.slice(0, 8));
    return NextResponse.json({ ok: true, count: ids.length, sample });
  }

  // ---- Resolved member list (View members) ----
  if (body.action === "members") {
    const group = await loadGroup(c, body.group_id);
    if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    const ids = await resolveGroupMembers(c.svc, group);
    const members = await namesFor(c.svc, ids);
    // Piggyback a count refresh — viewing IS the freshest resolution.
    await c.supabase
      .from("org_groups")
      .update({ member_count: ids.length, member_count_at: new Date().toISOString() })
      .eq("id", group.id);
    return NextResponse.json({ ok: true, count: ids.length, members });
  }

  if (body.action === "refresh_count") {
    const group = await loadGroup(c, body.group_id);
    if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    const count = await refreshCount(c, group);
    return NextResponse.json({ ok: true, count });
  }

  // ---- Static membership management ----
  if (body.action === "add_members" || body.action === "remove_members") {
    const group = await loadGroup(c, body.group_id);
    if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    if (group.group_type !== "static") {
      return NextResponse.json(
        { error: "Dynamic groups compute membership from rules — edit the rules instead" },
        { status: 400 }
      );
    }
    const ids = Array.from(
      new Set((body.user_ids ?? []).filter((x): x is string => typeof x === "string"))
    ).slice(0, 500);
    if (ids.length === 0) {
      return NextResponse.json({ error: "user_ids required" }, { status: 400 });
    }
    if (body.action === "add_members") {
      // Only ACTIVE org members may be added.
      const { data: valid } = await c.svc
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", c.org.id)
        .eq("status", "active")
        .in("user_id", ids);
      const validIds = ((valid ?? []) as Array<{ user_id: string }>).map((v) => v.user_id);
      if (validIds.length > 0) {
        const { error } = await c.supabase.from("org_group_members").upsert(
          validIds.map((uid) => ({
            group_id: group.id,
            organization_id: c.org.id,
            user_id: uid,
            added_by: c.userId,
          })),
          { onConflict: "group_id,user_id" }
        );
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      }
      const count = await refreshCount(c, group);
      return NextResponse.json({ ok: true, added: validIds.length, count });
    }
    const { error } = await c.supabase
      .from("org_group_members")
      .delete()
      .eq("group_id", group.id)
      .in("user_id", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    const count = await refreshCount(c, group);
    return NextResponse.json({ ok: true, removed: ids.length, count });
  }

  // ---- Create ----
  const name = (body.name ?? "").trim();
  if (!name || name.length > 80) {
    return NextResponse.json({ error: "Name required (max 80)" }, { status: 400 });
  }
  const groupType = body.group_type === "static" ? "static" : "dynamic";
  const rules = parseGroupRules(body.rules);
  const { data: created, error } = await c.supabase
    .from("org_groups")
    .insert({
      organization_id: c.org.id,
      name,
      description: (body.description ?? "").trim().slice(0, 300) || null,
      group_type: groupType,
      rules: groupType === "dynamic" && !rulesAreEmpty(rules) ? rules : null,
      created_by: c.userId,
    })
    .select("*")
    .single();
  if (error) {
    return NextResponse.json(
      {
        error: /duplicate|unique/i.test(error.message)
          ? "A group with that name already exists"
          : error.message,
      },
      { status: 400 }
    );
  }
  const count = await refreshCount(c, created as GroupRow);
  return NextResponse.json({ ok: true, group_id: (created as GroupRow).id, count });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    group_id?: string;
    name?: string;
    description?: string;
    rules?: unknown;
    is_active?: boolean;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const group = await loadGroup(c, body.group_id);
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n || n.length > 80) {
      return NextResponse.json({ error: "Name required (max 80)" }, { status: 400 });
    }
    update.name = n;
  }
  if (body.description !== undefined) {
    update.description = body.description.trim().slice(0, 300) || null;
  }
  if (body.rules !== undefined) {
    if (group.group_type !== "dynamic") {
      return NextResponse.json(
        { error: "Static groups have hand-picked members, not rules" },
        { status: 400 }
      );
    }
    const rules = parseGroupRules(body.rules);
    update.rules = rulesAreEmpty(rules) ? null : rules;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return NextResponse.json({ error: "is_active must be boolean" }, { status: 400 });
    }
    update.is_active = body.is_active;
  }
  const { error } = await c.supabase
    .from("org_groups")
    .update(update)
    .eq("id", group.id)
    .eq("organization_id", c.org.id);
  if (error) {
    return NextResponse.json(
      {
        error: /duplicate|unique/i.test(error.message)
          ? "A group with that name already exists"
          : error.message,
      },
      { status: 400 }
    );
  }
  const count = await refreshCount(c, { ...group, ...update } as GroupRow);
  return NextResponse.json({ ok: true, count });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    group_id?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const group = await loadGroup(c, body.group_id);
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
  const { error } = await c.supabase
    .from("org_groups")
    .delete()
    .eq("id", group.id)
    .eq("organization_id", c.org.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
