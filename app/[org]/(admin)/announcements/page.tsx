import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { AnnouncementsClient, type Announcement } from "./announcements-client";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();
  // select("*") so the 0068 popup columns ride along when present and the
  // page still works on a pre-migration database.
  const { data: rows } = await supabase
    .from("org_announcements")
    .select("*")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: false });

  const announcements = (rows ?? []) as Announcement[];

  // Custom Groups (0067) as popup audiences — fail-soft to empty.
  let groups: Array<{ id: string; name: string }> = [];
  try {
    const { data } = await supabase
      .from("org_groups")
      .select("id, name")
      .eq("organization_id", org.id)
      .eq("is_active", true)
      .order("name", { ascending: true });
    groups = (data ?? []) as Array<{ id: string; name: string }>;
  } catch {
    /* pre-0067 */
  }

  return (
    <AnnouncementsClient orgSlug={orgSlug} announcements={announcements} groups={groups} />
  );
}
