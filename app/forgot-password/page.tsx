import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ForgotPasswordClient } from "./forgot-password-client";

export const dynamic = "force-dynamic";

/**
 * Standalone /forgot-password route. Signed-in users get bounced to
 * /select-org (which routes them onward) — they don't need this page.
 */
export default async function ForgotPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/select-org");

  return (
    <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <ForgotPasswordClient />
      </div>
    </main>
  );
}
