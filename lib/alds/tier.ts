/**
 * Analytics tiers (ADR 0005 step 1) and the Package Guardian's reason
 * vocabulary (ADR 0005 note (e) of 2026-10-19). Pure: no imports, safe to
 * import from client components for labels. Rule findings keep their `code`
 * from lib/alds/rules/findings.ts; the codes below are the gate's own.
 */
export const ANALYTICS_TIERS = ["unverified", "pending", "uncertified", "certified", "revoked"] as const;
export type AnalyticsTier = (typeof ANALYTICS_TIERS)[number];

export function isAnalyticsTier(v: unknown): v is AnalyticsTier {
  return typeof v === "string" && (ANALYTICS_TIERS as readonly string[]).includes(v);
}

/** package_certifications.status */
export type CertificationStatus = "pending" | "certified" | "uncertified" | "revoked";

/** The gate's reason codes (analytics_tier_reason starts with one of these or with "<rule>:<finding code>"). */
export const TIER_REASON = {
  /** pending: the synchronous static check is running */
  checkRunning: "check_running",
  /** deadline, storage error, budget or an unexpected error; re-runnable (ADR 0005 step 1) */
  checkError: "check_error",
  /** not a cmi5 package: only KIVO cmi5 packages can be certified (ADR 0002 decision 2, ADR 0005 step 1) */
  manifestTypeNotCertifiable: "manifest_type_not_certifiable",
  /** manifest without selfCheck (ADR 0006 step 14) */
  selfCheckMissing: "self_check_missing",
  /** (selfCheck.engineDigest, rulesBundleHash) is not an entry of engine-allowlist.json (ADR 0005 step 4) */
  engineNotAllowlisted: "engine_not_allowlisted",
  /** a questions[].authoringKind outside the allowlist entry's certifiedKinds (ADR 0005 step 5) */
  kindNotCertified: "kind_not_certified",
  /** reserved: the COURSE_CONFIG settings check of ADR 0005 step 5, built once the reference 2.0 export exists */
  configNotCertified: "config_not_certified",
  /** the stored objects exceed the digest byte budget */
  packageDigestBudget: "package_digest_budget",
  /** reserved (ADR 0006 decision 4): unreachable while one flag gates both the gate and the launch contract */
  launchContractMissing: "launch_contract_missing",
} as const;
export type TierReasonCode = (typeof TIER_REASON)[keyof typeof TIER_REASON];

export interface TierBadgeSpec {
  label: string;
  title: string;
  tone: "neutral" | "pending" | "bad" | "good" | "revoked";
}

/** The badge for a version row; null = no badge (column absent or flag off). */
export function tierBadge(tier: AnalyticsTier | null | undefined, reason?: string | null): TierBadgeSpec | null {
  if (!isAnalyticsTier(tier)) return null;
  switch (tier) {
    case "unverified":
      return { label: "Unverified", title: "No ALDS manifest: SCORM, third-party or a pre-2.0 KIVO export. Question analytics are unverified.", tone: "neutral" };
    case "pending":
      return { label: "Checking", title: reason ?? "The static check is running.", tone: "pending" };
    case "uncertified":
      return { label: "Uncertified", title: reason ?? "The static check failed.", tone: "bad" };
    case "certified":
      return { label: "Certified", title: "Certified KIVO cmi5 package: question analytics are reliable.", tone: "good" };
    case "revoked":
      return { label: "Revoked", title: reason ?? "Certification revoked.", tone: "revoked" };
  }
}

/** The Reports column (ADR 0005 step 11). Never an input to completion or scoring (D1). */
export function questionAnalyticsLabel(
  tier: AnalyticsTier | null | undefined,
  manifestType: string | null | undefined
): "Certified" | "Unverified" | "Not available (SCORM)" {
  if (manifestType === "scorm12") return "Not available (SCORM)";
  return tier === "certified" ? "Certified" : "Unverified";
}

export const D1_SENTENCE =
  "Completion, scores, official status, the Report Card, CRM and journeys never depend on the analytics tier.";
