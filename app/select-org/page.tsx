import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { mustChangePassword } from "@/lib/auth/must-change-password";

type Org = { id: string; name: string; slug: string };

export default async function SelectOrgPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (await mustChangePassword(user.id)) {
    redirect("/change-password");
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: po } = await svc
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const isPlatformOwner = Boolean(po);

  const { data: memberships, error: membershipError } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", user.id);

  const orgIds = (memberships ?? []).map((m) => m.organization_id);
  const orgsResp = orgIds.length
    ? await supabase
        .from("organizations")
        .select("id, name, slug")
        .in("id", orgIds)
    : { data: [] as Org[], error: null };
  const orgs = (orgsResp.data ?? []) as Org[];

  if (isPlatformOwner) {
    redirect("/super/organizations");
  }
  if (orgs.length === 1) {
    redirect(`/${orgs[0].slug}/dashboard`);
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <h1 className="serif text-5xl mb-2">Workspaces</h1>
        <p className="text-muted mb-8">Choose an organization to enter.</p>

        {orgs.length === 0 ? (
          <div className="border border-line rounded-lg p-6 bg-paper">
            <p className="serif text-2xl mb-2">No workspaces yet</p>
            <p className="text-muted text-sm mb-4">
              You&apos;re not a member of any organization. See the README for
              how to create your first workspace from the Supabase SQL editor.
            </p>
            {process.env.NODE_ENV !== "production" && (
              <details className="text-xs text-muted border-t border-line pt-3 mt-3" open>
                <summary className="cursor-pointer font-medium">Debug (dev only)</summary>
                <pre className="mt-2 whitespace-pre-wrap break-all text-[10px] bg-canvas p-2 rounded">
{`user.id: ${user.id}
user.email: ${user.email}

memberships query:
  rows: ${JSON.stringify(memberships)}
  error: ${JSON.stringify(membershipError)}

orgs query (filtered to org_ids ${JSON.stringify(orgIds)}):
  rows: ${JSON.stringify(orgsResp.data)}
  error: ${JSON.stringify(orgsResp.error)}`}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <ul className="space-y-2">
            {orgs.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/${o.slug}/dashboard`}
                  className="block px-4 py-3 border border-line rounded-lg bg-paper hover:border-ink transition-colors"
                >
                  <span className="serif text-xl">{o.name}</span>
                  <span className="text-muted text-sm block">/{o.slug}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
