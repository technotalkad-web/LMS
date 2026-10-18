import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex, validatePackage } from "./validate-package";
import {
  BLOCKED_UPLOAD_ERROR,
  applyIntegrity,
  checkIntegrity,
  isUnresolvedBlock,
  validatedForOtherCourse,
  type GateValidationRow,
} from "./integrity";

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
 *   - verdict 'blocked' (ADR 0004 step 3: the module already belongs to a
 *     different course in the org) → refused (409) unless a super_owner
 *     overrode it with a reason (overridden_at set), which then counts as an
 *     acknowledged warning.
 *   - verdict 'warning'/'fail' → needs acknowledge=true, recorded for audit.
 *   - Direct API calls without validation_id (bots, curl, CI) still work:
 *     validation runs inline and is recorded as auto-acknowledged, so every
 *     version ends up with a stored report either way — except a 'blocked'
 *     package: its row is stored PENDING and the call answers 409 with the
 *     validation_id, so the override has a row to target and the re-POST
 *     (with that validation_id) is re-bound by sha256.
 */
export async function enforcePackageValidation(opts: {
  /**
   * Caller-bound client, used for READS only (RLS: admins read
   * package_validations). Every write goes through the service client with
   * an explicit organization_id (ADR 0008 C): the upload route's admin check
   * is the authorisation.
   */
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  courseId: string | null;
  zipBytes: Uint8Array;
  fileName: string | null;
  validationId: string | null;
  acknowledge: boolean;
  /** ADR 0004 step 4: the language slot this upload replaces (same-slot warning); null for a new slot. */
  packageId?: string | null;
}): Promise<
  | { ok: true; validationId: string | null }
  | { ok: false; status: number; error: string; validationId?: string | null }
