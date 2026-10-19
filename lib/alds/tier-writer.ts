/**
 * The only caller of public.alds_set_version_tier() (ADR 0005 step 2, note (c)
 * of 2026-10-19). The function is security definer, executable by
 * service_role only, and the course_versions guard trigger reverts any other
 * write to the tier columns, so `svc` must be a service-role client.
 * tests/unit/alds-tier-read-sites.test.ts fails when the RPC is called from
 * any other file.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAldsSchemaMissing } from "./flag";
import { ALDS_RPC, type SetVersionTierArgs, type SetVersionTierResult } from "./rpc";

export async function setVersionTier(
  svc: SupabaseClient,
  args: SetVersionTierArgs
): Promise<
  | { ok: true; result: SetVersionTierResult }
  | { ok: false; error: { code?: string; message: string }; schemaMissing: boolean }
> {
  const { data, error } = await svc.rpc(ALDS_RPC.setVersionTier, args);
  if (error) {
    const e = { code: error.code ?? undefined, message: error.message ?? "alds_set_version_tier failed" };
    return { ok: false, error: e, schemaMissing: isAldsSchemaMissing(error) };
  }
  return { ok: true, result: data as SetVersionTierResult };
}
