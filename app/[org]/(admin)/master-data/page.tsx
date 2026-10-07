import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { loadFieldOptionRows } from "@/lib/org/field-options";
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
    loadFieldOptionRows(supabase, org.id).then((rows) => ({ data: rows })),
    supabase
      .from("organizations")
      .select("require_manager_fields")
      .eq("id", org.id)
      .maybeSingle(),
  ]);
  // 0097: the enforce switch (fail-soft before the migration).
  const enforceRes = await supabase.from("organizations").select("enforce_content_mapping").eq("id", org.id).maybeSingle();
  const enforceContentMapping: boolean | null = enforceRes.error ? null : (enforceRes.data as { enforce_content_mapping?: boolean } | null)?.enforce_content_mapping === true;

  // 0096: how much active content is still unmapped (null before the migration).
  let unmappedContent: number | null = null;
  {
    const [{ data: cs }, { data: ps }, { data: js }, mapped] = await Promise.all([
      supabase.from("courses").select("id").eq("organization_id", org.id).eq("is_active", true),
      supabase.from("learning_paths").select("id").eq("organization_id", org.id).eq("is_active", true),
      supabase.from("journey_programs").select("id").eq("organization_id", org.id).eq("is_active", true),
      supabase.from("content_scopes").select("content_type, content_id").eq("organization_id", org.id),
    ]);
    if (!mapped.error) {
      const done = new Set(((mapped.data ?? []) as Array<{ content_type: string; content_id: string }>).map((r) => `${r.content_type}:${r.content_id}`));
      const all = [
        ...((cs ?? []) as Array<{ id: string }>).map((r) => `course:${r.id}`),
        ...((ps ?? []) as Array<{ id: string }>).map((r) => `path:${r.id}`),
        ...((js ?? []) as Array<{ id: string }>).map((r) => `journey:${r.id}`),
      ];
      unmappedContent = all.filter((k) => !done.has(k)).length;
    }
  }

  return (
    <MasterDataClient
      orgSlug={orgSlug}
      unmappedContent={unmappedContent}
      initialEnforce={enforceContentMapping}
      initialOptions={(optRows ?? []) as OptionRow[]}
      initialRequireManagers={
        (orgRow as { require_manager_fields?: boolean } | null)
          ?.require_manager_fields === true
      }
    />
  );
}
