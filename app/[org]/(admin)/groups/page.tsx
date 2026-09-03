import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { GroupRow } from "@/lib/org/groups";
import { GroupsClient, type MemberOption } from "./groups-client";

export const dynamic = "force-dynamic";

/**
 * Custom Groups (0067) — the org's reusable audiences, built from the
 * employee database. Static (hand-picked) or dynamic (rules, resolved live).
 */
export default async function GroupsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) redirect(`/${orgSlug}/dashboard?denied=1`);

  const supabase = await createClient();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Groups (RLS: admins). Fail-soft to empty pre-0067.
  let groups: GroupRow[] = [];
  try {
    const { data } = await supabase
      .from("org_groups")
      .select("*")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false });
    groups = (data ?? []) as GroupRow[];
  } catch {
    /* pre-migration */
  }

  // Rule-builder data: governed master values, teams, managers.
  const { data: optRows } = await supabase
    .from("org_field_options")
    .select("field, value")
    .eq("organization_id", org.id)
    .order("value", { ascending: true });
  const ruleOptions: Record<string, string[]> = {};
  for (const r of (optRows ?? []) as Array<{ field: string; value: string }>) {
    (ruleOptions[r.field] ??= []).push(r.value);
  }
  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name", { ascending: true });
  const teams = (teamRows ?? []) as Array<{ id: string; name: string }>;

  // Active members (static-group picker) + manager list + creator names.
  const { data: memRows } = await svc
    .from("organization_members")
    .select("user_id, line_manager_id")
    .eq("organization_id", org.id)
    .eq("status", "active");
  const memberIds = ((memRows ?? []) as Array<{ user_id: string; line_manager_id: string | null }>);
  const managerIds = new Set(
    memberIds.map((m) => m.line_manager_id).filter((x): x is string => !!x)
  );
  const nameIds = new Set<string>(memberIds.map((m) => m.user_id));
  for (const g of groups) if (g.created_by) nameIds.add(g.created_by);
  const names = new Map<string, { name: string; email: string }>();
  const idList = [...nameIds];
  for (let i = 0; i < idList.length; i += 150) {
    const { data } = await svc
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", idList.slice(i, i + 150));
    for (const p of (data ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      names.set(p.id, {
        name:
          [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
          (p.email ?? "").split("@")[0],
        email: p.email ?? "",
      });
    }
  }
  const members: MemberOption[] = memberIds
    .map((m) => ({
      user_id: m.user_id,
      ...(names.get(m.user_id) ?? { name: m.user_id.slice(0, 8), email: "" }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const managers = [...managerIds]
    .filter((id) => names.has(id))
    .map((id) => ({ id, name: names.get(id)!.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const creatorNames: Record<string, string> = {};
  for (const g of groups) {
    if (g.created_by) creatorNames[g.created_by] = names.get(g.created_by)?.name ?? "—";
  }

  return (
    <GroupsClient
      orgSlug={orgSlug}
      groups={groups}
      creatorNames={creatorNames}
      ruleOptions={ruleOptions}
      teams={teams}
      managers={managers}
      members={members}
    />
  );
}
