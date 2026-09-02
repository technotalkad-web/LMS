import { Lock } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { roleLabel } from "@/lib/auth/permissions";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { ProfileForm, type EditablePersonal } from "./profile-form";
import { ChangePasswordButton } from "./change-password-button";
import { AvatarUploader } from "./avatar-uploader";
import { LeaderboardPrivacyToggle } from "./leaderboard-privacy-toggle";

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
    .select("first_name, last_name, username, gender, date_of_birth, phone, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  const avatarUrl =
    ((profileRow as { avatar_url?: string | null } | null)?.avatar_url as
      | string
      | null) ?? null;

  // Gamification: avatar-upload kill switch + current leaderboard visibility.
  const { data: gsRow } = await svc
    .from("gamification_settings")
    .select("enabled, leaderboard_enabled, allow_opt_out, allow_avatar_uploads")
    .eq("organization_id", org.id)
    .maybeSingle();
  const gs = gsRow as {
    enabled?: boolean;
    leaderboard_enabled?: boolean;
    allow_opt_out?: boolean;
    allow_avatar_uploads?: boolean;
  } | null;
  const { data: ugRow } = await svc
    .from("user_gamification")
    .select("opted_out")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const optedOut = (ugRow as { opted_out?: boolean } | null)?.opted_out ?? false;

  // Earned badges (gamification + the Yoddha journey badge) — the journey
  // completion screen promises the badge lives on the profile, so it must.
  const { data: myBadgeRows } = await svc
    .from("user_badges")
    .select("badge_slug, awarded_at, period")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .order("awarded_at", { ascending: false });
  const myBadges = (myBadgeRows ?? []) as Array<{
    badge_slug: string;
    awarded_at: string;
    period: string | null;
  }>;
  const badgeCatalog = new Map<string, { name: string; icon: string | null }>();
  if (myBadges.length > 0) {
    const { data: cat } = await svc
      .from("gamification_badges")
      .select("slug, name, icon, organization_id")
      .or(`organization_id.is.null,organization_id.eq.${org.id}`);
    for (const b of (cat ?? []) as Array<{
      slug: string;
      name: string;
      icon: string | null;
      organization_id: string | null;
    }>) {
      const existing = badgeCatalog.get(b.slug);
      if (!existing || b.organization_id !== null) {
        badgeCatalog.set(b.slug, { name: b.name, icon: b.icon });
      }
    }
  }
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
            <AvatarUploader
              orgSlug={orgSlug}
              displayName={displayName}
              avatarUrl={avatarUrl}
              allowUploads={gs?.allow_avatar_uploads !== false}
            />
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

          {myBadges.length > 0 && (
            <div className="bg-paper border border-line rounded-2xl p-5">
              <h3 className="text-sm font-semibold mb-3">My badges</h3>
              <ul className="space-y-2.5">
                {myBadges.map((b) => {
                  const meta = badgeCatalog.get(b.badge_slug);
                  return (
                    <li
                      key={`${b.badge_slug}-${b.period ?? ""}`}
                      className="flex items-center gap-2.5 text-sm"
                    >
                      <span className="text-xl shrink-0" aria-hidden>
                        {meta?.icon ?? "🏅"}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-medium truncate">
                          {meta?.name ?? b.badge_slug}
                        </span>
                        <span className="block text-[11px] text-muted">
                          {b.period ? `${b.period} · ` : ""}
                          {new Date(b.awarded_at).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {gs?.enabled !== false && gs?.leaderboard_enabled !== false && (
            <div className="bg-paper border border-line rounded-2xl p-5">
              <h3 className="text-sm font-semibold mb-3">Privacy</h3>
              <LeaderboardPrivacyToggle
                orgSlug={orgSlug}
                optedOut={optedOut}
                allowOptOut={gs?.allow_opt_out !== false}
              />
            </div>
          )}

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
