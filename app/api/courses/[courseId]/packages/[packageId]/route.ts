import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { isSupportedLanguage } from "@/lib/i18n/languages";

/**
 * PATCH /api/courses/{courseId}/packages/{packageId}
 *
 * Updates package metadata. Admin-only, tenant-scoped. Body fields are
 * all optional — send only the ones you want to change:
 *
 *   { display_name?: string | null, is_active?: boolean, language?: string }
 *
 * - display_name: human-friendly label shown in the picker. NULL falls
 *   back to the canonical native name of the language code.
 * - is_active: false hides the package from the learner picker without
 *   losing learner attempts/data. True re-enables.
 * - language: lets admins PROMOTE a legacy NULL-language default
 *   package to a real language code when they\'re adding a 2nd
 *   variant. (E.g. existing course was effectively English; admin
 *   labels it \'en\' before uploading Hindi.)
 *
 * DELETE on this same path lives in DELETE handler below.
 *
 * Closes #158 Phase 1c (PATCH half).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string; packageId: string }> }
) {
  const { courseId, packageId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    display_name?: string | null;
    is_active?: boolean;
    language?: string | null;
    orgSlug?: string;
  };

  if (!body.orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user: caller } } = await supabase.auth.getUser();
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations").select("id").eq("slug", body.orgSlug).maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id).eq("user_id", caller.id).maybeSingle();
  const cr = callerMem?.role as string | undefined;
  if (!(cr === "super_owner" || cr === "owner" || cr === "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Verify the package belongs to a course in this org.
  const { data: pkg } = await svc
    .from("course_packages")
    .select("id, course_id, language, courses!inner(organization_id)")
    .eq("id", packageId)
    .maybeSingle();
  if (!pkg || (pkg as { course_id: string }).course_id !== courseId) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }
  const pkgRow = pkg as {
    id: string;
    course_id: string;
    language: string | null;
    courses: { organization_id: string } | Array<{ organization_id: string }>;
  };
  const orgIdFromJoin = Array.isArray(pkgRow.courses)
    ? pkgRow.courses[0]?.organization_id
    : pkgRow.courses?.organization_id;
  if (orgIdFromJoin !== org.id) {
    return NextResponse.json({ error: "Cross-tenant" }, { status: 403 });
  }

  const update: Record<string, unknown> = {};
  if (body.display_name !== undefined) {
    update.display_name = body.display_name?.trim() || null;
  }
  if (body.is_active !== undefined) {
    update.is_active = !!body.is_active;
  }
  if (body.language !== undefined) {
    if (body.language === null) {
      // Demoting back to NULL is rarely useful; allow it but only for
      // the special case where no other NULL package exists on this
      // course (unique-index would block otherwise).
      update.language = null;
    } else {
      if (!isSupportedLanguage(body.language)) {
        return NextResponse.json(
          { error: `Unsupported language code "${body.language}"` },
          { status: 400 }
        );
      }
      // Refuse if another package already has this language on this course.
      const { data: clash } = await svc
        .from("course_packages")
        .select("id")
        .eq("course_id", courseId)
        .eq("language", body.language)
        .neq("id", packageId)
        .maybeSingle();
      if (clash) {
        return NextResponse.json(
          { error: `Course already has a "${body.language}" package` },
          { status: 409 }
        );
      }
      update.language = body.language;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true, noop: true });
  }

  const { error } = await svc
    .from("course_packages")
    .update(update)
    .eq("id", packageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/courses/{courseId}/packages/{packageId}
 *
 * Hard-delete a package. Refuses with 409 if any course_attempts exist
 * for versions in this package (admin should deactivate via PATCH
 * is_active: false instead, preserving learner history).
 *
 * Closes #158 Phase 1c (DELETE half).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ courseId: string; packageId: string }> }
) {
  const { courseId, packageId } = await params;
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("orgSlug");
  if (!orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user: caller } } = await supabase.auth.getUser();
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations").select("id").eq("slug", orgSlug).maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id).eq("user_id", caller.id).maybeSingle();
  const cr = callerMem?.role as string | undefined;
  if (!(cr === "super_owner" || cr === "owner" || cr === "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Tenant guard: the course must belong to the caller's org. The caller is only
  // authorized as admin of `orgSlug`; everything below runs on the service-role
  // client (bypasses RLS). Without this, an admin of org A could delete a
  // package from org B's course by passing org B's courseId/packageId. (The PATCH
  // handler already does this join; DELETE was missing it.)
  const { data: courseOwner } = await svc
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!courseOwner) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  // Refuse if any course_attempts exist for versions in this package.
  const { data: versions } = await svc
    .from("course_versions")
    .select("id")
    .eq("package_id", packageId);
  const versionIds = ((versions ?? []) as Array<{ id: string }>).map((v) => v.id);
  if (versionIds.length > 0) {
    const { count } = await svc
      .from("course_attempts")
      .select("id", { count: "exact", head: true })
      .in("course_version_id", versionIds);
    if ((count ?? 0) > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete: ${count} learner attempts exist on this language. Deactivate instead (PATCH { is_active: false }) to preserve history.`,
          attempt_count: count,
        },
        { status: 409 }
      );
    }
  }

  // Verify package belongs to this course before deleting.
  const { data: pkg } = await svc
    .from("course_packages").select("id, course_id").eq("id", packageId).maybeSingle();
  if (!pkg || (pkg as { course_id: string }).course_id !== courseId) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  const { error } = await svc.from("course_packages").delete().eq("id", packageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
