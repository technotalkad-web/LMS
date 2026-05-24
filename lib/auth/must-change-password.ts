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
  const { data } = await svc
    .from("profiles")
    .select("must_change_password")
    .eq("id", userId)
    .maybeSingle();
  return Boolean((data as { must_change_password?: boolean } | null)?.must_change_password);
}
