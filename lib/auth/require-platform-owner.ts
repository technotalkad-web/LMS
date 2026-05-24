import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { mustChangePassword } from "@/lib/auth/must-change-password";

/**
 * Gate for /super/* pages. Verifies that:
 *   1. A user is signed in.
 *   2. They are not in the must-change-password state.
 *   3. Their auth.users.id is in public.platform_owners.
 *   4. (Phase 10c) They are at AAL2 if mfa_required is true.
 */
export async function requirePlatformOwner() {
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
  const { data: row } = await svc
    .from("platform_owners")
    .select("user_id, mfa_required")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!row) {
    redirect("/login");
  }

  const mfaRequired = (row as { mfa_required?: boolean }).mfa_required !== false;
  if (mfaRequired) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const current = aal?.currentLevel ?? "aal1";
    const next = aal?.nextLevel ?? "aal1";
    if (current !== "aal2") {
      if (next === "aal2") {
        redirect("/super-mfa/challenge");
      } else {
        redirect("/super-mfa/enroll");
      }
    }
    await svc
      .from("platform_owners")
      .update({ last_mfa_check_at: new Date().toISOString() })
      .eq("user_id", user.id);
  }

  return { user };
}

export async function auditLog(args: {
  actorUserId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}) {
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    await svc.from("platform_audit_log").insert({
      actor_user_id: args.actorUserId,
      action: args.action,
      target_type: args.targetType ?? null,
      target_id: args.targetId ?? null,
      metadata: (args.metadata ?? null) as object | null,
      ip: args.ip ?? null,
      user_agent: args.userAgent ?? null,
    });
  } catch (e) {
    console.warn("[audit] log failed:", e);
  }
}
