import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { LearnersClient } from "./learners-client";

type Member = {
  user_id: string;
  role: OrgRole;
  joined_at: string;
  email: string;
  // New fields for the filter strip (v0): status from organization_members,
  // teamIds via team_members join. Other 9 filter dimensions deferred to #163.
  status: "active" | "inactive" | "suspended";
  teamIds: string[];
};

type TeamOption = { id: string; name: string };

type Invitation = {
  id: string;
  email: string;
  role: OrgRole;
  token: string;
  invited_at: string;
  expires_at: string;
};

function normalizeRole(raw: string): OrgRole {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw as OrgRole;
}

export default async function LearnersPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role, user } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard`);
  }

  const supabase = await createClient();

  // Memberships in this org. Now includes `status` so the filter strip
  // can group by active / inactive / suspended.
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id, role, joined_at, status")
    .eq("organization_id", org.id);

  // Teams + team membership for the team filter.
  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name");
  const teams: TeamOption[] = (teamRows ?? []) as TeamOption[];

  const teamIdsByUser = new Map<string, string[]>();
  if (teams.length > 0) {
    const { data: tmRows } = await supabase
      .from("team_members")
      .select("team_id, user_id")
      .in(
        "team_id",
        teams.map((t) => t.id)
      );
    for (const r of (tmRows ?? []) as Array<{
      team_id: string;
      user_id: string;
    }>) {
      const list = teamIdsByUser.get(r.user_id) ?? [];
      list.push(r.team_id);
      teamIdsByUser.set(r.user_id, list);
    }
  }

  // Pending invitations.
  const { data: inviteRows } = await supabase
    .from("invitations")
    .select("id, email, role, token, invited_at, expires_at")
    .eq("organization_id", org.id)
    .is("accepted_at", null)
    .order("invited_at", { ascending: false });

  // Resolve emails via service-role (auth.users not exposed normally).
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const memberIds = (memberRows ?? []).map((m) => m.user_id);
  const emailByUser = new Map<string, string>();
  if (memberIds.length > 0) {
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of data?.users ?? []) {
      if (u.email && memberIds.includes(u.id)) emailByUser.set(u.id, u.email);
    }
  }

  const members: Member[] = (memberRows ?? []).map((m) => {
    const s = m.status as string | undefined;
    const status: Member["status"] =
      s === "inactive" || s === "suspended" ? s : "active";
    return {
      user_id: m.user_id,
      role: normalizeRole(m.role as string),
      joined_at: m.joined_at,
      email: emailByUser.get(m.user_id) ?? m.user_id.slice(0, 8),
      status,
      teamIds: teamIdsByUser.get(m.user_id) ?? [],
    };
  });

  // Sort: super_owner first, admin, data_analyst, user; alpha by email within tier.
  const tier: Record<OrgRole, number> = {
    super_owner: 0,
    admin: 1,
    data_analyst: 2,
    user: 3,
  };
  members.sort(
    (a, b) => tier[a.role] - tier[b.role] || a.email.localeCompare(b.email)
  );

  const invitations: Invitation[] = (inviteRows ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    role: normalizeRole(r.role as string),
    token: r.token,
    invited_at: r.invited_at,
    expires_at: r.expires_at,
  }));

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    "http://localhost:3000";

  return (
    <LearnersClient
      orgSlug={orgSlug}
      orgName={org.name}
      currentUserId={user.id}
      currentUserRole={role}
      members={members}
      teams={teams}
      invitations={invitations}
      shareBase={`${origin}/invitations`}
    />
  );
}
