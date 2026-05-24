import { createClient as createServiceClient } from "@supabase/supabase-js";
import { AcceptForm } from "./accept-form";

/**
 * Public landing page for an invitation link.
 *
 *   /invitations/{token}
 *
 * Looks up the invitation, shows the org name + role, presents a password
 * form. Submission flows through /api/invitations/accept which creates the
 * auth user (or signs in the existing one), writes the membership, marks
 * the invitation accepted, and redirects to /select-org.
 *
 * No auth required on this route - the token itself is the credential.
 * The middleware exempts /invitations/* for this reason.
 */
export default async function InvitationAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: invitation } = await svc
    .from("invitations")
    .select("id, email, role, accepted_at, expires_at, organization_id, organizations(name, slug)")
    .eq("token", token)
    .maybeSingle();

  if (!invitation) {
    return (
      <Shell title="Invitation not found">
        <p className="text-muted text-sm">
          This invitation link is invalid. Ask the admin who invited you to
          send a new one.
        </p>
      </Shell>
    );
  }

  const expired = new Date(invitation.expires_at).getTime() < Date.now();
  if (expired) {
    return (
      <Shell title="Invitation expired">
        <p className="text-muted text-sm">
          This invitation has expired. Ask the admin to send a new one.
        </p>
      </Shell>
    );
  }
  if (invitation.accepted_at) {
    return (
      <Shell title="Already accepted">
        <p className="text-muted text-sm">
          This invitation has already been used. Sign in to your account
          normally.
        </p>
      </Shell>
    );
  }

  const orgRow = (invitation as unknown as {
    organizations?: { name?: string; slug?: string } | { name?: string; slug?: string }[];
  }).organizations;
  const org = Array.isArray(orgRow) ? orgRow[0] : orgRow;
  const orgName = org?.name ?? "the workspace";

  return (
    <Shell title="You've been invited">
      <p className="text-muted text-sm mb-6">
        Join <span className="text-ink font-medium">{orgName}</span> as a{" "}
        <span className="text-ink font-medium">{invitation.role}</span>.
      </p>
      <AcceptForm token={token} email={invitation.email} />
    </Shell>
  );
}

// Server action helper redirect not needed here; the form posts to /api/...
// and uses window.location.href on success.
export const dynamic = "force-dynamic";

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="serif text-5xl mb-2">{title}</h1>
        {children}
      </div>
    </main>
  );
}

