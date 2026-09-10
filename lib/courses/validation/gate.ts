import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex, validatePackage } from "./validate-package";

/**
 * Phase-2 enforcement shared by every package-upload endpoint.
 *
 * The UI flow: the client first POSTs the zip to /api/courses/validate-package
 * (phase 1 — report + pending row), shows the admin the Pass/Warning/Fail
 * report, and only on "Accept & Upload" calls the real upload endpoint with
 * `validation_id` (+ `acknowledge` when the verdict wasn't a clean pass).
 * This function re-binds the accepted row to the received bytes by sha256 so
 * the approved package and the uploaded package are provably the same file.
 *
 * Locked rules (product decision):
 *   - verdict 'unplayable'  → can NEVER be accepted.
 *   - verdict 'warning'/'fail' → needs acknowledge=true, recorded for audit.
 *   - Direct API calls without validation_id (bots, curl, CI) still work:
 *     validation runs inline and is recorded as auto-acknowledged, so every
 *     version ends up with a stored report either way.
 */
export async function enforcePackageValidation(opts: {
  /** Caller-bound client (RLS: admins manage package_validations). */
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  courseId: string | null;
  zipBytes: Uint8Array;
  fileName: string | null;
  validationId: string | null;
  acknowledge: boolean;
}): Promise<
  | { ok: true; validationId: string | null }
  | { ok: false; status: number; error: string }
> {
  const { supabase, organizationId, userId, courseId, zipBytes, fileName } = opts;

  if (opts.validationId) {
    const { data: row } = await supabase
      .from("package_validations")
      .select("id, organization_id, sha256, verdict, status")
      .eq("id", opts.validationId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const v = row as {
      id: string; sha256: string; verdict: string; status: string;
    } | null;
    if (!v || v.status !== "pending") {
      return { ok: false, status: 400, error: "Validation not found or already used — re-validate the package." };
    }
    if (v.sha256 !== sha256Hex(zipBytes)) {
      return {
        ok: false, status: 400,
        error: "The uploaded file differs from the validated one. Re-validate this exact package.",
      };
    }
    if (v.verdict === "unplayable") {
      return {
        ok: false, status: 400,
        error: "This package failed structural validation (no playable content) and cannot be uploaded. Fix the package and validate again.",
      };
    }
    if (v.verdict !== "pass" && !opts.acknowledge) {
      return {
        ok: false, status: 400,
        error: "Validation reported issues — confirm 'Accept & Upload' to acknowledge them.",
      };
    }
    await supabase
      .from("package_validations")
      .update({
        status: "accepted",
        accepted_by: userId,
        accepted_at: new Date().toISOString(),
        acknowledged_warnings: v.verdict !== "pass",
        ...(courseId ? { course_id: courseId } : {}),
      })
      .eq("id", v.id);
    return { ok: true, validationId: v.id };
  }

  // Direct call (no phase 1): validate inline. Fail-soft on validator errors
  // EXCEPT structural unplayability — that must always block, since the
  // package literally cannot open.
  try {
    const report = await validatePackage(zipBytes);
    if (report.verdict === "unplayable") {
      const why = report.checks.find((c) => c.status === "fail")?.detail ?? "";
      return { ok: false, status: 400, error: `Package failed validation: ${why}` };
    }
    const { data: inserted } = await supabase
      .from("package_validations")
      .insert({
        organization_id: organizationId,
        course_id: courseId,
        uploaded_by: userId,
        file_name: fileName,
        size_bytes: zipBytes.length,
        sha256: sha256Hex(zipBytes),
        verdict: report.verdict,
        report,
        status: "accepted",
        accepted_by: userId,
        accepted_at: new Date().toISOString(),
        acknowledged_warnings: report.verdict !== "pass",
      })
      .select("id")
      .maybeSingle();
    return { ok: true, validationId: (inserted as { id: string } | null)?.id ?? null };
  } catch {
    // Pre-0070 database or validator hiccup — never break uploads for it.
    return { ok: true, validationId: null };
  }
}

/** After the upload succeeds, link the created version to its report. */
export async function linkValidationToVersion(opts: {
  supabase: SupabaseClient;
  validationId: string | null;
  courseId: string;
  versionId: string;
}): Promise<void> {
  if (!opts.validationId) return;
  try {
    await opts.supabase
      .from("package_validations")
      .update({ course_id: opts.courseId, course_version_id: opts.versionId })
      .eq("id", opts.validationId);
  } catch {
    // linking is best-effort
  }
}
