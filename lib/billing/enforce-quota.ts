import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 * Quota enforcement (pre-flight). The hard, atomic guarantee lives in DB
 * triggers (migration 0038, enforce_row_quota) which lock the org row and
 * re-count inside the insert's own transaction — eliminating the check-then-
 * create TOCTOU race. This function is the friendly pre-check so the UI can
 * show a clear "limit reached / upgrade" message before attempting the write.
 *
 * Cap resolution is centralized in SQL (`effective_cap`): per-tenant override →
 * plan → BASIC default, with a manual grace period treated as unlimited. We
 * call that same function here so the pre-check and the trigger never diverge.
 *
 * Suspended/cancelled tenants are blocked from ALL creates regardless of cap.
 * On any lookup error we fail CLOSED.
 */

export type QuotaKind = "users" | "courses" | "storage_mb";

export type QuotaCheck =
  | { ok: true; remaining: number | null; cap: number | null }
  | { ok: false; reason: string; message: string };

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function checkQuota(
  organizationId: string,
  kind: QuotaKind,
  delta = 1
): Promise<QuotaCheck> {
  const s = svc();

  // 1) Billing status gate. Suspended/cancelled → no creates. Fail closed.
  const { data: subRow, error: subErr } = await s
    .from("tenant_subscriptions")
    .select("billing_status")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (subErr) {
    return {
      ok: false,
      reason: "quota_check_failed",
      message: "Couldn't verify your subscription right now. Please try again.",
    };
  }
  const status = (subRow as { billing_status?: string } | null)?.billing_status;
  if (status === "suspended" || status === "cancelled") {
    return {
      ok: false,
      reason: "tenant_suspended",
      message: `This workspace is ${status}. Contact the billing admin to restore service.`,
    };
  }

  // 2) Effective cap via the same SQL the DB trigger uses
  //    (override → plan → basic; manual grace period = unlimited).
  const { data: capRaw, error: capErr } = await s.rpc("effective_cap", {
    org_id: organizationId,
    kind,
  });
  if (capErr) {
    return {
      ok: false,
      reason: "quota_check_failed",
      message: "Couldn't verify your plan limits right now. Please try again.",
    };
  }
  if (capRaw === null || capRaw === undefined) {
    return { ok: true, remaining: null, cap: null }; // unlimited
  }
  const cap = Number(capRaw);

  // 3) Current usage (real byte accounting for storage).
  const { data: usageRaw, error: usageErr } = await s.rpc("current_quota_usage", {
    org_id: organizationId,
    kind,
  });
  if (usageErr) {
    return {
      ok: false,
      reason: "quota_check_failed",
      message: "Couldn't verify current usage right now. Please try again.",
    };
  }
  const current = Number(usageRaw ?? 0);

  if (current + delta > cap) {
    return {
      ok: false,
      reason: "quota_exceeded",
      message: `Plan limit reached: ${current}/${cap} ${labelFor(kind)}. Upgrade your plan or contact support to raise the limit.`,
    };
  }
  return { ok: true, remaining: cap - current - delta, cap };
}

function labelFor(k: QuotaKind): string {
  return k === "users" ? "users" : k === "courses" ? "courses" : "MB of storage";
}
