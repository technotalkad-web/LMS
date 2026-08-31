import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { MasterDataClient, type OptionRow } from "./master-data-client";

export const dynamic = "force-dynamic";

/**
 * Master data — Super-Owner-only control of the governed Organization-details
 * value lists (Designation, Node ID, Job Role/Title, City, State/Territory)
 * plus the mandatory-manager toggle. Admins creating users (manually or via
 * bulk upload) can only pick from these values once a list is populated.
 */
export default async function MasterDataPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (role !== "super_owner") redirect(`/${orgSlug}/users?denied=1`);

  const supabase = await createClient();
  const [{ data: optRows }, { data: orgRow }] = await Promise.all([
    supabase
      .from("org_field_options")
      .select("id, field, value")
      .eq("organization_id", org.id)
      .order("value", { ascending: true }),
    supabase
      .from("organizations")
      .select("require_manager_fields")
      .eq("id", org.id)
      .maybeSingle(),
  ]);

  return (
    <MasterDataClient
      orgSlug={orgSlug}
      initialOptions={(optRows ?? []) as OptionRow[]}
      initialRequireManagers={
        (orgRow as { require_manager_fields?: boolean } | null)
          ?.require_manager_fields === true
      }
    />
  );
}