> {
  const { supabase, organizationId, userId, courseId, zipBytes, fileName } = opts;

  if (opts.validationId) {
    // select("*"): deploy-safe across 0098 (overridden_at).
    const { data: row } = await supabase
      .from("package_validations")
      .select("*")
      .eq("id", opts.validationId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const v = row as (GateValidationRow & {
      id: string; sha256: string; verdict: string; status: string;
    }) | null;
    if (!v || v.status !== "pending") {
      return { ok: false, status: 400, error: "Validation not found or already used — re-validate the package." };
    }
    if (v.sha256 !== sha256Hex(zipBytes)) {
      return {
        ok: false, status: 400,
        error: "The uploaded file differs from the validated one. Re-validate this exact package.",
      };
    }
    if (validatedForOtherCourse(v, courseId)) {
      return {
        ok: false, status: 400,
        error: "This validation was run for a different course. Re-validate the package for this course.",
      };
    }
    if (v.verdict === "unplayable") {
      return {
        ok: false, status: 400,
        error: "This package failed structural validation (no playable content) and cannot be uploaded. Fix the package and validate again.",
      };
    }
    if (isUnresolvedBlock(v)) {
      return { ok: false, status: 409, error: BLOCKED_UPLOAD_ERROR, validationId: v.id };
    }
    // A super_owner-overridden block counts as an acknowledged warning.
    const overriddenBlock = v.verdict === "blocked";
    // ADR 0004 step 2: the collision lookup again at accept time, on the
    // RECEIVED bytes (never on the row's own report, which a stale or
    // hand-written row could leave empty), as the direct path's finalize
    // does. A collision that no super_owner overrode is refused; the row is
    // marked blocked so the override has something to target.
    const recheck = await recheckIntegrityAtAccept({
      zipBytes,
      organizationId,
      courseId,
      packageId: opts.packageId ?? null,
      row: v,
    });
    if (!recheck.ok) return recheck;
    if (v.verdict !== "pass" && !overriddenBlock && !opts.acknowledge) {
      return {
        ok: false, status: 400,
        error: "Validation reported issues — confirm 'Accept & Upload' to acknowledge them.",
      };
    }
    // Conditional on 'pending', as the reject and override writes are: a
    // double submit, or a reject landing after the read above, consumes the
    // row once and the other request is refused.
    const { data: accepted, error: acceptErr } = await serviceClient()
      .from("package_validations")
      .update({
        status: "accepted",
        accepted_by: userId,
        accepted_at: new Date().toISOString(),
        acknowledged_warnings: v.verdict !== "pass",
        ...(courseId ? { course_id: courseId } : {}),
      })
      .eq("id", v.id)
      .eq("organization_id", organizationId)
      .eq("status", "pending")
      .select("id");
    if (acceptErr) return { ok: false, status: 500, error: `Could not accept the validation: ${acceptErr.message}` };
    if (!accepted || accepted.length === 0) {
      return { ok: false, status: 400, error: "Validation not found or already used — re-validate the package." };
    }
    return { ok: true, validationId: v.id };
  }

  // Direct call (no phase 1): validate inline. Fail-soft on validator errors
  // EXCEPT structural unplayability — that must always block, since the
  // package literally cannot open — and the content-integrity block.
  let report: Awaited<ReturnType<typeof validatePackage>>;
  try {
    report = await validatePackage(zipBytes);
  } catch {
    // Validator hiccup — never break uploads for it.
    return { ok: true, validationId: null };
  }
  if (report.verdict === "unplayable") {
    const why = report.checks.find((c) => c.status === "fail")?.detail ?? "";
    return { ok: false, status: 400, error: `Package failed validation: ${why}` };
  }
  // ADR 0004 step 2(b): the org-scoped collision lookup. Fail closed — a
  // lookup that cannot run must not wave a wrong-course module through.
  if (report.package.identity) {
    try {
      const findings = await checkIntegrity(serviceClient(), {
        organizationId,
        courseId,
        packageId: opts.packageId ?? null,
        identity: report.package.identity,
        stage: "inline",
      });
      report = applyIntegrity(report, findings);
    } catch (e) {
      return { ok: false, status: 503, error: e instanceof Error ? e.message : "Integrity check failed" };
    }
  }
  if (report.verdict === "blocked") {
    // Stored PENDING (not accepted): the super_owner override targets it and
    // the re-POST with this validation_id is re-bound by sha256. Before 0098
    // the verdict cannot be stored; the call still answers 409.
    const { data: pending } = await serviceClient()
      .from("package_validations")
      .insert({
        organization_id: organizationId,
        uploaded_by: userId,
        file_name: fileName,
        size_bytes: zipBytes.length,
        sha256: sha256Hex(zipBytes),
        verdict: report.verdict,
        report,
        status: "pending",
      })
      .select("id")
      .maybeSingle();
    return {
      ok: false,
      status: 409,
      error: BLOCKED_UPLOAD_ERROR,
      validationId: (pending as { id: string } | null)?.id ?? null,
    };
  }
  try {
    const { data: inserted } = await serviceClient()
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
    // Pre-0070 database hiccup — never break uploads for it.
    return { ok: true, validationId: null };
  }
}

/**
 * The accept-time integrity re-check of the validation_id branch. Fails
 * closed: bytes that cannot be read or a lookup that cannot run never wave a
 * package through (phase 1 already validated these exact bytes, matched by
 * sha256, so a validator failure here means the row did not come from it).
 */
async function recheckIntegrityAtAccept(args: {
  zipBytes: Uint8Array;
  organizationId: string;
  courseId: string | null;
  packageId: string | null;
  row: GateValidationRow & { id: string };
}): Promise<{ ok: true } | { ok: false; status: number; error: string; validationId?: string | null }> {
  let received: Awaited<ReturnType<typeof validatePackage>>;
  try {
    received = await validatePackage(args.zipBytes);
  } catch {
    return { ok: false, status: 400, error: "The package could not be read for the integrity check. Re-validate the package." };
  }
  const identity = received.package.identity;
  if (!identity) return { ok: true };
  const svc = serviceClient();
  let findings: Awaited<ReturnType<typeof checkIntegrity>>;
  try {
    findings = await checkIntegrity(svc, {
      organizationId: args.organizationId,
      courseId: args.courseId,
      packageId: args.packageId,
      identity,
      stage: "inline",
    });
  } catch (e) {
    return { ok: false, status: 503, error: e instanceof Error ? e.message : "Integrity check failed" };
  }
  const overridden = args.row.verdict === "blocked" && !!args.row.overridden_at;
  if (!findings.blocked || overridden) return { ok: true };
  // Keep the row pending, now blocked with the fresh findings. Before 0098
  // the verdict cannot be stored: the call still answers 409, with no id.
  const base = (args.row.report ?? {}) as unknown as { verdict?: string; checks?: unknown[] };
  const report = applyIntegrity(
    { ...base, verdict: args.row.verdict, checks: Array.isArray(base.checks) ? base.checks : [] } as {
      verdict: string;
      checks: Array<{ id: string; label: string; status: "pass" | "warning" | "fail" | "info"; detail: string }>;
    },
    findings
  );
  const { data: marked, error } = await svc
    .from("package_validations")
    .update({ verdict: "blocked", report })
    .eq("id", args.row.id)
    .eq("organization_id", args.organizationId)
    .eq("status", "pending")
    .select("id");
  const stored = !error && (marked ?? []).length > 0;
  return { ok: false, status: 409, error: BLOCKED_UPLOAD_ERROR, validationId: stored ? args.row.id : null };
}

function serviceClient(): SupabaseClient {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/**
 * After the upload succeeds, link the created version to its report. A
 * server write (ADR 0008 C), scoped to the uploading admin's organisation.
 */
export async function linkValidationToVersion(opts: {
  organizationId: string;
  validationId: string | null;
  courseId: string;
  versionId: string;
}): Promise<void> {
  if (!opts.validationId) return;
  try {
    await serviceClient()
      .from("package_validations")
      .update({ course_id: opts.courseId, course_version_id: opts.versionId })
      .eq("id", opts.validationId)
      .eq("organization_id", opts.organizationId);
  } catch {
    // linking is best-effort
  }
}
