import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { mustChangePassword } from "@/lib/auth/must-change-password";
import { listCountingMemberships } from "@/lib/auth/org-membership";

/**
 * The caller's workspaces (ADR 0030): only organisations where their
 * membership counts (an active row, in an organisation that is not deleted).
 * With exactly one it goes straight there; the page guard sends a person
 * whose membership does not count back here, so this list and the guard read
 * the same rule. With none it says so, names no organisation and gives no
 * reason. When the list cannot be read it says "try again" and goes nowhere.
 */
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
  if (po) {
    redirect("/super/organizations");
  }

  const orgs = await listCountingMemberships(supabase, user.id);
  if (orgs !== "unreadable" && orgs.length === 1) {
    redirect(`/${orgs[0].slug}/dashboard`);
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <h1 className="serif text-5xl mb-2">Workspaces</h1>
        {orgs === "unreadable" ? (
          <div className="border border-line rounded-lg p-6 bg-paper">
            <p className="text-muted text-sm mb-4">
              We could not load your workspaces. Please reload this page to try again.
            </p>
            <SignOut />
          </div>
        ) : orgs.length === 0 ? (
          <div className="border border-line rounded-lg p-6 bg-paper">
            <p className="text-sm mb-4">
              You do not have access to a workspace. If you expected access, contact your
              organisation&apos;s administrator.
            </p>
            <SignOut />
          </div>
        ) : (
          <>
            <p className="text-muted mb-8">Choose an organization to enter.</p>
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
          </>
        )}
      </div>
    </main>
  );
}

function SignOut() {
  return (
    <form action="/auth/sign-out" method="post">
      <button type="submit" className="text-sm underline text-ink hover:text-muted">
        Sign out
      </button>
    </form>
  );
}
