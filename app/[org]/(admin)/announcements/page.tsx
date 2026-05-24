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
  const { data: rows } = await supabase
    .from("org_announcements")
    .select("id, title, body, tone, is_active, created_at, expires_at")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: false });

  const announcements = (rows ?? []) as Announcement[];

  return <AnnouncementsClient orgSlug={orgSlug} announcements={announcements} />;
}
