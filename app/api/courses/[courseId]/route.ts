import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   PATCH  /api/courses/[courseId]
 *   DELETE /api/courses/[courseId]
 *
 * Admin-only via RLS. PATCH accepts any subset of: title, description,
 * duration_minutes, is_active, thumbnail_url, visibility.
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
    visibility?: string;
  };

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

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
  if (body.thumbnail_url !== undefined) {
    update.thumbnail_url = body.thumbnail_url || null;
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

  const supabase = await createClient();
  const { error } = await supabase
    .from("courses")
    .update(update)
    .eq("id", courseId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const supabase = await createClient();
  const { error } = await supabase
    .from("courses")
    .delete()
    .eq("id", courseId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
