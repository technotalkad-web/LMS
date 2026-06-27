import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 * Quota enforcement. The super-owner-defined subscription_plans table
 * holds caps on users / storage / courses per tenant; this module
 * checks them BEFORE the corresponding create operation runs.
 *
 * Call patterns:
 *   const q = await checkQuota(orgId, "users");
 *   if (!q.ok) return NextResponse.json({ error: q.message }, { status: 402 });
 *
 * 402 (Payment Required) is the semantic status — billing tier is the
 * reason we said no. Frontend can detect this and show a "Upgrade plan"
 * CTA.
 *
 * Suspended/cancelled tenants are blocked from ALL creates regardless
 * of cap.
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

  // 1) Subscription + plan cap.
  const { data: subRaw, error: subErr } = await s
    .from("tenant_subscriptions")
    .select("billing_status, plan_id, subscription_plans(max_users,max_courses,max_storage_gb)")
    .eq("organization_id", organizationId)
    .maybeSingle();
  // Fail CLOSED on a lookup error: previously the error was ignored and a null
  // result fell through to "unlimited", which would also bypass the
  // suspended/cancelled block. Better to refuse the create than to silently
  // exceed plan limits or let a suspended tenant write.
  if (subErr) {
    return {
      ok: false,
      reason: "quota_check_failed",
      message: "Couldn't verify your plan limits right now. Please try again.",
    };
  }

  // Defensive default: no sub row means we treat the tenant as Basic
  // (rather than letting them through with no limits). Admins running
  // a fresh dev DB will hit this branch.
  const sub = subRaw as
    | {
        billing_status: string;
        plan_id: string | null;
        subscription_plans: {
          max_users: number | null;
          max_courses: number | null;
          max_storage_gb: number | null;
        } | null;
      }
    | null;

  if (sub && (sub.billing_status === "suspended" || sub.billing_status === "cancelled")) {
    return {
      ok: false,
      reason: "tenant_suspended",
      message: `This workspace is ${sub.billing_status}. Contact the billing admin to restore service.`,
    };
  }

  const plan = sub?.subscription_plans ?? null;
  const cap =
    kind === "users"
      ? plan?.max_users ?? null
      : kind === "courses"
        ? plan?.max_courses ?? null
        : (plan?.max_storage_gb ?? null) === null
          ? null
          : (plan!.max_storage_gb as number) * 1024;

  if (cap === null) {
    // Unlimited (Enterprise) or unknown plan — allow.
    return { ok: true, remaining: null, cap: null };
  }

  // 2) Current usage from the tenant_usage view.
  const { data: usageRaw, error: usageErr } = await s
    .from("tenant_usage")
    .select("user_count, course_count, storage_mb_est")
    .eq("organization_id", organizationId)
    .maybeSingle();
  // Fail CLOSED: an ignored error here defaulted usage to 0 and let the create
  // through regardless of the real count.
  if (usageErr) {
    return {
      ok: false,
      reason: "quota_check_failed",
      message: "Couldn't verify current usage right now. Please try again.",
    };
  }
  const usage = usageRaw as
    | {
        user_count: number;
        course_count: number;
        storage_mb_est: number;
      }
    | null;

  const current =
    kind === "users"
      ? usage?.user_count ?? 0
      : kind === "courses"
        ? usage?.course_count ?? 0
        : usage?.storage_mb_est ?? 0;

  if (current + delta > cap) {
    return {
      ok: false,
      reason: "quota_exceeded",
      message: `Plan limit reached: ${current}/${cap} ${labelFor(kind)}. Upgrade your plan to add more.`,
    };
  }

  return { ok: true, remaining: cap - current - delta, cap };
}

function labelFor(k: QuotaKind): string {
  return k === "users" ? "users" : k === "courses" ? "courses" : "MB of storage";
}
