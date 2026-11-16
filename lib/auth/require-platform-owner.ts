import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { mustChangePassword } from "@/lib/auth/must-change-password";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The platform's second-factor rule, shared by the pages and the API: an
 * owner whose platform_owners row does not set mfa_required to false acts
 * only from a session at AAL2, whether or not a factor is enrolled yet.
 */
function secondFactorRequired(row: { mfa_required?: boolean | null }): boolean {
  return row.mfa_required !== false;
}

/**
 * Where a session that must be at AAL2 stands: null when it is at AAL2;
 * "challenge" when a verified factor is enrolled but this session has not
 * used it; "enroll" when no factor is enrolled.
 */
async function secondFactorShortfall(
  supabase: ServerClient
): Promise<null | "challenge" | "enroll"> {
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const current = aal?.currentLevel ?? "aal1";
  const next = aal?.nextLevel ?? "aal1";
  if (current === "aal2") return null;
  return next === "aal2" ? "challenge" : "enroll";
}

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

  if (secondFactorRequired(row as { mfa_required?: boolean })) {
    const shortfall = await secondFactorShortfall(supabase);
    if (shortfall === "challenge") redirect("/super-mfa/challenge");
    if (shortfall === "enroll") redirect("/super-mfa/enroll");
    await svc
      .from("platform_owners")
      .update({ last_mfa_check_at: new Date().toISOString() })
      .eq("user_id", user.id);
  }

  return { user };
}

/** The level a platform API handler requires; see requirePlatformOwnerApi. */
export type PlatformOwnerApiLevel = "full" | "end";

/** Admitted: the caller's user id. Refused: the JSON error and status to answer. */
export type PlatformOwnerApiGuard =
  | { userId: string }
  | { error: string; status: number };

/**
 * Gate for every handler under app/api/super/ (the platform route rule).
 * The first two statements of a handler are
 *
 *   const guard = await requirePlatformOwnerApi("full");
 *   if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
 *
 * It answers; it never redirects.
 *
 *   "full": what the platform pages require. Signed in (401 "Unauthorized");
 *     a platform_owners row (403 "Forbidden"); not in the must-change-password
 *     state (403 "password_change_required"); and, when the row's
 *     mfa_required is not false, a session at AAL2 (403 "mfa_required"),
 *     whether or not a factor is enrolled.
 *   "end": signed in and a platform_owners row, nothing else. Ending an
 *     impersonation uses it, so the exit is never refused for the second
 *     factor or the password state.
 *
 * The checks run in that order, so a caller who is not a platform owner
 * learns nothing about any owner's second factor. A failed owner read
 * answers 503 and never admits. An assurance level that cannot be read is a
 * refusal.
 */
export async function requirePlatformOwnerApi(
  level: PlatformOwnerApiLevel
): Promise<PlatformOwnerApiGuard> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: row, error } = await svc
    .from("platform_owners")
    .select("user_id, mfa_required")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return { error: "try again", status: 503 };
  if (!row) return { error: "Forbidden", status: 403 };
  if (level === "end") return { userId: user.id };

  if (await mustChangePassword(user.id)) {
    return { error: "password_change_required", status: 403 };
  }
  if (secondFactorRequired(row as { mfa_required?: boolean })) {
    let shortfall: null | "challenge" | "enroll";
    try {
      shortfall = await secondFactorShortfall(supabase);
    } catch {
      shortfall = "enroll";
    }
    if (shortfall !== null) return { error: "mfa_required", status: 403 };
  }
  return { userId: user.id };
}

/**
 * Writes one platform_audit_log row. Fail-soft: never throws. Resolves to
 * `{ error }` (null when the row was written) so a caller whose record names
 * the audit row as its control can say when it is missing; callers that
 * ignore the result keep the old behaviour.
 */
export async function auditLog(args: {
  actorUserId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ error: string | null }> {
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { error } = await svc.from("platform_audit_log").insert({
      actor_user_id: args.actorUserId,
      action: args.action,
      target_type: args.targetType ?? null,
      target_id: args.targetId ?? null,
      metadata: (args.metadata ?? null) as object | null,
      ip: args.ip ?? null,
      user_agent: args.userAgent ?? null,
    });
    if (error) {
      console.warn("[audit] log failed:", args.action, error.message);
      return { error: error.message };
    }
    return { error: null };
  } catch (e) {
    console.warn("[audit] log failed:", e);
    return { error: e instanceof Error ? e.message : "audit insert failed" };
  }
}
