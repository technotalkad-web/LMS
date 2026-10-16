import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { countLearnerAttemptsOnCourse, isLearnerHistoryError } from "@/lib/courses/learner-history";

/**
 *   PATCH  /api/courses/[courseId]
 *   DELETE /api/courses/[courseId]
 *
 * Admin-only via RLS. PATCH accepts any subset of: title, description,
 * duration_minutes, is_active, thumbnail_url, thumbnail_fit,
 * thumbnail_pos_x, thumbnail_pos_y, visibility, folder_id,
 * show_attempts_history.
 */

const VISIBILITY_VALUES = ["private", "org_public"] as const;
type Visibility = (typeof VISIBILITY_VALUES)[number];

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    description?: string | null;
    duration_minutes?: number | string | null;
    is_active?: boolean;
    thumbnail_url?: string | null;
    thumbnail_fit?: string;
    thumbnail_pos_x?: number;
    thumbnail_pos_y?: number;
    visibility?: string;
    folder_id?: string | null;
    show_attempts_history?: boolean;
    pass_required?: boolean;
  };

  const supabase = await createClient();

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // Move into a folder. Validate the folder belongs to the same org as the
  // course (no cross-org filing); null = move to root / Uncategorised.
  if (body.folder_id !== undefined) {
    if (body.folder_id === null) {
      update.folder_id = null;
    } else {
      const { data: course } = await supabase
        .from("courses")
        .select("id, organization_id")
        .eq("id", courseId)
        .maybeSingle();
      if (!course) {
        return NextResponse.json({ error: "Course not found" }, { status: 404 });
      }
      const { data: folder } = await supabase
        .from("folders")
        .select("id")
        .eq("id", body.folder_id)
        .eq("organization_id", course.organization_id as string)
        .maybeSingle();
      if (!folder) {
        return NextResponse.json({ error: "Folder not found" }, { status: 404 });
      }
      update.folder_id = folder.id as string;
    }
  }

  if (typeof body.title === "string") {
    const t = body.title.trim();
    if (!t) {
      return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
    }
    update.title = t;
  }
  if (body.description !== undefined) {
    update.description =
      typeof body.description === "string"
        ? body.description.trim() || null
        : null;
  }
  if (body.duration_minutes !== undefined) {
    if (body.duration_minutes === null || body.duration_minutes === "") {
      update.duration_minutes = null;
    } else {
      const n =
        typeof body.duration_minutes === "string"
          ? parseInt(body.duration_minutes, 10)
          : body.duration_minutes;
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json(
          { error: "duration_minutes must be a non-negative integer" },
          { status: 400 }
        );
      }
      update.duration_minutes = n;
    }
  }
  if (typeof body.is_active === "boolean") {
    update.is_active = body.is_active;
  }
  // 0072 — only written when explicitly sent, so pre-migration saves of the
  // other fields keep working.
  if (typeof body.show_attempts_history === "boolean") {
    update.show_attempts_history = body.show_attempts_history;
  }
  // 0081 — pass required: a path step / journey day completes only on a pass.
  if (typeof body.pass_required === "boolean") {
    update.pass_required = body.pass_required;
  }
  if (body.thumbnail_url !== undefined) {
    update.thumbnail_url = body.thumbnail_url || null;
  }
  if (body.thumbnail_fit !== undefined) {
    if (body.thumbnail_fit !== "cover" && body.thumbnail_fit !== "contain") {
      return NextResponse.json(
        { error: "thumbnail_fit must be 'cover' or 'contain'" },
        { status: 400 }
      );
    }
    update.thumbnail_fit = body.thumbnail_fit;
  }
  for (const key of ["thumbnail_pos_x", "thumbnail_pos_y"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 100) {
      return NextResponse.json(
        { error: `${key} must be a number between 0 and 100` },
        { status: 400 }
      );
    }
    update[key] = Math.round(v);
  }
  if (body.visibility !== undefined) {
    if (!VISIBILITY_VALUES.includes(body.visibility as Visibility)) {
      return NextResponse.json(
        {
          error: `visibility must be one of: ${VISIBILITY_VALUES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    update.visibility = body.visibility;
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ ok: true, noop: true });
  }

  const { error } = await supabase
    .from("courses")
    .update(update)
    .eq("id", courseId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

/**
 * DELETE refuses (409) while learner attempts exist on any version of the
 * course (ADR 0003 step 12; same definition as the 0098 delete guard: staff
 * attempts don't count, former members' do). The delete itself stays an RLS
 * delete, so a non-admin still deletes nothing.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const supabase = await createClient();
  const refuse = (count: number | null) =>
    NextResponse.json(
      {
        error: `Cannot delete: ${count ?? "some"} learner attempts exist on this course. Deactivate instead (PATCH { is_active: false }) to preserve history.`,
        attempt_count: count,
      },
      { status: 409 }
    );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data: course } = await supabase
      .from("courses")
      .select("id, organization_id")
      .eq("id", courseId)
      .maybeSingle();
    const orgId = (course as { organization_id?: string } | null)?.organization_id;
    if (orgId) {
      const { data: mem } = await supabase
        .from("organization_members")
        .select("role")
        .eq("organization_id", orgId)
        .eq("user_id", user.id)
        .maybeSingle();
      const role = (mem?.role as string | undefined) ?? "";
      if (role === "super_owner" || role === "owner" || role === "admin") {
        // Attempts belong to other users: count with the service role, after
        // the admin check. Fail closed when the count cannot be read.
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        let learnerAttempts: number;
        try {
          learnerAttempts = await countLearnerAttemptsOnCourse(svc, courseId);
        } catch (e) {
          return NextResponse.json(
            { error: e instanceof Error ? e.message : "Could not check learner history" },
            { status: 503 }
          );
        }
        if (learnerAttempts > 0) return refuse(learnerAttempts);
      }
    }
  }

  const { error } = await supabase
    .from("courses")
    .delete()
    .eq("id", courseId);
  // A learner attempt that arrived after the count: the 0098 trigger refuses.
  if (isLearnerHistoryError(error)) return refuse(null);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
