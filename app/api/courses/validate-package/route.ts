import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  sha256Hex,
  validatePackage,
} from "@/lib/courses/validation/validate-package";
import { validateStoredVersion } from "@/lib/courses/validation/validate-stored";
import { applyIntegrity, checkIntegrity, type IntegrityFindings } from "@/lib/courses/validation/integrity";
import { auditLog } from "@/lib/auth/require-platform-owner";

/**
 * Pre-Upload Package Validation — phase 1 of the quality gate.
 *
 *   POST /api/courses/validate-package
 *     multipart/form-data { file, orgSlug, courseId?, packageId? }
 *       → runs the static validator and the org-scoped content-integrity
 *         lookup (ADR 0004 step 2: courseId = the course being uploaded into,
 *         excluded from the lookup; packageId = the language slot being
 *         replaced, for the same-slot warning), stores a 'pending'
 *         package_validations row (verdict 'blocked' on a cross-course
 *         collision), returns { validation_id, report }.
 *     application/json { action: "reject", orgSlug, validation_id }
 *       → marks the pending row rejected (the "Reject & upload new package"
 *         button) so the audit trail shows the admin saw the report and
 *         chose not to ship it.
 *     application/json { action: "override", orgSlug, validation_id, override_reason }
 *       → super_owner only (ADR 0004 step 3a): records the reason on a
 *         pending 'blocked' row so the upload gates accept it; the row stays
 *         pending and blocked until the upload consumes it. Audited.
 *
 * Admin-only. Phase 2 (Accept & Upload) happens on the real upload
 * endpoints with `validation_id` + `acknowledge` — see
 * lib/courses/validation/gate.ts.
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";

  // ---- JSON actions: reject | validate_existing ----
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      orgSlug?: string;
      validation_id?: string;
      course_id?: string;
      override_reason?: string;
    };

    // ADR 0004 step 3a: a super_owner overrides a cross-course collision block.
    if (body.action === "override") {
      if (!body.orgSlug || !body.validation_id) {
        return NextResponse.json({ error: "orgSlug and validation_id required" }, { status: 400 });
      }
      const reason = typeof body.override_reason === "string" ? body.override_reason.trim() : "";
      if (!reason || reason.length > 500) {
        return NextResponse.json(
          { error: "override_reason is required (1 to 500 characters)" },
          { status: 400 }
        );
      }
      const auth = await requireAdmin(body.orgSlug);
      if ("error" in auth) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
      }
      if (auth.role !== "super_owner") {
        return NextResponse.json(
          { error: "Only a super owner can override an integrity block" },
          { status: 403 }
        );
      }
      const { data: rowData } = await auth.supabase
        .from("package_validations")
        .select("*")
        .eq("id", body.validation_id)
        .eq("organization_id", auth.orgId)
        .maybeSingle();
      const row = rowData as {
        id: string;
        verdict: string;
        status: string;
        overridden_at?: string | null;
        file_name?: string | null;
        report?: { integrity?: IntegrityFindings | null } | null;
      } | null;
      if (!row) return NextResponse.json({ error: "Validation not found" }, { status: 404 });
      if (row.status !== "pending" || row.verdict !== "blocked") {
        return NextResponse.json(
          { error: "Only a pending, blocked validation can be overridden" },
          { status: 409 }
        );
      }
      // One override per block: a second one would overwrite who overrode it
      // and why (the Attention item names that super owner).
      if (row.overridden_at) {
        return NextResponse.json(
          { error: "This block has already been overridden" },
          { status: 409 }
        );
      }
      const nowIso = new Date().toISOString();
      // Written by the server after the super_owner check above (the caller's
      // RLS session is not what authorises an override).
      const { data: updated, error } = await serviceClient()
        .from("package_validations")
        .update({ override_reason: reason, overridden_by: auth.userId, overridden_at: nowIso })
        .eq("id", row.id)
        .eq("organization_id", auth.orgId)
        .eq("status", "pending")
        .eq("verdict", "blocked")
        .is("overridden_at", null)
        .select("id");
      if (error) {
        return NextResponse.json(
          { error: `${error.message} (is migration 0098 applied?)` },
          { status: 500 }
        );
      }
      if (!updated || updated.length === 0) {
        // Consumed, rejected or overridden by a concurrent request since the read.
        return NextResponse.json({ error: "Only a pending, blocked validation can be overridden" }, { status: 409 });
      }
      const collisions = row.report?.integrity?.collisions ?? [];
      await auditLog({
        actorUserId: auth.userId,
        action: "package_validation.block_overridden",
        targetType: "package_validation",
        targetId: row.id,
        metadata: {
          organizationId: auth.orgId,
          reason,
          fileName: row.file_name ?? null,
          collidingCourses: collisions.map((c) => ({ courseId: c.courseId, title: c.courseTitle, matchedOn: c.matchedOn })),
          target: row.report?.integrity?.context ?? null,
        },
      });
      return NextResponse.json({ ok: true, validation_id: row.id, overridden_at: nowIso });
    }

    // Re-scan an ALREADY-UPLOADED course from its stored files — the audit
    // path for content that pre-dates the pre-upload gate.
    if (body.action === "validate_existing") {
      if (!body.orgSlug || !body.course_id) {
        return NextResponse.json(
          { error: "orgSlug and course_id required" },
          { status: 400 }
        );
      }
      const auth = await requireAdmin(body.orgSlug);
      if ("error" in auth) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
      }
      const { data: courseRow } = await auth.supabase
        .from("courses")
        .select("id, current_version_id")
        .eq("id", body.course_id)
        .eq("organization_id", auth.orgId)
        .maybeSingle();
      const course = courseRow as {
        id: string;
        current_version_id: string | null;
      } | null;
      if (!course) {
        return NextResponse.json({ error: "Course not found" }, { status: 404 });
      }
      let vq = auth.supabase
        .from("course_versions")
        .select("id, version_number, storage_prefix")
        .eq("course_id", course.id);
      vq = course.current_version_id
        ? vq.eq("id", course.current_version_id)
        : vq.order("version_number", { ascending: false }).limit(1);
      const { data: verRows } = await vq;
      const version = (verRows ?? [])[0] as
        | { id: string; version_number: number; storage_prefix: string }
        | undefined;
      if (!version?.storage_prefix) {
        return NextResponse.json(
          { error: "Course has no stored version to validate" },
          { status: 404 }
        );
      }

      const report = await validateStoredVersion(version.storage_prefix);
      // Content is already live for learners, so the row records an audit
      // (status accepted), not a pending gate decision.
      const { data: inserted, error } = await auth.supabase
        .from("package_validations")
        .insert({
          organization_id: auth.orgId,
          course_id: course.id,
          course_version_id: version.id,
          uploaded_by: auth.userId,
          file_name: `re-scan of v${version.version_number} (stored files)`,
          size_bytes: null,
          sha256: `stored:${version.id}`,
          verdict: report.verdict,
          report,
          status: "accepted",
          accepted_by: auth.userId,
          accepted_at: new Date().toISOString(),
          acknowledged_warnings: false,
        })
        .select("id")
        .maybeSingle();
      if (error || !inserted) {
        return NextResponse.json(
          { error: error?.message ?? "Could not store validation (is migration 0070 applied?)" },
          { status: 400 }
        );
      }
      return NextResponse.json({
        validation_id: (inserted as { id: string }).id,
        report,
      });
    }

    if (body.action !== "reject" || !body.orgSlug || !body.validation_id) {
      return NextResponse.json(
        { error: "action 'reject', 'override' or 'validate_existing' required (with orgSlug + validation_id / course_id)" },
        { status: 400 }
      );
    }
    const auth = await requireAdmin(body.orgSlug);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const { data: updated, error } = await auth.supabase
      .from("package_validations")
      .update({ status: "rejected" })
      .eq("id", body.validation_id)
      .eq("organization_id", auth.orgId)
      .eq("status", "pending")
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: "Validation not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, rejected: body.validation_id });
  }

  // ---- validate action (multipart) ----
  const form = await request.formData();
  const file = form.get("file");
  const orgSlug = form.get("orgSlug");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing 'file'" }, { status: 400 });
  }
  if (typeof orgSlug !== "string" || !orgSlug) {
    return NextResponse.json({ error: "Missing 'orgSlug'" }, { status: 400 });
  }
  const auth = await requireAdmin(orgSlug);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // ADR 0004 step 2: the upload target, tenant-checked. courseId is the
  // course this package is going into (excluded from the collision lookup);
  // packageId the language slot it replaces (same-slot warning).
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const courseId = field("courseId");
  const packageId = field("packageId");
  if (packageId && !courseId) {
    return NextResponse.json({ error: "packageId requires courseId" }, { status: 400 });
  }
  if (courseId) {
    const { data: c } = await auth.supabase
      .from("courses")
      .select("id")
      .eq("id", courseId)
      .eq("organization_id", auth.orgId)
      .maybeSingle();
    if (!c) return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (packageId) {
    const { data: p } = await auth.supabase
      .from("course_packages")
      .select("id")
      .eq("id", packageId)
      .eq("course_id", courseId!)
      .maybeSingle();
    if (!p) return NextResponse.json({ error: "Package not found on this course" }, { status: 404 });
  }

  const zipBytes = new Uint8Array(await file.arrayBuffer());
  let report = await validatePackage(zipBytes);
  if (report.verdict !== "unplayable" && report.package.identity) {
    try {
      const findings = await checkIntegrity(serviceClient(), {
        organizationId: auth.orgId,
        courseId,
        packageId,
        identity: report.package.identity,
        stage: "validate",
      });
      report = applyIntegrity(report, findings);
    } catch (e) {
      // Fail closed: a lookup that cannot run must not wave a package through.
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Integrity check failed" },
        { status: 503 }
      );
    }
  }

  const { data: inserted, error } = await auth.supabase
    .from("package_validations")
    .insert({
      organization_id: auth.orgId,
      uploaded_by: auth.userId,
      file_name: file instanceof File ? file.name : null,
      // Whole-package size: a direct-upload bundle declares it (media omitted from the bytes).
      size_bytes: report.package.sizeBytes || zipBytes.length,
      sha256: sha256Hex(zipBytes),
      verdict: report.verdict,
      report,
      status: "pending",
    })
    .select("id")
    .maybeSingle();
  if (error || !inserted) {
    // Before 0098 the 'blocked' verdict cannot be stored. The block still
    // blocks: no validation id, so neither gate can accept this package.
    if (report.verdict === "blocked") {
      return NextResponse.json(
        {
          error: "This module already belongs to a different course in this organisation, so the upload is blocked (the override needs database migration 0098).",
          validation_id: null,
          report,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: error?.message ?? "Could not store validation (is migration 0070 applied?)" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    validation_id: (inserted as { id: string }).id,
    report,
    // ADR 0004 step 3a: the Library shows the override reason field to a
    // super_owner only.
    can_override: report.verdict === "blocked" && auth.role === "super_owner",
  });
}

function serviceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function requireAdmin(orgSlug: string): Promise<
  | { supabase: Awaited<ReturnType<typeof createClient>>; orgId: string; userId: string; role: string }
  | { error: string; status: 401 | 403 | 404 }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = mem?.role as string | undefined;
  if (!(role === "super_owner" || role === "owner" || role === "admin")) {
    return { error: "Forbidden", status: 403 };
  }
  return { supabase, orgId: org.id as string, userId: user.id, role: role as string };
}
