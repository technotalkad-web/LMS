/**
 * Names and shapes of the 0100 objects the P4 code calls (ADR 0005 note (c)
 * of 2026-10-19). The RPC is called ONLY from lib/alds/tier-writer.ts
 * (tests/unit/alds-tier-read-sites.test.ts enforces it).
 */
import type { AnalyticsTier } from "./tier";

export const ALDS_RPC = { setVersionTier: "alds_set_version_tier" } as const;
export const PACKAGE_CERTIFICATIONS_TABLE = "package_certifications" as const;
export const LEARNING_SESSIONS_TABLE = "learning_sessions" as const;

/** cmi5 §10.1: the LMS-owned State document; the AU may only GET it (ADR 0006 step 16). */
export const LMS_LAUNCH_DATA_STATE_ID = "LMS.LaunchData" as const;

/** Named arguments of public.alds_set_version_tier(...); supabase-js rpc() passes them by name. */
export interface SetVersionTierArgs {
  p_version_id: string;
  p_tier: AnalyticsTier;
  p_reason_code?: string | null;
  p_reason?: string | null;
  p_certification_id?: string | null;
  p_manifest?: unknown | null;
  p_standard_version?: string | null;
  p_engine_version?: string | null;
  p_conformance_level?: 1 | 2 | null;
}

/** The jsonb the function returns. */
export interface SetVersionTierResult {
  version_id: string;
  analytics_tier: AnalyticsTier;
  analytics_tier_reason: string | null;
  certified_at: string | null;
  certification_id: string | null;
}

/** The columns 0100 adds to course_versions, as pages read them from select("*") (undefined before 0100). */
export interface VersionTierColumns {
  analytics_tier?: AnalyticsTier | null;
  analytics_tier_reason?: string | null;
  certified_at?: string | null;
  certification_id?: string | null;
  conformance_level?: number | null;
  standard_version?: string | null;
  engine_version?: string | null;
  alds_manifest?: unknown | null;
}

/** The columns 0100 adds to course_attempts (written by the launch page only; never read by scoring, D1). */
export interface AttemptAldsColumns {
  served_language?: string | null;
  launch_mode?: "Normal" | "Browse" | "Review";
  is_preview?: boolean;
  alds_ingested_at?: string | null;
}
