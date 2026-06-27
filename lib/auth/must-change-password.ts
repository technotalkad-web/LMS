import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 * Reads profiles.must_change_password for the given user via service-role.
 * Cheap single-row lookup. Callers redirect to /change-password when this
 * returns true (and they're not already on /change-password).
 *
 * Note: this DB's `profiles` table uses `id` as the FK to `auth.users(id)`.
 */
export async function mustChangePassword(userId: string): Promise<boolean> {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data, error } = await svc
    .from("profiles")
    .select("must_change_password")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    // Security gate: fail CLOSED. Previously the error was ignored and this
    // returned false, silently skipping a mandatory password change. The
    // /change-password page is self-service, so a not-actually-required user
    // just sets a new password — no lockout. Surface the error for alerting.
    console.error(
      `[mustChangePassword] lookup failed for ${userId}, failing closed:`,
      error.message
    );
    return true;
  }
  return Boolean((data as { must_change_password?: boolean } | null)?.must_change_password);
}
