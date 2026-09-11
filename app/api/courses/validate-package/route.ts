import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  sha256Hex,
  validatePackage,
} from "@/lib/courses/validation/validate-package";
import { validateStoredVersion } from "@/lib/courses/validation/validate-stored";

/**
 * Pre-Upload Package Validation — phase 1 of the quality gate.
 *
 *   POST /api/courses/validate-package
 *     multipart/form-data { file, orgSlug }
 *       → runs the static validator, stores a 'pending' package_validations
 *         row, returns { validation_id, report }.
 *     application/json { action: "reject", orgSlug, validation_id }
 *       → marks the pending row rejected (the "Reject & upload new package"
 *         button) so the audit trail shows the admin saw the report and
 *         chose not to ship it.
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
    };

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
        { error: "action 'reject' or 'validate_existing' required (with orgSlug + validation_id / course_id)" },
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

  const zipBytes = new Uint8Array(await file.arrayBuffer());
  const report = await validatePackage(zipBytes);

  const { data: inserted, error } = await auth.supabase
    .from("package_validations")
    .insert({
      organization_id: auth.orgId,
      uploaded_by: auth.userId,
      file_name: file instanceof File ? file.name : null,
      size_bytes: zipBytes.length,
      sha256: sha256Hex(zipBytes),
      verdict: report.verdict,
      report,
      status: "pending",
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

async function requireAdmin(orgSlug: string): Promise<
  | { supabase: Awaited<ReturnType<typeof createClient>>; orgId: string; userId: string }
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
  return { supabase, orgId: org.id as string, userId: user.id };
}
