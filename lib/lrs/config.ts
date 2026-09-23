import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 * Per-org external-LRS configuration. RLS denies all client access to
 * tenant_lrs_config, so everything here uses the service role. The raw
 * auth_secret is for server-side forwarding only and is masked before any
 * response reaches the browser (see maskedConfig).
 */

export type LrsConfig = {
  organization_id: string;
  enabled: boolean;
  endpoint: string | null;
  auth_key: string | null;
  auth_secret: string | null;
  xapi_version: string;
  /** 0078 — 'ambak-v1' (enriched analytics profile) | 'raw' (engine
   *  statements verbatim, the pre-0078 behaviour). Undefined before the
   *  migration lands → treated as the default. */
  statement_profile?: StatementProfile | null;
  backfill_requested_at?: string | null;
  backfill_started_at?: string | null;
  backfill_completed_at?: string | null;
  backfill_cursor?: Record<string, unknown> | null;
  backfill_stats?: Record<string, unknown> | null;
  last_test_at: string | null;
  last_test_status: string | null;
  last_test_error: string | null;
};

export type StatementProfile = "ambak-v1" | "raw";
export const STATEMENT_PROFILES: StatementProfile[] = ["ambak-v1", "raw"];
export const DEFAULT_STATEMENT_PROFILE: StatementProfile = "ambak-v1";

export function statementProfileOf(cfg: Pick<LrsConfig, "statement_profile"> | null): StatementProfile {
  const v = cfg?.statement_profile;
  return v === "raw" ? "raw" : DEFAULT_STATEMENT_PROFILE;
}

export const SECRET_MASK = "••••••";

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/** Full config (incl. secret) for server-side use. Null if the table/row is
 *  absent — callers treat that as "forwarding disabled". */
export async function loadLrsConfig(orgId: string): Promise<LrsConfig | null> {
  try {
    const { data } = await svc()
      .from("tenant_lrs_config")
      .select("*")
      .eq("organization_id", orgId)
      .maybeSingle();
    return (data as LrsConfig) ?? null;
  } catch {
    return null; // migration not applied yet → behave as disabled
  }
}

/** Config for the admin API — auth_secret masked, never returned raw. */
export async function maskedConfig(orgId: string) {
  const cfg = await loadLrsConfig(orgId);
  if (!cfg) {
    return {
      enabled: false,
      endpoint: "",
      auth_key: "",
      has_secret: false,
      auth_secret: "",
      xapi_version: "1.0.3",
      statement_profile: DEFAULT_STATEMENT_PROFILE,
      backfill_requested_at: null,
      backfill_started_at: null,
      backfill_completed_at: null,
      backfill_stats: null,
      last_test_at: null,
      last_test_status: null,
      last_test_error: null,
    };
  }
  return {
    enabled: cfg.enabled,
    endpoint: cfg.endpoint ?? "",
    auth_key: cfg.auth_key ?? "",
    has_secret: Boolean(cfg.auth_secret),
    auth_secret: cfg.auth_secret ? SECRET_MASK : "",
    xapi_version: cfg.xapi_version ?? "1.0.3",
    statement_profile: statementProfileOf(cfg),
    backfill_requested_at: cfg.backfill_requested_at ?? null,
    backfill_started_at: cfg.backfill_started_at ?? null,
    backfill_completed_at: cfg.backfill_completed_at ?? null,
    backfill_stats: cfg.backfill_stats ?? null,
    last_test_at: cfg.last_test_at,
    last_test_status: cfg.last_test_status,
    last_test_error: cfg.last_test_error,
  };
}

/** Upsert config. auth_secret is only written when a real new value is provided
 *  (never overwritten with the mask / blank from the masked GET). */
export async function saveLrsConfig(
  orgId: string,
  fields: {
    enabled?: boolean;
    endpoint?: string | null;
    auth_key?: string | null;
    auth_secret?: string | null;
    xapi_version?: string;
    statement_profile?: StatementProfile;
  }
): Promise<{ ok: boolean; error?: string }> {
  const update: Record<string, unknown> = {
    organization_id: orgId,
    updated_at: new Date().toISOString(),
  };
  if (fields.enabled !== undefined) update.enabled = fields.enabled;
  // Only written when supplied, so a deploy ahead of migration 0078 keeps
  // saving the other fields.
  if (fields.statement_profile !== undefined && STATEMENT_PROFILES.includes(fields.statement_profile))
    update.statement_profile = fields.statement_profile;
  if (fields.endpoint !== undefined)
    update.endpoint = fields.endpoint?.trim().replace(/\/+$/, "") || null;
  if (fields.auth_key !== undefined) update.auth_key = fields.auth_key?.trim() || null;
  if (fields.xapi_version !== undefined)
    update.xapi_version = fields.xapi_version?.trim() || "1.0.3";
  // Only touch the secret when a genuine new value is supplied.
  if (
    fields.auth_secret !== undefined &&
    fields.auth_secret !== null &&
    fields.auth_secret !== "" &&
    fields.auth_secret !== SECRET_MASK
  ) {
    update.auth_secret = fields.auth_secret;
  }

  const { error } = await svc()
    .from("tenant_lrs_config")
    .upsert(update, { onConflict: "organization_id" });
  // Deploy-before-migration safety (0078): a database without the
  // statement_profile column must still save every other field.
  if (error && "statement_profile" in update && /statement_profile/.test(error.message)) {
    delete update.statement_profile;
    const retry = await svc().from("tenant_lrs_config").upsert(update, { onConflict: "organization_id" });
    return retry.error ? { ok: false, error: retry.error.message } : { ok: true };
  }
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function recordTestResult(
  orgId: string,
  status: string,
  error: string | null
) {
  await svc()
    .from("tenant_lrs_config")
    .update({
      last_test_at: new Date().toISOString(),
      last_test_status: status,
      last_test_error: error,
    })
    .eq("organization_id", orgId);
}
