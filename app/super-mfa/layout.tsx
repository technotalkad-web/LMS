import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 * Layout for /super-mfa/* — the MFA enroll + challenge flow for
 * platform owners. We DON'T call requirePlatformOwner here (that
 * helper itself redirects into /super-mfa, which would create a loop).
 * Instead we just verify the caller is signed in AND is a platform
 * owner; if not, bounce to /login.
 */
export default async function SuperMfaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

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
  if (!po) redirect("/login");

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4 py-12 font-sans text-slate-100">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 justify-center mb-6">
          <ShieldAlert className="w-6 h-6 text-emerald-400" />
          <span className="font-bold text-white tracking-wide">LMS SYSTEM</span>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
