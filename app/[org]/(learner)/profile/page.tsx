import { Camera, Lock } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { roleLabel } from "@/lib/auth/permissions";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { ProfileForm, type EditablePersonal } from "./profile-form";
import { ChangePasswordButton } from "./change-password-button";

export const dynamic = "force-dynamic";

type ProfileRow = {
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  gender: "male" | "female" | "other" | "prefer_not_to_say" | null;
  date_of_birth: string | null;
  phone: string | null;
};

type MembershipRow = {
  employee_id: string | null;
  role: string;
  status: string | null;
  joined_at: string;
  date_of_joining: string | null;
  grade: string | null;
  designation: string | null;
  job_role: string | null;
  line_manager_id: string | null;
  indirect_manager_id: string | null;
  node_id: string | null;
  city: string | null;
  state: string | null;
};

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { user, org, role } = await requireOrgAccess(orgSlug);

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // profiles PK is `id`, not `user_id` — the column was renamed during
  // development (see migration 0027). Reading by `user_id` silently
  // returns null + an error that the destructure ignores, leaving the
  // form initialized with empty fields.
  const { data: profileRow } = await svc
    .from("profiles")
    .select("first_name, last_name, username, gender, date_of_birth, phone")
    .eq("id", user.id)
    .maybeSingle();
  const profile = (profileRow ?? {
    first_name: null,
    last_name: null,
    username: null,
    gender: null,
    date_of_birth: null,
    phone: null,
  }) as ProfileRow;

  const { data: memRow } = await svc
    .from("organization_members")
    .select(
      "employee_id, role, status, joined_at, date_of_joining, grade, designation, job_role, line_manager_id, indirect_manager_id, node_id, city, state"
    )
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const membership = (memRow ?? {
    employee_id: null,
    role,
    status: "active",
    joined_at: new Date().toISOString(),
    date_of_joining: null,
    grade: null,
    designation: null,
    job_role: null,
    line_manager_id: null,
    indirect_manager_id: null,
    node_id: null,
    city: null,
    state: null,
  }) as MembershipRow;

  // Resolve manager emails for display.
  const managerIds = [
    membership.line_manager_id,
    membership.indirect_manager_id,
  ].filter((id): id is string => !!id);
  const managerEmailById = new Map<string, string>();
  if (managerIds.length > 0) {
    for (const id of managerIds) {
      const { data: m } = await svc.auth.admin.getUserById(id);
      if (m?.user?.email) managerEmailById.set(id, m.user.email);
    }
  }

  const editable: EditablePersonal = {
    first_name: profile.first_name ?? "",
    last_name: profile.last_name ?? "",
    username: profile.username ?? "",
    gender: profile.gender ?? "",
    date_of_birth: profile.date_of_birth ?? "",
    phone: profile.phone ?? "",
  };

  const displayName =
    [profile.first_name, profile.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || (user.email ?? "").split("@")[0];
  const initial = (displayName?.[0] ?? "?").toUpperCase();

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          My Profile
        </h1>
        <p className="text-muted mt-1 text-sm">
          Manage your personal information and view organizational details.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: Avatar card */}
        <div className="md:col-span-1 space-y-5">
          <div className="bg-paper border border-line rounded-2xl p-6 text-center shadow-sm">
            <div className="relative inline-block">
              <div className="h-28 w-28 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white flex items-center justify-center text-4xl font-semibold ring-4 ring-canvas">
                {initial}
              </div>
              <button
                type="button"
                disabled
                title="Avatar uploads coming soon"
                className="absolute bottom-1 right-1 bg-indigo-600 text-white p-2 rounded-full shadow-lg cursor-not-allowed opacity-70"
                aria-label="Change photo"
              >
                <Camera className="w-4 h-4" />
              </button>
            </div>
            <h2 className="mt-4 text-xl font-semibold">{displayName}</h2>
            <p className="text-muted text-sm mt-0.5">
              {membership.designation ?? membership.job_role ?? roleLabel(role as OrgRole)}
            </p>

            <div className="mt-6 border-t border-line pt-5">
              {/* Extracted into a Client Component so RSC doesn't reject
                  the onClick prop. See change-password-button.tsx. */}
              <ChangePasswordButton />
            </div>
          </div>

          <div className="bg-paper border border-line rounded-2xl p-5 text-xs text-muted leading-relaxed">
            <strong className="block text-ink mb-1 text-sm">
              Need to update locked fields?
            </strong>
            Employee ID, manager, team and other org-level fields are managed
            by your administrator. Open a{" "}
            <a
              href={`/${orgSlug}/support`}
              className="text-indigo-600 hover:text-indigo-700 underline-offset-4 hover:underline"
            >
              support ticket
            </a>{" "}
            if anything looks wrong.
          </div>
        </div>

        {/* Right: forms */}
        <div className="md:col-span-2 space-y-6">
          {/* Editable personal details */}
          <ProfileForm
            orgSlug={orgSlug}
            initial={editable}
            email={user.email ?? ""}
          />

          {/* Locked org details */}
          <section className="bg-paper border border-line rounded-2xl overflow-hidden shadow-sm">
            <header className="px-6 py-4 border-b border-line bg-canvas/40 flex items-center justify-between">
              <div>
                <h2 className="font-semibold flex items-center gap-2">
                  <Lock className="w-4 h-4 text-muted" />
                  Organization details
                </h2>
                <p className="text-xs text-muted mt-0.5">
                  Managed by your administrator.
                </p>
              </div>
              <span className="text-[10px] uppercase tracking-wide bg-canvas border border-line px-2 py-1 rounded-full text-muted">
                Read-only
              </span>
            </header>
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <LockedField
                label="Employee ID"
                value={membership.employee_id ?? "—"}
              />
              <LockedField
                label="Status"
                value={
                  membership.status
                    ? membership.status[0].toUpperCase() +
                      membership.status.slice(1)
                    : "—"
                }
              />
              <LockedField
                label="LMS role"
                value={roleLabel(membership.role as OrgRole)}
              />
              <LockedField
                label="Date of joining"
                value={
                  membership.date_of_joining ??
                  new Date(membership.joined_at).toISOString().slice(0, 10)
                }
              />
              <LockedField label="Grade" value={membership.grade ?? "—"} />
              <LockedField
                label="Designation"
                value={membership.designation ?? "—"}
              />
              <LockedField
                label="Job role / title"
                value={membership.job_role ?? "—"}
              />
              <LockedField
                label="Node ID"
                value={membership.node_id ?? "—"}
              />
              <LockedField
                label="Line manager"
                value={
                  membership.line_manager_id
                    ? managerEmailById.get(membership.line_manager_id) ?? "—"
                    : "—"
                }
              />
              <LockedField
                label="Indirect manager"
                value={
                  membership.indirect_manager_id
                    ? managerEmailById.get(membership.indirect_manager_id) ??
                      "—"
                    : "—"
                }
              />
              <LockedField label="City" value={membership.city ?? "—"} />
              <LockedField
                label="State / Territory"
                value={membership.state ?? "—"}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function LockedField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted block mb-1.5">
        {label}
      </label>
      <div className="border border-line rounded-lg bg-canvas/50 px-3 py-2.5 text-sm select-none cursor-not-allowed">
        {value}
      </div>
    </div>
  );
}
