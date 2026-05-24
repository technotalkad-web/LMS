import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   PUT /api/courses/[courseId]/reminders
 *   body: { enabled: boolean, cadence_days: 1..30, cap_days?: 1..365 }
 *
 * Upserts the per-course reminder configuration. Admin-only via RLS.
 * cadence_days range (1-30) matches migration 0028's CHECK constraint.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    enabled?: boolean;
    cadence_days?: number;
    cap_days?: number;
  };
  const cadence_days =
    typeof body.cadence_days === "number" &&
    Number.isInteger(body.cadence_days) &&
    body.cadence_days >= 1 &&
    body.cadence_days <= 30
      ? body.cadence_days
      : 1;
  const cap_days =
    typeof body.cap_days === "number" &&
    body.cap_days > 0 &&
    body.cap_days <= 365
      ? body.cap_days
      : 30;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("course_reminder_settings")
    .upsert(
      {
        course_id: courseId,
        enabled: !!body.enabled,
        cadence_days,
        cap_days,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      },
      { onConflict: "course_id" }
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
