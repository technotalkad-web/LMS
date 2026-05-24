import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChangePasswordForm } from "./change-password-form";

/**
 * Standalone page so this route works regardless of which group the
 * user "belonged" to before. Lives outside the [org] segment so
 * unauthenticated routing doesn't bounce on a missing slug.
 */
export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <header className="text-center mb-8">
          <h1 className="serif text-4xl mb-2">Set a new password</h1>
          <p className="text-muted text-sm">
            Choose a permanent password for{" "}
            <span className="font-mono">{user.email}</span>.
            You won&apos;t need the temporary one again.
          </p>
        </header>
        <ChangePasswordForm />
      </div>
    </main>
  );
}
