import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { TeamsClient } from "./teams-client";

export const dynamic = "force-dynamic";

type Team = { id: string; name: string; slug: string; created_at: string };
type TeamMember = { team_id: string; user_id: string; email: string };
type OrgMember = { user_id: string; email: string; role: string };

export default async function TeamsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard`);
  }

  const supabase = await createClient();

  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name, slug, created_at")
    .eq("organization_id", org.id)
    .order("name");
  const teams = (teamRows ?? []) as Team[];

  const { data: memberRows } = await supabase
    .from("team_members")
    .select("team_id, user_id")
    .in("team_id", teams.map((t) => t.id));
  const teamMemberLinks = (memberRows ?? []) as Array<{
    team_id: string;
    user_id: string;
  }>;

  // Look up org members + their emails.
  const { data: orgMemberRows } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", org.id);

  const allUserIds = Array.from(
    new Set([
      ...teamMemberLinks.map((m) => m.user_id),
      ...(orgMemberRows ?? []).map((m) => m.user_id),
    ])
  );

  const emailByUser = new Map<string, string>();
  if (allUserIds.length > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of data?.users ?? []) {
      if (u.email && allUserIds.includes(u.id)) emailByUser.set(u.id, u.email);
    }
  }

  const teamMembers: TeamMember[] = teamMemberLinks.map((m) => ({
    team_id: m.team_id,
    user_id: m.user_id,
    email: emailByUser.get(m.user_id) ?? m.user_id.slice(0, 8),
  }));

  const orgMembers: OrgMember[] = (orgMemberRows ?? []).map((m) => ({
    user_id: m.user_id,
    email: emailByUser.get(m.user_id) ?? m.user_id.slice(0, 8),
    role: m.role,
  }));

  return (
    <TeamsClient
      orgSlug={orgSlug}
      orgName={org.name}
      teams={teams}
      teamMembers={teamMembers}
      orgMembers={orgMembers}
    />
  );
}
