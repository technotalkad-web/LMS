import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NewUserForm, type ManagerOption } from "./new-user-form";

export const dynamic = "force-dynamic";

export default async function NewUserPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  // Fetch existing org members so admin can pick a line manager.
  const supabase = await createClient();
  const { data: memberRows } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id);
  const memberIds = (memberRows ?? []).map((m) => m.user_id);

  const emailByUser = new Map<string, string>();
  if (memberIds.length > 0) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of data?.users ?? []) {
      if (u.email && memberIds.includes(u.id)) emailByUser.set(u.id, u.email);
    }
  }
  const managers: ManagerOption[] = memberIds.map((id) => ({
    user_id: id,
    email: emailByUser.get(id) ?? id.slice(0, 8),
  }));
  managers.sort((a, b) => a.email.localeCompare(b.email));

  // super_owner gate (only super_owners can assign super_owner role)
  const canAssignSuperOwner = role === "super_owner";

  return (
    <div className="max-w-3xl">
      <Link
        href={`/${orgSlug}/users`}
        className="text-muted text-sm hover:text-ink transition-colors"
      >
        ← Users
      </Link>
      <h1 className="serif text-5xl mt-2 mb-2">Create user</h1>
      <p className="text-muted mb-8 text-sm">
        Fields marked with <span className="text-red-700">*</span> are required.
        Leave password blank to send the user a setup link via email.
      </p>

      <NewUserForm
        orgSlug={orgSlug}
        managers={managers}
        canAssignSuperOwner={canAssignSuperOwner}
      />
    </div>
  );
}
