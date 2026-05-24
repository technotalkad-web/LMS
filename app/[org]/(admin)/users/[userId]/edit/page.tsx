import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { EditUserForm, type ManagerOption, type UserDetail } from "./edit-user-form";

export const dynamic = "force-dynamic";

export default async function EditUserPage({
  params,
}: {
  params: Promise<{ org: string; userId: string }>;
}) {
  const { org: orgSlug, userId } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Fetch profile + membership for the target user.
  // profiles PK is `id` (see migration 0027) — earlier code used `user_id`
  // and silently returned null, so admins saw an empty form when editing
  // a user whose profile row was actually populated.
  // organization_members still uses `user_id` — only `profiles` was renamed.
  const { data: profileRow } = await svc
    .from("profiles")
    .select(
      "id, first_name, last_name, username, gender, date_of_birth, phone"
    )
    .eq("id", userId)
    .maybeSingle();

  const { data: memRow } = await svc
    .from("organization_members")
    .select(
      "user_id, role, employee_id, status, date_of_joining, grade, designation, job_role, line_manager_id, indirect_manager_id, node_id, city, state"
    )
    .eq("organization_id", org.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!memRow) {
    redirect(`/${orgSlug}/users`);
  }

  // Look up target's email.
  const { data: targetAuth } = await svc.auth.admin.getUserById(userId);
  const email = targetAuth?.user?.email ?? "";

  const detail: UserDetail = {
    user_id: userId,
    email,
    first_name: profileRow?.first_name ?? "",
    last_name: profileRow?.last_name ?? "",
    username: profileRow?.username ?? "",
    gender: (profileRow?.gender as UserDetail["gender"]) ?? "",
    date_of_birth: profileRow?.date_of_birth ?? "",
    phone: profileRow?.phone ?? "",
    employee_id: memRow.employee_id ?? "",
    status: (memRow.status as UserDetail["status"]) ?? "active",
    date_of_joining: memRow.date_of_joining ?? "",
    grade: memRow.grade ?? "",
    designation: memRow.designation ?? "",
    job_role: memRow.job_role ?? "",
    line_manager_id: memRow.line_manager_id ?? "",
    indirect_manager_id: memRow.indirect_manager_id ?? "",
    lms_role: memRow.role as UserDetail["lms_role"],
    node_id: memRow.node_id ?? "",
    city: memRow.city ?? "",
    state: memRow.state ?? "",
  };

  // Manager picker options (excluding self).
  const { data: peerRows } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id);
  const peerIds = (peerRows ?? [])
    .map((m) => m.user_id)
    .filter((id) => id !== userId);

  const emailByUser = new Map<string, string>();
  if (peerIds.length > 0) {
    const { data: listed } = await svc.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    for (const u of listed?.users ?? []) {
      if (u.email && peerIds.includes(u.id)) emailByUser.set(u.id, u.email);
    }
  }
  const managers: ManagerOption[] = peerIds.map((id) => ({
    user_id: id,
    email: emailByUser.get(id) ?? id.slice(0, 8),
  }));
  managers.sort((a, b) => a.email.localeCompare(b.email));

  const canAssignSuperOwner = role === "super_owner";

  return (
    <div className="max-w-3xl">
      <Link
        href={`/${orgSlug}/users`}
        className="text-muted text-sm hover:text-ink transition-colors"
      >
        ← Users
      </Link>
      <h1 className="serif text-5xl mt-2 mb-2">Edit user</h1>
      <p className="text-muted mb-8 text-sm">
        {email && (
          <>
            Editing <span className="text-ink font-medium">{email}</span>.{" "}
          </>
        )}
        Email + password are managed separately and can't be changed here.
      </p>

      <EditUserForm
        orgSlug={orgSlug}
        userId={userId}
        initial={detail}
        managers={managers}
        canAssignSuperOwner={canAssignSuperOwner}
      />
    </div>
  );
}
